#!/usr/bin/env python3
"""HL 触发单能力探针（阶段0 交付物）。

验证 Hyperliquid 原生触发止损单的关键契约：
  1. 触发单受理（trigger + tpsl=sl + reduce-only + isMarket）
  2. 挂单可见性（frontendOpenOrders 能查到该触发单）
  3. 撤单（cancel）
  4. （可选）触发行为验证——需真实持仓，默认跳过

用法：
  # dry-run：仅构造+签名，不上送（任何环境可跑，无需资金）
  python3 scripts/probe/probe-hl-trigger.py --dry-run

  # testnet 实测（需先在 app.hyperliquid-testnet.xyz 领水入金）
  HL_ACCOUNT_ADDRESS=0x... HL_AGENT_PRIVATE_KEY=0x... \
    python3 scripts/probe/probe-hl-trigger.py --network testnet --with-entry

  # 主网实测（需用户确认；使用子账户 agent key，只交易不提现）
  HL_ACCOUNT_ADDRESS=0x... HL_AGENT_PRIVATE_KEY_FILE=/path/key \
    python3 scripts/probe/probe-hl-trigger.py --network mainnet --with-entry --coin BTC

环境变量（与项目 signer_worker 一致）：
  HL_ACCOUNT_ADDRESS / HL_AGENT_PRIVATE_KEY / HL_AGENT_PRIVATE_KEY_FILE
退出码：0=全部通过；2=依赖缺失；3=探针失败（详情见输出）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from eth_account import Account
    from hyperliquid.info import Info
    from hyperliquid.exchange import Exchange
except Exception as exc:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"依赖缺失（需 hyperliquid-python-sdk + eth-account）: {exc}"}, ensure_ascii=False))
    raise SystemExit(2)

URLS = {
    "testnet": "https://api.hyperliquid-testnet.xyz",
    "mainnet": "https://api.hyperliquid.xyz",
}


def _private_key() -> str:
    value = os.environ.get("HL_AGENT_PRIVATE_KEY", "").strip()
    filename = os.environ.get("HL_AGENT_PRIVATE_KEY_FILE", "").strip()
    if filename:
        value = Path(filename).expanduser().read_text(encoding="utf-8").strip()
    value = value.strip().strip('"').strip("'")
    if not value:
        raise RuntimeError("缺少 HL_AGENT_PRIVATE_KEY 或 HL_AGENT_PRIVATE_KEY_FILE")
    return value


def _order_type(trigger_px: float, tpsl: str) -> dict:
    return {"trigger": {"isMarket": True, "triggerPx": float(trigger_px), "tpsl": tpsl}}


def main() -> int:
    ap = argparse.ArgumentParser(description="HL 触发单能力探针")
    ap.add_argument("--network", choices=["testnet", "mainnet"], default="testnet")
    ap.add_argument("--coin", default="BTC")
    ap.add_argument("--size", type=float, default=0.001, help="探针下单数量（主网请用最小名义 ~$11+）")
    ap.add_argument("--entry-offset-pct", type=float, default=5.0, help="入场限价距现价百分比（挂远单不成交）")
    ap.add_argument("--stop-offset-pct", type=float, default=10.0, help="触发止损距现价百分比")
    ap.add_argument("--with-entry", action="store_true", help="先挂一张远价限价入场单（否则仅测触发单构造/受理）")
    ap.add_argument("--dry-run", action="store_true", help="只构造+签名，不上送（无需资金）")
    args = ap.parse_args()

    url = URLS[args.network]
    report: dict = {"probe": "hl-trigger", "network": args.network, "coin": args.coin, "steps": []}

    def step(name: str, ok: bool, detail=None):
        report["steps"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(f"[{'✓' if ok else '✗'}] {name}" + (f" -> {json.dumps(detail, ensure_ascii=False)[:300]}" if detail is not None else ""))

    if args.dry_run:
        import secrets
        acct = Account.from_key("0x" + secrets.token_hex(32))
        ex = Exchange(wallet=acct, base_url=url, account_address=acct.address)
        captured = {}
        ex._post_action = lambda action, signature, nonce: captured.update(action=action) or {"status": "dry-run-ok"}
        r = ex.order(args.coin, False, args.size, 90000.0, _order_type(90000.0, "sl"), reduce_only=True)
        step("dry-run: 触发单构造+签名", r.get("status") == "dry-run-ok", captured.get("action"))
        r2 = ex.order(args.coin, False, args.size, 100000.0, _order_type(100000.0, "tp"), reduce_only=True)
        step("dry-run: TP 触发单构造+签名", r2.get("status") == "dry-run-ok")
        report["ok"] = all(s["ok"] for s in report["steps"])
        print(json.dumps({"ok": report["ok"], "report": report}, ensure_ascii=False))
        return 0 if report["ok"] else 3

    # ── 实测路径 ──
    try:
        address = os.environ.get("HL_ACCOUNT_ADDRESS", "").strip()
        if not address:
            raise RuntimeError("缺少 HL_ACCOUNT_ADDRESS")
        wallet = Account.from_key(_private_key())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2

    info = Info(base_url=url, skip_ws=True)
    ex = Exchange(wallet=wallet, base_url=url, account_address=address)

    # 0) 账户存在性 + 现价
    try:
        st = info.user_state(address)
        acct_value = float(st.get("marginSummary", {}).get("accountValue", 0) or 0)
        step("账户存在且可读 clearinghouseState", True, {"accountValue": acct_value})
    except Exception as exc:
        step("账户存在且可读 clearinghouseState", False, str(exc)[:200])
        print(json.dumps({"ok": False, "report": report}, ensure_ascii=False))
        return 3
    mids = info.all_mids()
    px = float(mids.get(args.coin, 0))
    step("行情可得（allMids）", px > 0, {"coin": args.coin, "markPx": px})
    if px <= 0:
        print(json.dumps({"ok": False, "report": report}, ensure_ascii=False))
        return 3

    entry_oid = None
    # 1) 可选：远价限价入场单（不成交，仅用于使 reduce-only 触发单可被受理）
    if args.with_entry:
        entry_px = round(px * (1 - args.entry_offset_pct / 100), 1)
        try:
            r = ex.order(args.coin, True, args.size, entry_px, {"limit": {"tif": "Gtc"}})
            statuses = r.get("response", {}).get("data", {}).get("statuses", [{}])
            entry_oid = statuses[0].get("resting", {}).get("oid") if statuses else None
            step("远价限价入场单受理", r.get("status") == "ok" and entry_oid is not None, {"oid": entry_oid, "px": entry_px, "resp": r})
        except Exception as exc:
            step("远价限价入场单受理", False, str(exc)[:200])

    # 2) 触发止损单（reduce-only + isMarket）
    stop_px = round(px * (1 - args.stop_offset_pct / 100), 1)
    trigger_oid = None
    try:
        r = ex.order(args.coin, False, args.size, stop_px, _order_type(stop_px, "sl"), reduce_only=True)
        statuses = r.get("response", {}).get("data", {}).get("statuses", [{}])
        first = statuses[0] if statuses else {}
        trigger_oid = (first.get("resting") or {}).get("oid")
        step("触发止损单受理（reduce-only）", r.get("status") == "ok" and trigger_oid is not None, {"oid": trigger_oid, "triggerPx": stop_px, "resp": r})
    except Exception as exc:
        step("触发止损单受理（reduce-only）", False, str(exc)[:200])

    # 3) 挂单可见性（含触发字段）
    if trigger_oid is not None:
        try:
            rows = info.frontend_open_orders(address)
            found = [o for o in rows if str(o.get("oid")) == str(trigger_oid)]
            step("frontendOpenOrders 可查到触发单", bool(found), {"order": found[0] if found else None})
        except Exception as exc:
            step("frontendOpenOrders 可查到触发单", False, str(exc)[:200])

    # 4) 撤单
    if trigger_oid is not None:
        try:
            r = ex.cancel(args.coin, int(trigger_oid))
            step("触发单撤单", r.get("status") == "ok", r)
        except Exception as exc:
            step("触发单撤单", False, str(exc)[:200])
    if entry_oid is not None:
        try:
            r = ex.cancel(args.coin, int(entry_oid))
            step("入场单撤单", r.get("status") == "ok", r)
        except Exception as exc:
            step("入场单撤单", False, str(exc)[:200])

    report["ok"] = all(s["ok"] for s in report["steps"])
    print(json.dumps({"ok": report["ok"], "report": report}, ensure_ascii=False))
    return 0 if report["ok"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
