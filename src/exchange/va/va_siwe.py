"""Variational SIWE 登录的共享纯逻辑（login_probe.py 与 transport_worker.py 共用）。

只做两件事：解析/校验 SIWE 消息，以及用私钥完成 generate→sign→login 编排。
HTTP 传输由调用方注入（post_json 回调），本模块不持有 session；这样探针与 worker
各自用自己的 curl_cffi 会话，过墙姿势一致。

安全要点：
  · 私钥只在 sign_text/do_login 内部使用，绝不进日志、绝不回传；
  · 签名前必过 assert_siwe（域名/Chain ID/地址/过期），防服务端或中间人塞别的消息；
  · Omni 的 SIWE 消息 Expiration Time 仅比 Issued At 晚 60 秒，故 generate→sign→login
    必须在同一进程内一次性完成（毫秒级），不能跨网络往返。
"""

from __future__ import annotations

import base64
import json
import re

EXPECTED_CHAIN_ID = 42161  # Arbitrum One


def mask(s, keep: int = 8) -> str:
    s = str(s or "")
    return (s[:keep] + "…") if len(s) > keep else "…"


def parse_field(msg: str, label: str):
    m = re.search(rf"^{re.escape(label)}:\s*(.+)$", msg, re.MULTILINE)
    return m.group(1).strip() if m else None


def extract_message(payload):
    """generate_signing_data 的返回可能是裸字符串，也可能包在对象里。"""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        for k in ("message", "signing_data", "data", "siwe", "result"):
            v = payload.get(k)
            if isinstance(v, str) and v:
                return v
            if isinstance(v, dict):
                inner = extract_message(v)
                if inner:
                    return inner
    return None


EXPECTED_DOMAIN = "omni.variational.io"


def assert_siwe(msg: str, address: str) -> list:
    """签名前校验 SIWE 消息。返回问题列表（空=通过）。

    精确校验（不用子串包含，否则 evil.omni.variational.io.attacker.net 也会过）：
      · 首行域名 == omni.variational.io（容忍带/不带 https:// 前缀）；
      · 第二行 == 目标地址；
      · URI 以 https://omni.variational.io[/...] 开头；
      · Chain ID / Nonce / Expiration Time；
      · Issued At 与本机时钟偏差 > 5 分钟也报（提前暴露时钟漂移——那会让 60s 窗口莫名失败）。
    """
    from datetime import datetime, timezone
    problems = []
    lines = [ln.rstrip() for ln in msg.splitlines()]

    # 首行：'<domain> wants you to sign in with your Ethereum account:'
    first = lines[0] if lines else ""
    m = re.match(r"^(\S+) wants you to sign in with your Ethereum account:\s*$", first)
    domain = m.group(1) if m else None
    if domain not in (EXPECTED_DOMAIN, f"https://{EXPECTED_DOMAIN}"):
        problems.append(f"SIWE 首行域名不符：{first!r}")

    # 第二行：目标地址（SIWE 里是 EIP-55 校验和，比对时转小写）
    if len(lines) < 2 or lines[1].strip().lower() != address.lower():
        problems.append(f"SIWE 第二行地址不符（期望 {mask(address, 10)}）")

    # URI：必须精确指向本域
    uri = parse_field(msg, "URI")
    if not uri or not (uri == f"https://{EXPECTED_DOMAIN}" or uri.startswith(f"https://{EXPECTED_DOMAIN}/")):
        problems.append(f"URI 不符：{uri!r}")

    chain = parse_field(msg, "Chain ID")
    if chain is None or chain.strip() != str(EXPECTED_CHAIN_ID):
        problems.append(f"Chain ID 期望 {EXPECTED_CHAIN_ID}，实际 {chain!r}")

    if not parse_field(msg, "Nonce"):
        problems.append("缺少 Nonce")

    exp = parse_field(msg, "Expiration Time")
    if exp:
        try:
            t = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            if t <= datetime.now(timezone.utc):
                problems.append(f"消息 Expiration Time 已过期：{exp}")
        except Exception:  # noqa: BLE001
            problems.append(f"无法解析 Expiration Time：{exp!r}")

    issued = parse_field(msg, "Issued At")
    if issued:
        try:
            t = datetime.fromisoformat(issued.replace("Z", "+00:00"))
            skew = abs((datetime.now(timezone.utc) - t).total_seconds())
            if skew > 300:
                problems.append(f"Issued At 与本机时钟偏差 {int(skew)}s（>5min），可能时钟漂移，60s 窗口会失败")
        except Exception:  # noqa: BLE001
            pass  # Issued At 解析失败不阻断（Expiration 已兜底）
    return problems


def jwt_exp(token: str):
    """解码 JWT 的 exp（秒），不验签。"""
    try:
        parts = str(token).split(".")
        pad = "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + pad))
        exp = payload.get("exp")
        return int(exp) if exp is not None else None
    except Exception:  # noqa: BLE001
        return None


def derive_address(private_key: str) -> str:
    from eth_account import Account
    return Account.from_key(private_key).address


def sign_text(msg: str, private_key: str) -> str:
    """personal_sign 一段 SIWE 文本，返回 130-hex（无 0x 前缀，与抓包一致）。"""
    from eth_account import Account
    from eth_account.messages import encode_defunct
    sig = Account.sign_message(encode_defunct(text=msg), private_key=private_key).signature.hex()
    return sig[2:] if sig.startswith("0x") else sig


def do_login(post_json, address: str, private_key: str) -> dict:
    """完整 SIWE 登录编排。post_json(path, body) -> (status:int, text:str)。

    返回 {"token": str, "exp": int|None}；任何一步失败抛 RuntimeError（错误信息已脱敏）。
    """
    if not address:
        raise RuntimeError("缺少地址（VA_ADDRESS）")
    if not private_key:
        raise RuntimeError("缺少私钥（VA_WALLET_PRIVATE_KEY）")

    # 地址一致性：私钥推导地址必须等于目标地址，否则拒绝（防用错钱包）。
    derived = derive_address(private_key)
    if derived.lower() != address.lower():
        raise RuntimeError(f"私钥推导地址 {mask(derived, 10)} 与目标地址 {mask(address, 10)} 不一致")

    st, text = post_json("/api/auth/generate_signing_data", {"address": address})
    if st != 200:
        raise RuntimeError(f"generate_signing_data HTTP {st}：{str(text)[:200]}")
    try:
        payload = json.loads(text)
    except Exception:  # noqa: BLE001
        payload = text
    msg = extract_message(payload)
    if not msg:
        raise RuntimeError(f"未能从返回提取 SIWE 消息：{str(text)[:200]}")

    problems = assert_siwe(msg, address)
    if problems:
        raise RuntimeError("SIWE 校验失败：" + "；".join(problems))

    sig = sign_text(msg, private_key)

    st, text = post_json("/api/auth/login", {"address": address, "signed_message": sig})
    if st != 200:
        raise RuntimeError(f"login HTTP {st}：{str(text)[:200]}")
    try:
        out = json.loads(text)
    except Exception:  # noqa: BLE001
        raise RuntimeError(f"login 返回非 JSON：{str(text)[:200]}")
    token = out.get("token") if isinstance(out, dict) else None
    if not token:
        raise RuntimeError("login 成功但未找到 token 字段")
    return {"token": token, "exp": jwt_exp(token)}
