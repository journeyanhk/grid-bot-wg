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
    python3 scripts/va_probe.py cancel-one --run  # 撤单机制体检：新挂一张再撤，轮询确认
    python3 scripts/va_probe.py cancel-all --run  # 多轮撤单可靠性样本（1.1s 间隔，最多 5 轮）
    python3 scripts/va_probe.py reject-trigger --run  # 硬触发风控拒单（临时改杠杆=1）
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


def cancel_all_pending(max_rounds=5, record=None):
    """多轮撤单 + 每次记录响应码/体（cancelAll 单轮不可靠）。间隔 1.1s 避免读写抢节拍。"""
    rounds = []
    remaining = None
    for rnd in range(max_rounds):
        st, rows = list_pending()
        ids = [r.get("rfq_id") for r in rows if r.get("order_type") == "limit"]
        print(f"[round {rnd}] pending 限价单 {len(ids)} 张，逐张撤…")
        resp = []
        for rid in ids:
            s, _, body = cancel(rid)
            resp.append({"rfq_id": rid, "status": s, "body": body})
            time.sleep(1.1)
        rounds.append({"round": rnd, "before": len(ids), "responses": resp})
        time.sleep(1.5)
        _, rows2 = list_pending()
        remaining = [r.get("rfq_id") for r in rows2 if r.get("order_type") == "limit"]
        print(f"[round {rnd}] 撤后剩 {len(remaining)}")
        if not remaining:
            break
    st3, _, pos = call("GET", "/api/positions")
    print(f"仓位确认：{json.dumps(pos, ensure_ascii=False)[:300]}")
    if record is not None:
        record["cancel_rounds"] = rounds
        record["residual"] = remaining
        record["positions"] = pos
    return len(remaining or [])


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
            # rfq_id= 过滤器无效（探针已证），改用 status+instrument+limit 拉最近终态行
            s2, _, term = call("GET", f"/api/orders/v2?status=canceled&instrument={INSTRUMENT_KEY}&limit=3&order_by=created_at&order=desc")
            rec["terminal_status"] = s2
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


def cmd_cancel_one(_args):
    """撤单机制体检（review5 第2步）：挂 1 张 0.0001 BTC @ 现价−20% → 确认在 pending →
    撤 → 每秒轮询 10 次看它是否变 canceled / 从 pending 消失。落盘全过程含 cf-ray/cf-mitigated。
    新单能撤 => 机制正常，残留单是僵尸；新单也撤不掉 => 会话/账户级问题（看响应码）。"""
    out = {}
    mp = mark_price()
    px = f"{mp * 0.8:.2f}"
    if DRY:
        print(f"[dry] 挂 0.0001 @ {px} → 确认 pending → 撤 → 轮询 10 秒")
        dump("cancel-one", {"_dry": True, "px": px})
        return
    s, h, body = place_limit("buy", px, qty="0.0001")
    rfq = (body or {}).get("rfq_id") if isinstance(body, dict) else None
    out["place"] = {"status": s, "headers": {k: h.get(k) for k in ("cf-ray", "cf-mitigated", "retry-after")}, "body": body}
    if not rfq:
        print("下单未返回 rfq_id，无法继续。")
        dump("cancel-one", out)
        return
    time.sleep(2.0)
    _, seen = list_pending()
    out["in_pending_before_cancel"] = any(r.get("rfq_id") == rfq for r in seen)
    cs, ch, cbody = cancel(rfq)
    out["cancel"] = {"status": cs, "headers": {k: ch.get(k) for k in ("cf-ray", "cf-mitigated", "retry-after")}, "body": cbody}
    polls = []
    for i in range(10):
        time.sleep(1.0)
        ps, _, prows = call("GET", f"/api/orders/v2?status=canceled&instrument={INSTRUMENT_KEY}&limit=5&order_by=created_at&order=desc")
        row = None
        if isinstance(prows, dict):
            for r in prows.get("result", []):
                if r.get("rfq_id") == rfq:
                    row = r
                    break
        _, pend = list_pending()
        polls.append({"i": i, "status": ps, "canceled_row_status": (row or {}).get("status"),
                      "cancel_reason": (row or {}).get("cancel_reason"),
                      "still_in_pending": any(r.get("rfq_id") == rfq for r in pend)})
        if row and (row.get("status") or "").lower() == "canceled":
            break
    out["polls"] = polls
    out["result"] = "canceled" if any(p["canceled_row_status"] and p["canceled_row_status"].lower() == "canceled" for p in polls) else "still_open_or_unknown"
    print(f"cancel-one 结果：{out['result']}")
    dump("cancel-one", out)


def cmd_cancel_all(_args):
    """多轮 cancelAll 可靠性样本：逐张撤 pending、每次记响应、最多 5 轮，落盘残留。"""
    out = {}
    if DRY:
        st, rows = list_pending()
        print(f"[dry] 将对 {sum(1 for r in rows if r.get('order_type')=='limit')} 张 pending 限价单做多轮撤单")
        dump("cancel-all", {"_dry": True, "pending": len(rows)})
        return
    cancel_all_pending(max_rounds=5, record=out)
    dump("cancel-all", out)


def cmd_reject_trigger(_args):
    """风控拒单（硬触发）：把杠杆设为 1，挂一张远超保证金的对手价单，
    捕获 failed_risk_checks，最后恢复到运行前杠杆并撤单收尾。"""
    out = {"steps": []}
    if DRY:
        print("[dry] set_leverage=1 → 大额越界单 → 捕获 failed_risk_checks → 恢复杠杆")
        dump("reject-trigger", {"_dry": True})
        return
    # 记录运行前杠杆用于最后恢复。GET 路径是猜的：若非 200，就退回 VA_LEVERAGE 环境变量，
    # 都拿不到才用保守的 "3"——绝不写死覆盖用户实际杠杆。
    s0, _, lev0 = call("GET", "/api/settlement_pools")
    out["leverage_before"] = {"status": s0, "body": lev0}
    prev_lev = None
    if s0 == 200 and isinstance(lev0, dict):
        prev_lev = lev0.get("leverage") or lev0.get("current")
        u = INSTRUMENT["underlying"]
        if isinstance(lev0.get(u), dict):
            prev_lev = lev0[u].get("leverage") or prev_lev
    restore_lev = str(prev_lev or os.environ.get("VA_LEVERAGE") or "3")
    out["restore_leverage_to"] = restore_lev
    sL, _, bL = call("POST", "/api/settlement_pools/set_leverage", {"leverage": "1", "asset": INSTRUMENT["underlying"]})
    out["steps"].append({"set_leverage_1": {"status": sL, "body": bL}})
    mp = mark_price()
    # 对手价 + 恰好越界的数量（0.01 BTC ≈ $780 名义 > 1x 保证金门槛，足以触发风控，
    # 又不至于夸张到打到别的风控分支，样本更贴近网格实际会遇到的那种）。
    px = f"{mp * 1.05:.2f}"
    s, h, body = place_limit("buy", px, qty="0.01")
    rfq = (body or {}).get("rfq_id") if isinstance(body, dict) else None
    out["place"] = {"status": s, "px": px, "qty": "0.01", "body": body}
    if rfq:
        time.sleep(2.0)
        s2, _, term = call("GET", f"/api/orders/v2?status=canceled&instrument={INSTRUMENT_KEY}&limit=3&order_by=created_at&order=desc")
        out["terminal"] = {"status": s2, "rows": term}
        cancel(rfq)
    # 恢复到运行前的杠杆（见上；非写死）
    sR, _, bR = call("POST", "/api/settlement_pools/set_leverage", {"leverage": restore_lev, "asset": INSTRUMENT["underlying"]})
    out["steps"].append({"restore_leverage": {"to": restore_lev, "status": sR, "body": bR}})
    cancel_all_pending(max_rounds=3, record=out)
    dump("reject-trigger", out)


COMMANDS = {
    "caps": cmd_caps, "tick": cmd_tick, "ladder": cmd_ladder, "reject": cmd_reject,
    "reject-trigger": cmd_reject_trigger, "cancel-all": cmd_cancel_all, "cancel-one": cmd_cancel_one,
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
