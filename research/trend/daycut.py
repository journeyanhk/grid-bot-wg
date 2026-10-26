"""日切强平结构实验（一次性，离线）。

假设：UTC 00:00 前平仓 → 日切时 equity == balance → 隔夜浮亏不再直接触发日损。
配平设计（同一折、同一参数，只换规则/动作）：
    A 1-Step 不强平    B 1-Step 日切强平
    C 2-Step 不强平    D 2-Step 日切强平

规则口径：
  1-Step：日损 3% / 静态 6%（地板 4700）/ 目标 +10%
  2-Step：日损 5% / 追踪 8%（floor = min(5000, HWM-400)）/ 目标 +5%
  日损基准：当日 00:00 UTC 的 **balance**；权益在 bar 内极值判定；触线即停。

1h 粒度限制：23:xx 的三个时点无法区分，统一按"当日最后一根 1h 收盘"平仓，
并把 00:00 那根也设为禁止开仓（不立即重开）。15m 敏感性另跑。

    python3 research/trend/daycut.py
"""
import json, os, statistics as st
import walkforward as W

HERE = os.path.dirname(os.path.abspath(__file__))
CAP = 5000.0
SLIP = 0.0002
DAY = 86_400_000

RULES = {
    '1step': dict(daily=0.03, target=5500.0, floor_kind='static', dd=0.06),
    '2step': dict(daily=0.05, target=5250.0, floor_kind='trailing', dd=0.08),
}


def floor_of(rule, hwm):
    if rule['floor_kind'] == 'static':
        return CAP * (1 - rule['dd'])
    return min(CAP, hwm - CAP * rule['dd'])


def simulate(bars, dirs, atrs, i0, i1, *, rule, risk, stop_mult, tp_mult,
             fee_in, fee_out, lev_cap=0.5, flatten=False, reopen_min=60):
    cash, qty, entry, side = CAP, 0.0, 0.0, 0
    fees, hwm, maxdd = 0.0, CAP, 0.0
    day, day_bal = None, CAP
    trades = wins = 0
    consec = max_consec = 0
    stop = tp = None
    pass_i = None
    breach = None

    def eq(px):
        return cash if side == 0 else cash + qty * (px - entry) * side

    def close(px, fee, is_win=None):
        nonlocal cash, qty, entry, side, fees, trades, wins, consec, max_consec
        if side == 0:
            return
        pnl = qty * (px - entry) * side
        cost = px * qty * fee
        cash += pnl - cost
        fees += cost
        trades += 1
        good = pnl - cost >= 0 if is_win is None else is_win
        if good:
            wins += 1
            consec = 0
        else:
            consec += 1
            max_consec = max(max_consec, consec)
        qty, entry, side = 0.0, 0.0, 0

    for i in range(i0, i1):
        b = bars[i]
        mod = (b['t'] // 60_000) % 1440          # UTC 分钟
        d = b['t'] // DAY
        if day is None:
            day, day_bal = d, cash
        elif d != day:
            day, day_bal = d, cash

        # 日切前强平：当日最后一根 1h（23:00）收盘平掉
        if flatten and mod >= 1380 and side != 0:
            close(b['c'] * (1 - SLIP) if side > 0 else b['c'] * (1 + SLIP), fee_out)

        floor = max(floor_of(rule, hwm), day_bal * (1 - rule['daily']))

        if side != 0:
            adverse = b['l'] if side > 0 else b['h']
            favour = b['h'] if side > 0 else b['l']
            hit_sl = adverse <= stop if side > 0 else adverse >= stop
            hit_tp = favour >= tp if side > 0 else favour <= tp
            if hit_sl:
                px = stop * (1 - SLIP) if side > 0 else stop * (1 + SLIP)
                close(px, fee_out)
            elif hit_tp:
                close(tp, fee_out)

        block_entry = flatten and (mod >= 1380 or mod < reopen_min)
        want = dirs[i]
        if want != side and not block_entry:
            if side != 0:
                close(b['o'], fee_out)
            if want != 0 and atrs[i] > 0:
                dist = stop_mult * atrs[i]
                q = min(cash * risk / dist, cash * lev_cap / b['o'])
                if q > 0:
                    qty, entry, side = q, b['o'], want
                    cash -= b['o'] * q * fee_in
                    fees += b['o'] * q * fee_in
                    stop = b['o'] - want * dist
                    tp = b['o'] + want * tp_mult * dist

        eq_bad = eq(b['l'] if side >= 0 else b['h'])
        eq_good = eq(b['h'] if side >= 0 else b['l'])
        hwm = max(hwm, eq_good)
        maxdd = max(maxdd, hwm - eq_bad)
        floor = max(floor_of(rule, hwm), day_bal * (1 - rule['daily']))
        if eq_bad <= floor:
            breach = 'daily' if eq_bad > floor_of(rule, hwm) else 'floor'
            close(b['c'], fee_out)
            break
        if eq_good >= rule['target']:
            pass_i = i
            break
    return dict(passed=pass_i is not None, pass_i=pass_i, breach=breach, maxdd=maxdd,
                fees=fees, trades=trades, wins=wins, max_consec=max_consec, hwm=hwm)


def run_group(bars, dirs, atrs, starts, horizon, rule, flatten, **kw):
    out = []
    for i0 in starts:
        out.append(simulate(bars, dirs, atrs, i0, min(i0 + horizon, len(bars)),
                            rule=rule, flatten=flatten, **kw))
    return out


def summarize(sims, starts):
    n = len(sims)
    days = [((s['pass_i'] - starts[k]) + 1) / 24 for k, s in enumerate(sims) if s['passed']]
    return dict(n=n,
                pass_pct=round(sum(1 for s in sims if s['passed']) / n * 100, 1),
                breach_pct=round(sum(1 for s in sims if s['breach']) / n * 100, 1),
                med_days=round(st.median(days), 1) if days else None,
                med_dd=round(st.median([s['maxdd'] for s in sims]), 1),
                med_fees=round(st.median([s['fees'] for s in sims]), 1))


def main():
    bars = W.load()
    b4 = W.resample(bars, 4)
    t0, t1 = bars[0]['t'], bars[-1]['t']
    month = 30 * 24 * 3_600_000
    train_ms, test_ms = 12 * month, 3 * month
    horizon = 60 * 24
    step = 10 * 24

    risks, stops, tps, tfs = [0.005, 0.01], [2.0, 2.5, 3.0], [2.0, 3.0], [1, 4]
    cache = {(tf, 14): W.build_signals(bars, tf, 14) for tf in tfs}
    combos = [(r, sm, tp, tf) for r in risks for sm in stops for tp in tps for tf in tfs]
    fee_in, fee_out = 0.00015, 0.00045

    def idx(ts):
        lo, hi = 0, len(bars) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if bars[mid]['t'] < ts:
                lo = mid + 1
            else:
                hi = mid
        return lo

    rows = []
    start = t0 + train_ms
    while start + test_ms <= t1:
        tr_lo = start - train_ms
        tr_starts = []
        for frac in (0.05, 0.45, 0.8):
            s = tr_lo + int((start - tr_lo - horizon * 3_600_000) * frac)
            if s >= tr_lo:
                tr_starts.append(idx(s))
        te_starts = [idx(x) for x in range(start, min(start + test_ms, t1) - horizon * 3_600_000 + 1, step * 3_600_000)]
        if not te_starts:
            start += test_ms
            continue

        # 选参：在训练段用 A 组（1-Step、不强平），四组共用 → 配平
        best, best_score = None, -1e9
        for (r, sm, tp, tf) in combos:
            dirs, atrs = cache[(tf, 14)]
            sims = run_group(bars, dirs, atrs, tr_starts, horizon, RULES['1step'], False,
                             risk=r, stop_mult=sm, tp_mult=tp, fee_in=fee_in, fee_out=fee_out)
            m = summarize(sims, tr_starts)
            sc = m['pass_pct'] - 1.5 * m['breach_pct']
            if sc > best_score:
                best_score, best = sc, (r, sm, tp, tf)
        r, sm, tp, tf = best
        dirs, atrs = cache[(tf, 14)]

        groups = {}
        for name, rule_key, flat in (('A', '1step', False), ('B', '1step', True),
                                     ('C', '2step', False), ('D', '2step', True)):
            sims = run_group(bars, dirs, atrs, te_starts, horizon, RULES[rule_key], flat,
                             risk=r, stop_mult=sm, tp_mult=tp, fee_in=fee_in, fee_out=fee_out)
            groups[name] = summarize(sims, te_starts)
        btc_ret = bars[min(te_starts[-1] + horizon, len(bars) - 1)]['c'] / bars[te_starts[0]]['o'] - 1
        rows.append({'from': start, 'params': best, 'btc60': round(btc_ret, 4), **{k: v for k, v in groups.items()}})
        print(f"fold {start}: {best}  A {groups['A']['pass_pct']:5.1f}/{groups['A']['breach_pct']:5.1f}  "
              f"B {groups['B']['pass_pct']:5.1f}/{groups['B']['breach_pct']:5.1f}  "
              f"C {groups['C']['pass_pct']:5.1f}/{groups['C']['breach_pct']:5.1f}  "
              f"D {groups['D']['pass_pct']:5.1f}/{groups['D']['breach_pct']:5.1f}  btc {btc_ret*100:+.0f}%", flush=True)
        start += test_ms

    print('\n== 汇总（加权，按窗口数）==')
    print(f"{'组':>2} {'规则':>8} {'强平':>4} {'通过%':>7} {'爆仓%':>7} {'中位天数':>7} {'中位DD':>7}")
    for name, rule_key, flat in (('A', '1step', '否'), ('B', '1step', '是'), ('C', '2step', '否'), ('D', '2step', '是')):
        n = sum(r[name]['n'] for r in rows)
        p = sum(r[name]['pass_pct'] * r[name]['n'] for r in rows) / n
        b = sum(r[name]['breach_pct'] * r[name]['n'] for r in rows) / n
        dd = st.median([r[name]['med_dd'] for r in rows])
        print(f"{name:>2} {rule_key:>8} {flat:>4} {p:7.1f} {b:7.1f} {'—':>7} {dd:7.1f}")

    improved = sum(1 for r in rows if r['B']['pass_pct'] > r['A']['pass_pct'])
    worsened = sum(1 for r in rows if r['B']['pass_pct'] < r['A']['pass_pct'])
    print(f"\nB 相对 A：改善 {improved} 折，变差 {worsened} 折，持平 {len(rows) - improved - worsened} 折")
    json.dump(rows, open(os.path.join(HERE, 'daycut.json'), 'w'), indent=1)
    print(f'→ {os.path.join(HERE, "daycut.json")}')


if __name__ == '__main__':
    main()