"""方案 B 可行性探针：无头/有头 Chromium 过 Cloudflare 挑战完成 SIWE 登录。

背景：/api/auth/login 被 Cloudflare 设了 managed challenge（需浏览器执行 JS 拿
cf_clearance），curl_cffi 过不去。本探针用 Playwright 起一个真实浏览器上下文，等挑战
通过后，在【页面上下文里】fetch 两个 auth 接口——这样请求天然带上 cf_clearance +
真实指纹。私钥【绝不】进浏览器：待签消息取回 Python，用 va_siwe 本地签名，再把签名塞回
页面发 login。

用法（在你的服务器上跑，先装依赖）：
    pip install -r requirements-va-browser.txt
    playwright install chromium            # 无头
    # 若无头过不去，装虚拟显示后用有头（managed challenge 有头通过率高很多）：
    #   apt-get install -y xvfb
    #   xvfb-run -a python src/exchange/va/auth_browser.py --headful
    VA_ADDRESS=0x... VA_WALLET_PRIVATE_KEY=0x... \
        python src/exchange/va/auth_browser.py [--headful] [--profile DIR] [--keep]

退出码：0 = 登录成功（拿到 7 天 token）；2 = 配置/依赖问题；3 = 挑战未过/登录失败。
成功时真实 token 只写入 --out 指定文件（默认 .runtime/va_token.json，600 权限），
stdout 末行只打印脱敏 JSON，不打印明文。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import va_siwe  # 复用 SIWE 校验 + 本地签名（与 worker/probe 同源）

BASE_URL = os.environ.get("VA_BASE_URL", "https://omni.variational.io").rstrip("/")
WARM_PATH = "/perpetual/BTC"          # 先打开这个页面让 Cloudflare 发起并通过挑战
CHALLENGE_TIMEOUT_MS = 45_000
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/152.0.0.0 Safari/537.36")


def log(tag: str, msg: str) -> None:
    print(f"[{tag}] {msg}", file=sys.stderr, flush=True)


# 页面上下文里发 fetch：带 credentials 让 cf_clearance 随请求发出。
_FETCH_JS = """
async ({ path, body, address }) => {
  const headers = { 'content-type': 'application/json' };
  if (address) headers['vr-connected-address'] = address;
  const r = await fetch(path, {
    method: 'POST', credentials: 'include', headers,
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}
"""


def _challenge_cleared(page) -> bool:
    title = (page.title() or "").lower()
    return "just a moment" not in title and "attention required" not in title


def run(headful: bool, profile: str, out_path: str, keep: bool) -> int:
    address = (os.environ.get("VA_ADDRESS") or "").strip()
    pk = (os.environ.get("VA_WALLET_PRIVATE_KEY") or "").strip()
    if not address:
        log("FATAL", "需要 VA_ADDRESS（钱包地址）。")
        return 2
    if not pk:
        log("FATAL", "需要 VA_WALLET_PRIVATE_KEY（私钥，仅本地签名用，不进浏览器）。")
        return 2

    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # noqa: BLE001
        log("FATAL", f"未安装 playwright（{exc}）。请 pip install -r requirements-va-browser.txt "
                     "并 playwright install chromium。")
        return 2

    os.makedirs(profile, exist_ok=True)
    with sync_playwright() as p:
        # 持久化上下文：复用 cf_clearance / __cf_bm，减少重复挑战。
        ctx = p.chromium.launch_persistent_context(
            profile,
            headless=not headful,
            user_agent=UA,
            viewport={"width": 1280, "height": 800},
            locale="en-US",
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()

            # ① 打开页面，等挑战通过 ------------------------------------------------
            log("1/4", f"打开 {BASE_URL}{WARM_PATH}，等待 Cloudflare 挑战通过…")
            page.goto(BASE_URL + WARM_PATH, wait_until="domcontentloaded", timeout=60_000)
            deadline = time.time() + CHALLENGE_TIMEOUT_MS / 1000
            while time.time() < deadline and not _challenge_cleared(page):
                page.wait_for_timeout(1000)
            if not _challenge_cleared(page):
                log("NO-GO", f"{int(CHALLENGE_TIMEOUT_MS/1000)}s 内挑战未通过（headless={not headful}）。"
                             "若当前是无头，请装 xvfb 后用 --headful 重试。")
                return 3
            has_clear = any(c.get("name") == "cf_clearance" for c in ctx.cookies())
            log("OK", f"挑战已通过（cf_clearance={'有' if has_clear else '无，但页面已放行'}）。")

            # ② generate_signing_data（页面上下文，带 cf_clearance）-----------------
            log("2/4", "在页面上下文请求 generate_signing_data…")
            g = page.evaluate(_FETCH_JS, {"path": "/api/auth/generate_signing_data",
                                          "body": {"address": address}, "address": address})
            if g["status"] != 200:
                log("NO-GO", f"generate_signing_data HTTP {g['status']}：{str(g['text'])[:200]}")
                return 3
            try:
                payload = json.loads(g["text"])
            except Exception:  # noqa: BLE001
                payload = g["text"]
            message = va_siwe.extract_message(payload)
            if not message:
                log("NO-GO", f"未能从返回提取 SIWE 消息：{str(g['text'])[:200]}")
                return 3

            # ③ 本地校验 + 签名（私钥只在 Python）----------------------------------
            problems = va_siwe.assert_siwe(message, address)
            if problems:
                log("NO-GO", "SIWE 校验失败：" + "；".join(problems))
                return 3
            derived = va_siwe.derive_address(pk)
            if derived.lower() != address.lower():
                log("NO-GO", f"私钥推导地址 {va_siwe.mask(derived,10)} 与 VA_ADDRESS 不一致。")
                return 3
            sig = va_siwe.sign_text(message, pk)
            log("3/4", "SIWE 校验通过，本地签名完成。")

            # ④ login（页面上下文）------------------------------------------------
            log("4/4", "在页面上下文提交 login…")
            r = page.evaluate(_FETCH_JS, {"path": "/api/auth/login",
                                          "body": {"address": address, "signed_message": sig},
                                          "address": address})
            if r["status"] != 200:
                log("NO-GO", f"login HTTP {r['status']}：{str(r['text'])[:200]}")
                return 3
            try:
                token = json.loads(r["text"]).get("token")
            except Exception:  # noqa: BLE001
                token = None
            if not token:
                log("NO-GO", f"login 成功但未找到 token：{str(r['text'])[:200]}")
                return 3

            exp = va_siwe.jwt_exp(token)
            _write_token(out_path, token, exp)
            hrs = int((exp - time.time()) / 3600) if exp else None
            log("GO", f"登录成功！token 已写入 {out_path}（600）{f'，有效约 {hrs} 小时' if hrs else ''}。")
            print(json.dumps({"ok": True, "token": va_siwe.mask(token, 12), "exp": exp}), flush=True)
            if keep:
                log("INFO", "--keep：浏览器保持打开，600s 后自动退出（或 Ctrl-C）。")
                page.wait_for_timeout(600_000)
            return 0
        finally:
            if not keep:
                ctx.close()


def _write_token(path: str, token: str, exp) -> None:
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"token": token, "exp": exp, "at": int(time.time() * 1000)}, f)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Variational 浏览器登录探针（方案 B 可行性验证）")
    ap.add_argument("--headful", action="store_true", help="有头模式（配合 xvfb-run，过挑战通过率更高）")
    ap.add_argument("--profile", default=".runtime/va_browser_profile", help="持久化浏览器 profile 目录")
    ap.add_argument("--out", default=".runtime/va_token.json", help="token 输出文件（600）")
    ap.add_argument("--keep", action="store_true", help="成功后保持浏览器打开")
    a = ap.parse_args()
    try:
        return run(a.headful, a.profile, a.out, a.keep)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
