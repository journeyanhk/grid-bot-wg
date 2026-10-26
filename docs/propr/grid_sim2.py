"""Grid feasibility, v2: adds auto-restart after breakout (mirrors the repo's
calm-gated auto-restart) so the grid is 'always on' instead of dying once.

Costs: fee per side on notional. Breakout: close inventory at bar close, wait
`cooldown` bars, re-seed band at the new price.
"""
import json, os, statistics as st

DATA = os.environ.get('BTC_1H',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'btc_1h.json'))

bars = [{'t': b['t'], 'o': float(b['o']), 'h': float(b['h']), 'l': float(b['l']), 'c': float(b['c'])}
        for b in sorted(json.load(open(DATA)), key=lambda x: x['t'])]


def run(start, nbars, rungs=6, spacing_pct=0.0067, size=0.004, fee=0.00075,
        breakout_pct=0.005, cooldown=6, capital=5000.0, recenter=False):
    i0 = start
    end = min(start + nbars, len(bars))
    p0 = bars[i0]['o']
    def band(p):
        sp = p * spacing_pct
        h = rungs / 2 * sp
        return [p - h + i * sp for i in range(rungs + 1)], p - h, p + h, sp
    levels, lower, upper, sp = band(p0)
    orders, inv, cash = {}, 0.0, capital
    fees = 0.0
    rungs_done = 0
    gross = 0.0          # sum of realized grid spreads
    breakout_pnl = 0.0   # P&L booked by forced closes
    breakouts = 0
    peak = capital
    maxdd = 0.0
    cool_until = -1
    k = i0
    while k < end:
        b = bars[k]
        if k < cool_until:
            k += 1
            continue
        pend = sorted(orders.items(), key=lambda kv: abs(levels[kv[0]] - b['o']))
        for i, side in pend:
            lvl = levels[i]
            if side == 'buy' and b['l'] <= lvl:
                orders.pop(i, None)
                cash -= lvl * size
                fees += lvl * size * fee
                inv += size
                # sell one rung up
                if i + 1 < len(levels):
                    orders[i + 1] = 'sell'
            elif side == 'sell' and b['h'] >= lvl and inv >= size - 1e-12:
                orders.pop(i, None)
                cash += lvl * size
                fees += lvl * size * fee
                inv -= size
                rungs_done += 1
                if i - 1 >= 0:
                    orders[i - 1] = 'buy'
        eq = cash + inv * b['c'] - fees
        peak = max(peak, eq)
        maxdd = max(maxdd, peak - eq)
        out = b['c'] < lower * (1 - breakout_pct) or b['c'] > upper * (1 + breakout_pct)
        if out or recenter and (b['c'] < lower or b['c'] > upper):
            if inv > 0:
                cash += inv * b['c']
                fees += inv * b['c'] * fee
                inv = 0.0
            if out:
                breakouts += 1
            p0 = b['c']
            levels, lower, upper, sp = band(p0)
            orders = {}
            for i, lvl in enumerate(levels):
                if lvl < p0 * 0.9995:
                    orders[i] = 'buy'
            cool_until = k + (cooldown if out else 0)
        k += 1
    lastc = bars[min(end, len(bars)) - 1]['c']
    eq_end = cash + inv * lastc - fees
    return dict(pnl=eq_end - capital, rungs=rungs_done, breakouts=breakouts,
                fees=fees, maxdd=maxdd, inv=inv)


CFG = {
    'A 6r 0.67% 0.004 (current)': dict(rungs=6, spacing_pct=0.0067, size=0.004),
    'B 12r 0.67% 0.003': dict(rungs=12, spacing_pct=0.0067, size=0.003),
    'C 20r 0.50% 0.002': dict(rungs=20, spacing_pct=0.005, size=0.002),
    'D 10r 0.40% 0.004': dict(rungs=10, spacing_pct=0.004, size=0.004),
    'E 6r 0.67% 0.004 recenter': dict(rungs=6, spacing_pct=0.0067, size=0.004, recenter=True),
    'F 20r 0.30% 0.004': dict(rungs=20, spacing_pct=0.003, size=0.004),
}

for days in (23, 60):
    W = days * 24
    print(f'\n=== {days}-day windows, long-only, auto-restart, fee 7.5bp/side ===')
    for name, cfg in CFG.items():
        res = [run(s, W, **cfg) for s in range(0, len(bars) - W, 24)]
        pnl = [r['pnl'] for r in res]
        if not pnl:
            continue
        print(f"{name:28s} med {st.median(pnl):+8.1f} mean {st.mean(pnl):+8.1f} "
              f"p10 {sorted(pnl)[len(pnl)//10]:+8.1f} p90 {sorted(pnl)[len(pnl)*9//10]:+8.1f} "
              f"win {sum(1 for x in pnl if x>0)/len(pnl)*100:4.0f}%  "
              f"rungs {st.median([r['rungs'] for r in res]):5.0f} bo {st.median([r['breakouts'] for r in res]):4.0f} "
              f"dd {st.median([r['maxdd'] for r in res]):6.1f}")

print('\n=== fee sensitivity, 60d, config A ===')
for fee in (0.00075, 0.00045, 0.00015, 0.0):
    res = [run(s, 60 * 24, **CFG['A 6r 0.67% 0.004 (current)'], fee=fee) for s in range(0, len(bars) - 60 * 24, 24)]
    pnl = sorted(r['pnl'] for r in res)
    print(f"fee {fee*1e4:4.1f}bp  med {st.median(pnl):+8.1f}  mean {st.mean(pnl):+8.1f}  rungs {st.median([r['rungs'] for r in res]):5.0f}  fees {st.median([r['fees'] for r in res]):7.1f}")