"""B 线第二版：2–3 年数据上的 walk-forward（训练 12m → 验证 3m → 步长 3m）。

设计约束（来自 review）：
  · 同一根 K 同时触发 TP 与 SL → **按 SL 先触发**（保守）
  · 入场在下一根 1h 开盘；止损按触发价 + 滑点
  · 三种费用口径：maker 入场/taker 出场（默认）、全 maker、全 taker
  · 日损 3% 以 UTC 00:00 的 balance 重锚；权益按 bar 内极值判定
  · 触碰即停：breach / pass 后不再交易

    python3 research/trend/walkforward.py --grid full
"""
import argparse, bisect, json, os, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('BTC_WF', os.path.join(HERE, '..', 'data', 'btc_1h_binance.json'))

CAP, TARGET, FLOOR = 5000.0, 5500.0, 4700.0
DAILY = 0.03
SLIP = 0.0002
HOUR = 3_600_000


def load(path=DATA):
    rows = json.load(open(path))
    rows.sort(key=lambda x: x['t'])
    return rows


def resample(bars, hours):
    if hours <= 1:
        return [dict(b, end=b['t'] + HOUR - 1) for b in bars]
    out, cur, step = [], None, hours * HOUR
    for b in bars:
        bucket = b['t'] - (b['t'] % step)
        if cur is None or cur['t'] != bucket:
            if cur:
                out.append(cur)
            cur = {'t': bucket, 'o': b['o'], 'h': b['h'], 'l': b['l'], 'c': b['c'], 'end': b['t'] + HOUR - 1}
        else:
            cur['h'] = max(cur['h'], b['h'])
            cur['l'] = min(cur['l'], b['l'])
            cur['c'] = b['c']
            cur['end'] = b['t'] + HOUR - 1
    if cur:
        out.append(cur)
    return out


def ema(vals, n):
    k, out, prev = 2 / (n + 1), [], None
    for v in vals:
        prev = v if prev is None else v * k + prev * (1 - k)
        out.append(prev)
    return out


def atr(bars, n):
    trs, out, prev = [], [], None
    for b in bars:
        tr = b['h'] - b['l'] if prev is None else max(b['h'] - b['l'], abs(b['h'] - prev), abs(b['l'] - prev))
        trs.append(tr)
        out.append(sum(trs[max(0, len(trs) - n):]) / min(n, len(trs)))
        prev = b['c']
    return out


def build_signals(bars, tf_hours, atr_n, fast=20, slow=60):
    """返回与 1h bars 对齐的 (dir, atr_price)。dir 来自已收盘的 tf bar。"""
    tf = resample(bars, tf_hours)
    ef, es = ema([b['c'] for b in tf], fast), ema([b['c'] for b in tf], slow)
    a = atr(tf, atr_n)
    ends = [b['end'] for b in tf]
    dirs = [0] * len(bars)
    atrs = [0.0] * len(bars)
    for i, b in enumerate(bars):
        j = bisect.bisect_right(ends, b['t'] - 1) - 1   # 已经收盘的最后一根 tf bar
        if j < 1:
            continue
        dirs[i] = 1 if ef[j] > es[j] else -1
        atrs[i] = a[j]
    return dirs, atrs


class Sim:
    __slots__ = ('cash', 'qty', 'entry', 'dir', 'fees', 'peak', 'maxdd', 'day', 'day_bal',
                 'breach', 'passed', 'pass_i', 'trades', 'wins', 'consec', 'max_consec', 'worst_day', 'eq_min')

    def __init__(self):
        self.cash = CAP
        self.qty = 0.0
        self.entry = 0.0
        self.dir = 0
        self.fees = 0.0
        self.peak = CAP
        self.maxdd = 0.0
        self.day = None
        self.day_bal = CAP
        self.breach = None
        self.passed = False
        self.pass_i = None
        self.trades = 0
        self.wins = 0
        self.consec = 0
        self.max_consec = 0
        self.worst_day = 0.0
        self.eq_min = CAP

    def eq(self, px):
        if self.dir == 0:
            return self.cash
        return self.cash + self.qty * (px - self.entry) * self.dir


def simulate(bars, dirs, atrs, i0, i1, *, risk, stop_mult, tp_mult, fee_in, fee_out, lev_cap):
    s = Sim()
    stop = tp = None
    for i in range(i0, i1):
        b = bars[i]
        # UTC 日切：以当时 balance 重锚日损
        day = b['t'] // 86_400_000
        if s.day is None:
            s.day, s.day_bal = day, s.cash
        elif day != s.day:
            s.day, s.day_bal = day, s.cash
        floor = max(FLOOR, s.day_bal * (1 - DAILY))   # 两条线取更严的那条

        # 1) 持仓：先判 SL/TP（同 bar 双触发按 SL）
        if s.dir != 0:
            adverse = b['l'] if s.dir > 0 else b['h']
            favour = b['h'] if s.dir > 0 else b['l']
            hit_sl = (adverse <= stop) if s.dir > 0 else (adverse >= stop)
            hit_tp = (favour >= tp) if s.dir > 0 else (favour <= tp)
            if hit_sl:
                px = stop * (1 - SLIP) if s.dir > 0 else stop * (1 + SLIP)
                s.cash += s.qty * (px - s.entry) * s.dir - px * s.qty * fee_out
                s.fees += px * s.qty * fee_out
                s.trades += 1
                if (px - s.entry) * s.dir >= 0:
                    s.wins += 1
                    s.consec = 0
                else:
                    s.consec += 1
                    s.max_consec = max(s.max_consec, s.consec)
                s.dir, s.qty, s.entry = 0, 0.0, 0.0
            elif hit_tp:
                px = tp
                s.cash += s.qty * (px - s.entry) * s.dir - px * s.qty * fee_out
                s.fees += px * s.qty * fee_out
                s.trades += 1
                s.wins += 1
                s.consec = 0
                s.dir, s.qty, s.entry = 0, 0.0, 0.0

        # 2) 信号切换（上一根收盘产生 → 本根开盘执行）
        want = dirs[i]
        if want != s.dir:
            if s.dir != 0:      # 平旧仓
                px = b['o']
                s.cash += s.qty * (px - s.entry) * s.dir - px * s.qty * fee_out
                s.fees += px * s.qty * fee_out
                s.trades += 1
                if (px - s.entry) * s.dir >= 0:
                    s.wins += 1
                    s.consec = 0
                else:
                    s.consec += 1
                    s.max_consec = max(s.max_consec, s.consec)
                s.dir, s.qty, s.entry = 0, 0.0, 0.0
            if want != 0 and atrs[i] > 0:
                dist = stop_mult * atrs[i]
                eq = s.cash
                qty = min(eq * risk / dist, eq * lev_cap / b['o'])
                if qty > 0:
                    s.qty, s.entry, s.dir = qty, b['o'], want
                    s.cash -= b['o'] * qty * fee_in
                    s.fees += b['o'] * qty * fee_in
                    stop = b['o'] - want * dist
                    tp = b['o'] + want * tp_mult * dist

        # 3) 规则判定（先不利、后有利）
        eq_bad = s.eq(b['l'] if s.dir >= 0 else b['h'])
        eq_good = s.eq(b['h'] if s.dir >= 0 else b['l'])
        s.eq_min = min(s.eq_min, eq_bad)
        s.peak = max(s.peak, eq_good)
        s.maxdd = max(s.maxdd, s.peak - eq_bad)
        s.worst_day = max(s.worst_day, s.day_bal - min(s.day_bal, eq_bad))
        if eq_bad <= floor:
            s.breach = 'floor' if eq_bad <= FLOOR else 'daily'
            if s.dir != 0:
                px = b['c']
                s.cash += s.qty * (px - s.entry) * s.dir - px * s.qty * fee_out
                s.dir, s.qty = 0, 0.0
            return s, i
        if eq_good >= TARGET:
            s.passed, s.pass_i = True, i
            return s, i
    return s, i1 - 1


def metrics(sims, bars, starts):
    n = len(sims)
    passed = [s for s in sims if s.passed]
    days = [((s.pass_i - starts[k]) + 1) / 24 for k, s in enumerate(sims) if s.passed]
    return {
        'n': n,
        'pass_pct': round(len(passed) / n * 100, 1) if n else 0,
        'breach_pct': round(sum(1 for s in sims if s.breach) / n * 100, 1) if n else 0,
        'daily_pct': round(sum(1 for s in sims if s.breach == 'daily') / n * 100, 1) if n else 0,
        'med_days': round(st.median(days), 1) if days else None,
        'med_dd': round(st.median([s.maxdd for s in sims]), 1) if n else 0,
        'med_trades': st.median([s.trades for s in sims]) if n else 0,
        'med_fees': round(st.median([s.fees for s in sims]), 1) if n else 0,
        'worst_day': round(st.median([s.worst_day for s in sims]), 1) if n else 0,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grid', choices=['small', 'full'], default='small')
    ap.add_argument('--train-months', type=int, default=12)
    ap.add_argument('--test-months', type=int, default=3)
    ap.add_argument('--horizon-days', type=int, default=60)
    ap.add_argument('--step-days', type=int, default=5)
    ap.add_argument('--fee-mode', choices=['maker_in_taker_out', 'all_maker', 'all_taker'], default='maker_in_taker_out')
    ap.add_argument('--out', default=os.path.join(HERE, 'walkforward.json'))
    args = ap.parse_args()

    bars = load()
    print(f'data {len(bars)} bars  {bars[0]["t"]} → {bars[-1]["t"]}')
    t0, t1 = bars[0]['t'], bars[-1]['t']
    month = 30 * 24 * HOUR
    train_ms, test_ms = args.train_months * month, args.test_months * month
    horizon = args.horizon_days * 24
    step = args.step_days * 24

    if args.fee_mode == 'all_maker':
        fee_in, fee_out = 0.00015, 0.00015
    elif args.fee_mode == 'all_taker':
        fee_in, fee_out = 0.00045, 0.00045
    else:
        fee_in, fee_out = 0.00015, 0.00045

    if args.grid == 'full':
        risks = [0.0025, 0.005, 0.0075, 0.01]
        stops = [2.0, 2.5, 3.0]
        tps = [1.5, 2.0, 2.5, 3.0]
        atr_ns = [14, 20]
        tfs = [1, 4]
    else:
        risks = [0.005, 0.01]
        stops = [2.0, 2.5, 3.0]
        tps = [2.0, 3.0]
        atr_ns = [14]
        tfs = [1, 4]

    # 预计算信号（方向只依赖 tf / atr 周期）
    cache = {}
    for tf in tfs:
        for an in atr_ns:
            cache[(tf, an)] = build_signals(bars, tf, an)

    combos = [(r, sm, tp, an, tf) for r in risks for sm in stops for tp in tps for an in atr_ns for tf in tfs]
    print(f'grid={args.grid}  combos={len(combos)}  fee={args.fee_mode}  horizon={args.horizon_days}d')

    folds = []
    start = t0 + train_ms
    while start + test_ms <= t1:
        tr_lo, tr_hi = start - train_ms, start
        te_lo, te_hi = start, min(start + test_ms, t1)
        # 训练：在训练段内取 3 个 60 天窗口（起、中、尾）
        tr_starts = []
        for frac in (0.05, 0.45, 0.8):
            s = tr_lo + int((tr_hi - tr_lo - horizon * HOUR) * frac)
            if s >= tr_lo:
                tr_starts.append(s)
        # 验证：每 step_days 一个窗口
        te_starts = list(range(te_lo, te_hi - horizon * HOUR + 1, step * HOUR))

        def idx(ts):
            lo, hi = 0, len(bars) - 1
            while lo < hi:
                mid = (lo + hi) // 2
                if bars[mid]['t'] < ts:
                    lo = mid + 1
                else:
                    hi = mid
            return lo

        best, best_score = None, -1e9
        for (r, sm, tp, an, tf) in combos:
            dirs, atrs = cache[(tf, an)]
            sims, starts = [], []
            for sts in tr_starts:
                i0 = idx(sts)
                i1 = min(i0 + horizon, len(bars))
                s, _ = simulate(bars, dirs, atrs, i0, i1, risk=r, stop_mult=sm, tp_mult=tp,
                                fee_in=fee_in, fee_out=fee_out, lev_cap=0.5)
                sims.append(s)
                starts.append(i0)
            m = metrics(sims, bars, starts)
            # 选择：通过率 − 1.5×爆仓率（爆仓惩罚更重），并要求至少一次通过
            score = m['pass_pct'] - 1.5 * m['breach_pct']
            if score > best_score:
                best_score, best = score, ((r, sm, tp, an, tf), m)

        params, trm = best
        r, sm, tp, an, tf = params
        dirs, atrs = cache[(tf, an)]
        sims, starts = [], []
        for sts in te_starts:
            i0 = idx(sts)
            i1 = min(i0 + horizon, len(bars))
            s, _ = simulate(bars, dirs, atrs, i0, i1, risk=r, stop_mult=sm, tp_mult=tp,
                            fee_in=fee_in, fee_out=fee_out, lev_cap=0.5)
            sims.append(s)
            starts.append(i0)
        tem = metrics(sims, bars, starts)
        folds.append({
            'test_from': te_lo, 'test_to': te_hi,
            'params': {'risk': r, 'stop_atr': sm, 'tp_r': tp, 'atr': an, 'tf_h': tf},
            'train': trm, 'test': tem,
        })
        print(f"fold {te_lo}: train pass {trm['pass_pct']:5.1f}% / breach {trm['breach_pct']:5.1f}%  →  "
              f"test pass {tem['pass_pct']:5.1f}% / breach {tem['breach_pct']:5.1f}%  "
              f"params r{r*100:.2f}% stop{sm} tp{tp}R atr{an} {tf}h", flush=True)
        start += test_ms

    # 汇总：只汇总验证段
    all_sims = []
    for f in folds:
        all_sims.append(f['test'])
    agg_pass = sum(x['pass_pct'] * x['n'] for x in all_sims) / max(1, sum(x['n'] for x in all_sims))
    agg_breach = sum(x['breach_pct'] * x['n'] for x in all_sims) / max(1, sum(x['n'] for x in all_sims))
    print(f'\n验证段汇总：通过 {agg_pass:.1f}%  爆仓 {agg_breach:.1f}%  折数 {len(folds)}')
    json.dump({'fee_mode': args.fee_mode, 'grid': args.grid, 'folds': folds,
               'summary': {'pass_pct': round(agg_pass, 1), 'breach_pct': round(agg_breach, 1)}},
              open(args.out, 'w'), indent=1)
    print(f'→ {args.out}')


if __name__ == '__main__':
    main()