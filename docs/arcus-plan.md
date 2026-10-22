# Arcus 接入 grid-bot-wg：技术方案（评审稿 v0.1）

- 基线：`journeyanhk/grid-bot-wg` @ `main` v1.6.15（六所：de / ex / hl / lr / rs / va，15 个测试文件）
- 交易所：Arcus（beta，mainnet `production-v0.8.0-1`，Chain 4663；testnet Chain 46630）
- 日期：2026-10-22　状态：v0.2 已定稿（决策见 §5），开发分支 `dev007-ar`

---

## 0. 结论

你的方案骨架成立（`src/exchange/ar/` 对齐既有模式、测试网先行、Ed25519 用 node:crypto、BTC 单市场），但有 **6 处需要改**、**3 项硬需求漏了**。改完后风险显著下降，排期从 7 天调整为 **8 个工作日**（多出来的是被"零改动"低估的接线，以及死手开关与测试）。

最关键的三个改动：

1. **别做 WS-first 下单**。Arcus 的 WS 下单是异步 ACK、错误帧不回显 `id`、连接 24h 强制断开、且**明确没有断线自动撤单**。写路径走 REST，WS 只做行情。
2. **成交真值用 `/v1/fills`（有 `from`/`to` 微秒游标）**，照抄 `hl/hyperliquid.js` 的 `userFillsByTime` 循环。所以任务书里"D1 的 WS fill 可靠性结论决定 D4 架构"不成立——架构已经定了，D1 只量延迟。
3. **必须补 ALO（post-only）与 GTT（≥1 个月）**，否则 D2 会卡一整天；**必须补 `scheduleCancel` 死手开关**，否则进程一死 132 张单裸奔。

---

## 1. 已核实的事实

### 1.1 仓库侧

| 项 | 实测 |
|---|---|
| 版本 | v1.6.15，适配器目录 6 个（de/ex/hl/lr/rs/va） |
| 适配器体量 | rs 386 行、hl 481、ex 595、lr 606、va 1,661（含 auth 349 + market 280 + paper 265） |
| 契约 | `init/getMarkets/getCandles/getPrice/setLeverage/placeLimitOrder/cancelOrder/cancelAll/getOpenOrders/getPosition/start/stop` + `equity/balance/realizedPnl/adoptOrder/closePosition` + 事件 `price`/`fill`/`error` |
| 批量上限 | `bot.js:960` 硬压 `Math.min(15, orderBatchSize)` —— 适配器报 100 也只有 15 |
| 成交真值先例 | `hl/hyperliquid.js` 已用 `userFillsByTime` 增量，"无需穿越推定"；出簿未成交有计时 + 10 分钟兜底 |
| 外部接线点 | `server.js`（import / create / restore / 错误环 / AI 服务 bots+exchanges）、`config.js`、`ai/service.js`（**5 处硬编码 `['de','ex','rs','lr','hl']`，`va` 已漏**）、`public/index.html`（单所 tab 约 146-148 行 + 概览卡片）、`.env.example`、README、wiki |

### 1.2 Arcus 侧（只读实测 + 官方文档）

| 项 | 实测 |
|---|---|
| BTC-USD | `marketId=1`，tick 0.1（tickTiers），step 1e-8，minOrderSize 0.0001，minNotional $5，**maker 0 ppm / taker 225 ppm**，IMF 2.5%（≈40x） |
| 下单签名 | Scheme 1 类型化载荷，键排序 `ad ai ct g id m op p q r s t v`；`ct` **纳秒**；`g` = goodTilTime(µs)×1000；`p`/`q` 为 tick/quantum 整数；body 里 price/qty 十进制串必须与之一致 |
| 其它签名 | Scheme 2（timestamp + action + canonical body）：`cancelAllOrders` / `setLeverage` / WS `authenticate`；批量下单每张单独签、共用 `X-Timestamp`、头里放任一张的签名 |
| GTT | **每单必填**，µs，≥ 现在 + 1 个月 |
| ALO | TIF=3，仅挂单；全 ALO 批量按撤单优先级、**跳过 50ms taker speed bump** |
| 批量 | batchPlace 100 / batchCancel 100 / batchModify 100 |
| 限流 | IP 1,500 权重/分（25/s）；`markets`/`candles`/`fills`/`openOrders` = 20（每满 20 项 +1），`bbo`/`account`/`positions`/`order` = 2，`setLeverage` = 125；下单/撤单 IP 权重 **0**，走子账户池：order 20,000 / cancel 40,000，`cancelAll` 固定扣 100 |
| 成交读取 | `/v1/fills`（`from`/`to` 微秒、`market`、`role`、`side`），**无需鉴权**；`/v1/openOrders` 最多 1,000 |
| 死手开关 | `scheduleCancel`，deadline ≤ 5 分钟，权重 0，每日自动触发上限 10 次 |
| 访问 | 主网交易需邀请/白名单（`/v1/account` 对未白名单地址返回 403）；testnet 网页"Deposit"白送 ~$1,000 USDG |
| 市场构成 | 84 个市场，**42 个带 regularTradingHours（股票类）** |

### 1.3 行情质量（对本策略的现实约束）

```
Arcus BTC mid 82,609.25   HL BTC mid 82,709.50   → Arcus 低 12.1 bps
Arcus 价差 0.1（0.012 bps），但顶档 bid 0.00078 BTC vs ask 3.56 BTC（单边薄）
```
与 10-20 那次 Arcus/Lighter 探针（Arcus 常年低 HL 8-13 bps）完全一致。对网格的含义：中价不可作为"公允价"锚点；**网格中心要用自己的成交/挂单体系，不要用 12bps 偏斜的中价做动态触发器**。

### 1.4 单位经济（先算清，再谈排期）

```
单格名义     = 0.0002 BTC × 82,600      ≈ $16.5
单格毛利     = $50 间距 = 6.05 bps      ≈ $0.0100（maker 0 费时才成立）
单次 taker 腿 = $16.5 × 22.5 bps        ≈ $0.0370  ← 一次就吃掉 3.7 格
全梯 132 格往返一次                      ≈ $1.32
BTC 日内 1% 振幅（$826 ÷ $50 ≈ 16 格来回）≈ 30-40 格成交 ≈ $0.3-0.4/天
```
→ 经济性验收标准应写成"**实测成交密度（格/天）与库存漂移**"，而不是"WS 推送是否可靠"。→ 任何市价腿（硬止损）都要按"3.7 格利润"计成本，recover 阶梯必须尽量被动成交。

---

## 2. 架构

```
src/exchange/ar/
├── index.js     createExchange({paper}) → ArcusExchange | ArcusPaper
├── arcus.js     ~750 行：REST 写 + REST 真值 + WS 行情
├── signer.js    ~140 行：Ed25519 + canonical payload + tick/quantum + ns/µs
├── auth.js      ~40 行：只读 AR_API_SIGNING_KEY + 180 天到期提醒（不做 EIP-712）
├── market.js    ~150 行：元数据、tick/step/minNotional 校验、CRYPTO 闸门、makerFee 断言
├── paper.js     ~250 行：镜像 + 本地撮合（抄 rs/paper.js，换行情源）
└── types.js     契约注释（抄 rs/types.js）
```

**通道分工**

| 用途 | 通道 | 理由 |
|---|---|---|
| 下单 / 撤单 | REST（batch 15） | WS ACK 异步、错误不回 `id`、无法关联失败；REST 同步返回 `orderId`，与 reconcile 天然一致 |
| 行情 / `price` 事件 | WS `bbo`（+ 可选 `trades`） | 免鉴权，权重 0，替代 20 权重的 REST 轮询 |
| 成交真值 | REST `/v1/fills?from=<游标>` 每 1s | 权威、可回放、有游标；照抄 hl 的 truth loop |
| 挂单对账 | REST `/v1/openOrders` 每 10s | 20 权重，配合 `massVanish` 守卫 |
| 安全网 | `scheduleCancel` 每 60s 续期（deadline 5 分钟） | Arcus 明确无断线撤单 |

**读取权重预算（池 25/s）**：`fills` 1s（20-21）+ `openOrders` 10s（2）≈ **23/s**，剩余 2/s 给 `bbo` 兜底；WS 正常时 `bbo` 走推送，实测可降到 ~21/s。若还要更省，`fills` 降到 0.5s… 降到 2s（10-11/s）。

**关键实现点**

1. 全单 `TIF=ALO`，`goodTilTime = now + 35 天`（µs），签名里 `g = µs × 1000`。
2. `p = price / tickSize`、`q = size / 1e-8` 必须整数；启动时断言 `tickSize` 与配置的网格间距可整除。
3. `errorType: "Transmission"` → 可原样重发；引擎侧拒绝 → **绝不重发**（这是比 clientOrderId 更强的幂等原语）。
4. 时钟：`ct` 容差 ±5s，启动自检 `Date.now()` 与 `/v1/time`（或 `Date` 头）偏差，>2s 拒绝启动。
5. `cancelAll(marketId)` 实现为"先 `getOpenOrders` 过滤市场，再 `batchCancelOrders`（≤100/批）"；账户级 `cancelAllOrders`（-100 权重）只留给 panic/stop。
6. 市场闸门：`regularTradingHours !== null` 或非 CRYPTO → 直接拒绝启动（42 个股票类市场）。
7. 启动断言：`makerFeePpm === 0`，否则打印单格净利并**拒绝启动**（你的规则保留，判定前置到启动）。
8. `stop()` 顺序：撤单 → 等确认 → 解除死手 → 断 WS。

---

## 3. 排期（8 个工作日）

| 日 | 交付 | 验收 | 可砍 |
|---|---|---|---|
| **D0** (0.5d) | 无代码：确权与探路 | ①主网是否已被邀请/白名单 ②testnet 能建 key 并白拿 $1,000 USDG ③USDG 入金路径与最小额 ④`setLeverage(10)` 可用 | 不可砍，未通过则整条排期挂起 |
| **D1** (1d) | `scripts/probe-arcus.mjs` | 签名冒烟 → 批量 100 单 → 撤 → 部分成交 → `/v1/fills` 游标归集 → 故意打爆桶看 429/`Retry-After`/`rateLimitUsage` → **让死手真触发一次** → 记录 pool used/cap 与 24h 内是否有 reseed | 产出是数据表，不写适配器 |
| **D2** (1d) | `signer.js` + `market.js` + `ar.test.js` | testnet 真单签名通过；tick/quantum 越界、GTT 缺失、makerFee>0 三种拒绝路径有单测 | — |
| **D3** (1d) | `arcus.js` REST 全通 | testnet 满梯 132 单铺 → 撤 → 重铺（9 批 × 15）；`getPosition/equity` 与网页一致 | — |
| **D4** (1d) | 成交真值环 + WS 行情 | 拔网线：WS 断 → 行情降级 REST → 重连补订阅 → 对账零重复；`fills` 游标不丢不重（构造断点回放） | 可后置 `trades` 频道 |
| **D5** (1d) | `paper.js` + 6 处接线 + 概览卡片 + wiki | 实验 VPS 起 paper 24h；`npm test` 全绿；面板能切到 Arcus | **UI tab 可后置**（先复用 paper 页）→ 省 0.5d |
| **D6** (0.5d) | 主网半梯：66 格 / $100 / 0.0002 / $400 / 10x | 启动自检行（间距、makerFee=0、GTT、死手已武装）、48h 观察窗起点、首小时逐笔对账零差 | 需你亲自按开关 |
| **D7** (0.5d) | 观察窗内校准 | 实测成交密度、库存峰值、recover 阶梯触发次数 → 定满梯参数与 `recover+$X` | — |

压缩版：只要 testnet + paper 验证（不接 UI、不上主网）→ **5 个工作日**。

---

## 4. 风险与红线

- **D0 是唯一真 blocker**：没有邀请码/白名单，主网交易开不了。testnet 全程免费可跑。
- **taker 腿预算**：每次 3.7 格利润。硬止损必须罕见；recover 阶梯尽量被动成交。
- **recover 是最大回撤源**：不要预设 `+$60`，D7 用实测回撤定，且必须与"最大可承受回撤"绑定。
- **薄盘 + 12bps 偏斜**：Arcus 中价不可作为公允价；动态网格触发器用自身成交/挂单，不用中价。
- **beta 平台风险**：$350-400 封顶，盈利周提；maker 费一旦上调，启动即拒。
- **不许跳**：D0 → D1 → D2；不过 D1 不写 D3。

## 5. 已拍板（2026-10-22）

| # | 议题 | 结论 |
|---|---|---|
| 1 | 本金 | **$400**（满梯名义 $2.2k，10x 需 $218 保证金，留 45% 缓冲） |
| 2 | 写路径 | **REST 写**，WS 只做行情；成交真值走 `/v1/fills` 游标 |
| 3 | 建 key | **网页注册一次**，代码只读钥，不做 EIP-712 |
| 4 | 主网准入 | 白名单**已具备** |
| 5 | UI tab | **v1.1 再做**，v1 复用 paper 页与 `/api/ar/*` 路由 |

## 6. 开发约定

- 分支：`dev007-ar`（基于 `origin/main@98f4e43`），每完成一块即提交并推送远程。
- 密钥：Arcus Ed25519 私钥**不进仓库、不进 `.env.example`**；放 `~/.config/gridbot/arcus.env`（`AR_PRIVATE_KEY=<hex>`），`AR_PRIVATE_KEY_FILE` 可覆盖路径。
- 测试：纯离线（不连网、不下单），`node test/ar.test.js`；连网的真实探针单独放 `scripts/probe-arcus.mjs`，默认 dry-run。
- 线上开关：主网实盘需要同时满足 `AR_MODE=live` + `AR_NETWORK=mainnet` + 显式 `AR_I_UNDERSTAND_RISK=YES`，三缺一拒绝启动。

---

## D1 实测结果（2026-10-22 · testnet · BTC-USD）

账户 `0x93ea8FF3f82919ce2f419D6DE0E34770c0d44039`，脚本 `scripts/probe-arcus.mjs`，**14/15 通过**（唯一失败项是账户未充值，equity=0，属预期）。

| 项目 | 实测 | 含义 |
|---|---|---|
| 时钟偏差 | **2085ms** | 本机未对 NTP；适配器已按偏差补偿 `ct`。部署机必须开 NTP，否则签名会被拒 |
| init / markets | 952ms / 68 个 | 冷启动可接受 |
| placeOrder ALO | 135ms | — |
| **ACK→挂单可见** | **114ms** | REST 写路径延迟足够，$50 间距下无需 WS 下单 |
| cancelOrder | 136ms → **113ms 消失** | — |
| 批量撤单 | 202 ACK，**撤净 110ms**（调用 791ms，含轮询确认） | 必须轮询确认，不能只看 202 |
| 死手 arm/disarm | deadline +240s，撤销成功 | 安全网可用 |
| 子账户池 | order used 17 / cap 20,000；cancel used 40 / cap 40,000 | 132 单/次重铺 → 约 150 次重铺才见底，非瓶颈 |
| 费率 | testnet 模拟 150/450 ppm；主网 0/225 | 守卫在 testnet 只告警，主网 maker>0 直接拒启 |
| fills(from=µs) | rows=0（无成交） | 游标链路通，待充值后验证真实成交 |

### D1 抓到的两个真实缺陷（已修）

1. **`/v1/openOrders` 回包是信封 `{orders:[…]}`，且行里没有 `quantity`** —— 原实现按裸数组 + `quantity` 解析，testnet 上恒返回 0 张。这会让对账层误判"交易所在簿 0 单"，而 `massVanish` 守卫只保护"本地跟踪≥3 张"的场景，开局或单档时会直接失效。已改为信封/裸行双兼容 + `remainingSize` 优先。
2. **`batchCancelOrders` 是 202 ACK** —— 只在"已转发"层面成功。若不轮询消失就回报，bot 会在旧单之上重铺，形成同档双单（正是仓库历史上 `_cancelAllConfirmed` 要防的问题）。已改为撤后 400ms/1200ms 两轮确认，返回真实撤净数。

### 待办（D4 前）

- testnet 账户需在网页点 **Testnet Deposit**（~$1,000 USDG），否则无法验证成交/持仓/平仓链路。
- 部署机开 NTP（当前 2s 偏差会吃掉 `ct` 容差的一半）。
