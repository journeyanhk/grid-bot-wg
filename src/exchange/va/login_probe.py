"""Variational Omni 自动登录探针（P0 · go/no-go 闸门）。

用途：在把 SIWE 自动登录接进 worker 之前，先用一个独立脚本验证两件事——
  1) /api/auth/* 这两个登录接口能否过 Cloudflare（现在过墙的只有 /api/orders、/portfolio）；
  2) 完整 SIWE 流程（generate_signing_data → personal_sign → login）能否换到 7 天 JWT。

它复用 transport_worker.py 完全相同的 curl_cffi impersonation 与浏览器请求头，
所以过墙结论对 worker 有效。本脚本【不】改动 worker / Node 主流程，只读环境变量，
私钥永不进日志（脱敏输出）。

用法：
  # 只验 Cloudflare + 看 SIWE 消息结构（不需要私钥、不需要 eth_account）：
  VA_ADDRESS=0x你的新钱包地址 python3 src/exchange/va/login_probe.py --dry-run

  # 走完整登录、打印 token 的 exp（需要 eth_account 与私钥；用【新钱包】跑）：
  VA_ADDRESS=0x... VA_WALLET_PRIVATE_KEY=0x... python3 src/exchange/va/login_probe.py --run

依赖：--dry-run 只需 curl_cffi；--run 另需 eth-account（pip install eth-account）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

try:
    from curl_cffi import requests as cffi_requests
except Exception as exc:  # noqa: BLE001
    print(f"[FATAL] 无法加载 curl_cffi：{exc}\n请 pip install curl_cffi（装到 VA_PYTHON 指向的解释器）。", file=sys.stderr)
    raise SystemExit(2)

BASE_URL = os.environ.get("VA_BASE_URL", "https://omni.variational.io").rstrip("/")
IMPERSONATE = os.environ.get("VA_IMPERSONATE", "chrome")
TIMEOUT_S = float(os.environ.get("VA_TIMEOUT_S", "15"))
EXPECTED_CHAIN_ID = 42161  # Arbitrum One

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


def _mask(s: str, keep: int = 8) -> str:
    s = str(s or "")
    return (s[:keep] + "…") if len(s) > keep else "…"


def _looks_like_cloudflare(status: int, text: str) -> bool:
    t = (text or "").lower()
    return status in (403, 503) and ("cloudflare" in t or "cf-ray" in t or "just a moment" in t or "attention required" in t)


def _post(session, path: str, body: dict) -> tuple[int, str, dict]:
    headers = dict(BROWSER_HEADERS)
    headers["content-type"] = "application/json"
    headers["Referer"] = f"{BASE_URL}/perpetual/BTC"
    r = session.request("POST", BASE_URL + path, headers=headers, json=body, timeout=TIMEOUT_S)
    return r.status_code, r.text, {k.lower(): v for k, v in dict(r.headers).items()}


def _extract_message(payload):
    """generate_signing_data 的返回可能是裸字符串，也可能包在对象里。"""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        for k in ("message", "signing_data", "data", "siwe", "result"):
            v = payload.get(k)
            if isinstance(v, str) and v:
                return v
            if isinstance(v, dict):
                inner = _extract_message(v)
                if inner:
                    return inner
    return None


def _parse_field(msg: str, label: str):
    m = re.search(rf"^{re.escape(label)}:\s*(.+)$", msg, re.MULTILINE)
    return m.group(1).strip() if m else None


def assert_siwe(msg: str, address: str) -> list[str]:
    """签名前校验 SIWE 消息：域名 / Chain ID / 地址 / 过期时间。返回问题列表（空=通过）。"""
    problems = []
    low = msg.lower()
    if "omni.variational.io" not in low:
        problems.append("消息中未出现 omni.variational.io（域名/URI 不符）")
    chain = _parse_field(msg, "Chain ID")
    if chain is None or chain.strip() != str(EXPECTED_CHAIN_ID):
        problems.append(f"Chain ID 期望 {EXPECTED_CHAIN_ID}，实际 {chain!r}")
    if address.lower() not in low:
        problems.append("消息中未包含目标地址（可能被塞了别的地址）")
    exp = _parse_field(msg, "Expiration Time")
    if exp:
        try:
            from datetime import datetime, timezone
            t = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            if t <= datetime.now(timezone.utc):
                problems.append(f"消息 Expiration Time 已过期：{exp}")
        except Exception:  # noqa: BLE001
            problems.append(f"无法解析 Expiration Time：{exp!r}")
    return problems


def _jwt_exp(token: str):
    try:
        import base64
        parts = token.split(".")
        pad = "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + pad))
        return payload.get("exp")
    except Exception:  # noqa: BLE001
        return None


def run(dry_run: bool) -> int:
    address = os.environ.get("VA_ADDRESS", "").strip()
    if not address:
        print("[FATAL] 需要 VA_ADDRESS（新钱包地址）。", file=sys.stderr)
        return 2

    session = cffi_requests.Session(impersonate=IMPERSONATE)

    # ── 步骤 1：generate_signing_data（这一步就能验 Cloudflare）──
    print(f"[1/3] POST /api/auth/generate_signing_data  address={_mask(address, 10)}")
    status, text, _ = _post(session, "/api/auth/generate_signing_data", {"address": address})
    if _looks_like_cloudflare(status, text):
        print(f"[NO-GO] /api/auth/* 被 Cloudflare 拦截（HTTP {status}）。自动登录不可行，保持贴 token 方案。", file=sys.stderr)
        return 1
    if status != 200:
        print(f"[NO-GO] generate_signing_data 返回 HTTP {status}：{text[:400]}", file=sys.stderr)
        return 1
    print(f"[OK ] Cloudflare 已放行 /api/auth/*（HTTP 200）。")

    try:
        payload = json.loads(text)
    except Exception:  # noqa: BLE001
        payload = text
    msg = _extract_message(payload)
    if not msg:
        print(f"[WARN] 未能从返回里提取 SIWE 文本，原始返回：\n{text[:800]}", file=sys.stderr)
        return 1
    print("[OK ] 拿到 SIWE 待签消息：\n---8<---")
    print(msg)
    print("--->8---")

    problems = assert_siwe(msg, address)
    if problems:
        print("[WARN] SIWE 校验发现问题：")
        for p in problems:
            print("   · " + p)
    else:
        print("[OK ] SIWE 校验通过（域名 / Chain ID / 地址 / 过期时间）。")

    if dry_run:
        print("\n[DRY-RUN 完成] Cloudflare 可过、消息结构已确认。要走完整登录请去掉 --dry-run 并提供 VA_WALLET_PRIVATE_KEY（用新钱包）。")
        return 0 if not problems else 1

    if problems:
        print("[ABORT] SIWE 校验未通过，拒绝签名。", file=sys.stderr)
        return 1

    # ── 步骤 2：签名（私钥只从 env 读，脱敏输出）──
    pk = os.environ.get("VA_WALLET_PRIVATE_KEY", "").strip()
    if not pk:
        print("[FATAL] --run 需要 VA_WALLET_PRIVATE_KEY。", file=sys.stderr)
        return 2
    try:
        from eth_account import Account
        from eth_account.messages import encode_defunct
    except Exception as exc:  # noqa: BLE001
        print(f"[FATAL] 需要 eth-account：{exc}\n请 pip install eth-account。", file=sys.stderr)
        return 2

    derived = Account.from_key(pk).address
    if derived.lower() != address.lower():
        print(f"[FATAL] 私钥推导地址 {_mask(derived, 10)} 与 VA_ADDRESS {_mask(address, 10)} 不一致，拒绝登录。", file=sys.stderr)
        return 2
    print(f"[2/3] 地址一致（{_mask(derived, 10)}），本地签名中…")
    sig = Account.sign_message(encode_defunct(text=msg), private_key=pk).signature.hex()
    if sig.startswith("0x"):
        sig = sig[2:]  # 抓包里的 signed_message 无 0x 前缀，130 hex

    # ── 步骤 3：login ──
    print("[3/3] POST /api/auth/login …")
    status, text, _ = _post(session, "/api/auth/login", {"address": address, "signed_message": sig})
    if status != 200:
        print(f"[NO-GO] login 返回 HTTP {status}：{text[:400]}", file=sys.stderr)
        return 1
    try:
        out = json.loads(text)
    except Exception:  # noqa: BLE001
        print(f"[WARN] login 返回非 JSON：{text[:400]}", file=sys.stderr)
        return 1
    token = out.get("token") if isinstance(out, dict) else None
    if not token:
        print(f"[WARN] login 成功但未找到 token 字段，返回键：{list(out) if isinstance(out, dict) else type(out)}", file=sys.stderr)
        return 1
    exp = _jwt_exp(token)
    from datetime import datetime, timezone
    exp_str = datetime.fromtimestamp(exp, timezone.utc).isoformat() if exp else "未知"
    print(f"[GO ] 登录成功！token={_mask(token, 12)} exp={exp}（UTC {exp_str}）")
    print("      自动登录链路可用，可以进 P1（把 login 接进 worker）。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Variational SIWE 自动登录探针（P0）")
    ap.add_argument("--dry-run", action="store_true", help="只调 generate_signing_data，验 Cloudflare + 看消息结构，不签名不登录")
    ap.add_argument("--run", action="store_true", help="走完整 SIWE 登录并打印 token exp（需私钥）")
    args = ap.parse_args()
    if not args.dry_run and not args.run:
        ap.error("请指定 --dry-run 或 --run 之一")
    return run(dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
