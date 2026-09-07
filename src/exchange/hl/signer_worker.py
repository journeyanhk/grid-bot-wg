"""Minimal Hyperliquid (HL) signing worker for the grid bot.

Accepts JSON-lines on stdin, writes JSON-lines on stdout.  Deliberately exposes
only the trading operations required by the grid bot: place order, cancel,
bulk-cancel, update leverage (isolated).  There is no withdrawal, transfer,
API-key mutation or bridge command.

The signer holds only an AGENT wallet private key (authorised on the official
site as "can trade, cannot withdraw").  Private key material is read once from
the environment or a local file and is never included in a response or log
line.  The "io" dex namespace is applied to every order so HIP-3 assets such as
io:ANTH are addressed correctly.

API 契约已按 2026-09-07 对主网的真实探测校准（SDK 0.24.0）：
- Info(perp_dexs=["io"]) 解析 io 市场（asset id 偏移 200000），coin 名直传 "io:ANTH"
- Exchange.order(name, is_buy, sz, limit_px, order_type, reduce_only, cloid)
- Exchange.cancel(name, oid:int)；无 cancel_all —— 全撤由 bulk_cancel 实现
- update_leverage(lev, name, is_cross=False) 即逐仓
"""

from __future__ import annotations

import json
import os
import sys
import asyncio
from pathlib import Path

try:
    from eth_account import Account
    from hyperliquid.info import Info
    from hyperliquid.exchange import Exchange
    from hyperliquid.utils.signing import Cloid, Tif
except Exception as exc:  # pragma: no cover - exercised by the JS bridge
    print(json.dumps({"ready": False, "error": f"无法加载 hyperliquid-python-sdk: {exc}"}), flush=True)
    raise SystemExit(2)


HL_MAINNET_URL = "https://api.hyperliquid.xyz"
HL_DEX = "io"


def _private_key() -> str:
    value = os.environ.get("HL_AGENT_PRIVATE_KEY", "").strip()
    filename = os.environ.get("HL_AGENT_PRIVATE_KEY_FILE", "").strip()
    if filename:
        try:
            value = Path(filename).expanduser().read_text(encoding="utf-8").strip()
        except Exception as exc:
            raise RuntimeError(f"无法读取 HL_AGENT_PRIVATE_KEY_FILE: {exc}") from None
    value = value.strip().strip('"').strip("'")
    if not value:
        raise RuntimeError("缺少 HL_AGENT_PRIVATE_KEY 或 HL_AGENT_PRIVATE_KEY_FILE")
    return value


def _make_client():
    url = os.environ.get("HL_API_URL", HL_MAINNET_URL).rstrip("/")
    if url != HL_MAINNET_URL:
        raise RuntimeError("实盘签名器只允许 HL 主网 https://api.hyperliquid.xyz")
    address = os.environ.get("HL_ACCOUNT_ADDRESS", "").strip()
    if not address:
        raise RuntimeError("缺少 HL_ACCOUNT_ADDRESS（agent 钱包地址）")
    wallet = Account.from_key(_private_key())
    info = Info(base_url=url, skip_ws=True, perp_dexs=[HL_DEX])
    exchange = Exchange(wallet=wallet, base_url=url, account_address=address, perp_dexs=[HL_DEX])
    return info, exchange, address


def _handle(exchange, address: str, req: dict):
    command = req.get("command")
    if command == "health":
        return {"ok": True, "profile": "hyperliquid", "dex": HL_DEX, "accountAddress": address}
    if command == "place_order":
        order = req["order"]
        limit_type = {"limit": {"tif": Tif.Gtc}}
        if order.get("immediate"):
            limit_type = {"limit": {"tif": Tif.Ioc}}
        cloid = None
        if order.get("clientOrderId"):
            cloid = Cloid.from_str(str(order["clientOrderId"]))
        result = exchange.order(
            str(order["coin"]),
            bool(order["isBuy"]),
            float(order["sizeBase"]),
            float(order["price"]),
            limit_type,
            reduce_only=bool(order.get("reduceOnly", False)),
            cloid=cloid,
        )
        return {"order": result}
    if command == "cancel":
        result = exchange.cancel(str(req["coin"]), int(req["oid"]))
        return {"status": result}
    if command == "bulk_cancel":
        result = exchange.bulk_cancel(str(req["coin"]), [int(x) for x in req.get("oids", [])])
        return {"status": result}
    if command == "update_leverage":
        leverage = max(1, int(req["leverage"]))
        # is_cross=False => 逐仓（HL io 系市场强制逐仓；对齐实测契约）
        result = exchange.update_leverage(leverage, str(req["coin"]), is_cross=False)
        return {"status": result}
    raise RuntimeError("不支持的签名命令")


def main():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        async def build_client():
            return _make_client()
        info, exchange, address = loop.run_until_complete(build_client())
    except Exception as exc:
        print(json.dumps({"ready": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        return 2
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        request_id = None
        try:
            req = json.loads(line)
            request_id = req.get("id")
            result = _handle(exchange, address, req)
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as exc:
            response = {"id": request_id, "ok": False, "error": str(exc)}
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())