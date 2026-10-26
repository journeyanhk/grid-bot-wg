"""风险/速度前沿：同一策略、不同 risk 与止损宽度，看"通过率 vs 日损触发"。

用法：python3 research/trend/frontier.py [--risk 0.01,0.015] [--atr 1.5,2.5]
输出：results.json + 控制台表
"""
import json, os, statistics as st, sys
import challenge_bt as C

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOW_DAYS = 60


def main():
    bars = C.load()
    b4 = C.resample(bars, 4)
    W = WINDOW_DAYS * 24
    windows = list(range(0, len(bars) - W, 24))
    risks = [0.005, 0.0075, 0.01, 0.015, 0.02]
    atrs = [1.5, 2.0, 2.5]
    lev = 0.5
    rows = []
    for rs in risks:
        for am in atrs:
            out = []
            for s in windows:
                sub = bars[s:]
                sig, stops = C.ema_signals(b4, sub, 20, 60, am)
                out.append(C.run(sub, sig, stop_at=stops, risk_pct=rs, atr_mult=am, max_leverage=lev))
            n = len(out)
            passed = [x for x in out if x.passed]
            breached = [x for x in out if x.breached]
            days = [(x.pass_at - bars[s]['t']) / 86_400_000 for x, s in zip(out, windows) if x.passed]
            rows.append({
                'risk_pct': rs, 'atr_mult': am, 'max_leverage': lev, 'windows': n,
                'pass_pct': round(len(passed) / n * 100, 1),
                'breach_pct': round(len(breached) / n * 100, 1),
                'med_days': round(st.median(days), 1) if days else None,
                'med_maxdd': round(st.median([x.maxdd for x in out]), 1),
                'med_trades': st.median([x.trades for x in out]),
                'daily_breach': sum(1 for x in breached if x.breached == 'daily'),
                'floor_breach': sum(1 for x in breached if x.breached == 'floor'),
            })
    print(f"EMA 20/60 4h, 名义≤{lev}x, {WINDOW_DAYS}d 窗口 × {len(windows)}")
    print(f"{'risk':>5} {'atr':>5} {'pass%':>6} {'breach%':>8} {'medD':>5} {'maxDD':>7} {'trades':>7}")
    for r in rows:
        print(f"{r['risk_pct']*100:5.2f} {r['atr_mult']:5.1f} {r['pass_pct']:6.1f} {r['breach_pct']:8.1f} "
              f"{str(r['med_days']):>5} {r['med_maxdd']:7.1f} {r['med_trades']:7.0f}")
    json.dump(rows, open(os.path.join(HERE, 'results.json'), 'w'), indent=1)
    print(f"\n→ {os.path.join(HERE, 'results.json')}")


if __name__ == '__main__':
    main()