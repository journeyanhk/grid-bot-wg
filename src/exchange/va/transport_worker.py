"""Variational Omni transport worker — Cloudflare-passing HTTP via curl_cffi.

Node `fetch` (and plain curl) get a 403 Cloudflare challenge on omni.variational.io;
curl_cffi with a Chrome TLS/JA3 impersonation gets 200. This worker is the ONE
process that actually touches the network for the VA adapter.

Protocol (identical shape to hl/signer_worker.py): JSON-lines on stdin/stdout.
  ready handshake:  {"ready": true}  |  {"ready": false, "error": "..."}
  request  (stdin): {"id":N,"command":"request","method":"GET","path":"/api/...",
                     "body":{...}|null,"auth":true|false,"token":"...","address":"..."}
  login    (stdin): {"id":N,"command":"login","address":"0x..."}
                    → 用 env 里的 VA_WALLET_PRIVATE_KEY 完成 SIWE 登录，返回
                      {"status":200,"token":"...","exp":<秒>}。私钥【绝不】经 stdio。
  response (stdout):{"id":N,"ok":true,"result":{"status":200,"text":"...","headers":{...}}}
                    {"id":N,"ok":false,"error":"..."}

The worker NEVER interprets the payload — it returns the raw status/text so the
Node side keeps ALL Cloudflare-challenge detection and VaHttpError shaping in one
place (httpclient.js). Token/address are passed per-request (not held) so a token
refresh needs no worker restart.
"""

from __future__ import annotations

import json
import os
import sys

try:
    from curl_cffi import requests as cffi_requests
except Exception as exc:  # pragma: no cover - exercised by the JS bridge
    print(json.dumps({"ready": False, "error": (
        f"无法加载 curl_cffi（{exc}）。当前解释器 {sys.executable} 未安装该库。"
        "请安装：pip install curl_cffi；或用 VA_PYTHON 指向已装 curl_cffi 的 python"
        "（例如虚拟环境 .va-venv/bin/python3）。"
    )}), flush=True)
    raise SystemExit(2)


import va_siwe  # SIWE 登录共享逻辑（与 login_probe.py 同源）

BASE_URL = os.environ.get("VA_BASE_URL", "https://omni.variational.io").rstrip("/")
IMPERSONATE = os.environ.get("VA_IMPERSONATE", "chrome")
TIMEOUT_S = float(os.environ.get("VA_TIMEOUT_S", "15"))

# A believable desktop-Chrome header set (matches the real capture). curl_cffi
# supplies the TLS/JA3 + HTTP2 fingerprint; these are the plain headers on top.
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": BASE_URL,
}


def _make_session():
    return cffi_requests.Session(impersonate=IMPERSONATE)


def _do_request(session, req: dict) -> dict:
    method = str(req.get("method", "GET")).upper()
    path = str(req.get("path", ""))
    body = req.get("body")
    auth = bool(req.get("auth"))
    token = str(req.get("token") or "")
    address = str(req.get("address") or "")

    headers = dict(BROWSER_HEADERS)
    if body is not None:
        headers["content-type"] = "application/json"
    if address:
        headers["vr-connected-address"] = address
    if auth:
        if not token:
            raise RuntimeError("缺少 vr-token，无法访问账户接口")
        cookie = f"vr-token={token}"
        if address:
            cookie += f"; vr-connected-address={address}"
        headers["Cookie"] = cookie
        # 抓包显示 UI 的下单/撤单请求带的是 /perpetual/BTC 这个 Referer（不是 /portfolio）。
        # 写请求（/api/orders/*）对齐 UI，其它 authed 读请求仍用 /portfolio。
        headers["Referer"] = f"{BASE_URL}/perpetual/BTC" if path.startswith("/api/orders") else f"{BASE_URL}/portfolio"
    else:
        headers["Referer"] = f"{BASE_URL}/perpetual/BTC"

    kwargs = {"headers": headers, "timeout": TIMEOUT_S}
    if body is not None:
        kwargs["json"] = body
    r = session.request(method, BASE_URL + path, **kwargs)
    return {
        "status": r.status_code,
        "text": r.text,
        "headers": {k.lower(): v for k, v in dict(r.headers).items()},
    }


def _do_login(session, req: dict) -> dict:
    """SIWE 自动登录：generate→sign→login 一次性完成（消息 60s 过期，必须原子）。

    地址来自 Node 帧（req.address）或 env VA_ADDRESS；私钥【只】从 env 读，永不经 stdio、
    永不进日志。返回 {status, token, exp}。
    """
    address = str(req.get("address") or os.environ.get("VA_ADDRESS") or "").strip()
    pk = os.environ.get("VA_WALLET_PRIVATE_KEY", "").strip()
    if not pk:
        raise RuntimeError("未配置 VA_WALLET_PRIVATE_KEY，无法自动登录")

    def post_json(path: str, body: dict):
        headers = dict(BROWSER_HEADERS)
        headers["content-type"] = "application/json"
        headers["Referer"] = f"{BASE_URL}/perpetual/BTC"
        if address:
            headers["vr-connected-address"] = address  # 抓包里 auth 请求都带，WAF 会看
        r = session.request("POST", BASE_URL + path, headers=headers, json=body, timeout=TIMEOUT_S)
        return r.status_code, r.text

    out = va_siwe.do_login(post_json, address, pk)  # 抛错信息已脱敏
    return {"status": 200, "token": out["token"], "exp": out.get("exp")}


def _handle(session, req: dict):
    command = req.get("command")
    if command == "health":
        return {"ok": True, "profile": "variational", "base": BASE_URL, "impersonate": IMPERSONATE}
    if command == "request":
        return _do_request(session, req)
    if command == "login":
        return _do_login(session, req)
    raise RuntimeError(f"不支持的传输命令: {command}")


def main():
    try:
        session = _make_session()
    except Exception as exc:
        print(json.dumps({"ready": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        return 2
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            req = json.loads(line)
            request_id = req.get("id")
            result = _handle(session, req)
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as exc:
            response = {"id": request_id, "ok": False, "error": str(exc)}
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
