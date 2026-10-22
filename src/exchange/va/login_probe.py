"""Variational Omni 自动登录探针（P0 · go/no-go 闸门）。

用途：在把 SIWE 自动登录接进 worker 之前，先用独立脚本验证两件事——
  1) /api/auth/* 能否过 Cloudflare（现在过墙的只有 /api/orders、/portfolio）；
  2) 完整 SIWE 流程（generate_signing_data → personal_sign → login）能否换到 7 天 JWT。

复用 transport_worker.py 相同的 curl_cffi impersonation 与请求头，过墙结论对 worker 有效；
SIWE 编排逻辑复用 va_siwe.py（与 worker 同源）。本脚本【不】改动主流程，私钥只从 env 读。

用法：
  # 只验 Cloudflare + 看 SIWE 消息结构（不需私钥、不需 eth-account）：
  VA_ADDRESS=0x你的新钱包地址 python3 src/exchange/va/login_probe.py --dry-run

  # 走完整登录、打印 token 的 exp（需要 eth-account 与私钥；用【新钱包】跑）：
  VA_ADDRESS=0x... VA_WALLET_PRIVATE_KEY=0x... python3 src/exchange/va/login_probe.py --run
"""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    from curl_cffi import requests as cffi_requests
except Exception as exc:  # noqa: BLE001
    print(f"[FATAL] 无法加载 curl_cffi：{exc}\n请 pip install curl_cffi。", file=sys.stderr)
    raise SystemExit(2)

import va_siwe

BASE_URL = os.environ.get("VA_BASE_URL", "https://omni.variational.io").rstrip("/")
IMPERSONATE = os.environ.get("VA_IMPERSONATE", "chrome")
TIMEOUT_S = float(os.environ.get("VA_TIMEOUT_S", "15"))

# 与 transport_worker.py 完全一致的请求头（保证过墙结论可迁移）。
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": BASE_URL,
}


def _looks_like_cloudflare(status: int, text: str) -> bool:
    t = (text or "").lower()
    return status in (403, 503) and ("cloudflare" in t or "cf-ray" in t or "just a moment" in t or "attention required" in t)


def _make_post(session, address: str = ""):
    def post_json(path: str, body: dict):
        headers = dict(BROWSER_HEADERS)
        headers["content-type"] = "application/json"
        headers["Referer"] = f"{BASE_URL}/perpetual/BTC"
        if address:
            headers["vr-connected-address"] = address  # 与 worker 一致：auth 请求都带
        r = session.request("POST", BASE_URL + path, headers=headers, json=body, timeout=TIMEOUT_S)
        return r.status_code, r.text
    return post_json


def run(dry_run: bool) -> int:
    address = os.environ.get("VA_ADDRESS", "").strip()
    if not address:
        print("[FATAL] 需要 VA_ADDRESS（新钱包地址）。", file=sys.stderr)
        return 2

    session = cffi_requests.Session(impersonate=IMPERSONATE)
    post_json = _make_post(session, address)

    # ── 步骤 1：generate_signing_data（这一步就能验 Cloudflare）──
    print(f"[1/3] POST /api/auth/generate_signing_data  address={va_siwe.mask(address, 10)}")
    status, text = post_json("/api/auth/generate_signing_data", {"address": address})
    if _looks_like_cloudflare(status, text):
        print(f"[NO-GO] /api/auth/* 被 Cloudflare 拦截（HTTP {status}）。自动登录不可行，保持贴 token。", file=sys.stderr)
        return 1
    if status != 200:
        print(f"[NO-GO] generate_signing_data 返回 HTTP {status}：{text[:400]}", file=sys.stderr)
        return 1
    print("[OK ] Cloudflare 已放行 /api/auth/*（HTTP 200）。")

    try:
        payload = json.loads(text)
    except Exception:  # noqa: BLE001
        payload = text
    msg = va_siwe.extract_message(payload)
    if not msg:
        print(f"[WARN] 未能从返回里提取 SIWE 文本，原始返回：\n{text[:800]}", file=sys.stderr)
        return 1
    print("[OK ] 拿到 SIWE 待签消息：\n---8<---")
    print(msg)
    print("--->8---")

    problems = va_siwe.assert_siwe(msg, address)
    if problems:
        print("[WARN] SIWE 校验发现问题：")
        for p in problems:
            print("   · " + p)
    else:
        print("[OK ] SIWE 校验通过（域名 / Chain ID / 地址 / 过期时间）。")

    if dry_run:
        print("\n[DRY-RUN 完成] Cloudflare 可过、消息结构已确认。要走完整登录请去掉 --dry-run 并提供 VA_WALLET_PRIVATE_KEY（用新钱包）。")
        return 0 if not problems else 1

    # ── --run：完整 SIWE 登录（编排复用 va_siwe.do_login，与 worker 同源）──
    pk = os.environ.get("VA_WALLET_PRIVATE_KEY", "").strip()
    if not pk:
        print("[FATAL] --run 需要 VA_WALLET_PRIVATE_KEY。", file=sys.stderr)
        return 2
    try:
        print("[2/3] 校验地址一致 + 本地签名 + [3/3] login …")
        out = va_siwe.do_login(post_json, address, pk)
    except Exception as exc:  # noqa: BLE001
        print(f"[NO-GO] 登录失败：{exc}", file=sys.stderr)
        return 1
    exp = out.get("exp")
    from datetime import datetime, timezone
    exp_str = datetime.fromtimestamp(exp, timezone.utc).isoformat() if exp else "未知"
    print(f"[GO ] 登录成功！token={va_siwe.mask(out['token'], 12)} exp={exp}（UTC {exp_str}）")
    print("      自动登录链路可用，可以进 P1（把 login 接进 worker）。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Variational SIWE 自动登录探针（P0）")
    ap.add_argument("--dry-run", action="store_true", help="只调 generate_signing_data，验 Cloudflare + 看消息结构")
    ap.add_argument("--run", action="store_true", help="走完整 SIWE 登录并打印 token exp（需私钥）")
    args = ap.parse_args()
    if not args.dry_run and not args.run:
        ap.error("请指定 --dry-run 或 --run 之一")
    return run(dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
