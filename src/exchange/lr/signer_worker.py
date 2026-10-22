"""Minimal RHC Lighter signing worker.

The process accepts JSON-lines on stdin and writes JSON-lines on stdout.  It
deliberately exposes only trading operations required by the grid bot.  There
is no withdrawal, transfer, API-key mutation, sub-account or bridge command.

Private key material is read once from the environment or a local file and is
never included in a response or log line.
"""

from __future__ import annotations

import json
import os
import sys
import asyncio
from pathlib import Path

try:
    import lighter
except Exception as exc:  # pragma: no cover - exercised by the JS bridge
    print(json.dumps({"ready": False, "error": f"无法加载 lighter-sdk: {exc}"}), flush=True)
    raise SystemExit(2)


RHC_MAINNET_URL = "https://api.rh.lighter.xyz"
RHC_MAINNET_CHAIN_ID = 466324
RHC_MAX_CLIENT_ORDER_INDEX = (1 << 48) - 1


def _private_key() -> str:
    value = os.environ.get("LIGHTER_API_PRIVATE_KEY", "").strip()
    filename = os.environ.get("LIGHTER_API_PRIVATE_KEY_FILE", "").strip()
    if filename:
        try:
            value = Path(filename).expanduser().read_text(encoding="utf-8").strip()
        except Exception as exc:
            raise RuntimeError(f"无法读取 LIGHTER_API_PRIVATE_KEY_FILE: {exc}") from None
    value = value.strip().strip('"').strip("'")
    if not value:
        raise RuntimeError("缺少 LIGHTER_API_PRIVATE_KEY 或 LIGHTER_API_PRIVATE_KEY_FILE")
    return value


def _signed_tuple(result):
    tx_type, tx_info, tx_hash, error = result
    if error:
        raise RuntimeError(str(error))
    return {"txType": int(tx_type), "txInfo": tx_info, "txHash": tx_hash}


def _make_client():
    url = os.environ.get("LIGHTER_API_URL", RHC_MAINNET_URL).rstrip("/")
    chain_id = int(os.environ.get("LIGHTER_CHAIN_ID", str(RHC_MAINNET_CHAIN_ID)))
    account_index = int(os.environ["LIGHTER_ACCOUNT_INDEX"])
    api_key_index = int(os.environ["LIGHTER_API_KEY_INDEX"])
    if url != RHC_MAINNET_URL or chain_id != RHC_MAINNET_CHAIN_ID:
        raise RuntimeError("实盘签名器只允许 RHC 主网 https://api.rh.lighter.xyz（chainId=466324）")
    if account_index < 0:
        raise RuntimeError("LIGHTER_ACCOUNT_INDEX 必须是非负整数")
    if api_key_index < 4 or api_key_index > 254:
        raise RuntimeError("LIGHTER_API_KEY_INDEX 必须在 4-254；0-3 为平台保留索引")
    client = lighter.SignerClient(
        url=url,
        account_index=account_index,
        api_private_keys={api_key_index: _private_key()},
        chain_id=chain_id,
    )
    return client, account_index, api_key_index


def _handle(client, account_index: int, api_key_index: int, req: dict):
    command = req.get("command")
    if command == "health":
        return {
            "ok": True,
            "profile": "robinhood",
            "chainId": RHC_MAINNET_CHAIN_ID,
            "accountIndex": account_index,
            "apiKeyIndex": api_key_index,
        }
    if command == "auth":
        seconds = max(60, min(8 * 60 * 60, int(req.get("seconds", 600))))
        token, error = client.create_auth_token_with_expiry(seconds, api_key_index=api_key_index)
        if error:
            raise RuntimeError(str(error))
        return {"token": token, "expiresIn": seconds}
    if command == "sign_orders":
        rows = req.get("orders")
        if not isinstance(rows, list) or not rows or len(rows) > 15:
            raise RuntimeError("每个 RHC 签名批次必须包含 1-15 笔订单")
        out = []
        for row in rows:
            client_order_index = int(row["clientOrderIndex"])
            if client_order_index < 0 or client_order_index > RHC_MAX_CLIENT_ORDER_INDEX:
                raise RuntimeError(
                    f"RHC ClientOrderIndex 必须在 0-{RHC_MAX_CLIENT_ORDER_INDEX} 范围内"
                )
            out.append(_signed_tuple(client.sign_create_order(
                market_index=int(row["marketIndex"]),
                client_order_index=client_order_index,
                base_amount=int(row["baseAmount"]),
                price=int(row["price"]),
                is_ask=bool(row["isAsk"]),
                order_type=int(row.get("orderType", client.ORDER_TYPE_LIMIT)),
                time_in_force=int(row.get("timeInForce", client.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME)),
                reduce_only=bool(row.get("reduceOnly", False)),
                trigger_price=0,
                order_expiry=int(row.get("orderExpiry", client.DEFAULT_28_DAY_ORDER_EXPIRY)),
                nonce=int(row["nonce"]),
                api_key_index=api_key_index,
            )))
        return {"transactions": out}
    if command == "sign_cancel":
        return _signed_tuple(client.sign_cancel_order(
            market_index=int(req["marketIndex"]),
            order_index=int(req["orderIndex"]),
            nonce=int(req["nonce"]),
            api_key_index=api_key_index,
        ))
    if command == "sign_cancel_all":
        return _signed_tuple(client.sign_cancel_all_orders(
            time_in_force=client.CANCEL_ALL_TIF_IMMEDIATE,
            timestamp_ms=0,
            cancel_all_market_index=int(req["marketIndex"]),
            nonce=int(req["nonce"]),
            api_key_index=api_key_index,
        ))
    if command == "sign_update_leverage":
        leverage = max(1, int(req["leverage"]))
        fraction = int(10_000 / leverage)
        margin_mode = client.ISOLATED_MARGIN_MODE if bool(req.get("isolated", False)) else client.CROSS_MARGIN_MODE
        return _signed_tuple(client.sign_update_leverage(
            market_index=int(req["marketIndex"]),
            fraction=fraction,
            margin_mode=margin_mode,
            nonce=int(req["nonce"]),
            api_key_index=api_key_index,
        ))
    raise RuntimeError("不支持的签名命令")


def main():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        # ApiClient creates aiohttp resources and therefore needs to be
        # constructed while an event loop is actively running, even though
        # this worker never uses it for network requests.
        async def build_client():
            return _make_client()
        client, account_index, api_key_index = loop.run_until_complete(build_client())
    except Exception as exc:
        print(json.dumps({"ready": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        return 2
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        request_id = None
        try:
            req = json.loads(line)
            request_id = req.get("id")
            result = _handle(client, account_index, api_key_index, req)
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as exc:
            response = {"id": request_id, "ok": False, "error": str(exc)}
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)
    try:
        loop.run_until_complete(client.close())
    except Exception:
        pass
    loop.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
