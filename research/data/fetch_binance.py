"""拉 BTCUSDT 永续 1h 历史（Binance Vision 月包），合并成一份 JSON。

    python3 research/data/fetch_binance.py --from 2022-01 --to 2026-09

输出 research/data/btc_1h_binance.json（已 gitignore）：
    [{"t": <ms>, "o","h","l","c","v"}...]  升序、去重、无缺口报警
"""
import argparse, csv, io, json, os, sys, urllib.request, zipfile

BASE = 'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'btc_1h_binance.json')


def months(a, b):
    y, m = map(int, a.split('-'))
    y2, m2 = map(int, b.split('-'))
    while (y, m) <= (y2, m2):
        yield f'{y:04d}-{m:02d}'
        m += 1
        if m == 13:
            y, m = y + 1, 1


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'grid-bot-wg/research'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def parse_zip(blob):
    rows = []
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = z.namelist()[0]
        with z.open(name) as f:
            text = io.TextIOWrapper(f, encoding='utf-8')
            for r in csv.reader(text):
                if not r or not r[0].strip().isdigit():
                    continue  # 表头
                rows.append((int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='a', default='2022-01')
    ap.add_argument('--to', dest='b', default='2026-09')
    args = ap.parse_args()

    allrows, missing = [], []
    for ym in months(args.a, args.b):
        url = f'{BASE}/BTCUSDT-1h-{ym}.zip'
        try:
            rows = parse_zip(fetch(url))
            allrows += rows
            print(f'{ym}  {len(rows):5d} 行', flush=True)
        except Exception as e:
            missing.append(ym)
            print(f'{ym}  失败: {e}', flush=True)

    allrows.sort()
    seen, uniq = set(), []
    for r in allrows:
        if r[0] in seen:
            continue
        seen.add(r[0])
        uniq.append({'t': r[0], 'o': r[1], 'h': r[2], 'l': r[3], 'c': r[4], 'v': r[5]})

    gaps = []
    for a, b in zip(uniq, uniq[1:]):
        if b['t'] - a['t'] != 3_600_000:
            gaps.append((a['t'], b['t']))

    json.dump(uniq, open(OUT, 'w'))
    print(f'\n合计 {len(uniq)} 根  {uniq[0]["t"]} → {uniq[-1]["t"]}')
    print(f'缺口 {len(gaps)} 处  缺失月份 {len(missing)} 个 {missing[:6]}')
    print(f'→ {OUT}  ({os.path.getsize(OUT)/1e6:.1f} MB)')
    if missing or gaps:
        print('注意：缺口会影响回测连续性，需确认是否节假日/停服。')


if __name__ == '__main__':
    main()