"""How hard is the 5k Classic 1-Step challenge, really?

Baseline: a passive leveraged long entered at a random hour, held until either
equity +10% (pass) or equity -6% (static floor breach) or -3% intraday (daily
loss) or 60 days elapse. Uses hourly H/L for path order, 7.5bp/side fees.

This is not a strategy — it is the null hypothesis. Any real system has to beat
it, so it tells us which leverage band the rules actually reward.
"""
import json, os, statistics as st

DATA = os.environ.get('BTC_1H',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'btc_1h.json'))

bars = [{'t': b['t'], 'o': float(b['o']), 'h': float(b['h']), 'l': float(b['l']), 'c': float(b['c'])}
        for b in sorted(json.load(open(DATA)), key=lambda x: x['t'])]
CAP, TARGET, FLOOR, DAILY = 5000.0, 5500.0, 4700.0, 0.03


def run(i0, lev, fee=0.00075, max_bars=60 * 24):
    p0 = bars[i0]['c']
    q = CAP * lev / p0
    entry_fee = q * p0 * fee
    eq0 = CAP - entry_fee
    day_anchor = eq0
    day_i = i0
    end = min(i0 + max_bars, len(bars))
    for k in range(i0, end):
        b = bars[k]
        if (k - i0) % 24 == 0 and k > i0:
            day_anchor = bars[k - 1]['c'] and (CAP - entry_fee + q * (bars[k - 1]['c'] - p0))
            day_i = k
        # favourable first? conservative: check adverse first within a bar
        eq_low = eq0 + q * (b['l'] - p0) - q * b['c'] * fee
        eq_high = eq0 + q * (b['h'] - p0) - q * b['c'] * fee
        if eq_low <= FLOOR:
            return 'floor', k - i0
        if day_anchor - eq_low >= day_anchor * DAILY:
            return 'daily', k - i0
        if eq_high >= TARGET:
            return 'pass', k - i0
    return 'timeout', end - i0


print(f"{'lev':>4} {'pass%':>6} {'floor%':>7} {'daily%':>7} {'timeout%':>8} {'medDays':>8}")
for lev in (1, 1.5, 2, 2.5, 3, 4, 5):
    res = [run(i, lev) for i in range(0, len(bars) - 60 * 24, 6)]
    n = len(res)
    c = {k: sum(1 for r in res if r[0] == k) for k in ('pass', 'floor', 'daily', 'timeout')}
    days = [r[1] / 24 for r in res if r[0] == 'pass']
    print(f"{lev:>4} {c['pass']/n*100:6.1f} {c['floor']/n*100:7.1f} {c['daily']/n*100:7.1f} "
          f"{c['timeout']/n*100:8.1f} {st.median(days) if days else 0:8.1f}")

# context: BTC 30d return distribution
r = [(bars[i + 720]['c'] / bars[i]['c'] - 1) * 100 for i in range(0, len(bars) - 720, 24)]
print('\nBTC 30d return: median %.1f%%  p10 %.1f%%  p90 %.1f%%  |move|>5%%: %.0f%% of windows'
      % (st.median(r), sorted(r)[len(r) // 10], sorted(r)[len(r) * 9 // 10],
         sum(1 for x in r if abs(x) > 5) / len(r) * 100))