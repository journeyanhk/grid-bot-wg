"""Fetch BTC 1h candles from Hyperliquid public API (no key needed).

Writes btc_1h.json next to this file (or $BTC_1H). 180 days by default.
Hyperliquid returns at most 5000 candles per request, so 1h/180d fits.

    python3 docs/propr/fetch_btc_1h.py            # 180 days
    python3 docs/propr/fetch_btc_1h.py 90         # 90 days
"""
import json, os, sys, time, urllib.request

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 180
OUT = os.environ.get('BTC_1H', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'btc_1h.json'))
now = int(time.time() * 1000)
req = urllib.request.Request(
    'https://api.hyperliquid.xyz/info',
    data=json.dumps({'type': 'candleSnapshot',
                     'req': {'coin': 'BTC', 'interval': '1h',
                             'startTime': now - DAYS * 86_400_000, 'endTime': now}}).encode(),
    headers={'Content-Type': 'application/json'},
)
with urllib.request.urlopen(req, timeout=30) as r:
    rows = json.load(r)
json.dump(rows, open(OUT, 'w'))
print(f'{len(rows)} candles -> {OUT}')