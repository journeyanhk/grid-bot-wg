# API 手册

## 概述
纯 HTTP + SSE 服务，`{ex}` 为 `de` / `ex` / `rs`。默认监听 127.0.0.1:8080，VPS 部署需配置 `HOST=0.0.0.0` + HTTPS 反代。

## 认证方式
- 配置了 `DASHBOARD_TOKEN` 后，所有 `/api/*` 请求必须携带有效令牌：
  - **REST:** `X-Auth-Token: <token>` header
  - **SSE:** URL query `?token=<token>`
- 未配置令牌：仅允许回环 Host 访问（DNS rebinding 兜底）
- Origin 校验：请求带 Origin 头时必须匹配回环来源或 `PUBLIC_ORIGIN` 白名单
- 失败语义：401 = 令牌缺失/错误；403 = 来源被拒绝

---

## 接口列表

### 总览

#### GET /api/version
**描述:** 应用版本号（package.json 来源，前端 header 展示）

#### GET /api/overview
**描述:** 三所总览（余额/权益/盈亏/状态）

#### GET /api/overview/stream
**描述:** 总览 SSE 实时流（1s 节拍）

### 交易所（/api/{ex}/...）

| METHOD | 路径 | 描述 |
|--------|------|------|
| GET | /markets | 市场列表 + 模式/行情源 |
| GET | /trend?marketId=&intervalSec= | K线 + 趋势分析 |
| GET | /state | 机器人状态 |
| GET | /stream | 单所 SSE 流 |
| POST | /start | 启动网格 `{marketId,mode,lower,upper,gridCount,sizeBase,leverage,outOfRangeAction}` |
| POST | /stop | 停止 `{closePosition}` |
| POST | /adjust | 在线调整区间 `{lower,upper}` |
| POST | /cancel-orders | 撤全部挂单（保留持仓） |
| POST | /close-position | 市价平仓 |
| POST | /start-recovery | 启动只减仓回收阶梯 |
| POST | /reset | 重置统计 |
| POST | /reconnect | 重连交易所（不撤单不平仓，成功后自动续跑） |

### AI 助手

| METHOD | 路径 | 描述 |
|--------|------|------|
| GET | /api/ai/status | AI 配置状态（密钥只回掩码） |
| POST | /api/ai/test | 测试连接 |
| POST | /api/ai/chat | 对话操控 `{message,history}`（AI 只提议，前端确认执行） |
| POST | /api/ai/analyze | 市况分析 `{ex}` |
| POST | /api/ai/sentinel-run | 立即巡检 |
| POST | /api/ai/market-run | BTC 市况报告 |
| POST | /api/ai/report | 日报 |

### 代理 / 配置

| METHOD | 路径 | 描述 |
|--------|------|------|
| GET | /api/proxy-check | 检测出口 IP |
| GET | /api/proxy-config | 查询代理配置 |
| POST | /api/env | 写入白名单配置 `{key,value}`（代理/AI/通知类，交易密钥不可改） |

**错误码:**
| 错误码 | 说明 |
|--------|------|
| 400 | 参数错误/业务校验失败 |
| 401 | 未授权（令牌缺失/错误） |
| 403 | 来源被拒绝（Origin/Host 校验失败） |
| 404 | 路由不存在 |
| 500 | 服务器内部错误 |
