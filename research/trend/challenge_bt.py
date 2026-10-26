"""B 研究：挑战规则级回测（5k Classic 1-Step）。

和"策略回测"的区别：这里把规则本身当成一等公民——
  日损 3% 以 **当日 00:00 UTC 的 balance** 为基准（不是 equity），
  静态地板 6%（$4,700），目标 +10%（$5,500），
  权益在**bar 内极值**处判定（宁可错杀，不可漏杀）。

策略接口：给定 bar 序列，返回每根 bar 的目标仓位（0 或 ±qty）与止损价。
本文件先实现两个方向性策略，网格结果见 docs/propr/grid_sim2.py。
"""
import json, math, os, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('BTC_1H', os.path.join(HERE, '..', '..', 'docs', 'propr', 'btc_1h.json'))

CAP = 5000.0
TARGET = 5500.0
FLOOR = 4700.0
DAILY_PCT = 0.03
TAKER = 0.00045
SLIP = 0.0002          # 止损滑点 2bp


def load(path=DATA):
    rows = json.load(open(path))
    rows.sort(key=lambda x: x['t'])
    return [{'t': b['t'], 'o': float(b['o']), 'h': float(b['h']), 'l': float(b['l']), 'c': float(b['c'])} for b in rows]


def atr(bars, n=14):
    out, prev = [], None
    for b in bars:
        tr = b['h'] - b['l'] if prev is None else max(b['h'] - b['l'], abs(b['h'] - prev), abs(b['l'] - prev))
        out.append(tr)
        prev = b['c']
    return [sum(out[max(0, i - n + 1):i + 1]) / min(n, i + 1) for i in range(len(out))]


def ema(vals, n):
    k = 2 / (n + 1)
    out, prev = [], None
    for v in vals:
        prev = v if prev is None else v * k + prev * (1 - k)
        out.append(prev)
    return out


def donchian(bars, n):
    hi, lo = [], []
    for i in range(len(bars)):
        w = bars[max(0, i - n + 1):i + 1]
        hi.append(max(b['h'] for b in w))
        lo.append(min(b['l'] for b in w))
    return hi, lo


def resample(bars, hours):
    if hours <= 1:
        return bars
    out, cur = [], None
    step = hours * 3600_000
    for b in bars:
        bucket = b['t'] - (b['t'] % step)
        if cur is None or cur['t'] != bucket:
            if cur:
                out.append(cur)
            cur = {'t': bucket, 'o': b['o'], 'h': b['h'], 'l': b['l'], 'c': b['c'], 'end': b['t']}
        else:
            cur['h'] = max(cur['h'], b['h'])
            cur['l'] = min(cur['l'], b['l'])
            cur['c'] = b['c']
            cur['end'] = b['t']
    if cur:
        out.append(cur)
    return out


class Portfolio:
    """现金 + 单向仓位。事件按 bar 顺序推进。"""
    def __init__(self, cap=CAP):
        self.cash = cap
        self.qty = 0.0
        self.entry = 0.0
        self.side = 0        # +1 多 / -1 空 / 0 空仓
        self.fees = 0.0
        self.peak = cap
        self.maxdd = 0.0
        self.entry_day_balance = cap
        self.day_start_balance = cap
        self.day = None
        self.breached = None
        self.passed = False
        self.pass_at = None
        self.trades = 0
        self.wins = 0
        self.losses = 0
        self.consec_loss = 0
        self.max_consec_loss = 0
        self.worst_day = 0.0

    def equity(self, px):
        if self.side == 0:
            return self.cash
        if self.side > 0:
            return self.cash + self.qty * (px - self.entry)
        return self.cash + self.qty * (self.entry - px)

    def open(self, side, px, qty, fee=TAKER):
        if self.side != 0:
            self.close(px, fee)
        if qty <= 0:
            return
        cost = px * qty * fee
        self.cash -= cost
        self.fees += cost
        self.side = side
        self.qty = qty
        self.entry = px

    def close(self, px, fee=TAKER):
        if self.side == 0:
            return 0.0
        pnl = self.qty * (px - self.entry) * (1 if self.side > 0 else -1)
        cost = px * self.qty * fee
        self.cash += pnl - cost
        self.fees += cost
        self.trades += 1
        if pnl - cost >= 0:
            self.wins += 1
            self.consec_loss = 0
        else:
            self.losses += 1
            self.consec_loss += 1
            self.max_consec_loss = max(self.max_consec_loss, self.consec_loss)
        self.side, self.qty, self.entry = 0, 0.0, 0.0
        return pnl - cost

    def mark(self, eq):
        self.peak = max(self.peak, eq)
        self.maxdd = max(self.maxdd, self.peak - eq)
        self.worst_day = max(self.worst_day, self.day_start_balance - min(self.day_start_balance, eq))


def run(bars, signals, risk_pct=0.01, atr_mult=1.5, max_leverage=2.0, fee=TAKER, max_days=60, stop_at=None, flat_eod=False):
    """
    signals: list of (side, stop_price) per bar, side ∈ {0, ±1}. 在**下一根 bar 开盘**执行。
    stop_at: list of stop prices（可随 bar 更新）
    """
    p = Portfolio()
    start = bars[0]['t']
    for i, b in enumerate(bars):
        if b['t'] < start:
            continue
        # 日切：以 UTC 00:00 的 balance 重锚日损
        day = b['t'] // 86_400_000
        if p.day is None:
            p.day = day
            p.day_start_balance = p.cash
        elif day != p.day:
            # 日内平仓模式：先平掉隔夜仓，再用平仓后的 balance 重锚日损
            if flat_eod and p.side != 0:
                p.close(b['o'], fee)
            p.day = day
            p.day_start_balance = p.cash
        # 1) 先判此前持仓在 bar 内的止损
        if p.side != 0:
            stop = stop_at[i]
            if stop is not None:
                hit = (p.side > 0 and b['l'] <= stop) or (p.side < 0 and b['h'] >= stop)
                if hit:
                    px = stop * (1 - SLIP) if p.side > 0 else stop * (1 + SLIP)
                    p.close(px, fee)
        # 2) 执行信号（上一根收盘产生的 → 本根开盘）
        side, stop = signals[i]
        if side != p.side:
            if side == 0:
                if p.side != 0:
                    p.close(b['o'], fee)
            else:
                eq = p.equity(b['o'])
                dist = abs(b['o'] - stop)
                if dist > 0 and eq > 0:
                    qty = min(eq * risk_pct / dist, eq * max_leverage / b['o'])
                    p.open(side, b['o'], qty, fee)
        # 3) 规则判定：先用不利极值，再用有利极值
        if p.side >= 0:
            eq_bad = p.equity(b['l'] if p.side > 0 else b['c'])
            eq_good = p.equity(b['h'] if p.side > 0 else b['c'])
        else:
            eq_bad = p.equity(b['h'])
            eq_good = p.equity(b['l'])
        floor_day = p.day_start_balance * (1 - DAILY_PCT)
        if not p.breached and (eq_bad <= FLOOR or eq_bad <= floor_day):
            p.breached = 'daily' if eq_bad > FLOOR else 'floor'
            p.close(b['o'], fee)
            break
        if not p.passed and eq_good >= TARGET:
            p.passed = True
            p.pass_at = b['t']
            break
        p.mark(eq_bad)
        if (b['t'] - start) / 86_400_000 > max_days:
            break
    return p


def donchian_signals(bars_sig, bars, n=20, exit_n=10, atr_mult=1.5, allow_short=True):
    hi, lo = donchian(bars_sig, n)
    _, lo_exit = donchian(bars_sig, exit_n)
    hi_exit, _ = donchian(bars_sig, exit_n)
    a = atr(bars_sig, 14)
    # 把信号映射到 1h 时间轴（信号在 sig bar 收盘产生，下一根 1h 执行）
    idx = {b['t']: i for i, b in enumerate(bars_sig)}
    sig = [(0, None)] * len(bars)
    stops = [None] * len(bars)
    for i, b in enumerate(bars):
        # 找到已收盘的最后一根 sig bar
        j = None
        for k in range(len(bars_sig) - 1, -1, -1):
            if bars_sig[k]['end'] < b['t']:
                j = k
                break
        if j is None:
            continue
        side, stop = 0, None
        if j >= n:
            prev_close = bars_sig[j]['c']
            if prev_close > hi[j - 1]:
                side = 1
                stop = prev_close - atr_mult * a[j]
            elif allow_short and prev_close < lo[j - 1]:
                side = -1
                stop = prev_close + atr_mult * a[j]
        sig[i] = (side, stop)
        stops[i] = stop
    return sig, stops


def ema_signals(bars_sig, bars, fast=20, slow=60, atr_mult=2.0, allow_short=True):
    ef, es = ema([b['c'] for b in bars_sig], fast), ema([b['c'] for b in bars_sig], slow)
    a = atr(bars_sig, 14)
    sig = [(0, None)] * len(bars)
    stops = [None] * len(bars)
    for i, b in enumerate(bars):
        j = None
        for k in range(len(bars_sig) - 1, -1, -1):
            if bars_sig[k]['end'] < b['t']:
                j = k
                break
        if j is None or j < 1:
            continue
        side, stop = 0, None
        if ef[j] > es[j]:
            side = 1
            stop = bars_sig[j]['c'] - atr_mult * a[j]
        elif allow_short and ef[j] < es[j]:
            side = -1
            stop = bars_sig[j]['c'] + atr_mult * a[j]
        sig[i] = (side, stop)
        stops[i] = stop
    return sig, stops


def evaluate(name, bars, bars_sig, sigfn, windows, **kw):
    res = []
    for s in windows:
        sub = bars[s:]
        sig, stops = sigfn(bars_sig, sub, **kw)
        p = run(sub, sig, stop_at=stops, **{k: v for k, v in kw.items() if k in ('risk_pct', 'atr_mult', 'max_leverage', 'fee', 'flat_eod')})
        res.append(p)
    n = len(res)
    passed = [p for p in res if p.passed]
    days = [(p.pass_at - bars[s]['t']) / 86_400_000 for p, s in zip(res, windows) if p.passed]
    breaches = [p for p in res if p.breached]
    return {
        'name': name,
        'n': n,
        'pass_pct': round(len(passed) / n * 100, 1),
        'breach_pct': round(len(breaches) / n * 100, 1),
        'med_days': round(st.median(days), 1) if days else None,
        'med_maxdd': round(st.median([p.maxdd for p in res]), 1),
        'p90_maxdd': round(sorted(p.maxdd for p in res)[int(n * 0.9)], 1),
        'med_trades': st.median([p.trades for p in res]),
        'max_consec_loss': max((p.max_consec_loss for p in res), default=0),
        'med_fees': round(st.median([p.fees for p in res]), 1),
        'daily_breach': sum(1 for p in breaches if p.breached == 'daily'),
        'floor_breach': sum(1 for p in breaches if p.breached == 'floor'),
    }


if __name__ == '__main__':
    bars = load()
    bars4 = resample(bars, 4)
    print(f'bars={len(bars)} 4h={len(bars4)} price {min(b["l"] for b in bars):.0f}-{max(b["h"] for b in bars):.0f}')
    W = 60 * 24
    windows = list(range(0, len(bars) - W, 24))
    print(f'windows={len(windows)} (60d horizon, step 1d)\n')

    rows = []
    for n, ex, am, rs in [(20, 10, 1.5, 0.01), (40, 20, 2.0, 0.01), (20, 10, 2.5, 0.005), (55, 20, 2.0, 0.0075)]:
        fn = lambda b, sub, **kw: donchian_signals(b, sub, n=n, exit_n=ex, atr_mult=am)
        rows.append(evaluate(f'Donchian {n}/{ex} atr{am} risk{rs*100:.2f}%', bars, bars4, fn, windows, risk_pct=rs, atr_mult=am))
    for f, s_, am, rs in [(20, 60, 2.0, 0.01), (12, 48, 1.5, 0.01), (20, 60, 2.5, 0.02)]:
        fn = lambda b, sub, **kw: ema_signals(b, sub, fast=f, slow=s_, atr_mult=am)
        rows.append(evaluate(f'EMA {f}/{s_} atr{am} risk{rs*100:.2f}%', bars, bars4, fn, windows, risk_pct=rs, atr_mult=am))

    for r in rows:
        print(f"{r['name']:38s} pass {r['pass_pct']:5.1f}%  breach {r['breach_pct']:5.1f}%  "
              f"medD {str(r['med_days']):>5}  maxDD {r['med_maxdd']:6.1f}/{r['p90_maxdd']:6.1f}  "
              f"trades {r['med_trades']:4.0f}  consec {r['max_consec_loss']:2d}  fees {r['med_fees']:5.1f}  "
              f"(daily {r['daily_breach']}/floor {r['floor_breach']})")
    json.dump(rows, open(os.path.join(HERE, 'results.json'), 'w'), indent=1)