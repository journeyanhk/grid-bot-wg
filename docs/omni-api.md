# Variational Omni 接口笔记（逆向）

> 非官方 API；以下均为抓包/探针实测记录。最近更新：2026-10-02。

## 认证模型（2026-09 起：双 token）

| 项 | 值 |
|---|---|
| access token | `vr-token` cookie，**5 分钟** JWT（`exp = iat + 300`，含 `session_id`/`auth_at`/`address`/`company`） |
| 长期凭证 | `vr-ll-token` cookie，不透明格式 `xxx.yyy`；另有按地址后缀副本 `vr-ll-token-0x…` |
| 续期接口 | `POST /api/auth/refresh`，空 body，`content-type: application/json` |
| 续期必带 | `vr-ll-token` cookie（+ `vr-connected-address` 头/副本，最小值待探针结论） |
| 续期响应 | `{"token": <新 5 分钟 JWT>, "intercomUserJwt": …}`；同 `session_id`、同 `auth_at` |
| 过期后可否续期 | **可**（实测 access 过期 2 分钟后仍刷新成功，只要 ll-token 有效） |
| 其他 | `cf_clearance`/`__cf_bm` 由浏览器过 CF；本项目用 curl_cffi impersonate 过 CF |

### 探针记录
- **2026-10-02 v1**：`ll_only / +过期vr / +地址副本` 全 **400 `{"message":"Unable to refresh session"}`**；
  `无地址头` **401**；**无 Cloudflare 挑战**（cf_mitigated 空，响应还下发了 __cf_bm/_cfuvid）。
  → 排除 CF 拦截；400 为应用层拒绝。地址头是必需（无则 401）。
  假设：refresh 可能要求一枚**格式合法的（可过期）vr-token JWT**（v1 用的是垃圾串 `expired.invalid`；
  抓包成功案例带的是过期但签名合法的 JWT）。v2 探针对照实验验证（真实 vr-token / 内置过期夹具）。
- **2026-10-02 v2**：待跑（对照矩阵 + 环境 sanity + ll-token 格式检查）。

### 待探针确认（`python3 scripts/va_probe.py refresh --run`）
- [ ] `/api/auth/refresh` 是否被 Cloudflare 挑战（go/no-go）
- [ ] 最小 cookie 集（ll-only / +旧 vr-token / +地址副本 / 无地址头）
- [ ] refresh 是否 `Set-Cookie` 轮换 `vr-ll-token`（决定缓存优先级规则）
- [ ] refresh 限速（10 连发 @2s 实测）
- [ ] `vr-ll-token` 寿命（DevTools → Application → Cookies → Expires 列，手抄）：

## 常用端点
- `GET /api/portfolio?compute_margin=true`（auth）：余额/权益/保证金
- `GET /api/positions`（auth）、`GET /api/orders/v2?...`（auth）
- `POST /api/orders/new/limit`、`/api/orders/cancel`（auth，见 va_probe.py）
- `POST /api/auth/login`：SIWE 登录，**被 Cloudflare managed challenge 拦**（curl_cffi 过不去）→ 自动登录不可用，只能贴 token / refresh
