"""Minimal Hyperliquid (HL) signing worker for the grid bot.

Accepts JSON-lines on stdin, writes JSON-lines on stdout.  Deliberately exposes
only the trading operations required by the grid bot: place order, cancel,
cancel-all, update leverage (isolated).  There is no withdrawal, transfer,
API-key mutation or bridge command.

The signer holds only an AGENT wallet private key (authorised on the official
site as "can trade, cannot withdraw").  Private key material is read once from
the environment or a local file and is never included in a response or log
line.  The "io" dex namespace is applied to every order so HIP-3 assets such as
io:ANTH are addressed correctly.
"""

from __future__ import annotations

import json
import os
import sys
import asyncio
from pathlib import Path

try:
    from hyperliquid.info import Info
    from hyperliquid.exchange import Exchange
    from hyperliquid.utils.signing import OrderRequest, OrderType, OrderSide, OrderTimeInForce
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
    private_key = _private_key()
    info = Info(base_url=url, skip_ws=True, meta=None)
    exchange = Exchange(wallet=private_key, base_url=url, account_address=address)
    return info, exchange, address


def _order_request(row: dict) -> OrderRequest:
    return OrderRequest(
        name=str(row["coin"]),           # 例如 "io:ANTH"
        is_buy=str(row["side"]).lower() == "buy",
        sz=float(row["sizeBase"]),
        limit_px=float(row["price"]),
        order_type=OrderType.Limit,
        reduce_only=bool(row.get("reduceOnly", False)),
        time_in_force=OrderTimeInForce.Gtc,
        cloid=str(row.get("clientOrderId", "")) or None,
    )


def _handle(exchange, address: str, req: dict):
    command = req.get("command")
    if command == "health":
        return {"ok": True, "profile": "hyperliquid", "dex": HL_DEX, "accountAddress": address}
    if command == "place_order":
        order = _order_request(req["order"])
        result = exchange.order(order, build_request=True)
        return {"order": result}
    if command == "cancel":
        result = exchange.cancel(str(req["coin"]), float(req["oid"]))
        return {"status": result}
    if command == "cancel_all":
        result = exchange.cancel_all(str(req["coin"]))
        return {"status": result}
    if command == "update_leverage":
        leverage = max(1, int(req["leverage"]))
        result = exchange.update_leverage(leverage, str(req["coin"]), is_isolated=True)
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