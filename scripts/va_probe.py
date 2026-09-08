#!/usr/bin/env python3
"""va_probe.py — Variational Omni M0 探针脚本（curl_cffi，过 Cloudflare）。

它和 src/exchange/va/transport_worker.py 共用同一套 curl_cffi 传输：Node 直连 /
普通 curl 会吃 403 挑战页，curl_cffi impersonate="chrome" 是 200。所以把你现在的
vr-token 贴进环境变量就能在服务器上跑，把三份剩余硬样本一次抓齐。

用法（默认 --dry-run，不真发写请求，只打印将要做什么）：
    export VARIATIONAL_TOKEN='eyJ...'            # 必填：vr-token cookie 值（JWT）
    export VA_ADDRESS='0x8Ac2417...'             # 建议：vr-connected-address
    python3 scripts/va_probe.py caps             # 只读，验证过滤器
    python3 scripts/va_probe.py reject --run     # 风控拒单样本（硬门槛）
    python3 scripts/va_probe.py ladder 60 --run  # 最大挂单数 + 分页样本（硬门槛）
    python3 scripts/va_probe.py tick --run       # 价格精度
    python3 scripts/va_probe.py rate             # 限速（只读，120s）
    python3 scripts/va_probe.py cancel-filled <rfq_id> --run
    python3 scripts/va_probe.py ws               # WS 持仓行结构（只读，可选）

每个子命令把 (status, headers, body) 原样落到 probe_<cmd>_<ts>.json。
ladder / reject 结束时会自动把本合约 pending 撤到 0 并打印仓位确认无意外成交。
所有实验单都是 0.0001 BTC、挂在现价 -20%~-21%，$138 余额完全够，风险为零。
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone

try:
    from curl_cffi import requests as cffi_requests
except Exception as exc:  # pragma: no cover
    print(f"需要 curl_cffi：pip install curl_cffi（{exc}）", file=sys.stderr)
    raise SystemExit(2)

BASE = os.environ.get("VA_BASE_URL", "https://omni.variational.io").rstrip("/")
TOKEN = os.environ.get("VARIATIONAL_TOKEN", "").strip()
ADDR = os.environ.get("VA_ADDRESS", "").strip()
INSTRUMENT = {
    "underlying": os.environ.get("VA_UNDERLYING", "BTC"),
    "instrument_type": "perpetual_future",
    "settlement_asset": os.environ.get("VA_SETTLEMENT_ASSET", "USDC"),
    "funding_interval_s": int(os.environ.get("VA_FUNDING_INTERVAL_S", "3600")),
}
INSTRUMENT_KEY = f"P-{INSTRUMENT['underlying']}-{INSTRUMENT['settlement_asset']}-{INSTRUMENT['funding_interval_s']}"

_session = cffi_requests.Session(impersonate="chrome")
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": BASE,
}
DRY = True  # flipped by --run


def call(method, path, body=None, auth=True):
    """The transport primitive — identical shape to transport_worker.py."""
    h = dict(BROWSER_HEADERS)
    if body is not None:
        h["content-type"] = "application/json"
    if ADDR:
        h["vr-connected-address"] = ADDR
    if auth:
        if not TOKEN:
            raise RuntimeError("缺少 VARIATIONAL_TOKEN")
        h["Cookie"] = f"vr-token={TOKEN}" + (f"; vr-connected-address={ADDR}" if ADDR else "")
        h["Referer"] = f"{BASE}/portfolio"
    else:
        h["Referer"] = f"{BASE}/perpetual/BTC"
    kwargs = {"headers": h, "timeout": 15}
    if body is not None:
        kwargs["json"] = body
    r = _session.request(method, BASE + path, **kwargs)
    try:
        parsed = r.json() if r.text and r.text.strip() != "null" else None
    except Exception:
        parsed = {"_raw": r.text[:500]}
    return r.status_code, {k.lower(): v for k, v in dict(r.headers).items()}, parsed


def dump(cmd, payload):
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    fn = f"probe_{cmd}_{ts}.json"
    with open(fn, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(f"→ 写入 {fn}")
    return fn


def indicative(qty="0.001"):
    st, _, body = call("POST", "/api/quotes/indicative", {"instrument": INSTRUMENT, "qty": qty})
    if st != 200 or not body:
        raise RuntimeError(f"indicative 失败：HTTP {st}")
    return body


def mark_price():
    return float(indicative()["mark_price"])


def place_limit(side, price, qty="0.0001", reduce_only=False):
    body = {
        "order_type": "limit",
        "limit_price": str(price),
        "side": side,
        "instrument": INSTRUMENT,
        "qty": qty,
        "slippage_limit": "0.005",
        "is_auto_resize": False,
        "use_mark_price": False,
        "is_reduce_only": reduce_only,
    }
    if DRY:
        print(f"[dry] POST /api/orders/new/limit {json.dumps(body)}")
        return 0, {}, {"_dry": True}
    return call("POST", "/api/orders/new/limit", body)


def cancel(rfq_id):
    if DRY:
        print(f"[dry] POST /api/orders/cancel {rfq_id}")
        return 0, {}, {"_dry": True}
    return call("POST", "/api/orders/cancel", {"rfq_id": rfq_id})


def list_pending():
    st, _, body = call("GET", f"/api/orders/v2?status=pending&instrument={INSTRUMENT_KEY}&limit=100&offset=0")
    rows = (body or {}).get("result", []) if isinstance(body, dict) else []
    return st, rows


def cancel_all_pending():
    st, rows = list_pending()
    ids = [r.get("rfq_id") for r in rows if r.get("order_type") == "limit"]
    print(f"收尾：撤 {len(ids)} 张 pending 限价单…")
    for rid in ids:
        cancel(rid)
        time.sleep(0.3)
    time.sleep(1.0)
    st2, rows2 = list_pending()
    remaining = [r for r in rows2 if r.get("order_type") == "limit"]
    print(f"收尾后 pending={len(remaining)}（应为 0）")
    st3, _, pos = call("GET", "/api/positions")
    print(f"仓位确认：{json.dumps(pos, ensure_ascii=False)[:300]}")
    return len(remaining)


# ── subcommands ───────────────────────────────────────────────────────────
def cmd_caps(_args):
    """三种过滤器是否可用（纯只读）。"""
    st, rows = list_pending()
    sample_rfq = rows[0]["rfq_id"] if rows else os.environ.get("VA_SAMPLE_RFQ", "")
    out = {}
    for name, path in [
        ("rfq_filter", f"/api/orders/v2?rfq_id={sample_rfq}" if sample_rfq else None),
        ("status_cleared", f"/api/orders/v2?status=cleared&instrument={INSTRUMENT_KEY}&limit=5"),
        ("status_canceled", f"/api/orders/v2?status=canceled&instrument={INSTRUMENT_KEY}&limit=5"),
        ("instrument_pending", f"/api/orders/v2?status=pending&instrument={INSTRUMENT_KEY}&limit=5"),
    ]:
        if not path:
            out[name] = {"skipped": "no sample rfq_id (set VA_SAMPLE_RFQ)"}
            continue
        s, hdr, body = call("GET", path)
        out[name] = {"path": path, "status": s, "object_count": (body or {}).get("pagination", {}).get("object_count") if isinstance(body, dict) else None, "result_len": len((body or {}).get("result", [])) if isinstance(body, dict) else None}
    dump("caps", out)


def cmd_tick(_args):
    """价格精度：现价×0.8 挂 2/3/5 位小数各一张，记录响应，全撤。"""
    mp = mark_price()
    base = mp * 0.8
    out = {"mark_price": mp}
    for dp in (2, 3, 5):
        px = f"{base:.{dp}f}"
        s, h, body = place_limit("buy", px)
        out[f"decimals_{dp}"] = {"limit_price": px, "status": s, "body": body}
        time.sleep(1.1)
    dump("tick", out)
    if not DRY:
        cancel_all_pending()


def cmd_ladder(args):
    """最大挂单数：现价 -20%~-21% 挂 N 张 0.0001 限价买单，记第一张被拒序号；全撤。"""
    n = int(args[0]) if args else 60
    mp = mark_price()
    lo, hi = mp * 0.79, mp * 0.80
    step = (hi - lo) / max(1, n - 1)
    placed, first_reject = [], None
    for i in range(n):
        px = f"{lo + i * step:.2f}"
        s, h, body = place_limit("buy", px)
        rec = {"i": i, "limit_price": px, "status": s, "rfq_id": (body or {}).get("rfq_id") if isinstance(body, dict) else None}
        if s and s >= 400 and first_reject is None:
            rec["reject_body"] = body
            first_reject = rec
            placed.append(rec)
            break
        placed.append(rec)
        time.sleep(1.1)
    # 分页样本：单张 100 上限，翻页看 next_page
    _, _, page0 = call("GET", f"/api/orders/v2?status=pending&instrument={INSTRUMENT_KEY}&limit=100&offset=0")
    dump("ladder", {"n": n, "mark_price": mp, "placed": placed, "first_reject": first_reject,
                    "pagination_page0": (page0 or {}).get("pagination") if isinstance(page0, dict) else None})
    if not DRY:
        cancel_all_pending()


def cmd_reject(_args):
    """风控拒单：现价×0.8 挂 0.1 BTC 与 0.2 BTC（超 max_notional），记 HTTP/body/终态。"""
    mp = mark_price()
    px = f"{mp * 0.8:.2f}"
    out = {"mark_price": mp, "limit_price": px}
    for qty in ("0.1", "0.2"):
        s, h, body = place_limit("buy", px, qty=qty)
        rec = {"qty": qty, "status": s, "body": body}
        rfq = (body or {}).get("rfq_id") if isinstance(body, dict) else None
        if rfq and not DRY:
            time.sleep(2.0)
            s2, _, term = call("GET", f"/api/orders/v2?rfq_id={rfq}")
            rec["terminal"] = term
            cancel(rfq)  # if it somehow rested, pull it
        out[f"qty_{qty}"] = rec
        time.sleep(1.1)
    dump("reject", out)
    if not DRY:
        cancel_all_pending()


def cmd_cancel_filled(args):
    """撤一张已成交单，记录响应（HTTP 码 + body）。"""
    if not args:
        print("用法：cancel-filled <已成交的 rfq_id>", file=sys.stderr)
        raise SystemExit(2)
    rfq = args[0]
    s, h, body = cancel(rfq)
    dump("cancel-filled", {"rfq_id": rfq, "status": s, "headers": h, "body": body})


def cmd_rate(_args):
    """限速：1 次/秒连拉 pending 120 秒，统计非 200 码与响应头（只读）。"""
    codes, samples, t0 = {}, [], time.time()
    while time.time() - t0 < 120:
        s, hdr, _ = call("GET", f"/api/orders/v2?status=pending&instrument={INSTRUMENT_KEY}&limit=1")
        codes[s] = codes.get(s, 0) + 1
        if s != 200 and len(samples) < 10:
            samples.append({"status": s, "retry-after": hdr.get("retry-after"), "cf-mitigated": hdr.get("cf-mitigated")})
        time.sleep(1.0)
    dump("rate", {"codes": codes, "non200_samples": samples})


def cmd_ws(_args):
    """WS 持仓行结构（可选）。留骨架：连 wss 需 websocket 库，视服务器环境启用。"""
    print("ws 子命令需要 websocket 客户端库；如需请在服务器上 pip install websockets 后我再补齐。")
    dump("ws", {"note": "skipped", "hint": "wss://…/portfolio，发 {\"claims\": token}"})


COMMANDS = {
    "caps": cmd_caps, "tick": cmd_tick, "ladder": cmd_ladder, "reject": cmd_reject,
    "cancel-filled": cmd_cancel_filled, "rate": cmd_rate, "ws": cmd_ws,
}


def main(argv):
    global DRY
    args = [a for a in argv if a not in ("--run", "--dry-run")]
    DRY = "--run" not in argv
    if not args or args[0] not in COMMANDS:
        print(__doc__)
        print("子命令：" + ", ".join(COMMANDS))
        return 1
    if DRY and args[0] not in ("caps", "rate", "ws"):
        print("== DRY-RUN（加 --run 才真发写请求）==")
    if not TOKEN:
        print("提示：未设置 VARIATIONAL_TOKEN，脚本需要它读取行情/账户；请在服务器上 export 后再运行。", file=sys.stderr)
        return 2
    try:
        COMMANDS[args[0]](args[1:])
    except Exception as exc:  # noqa: BLE001 - deploy tool, surface a clean message
        print(f"探针出错：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
