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
  refresh  (stdin): {"id":N,"command":"refresh","ll_token":"...","token":"...","address":"0x..."}
                    → POST /api/auth/refresh 续期 5 分钟 access token。
                      探针 v2 证实：必须 ll-token + 同会话 vr-token（token）同时携带，
                      ll-only 会被 400 拒绝；ll-token 不轮换（仍回传 set_cookies 供兼容）。
                      返回 {"status":200,"token":"...","exp":<秒>,"set_cookies":{...}}
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


def _extract_set_cookies(response) -> dict:
    """提取响应 Set-Cookie 中的 vr-*（供被动轮换捕获；ll-token 永不入库/日志）。"""
    out = {}
    try:
        for c in response.cookies.jar:
            if str(c.name).startswith("vr-"):
                out[str(c.name)] = str(c.value)
    except Exception:
        pass
    return out


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
        "set_cookies": _extract_set_cookies(r),
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


def _do_refresh(session, req: dict) -> dict:
    """会话续期：POST /api/auth/refresh（空 body）。

    探针 v2 结论（tests/docs/omni-api.md）：
      * ll-token + **同会话 vr-token**（可过期）→ 200；只带 ll-token → 400；
        旧会话的 vr-token → 400（拒绝原因是会话不匹配，不是过期）。
      * 地址头必需（缺 → 401）；ll-token 未见轮换。
    """
    ll = str(req.get("ll_token") or os.environ.get("VA_LL_TOKEN") or "").strip()
    token = str(req.get("token") or "").strip()
    address = str(req.get("address") or os.environ.get("VA_ADDRESS") or "").strip()
    if not ll:
        raise RuntimeError("缺少 vr-ll-token")
    if not token:
        raise RuntimeError("缺少同会话 vr-token（refresh 必需）")
    h = dict(BROWSER_HEADERS)
    h["content-type"] = "application/json"
    h["Referer"] = f"{BASE_URL}/portfolio?tab=positions"
    if address:
        h["vr-connected-address"] = address
    cookie = f"vr-ll-token={ll}; vr-token={token}"
    if address:
        cookie += f"; vr-ll-token-{address.lower()}={ll}; vr-connected-address={address}"
    h["Cookie"] = cookie
    r = session.request("POST", BASE_URL + "/api/auth/refresh", headers=h, data=b"", timeout=TIMEOUT_S)
    out = {
        "status": r.status_code,
        "text": r.text,
        "headers": {k.lower(): v for k, v in dict(r.headers).items()},
        "set_cookies": _extract_set_cookies(r),
    }
    if r.status_code == 200:
        try:
            data = json.loads(r.text)
            tok = data.get("token")
            if tok:
                out["token"] = tok
                out["exp"] = va_siwe.jwt_exp(tok)
        except Exception:
            pass
    return out


def _handle(session, req: dict):
    command = req.get("command")
    if command == "health":
        return {"ok": True, "profile": "variational", "base": BASE_URL, "impersonate": IMPERSONATE}
    if command == "request":
        return _do_request(session, req)
    if command == "login":
        return _do_login(session, req)
    if command == "refresh":
        return _do_refresh(session, req)
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
