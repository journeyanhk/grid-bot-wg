# 数据模型

## 概述
无数据库。三类持久化：`.env`（配置，含私钥，仅本机）、`.state.json`（运行快照，tmp+rename 原子写，500ms 防抖）、`logs/*.log`（结构化日志）。

---

## .env 配置

| 字段 | 类型 | 说明 |
|------|------|------|
| PORT | number | 仪表盘端口（默认 8080） |
| HOST | string | 监听地址（默认 127.0.0.1；VPS 设 0.0.0.0） |
| DASHBOARD_TOKEN | string | 可选。设置后 API 强制令牌鉴权 |
| PUBLIC_ORIGIN | string | 可选。逗号分隔允许的 Origin（域名部署时配置） |
| PAPER_BALANCE | number | 模拟初始余额 |
| GLOBAL_PROXY / DECIBEL_PROXY / EXTENDED_PROXY / RISEX_PROXY | string | 代理地址 |
| DE_MODE / EX_MODE / RS_MODE | paper/live | 各所运行模式 |
| DE_NETWORK / EX_NETWORK / RS_NETWORK | mainnet/testnet | 各所网络 |
| DECIBEL_API_KEY / DECIBEL_PRIVATE_KEY / DECIBEL_SUBACCOUNT | string | Decibel 凭据 |
| EXTENDED_API_KEY / EXTENDED_VAULT / EXTENDED_STARK_PRIVATE_KEY / EXTENDED_STARK_PUBLIC_KEY / EXTENDED_MAX_FEE | string | Extended 凭据 |
| ACCOUNT_ADDRESS / SIGNER_PRIVATE_KEY | string | RISEx 凭据 |
| AI_PROVIDER / AI_API_KEY / AI_BASE_URL / AI_MODEL / AI_MODEL_SMALL | string | AI 服务配置 |
| AI_SENTINEL_MINUTES / AI_MARKET_MINUTES / AI_REPORT_HOUR | number | AI 定时任务 |
| TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / NOTIFY_WEBHOOK | string | 通知 |
| LOG_LEVEL / LOG_DIR | string | 日志级别/目录 |

## .state.json 快照

按交易所键存储 `{de, ex, rs, ai}`，每个 bot 快照字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| running | boolean | 是否运行中（重启续跑依据） |
| config | object | 网格配置（marketId/mode/lower/upper/gridCount/sizeBase/leverage/outOfRangeAction） |
| stats | object | 累计统计（buys/sells/completedRungs/gridProfit/volume） |
| startBalance | number/null | 起始权益（收益率基准） |
| pnlBase | number/null | 已实现盈亏基线（resetStats 偏移） |
| active | array | 挂单跟踪 [orderId, {levelIndex,side,price,sizeBase,opening,recovery,placedAt}] |
| recovery / outOfRange / lastPrice | mixed | 运行状态 |

**关联关系:** 快照 `active` 与交易所真实挂单通过 `reconcileOpenOrders` 对账（prune/trim/adopt）。

## 日志文件（logs/app-YYYY-MM-DD.log）

JSON lines 结构：`{"t":ISO时间,"level":"info|warn|error","module":"...","msg":"...","ctx":{...}}`

**索引:**
- 按日期文件轮转
- `logger.info/warn/error` 由 bot/web/exchange/platform 模块调用
