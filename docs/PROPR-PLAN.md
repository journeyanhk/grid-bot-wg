# Propr 接入方案与可行性判定

> 2026-10-26 ｜ 基线 `main@6ef0286` ｜ 目标账户：Propr **live** 环境 5,000 USDC 1-Step
> 官方文档快照：[`docs/propr/`](propr/)（api.md / websocket.md / 规则原文 / OpenAPI）
> 结论先行：**接入可行，成本不高；但「网格通过挑战」在数学上不成立。工程接入与过关打法必须分成两条线。**

---

## 0. TL;DR

1. Propr 是注册在 BVI 的 on-chain prop firm，**执行在 Hyperliquid，账户 100% 模拟**。5k Classic 1-Step：$60 评估费、目标 **+10%（$500）**、日损 **3%（$150，00:00 UTC 按当日 balance 重算）**、**静态回撤 6%（$300，地板 $4,700）**、无时限、无最少交易日。
2. 规则**明文允许网格、允许 bot**；禁止跨所对冲同一/相关标的、同 IP/设备多账户、利用价格延迟。**第一条正好是你过去的操作习惯，必须写进红线。**
3. 你的 `main` 已经具备 80% 的难度：撤单二次确认、30s 对账、重启续跑、重试队列、`opening/reduceOnly` 分类、库存审计、动态网格、三绿灯。新增第 7 个交易所是 **5–6 个工日**，不是附件估的 8–11 天。
4. 附件方案有 **6 处与官方文档/代码不符**，其中「净仓」和「批量下单」两处会直接造成双边持仓与订单黑洞（详见 §3.3）。
5. **可行性判定的核心算术**：现有参数每格净利 $1.66，+$500 需要约 **300 个格**；你 23 天实际做了 **8–10 格**（0.44 格/天）→ 按现节奏约 **2 年**。180 天 1 小时回测里没有任何网格组合能在 23 天达到 +$500。
6. 要过关，**形状得换**：单笔风险 ≤1%、靠多次 2–3R 累积。网格是「赚 300 次 1.66 美元，赔 1 次 300 美元」；挑战要的恰好是反过来的赔率结构。

---

## 1. 目标与判定口径

| 项 | 内容 |
|---|---|
| 主目标 | 通过 5k Classic 1-Step，拿 payout（用户 2026-10-26 确认） |
| 次目标 | Propr 作为第 7 个交易所接入本项目（工程资产，长期可复用） |
| 过关判定 | 在日损/回撤约束内把 equity 做到 **≥ 5,500**，且 attempt 状态变 `passed` |
| 工程判定 | shadow 读数与官方面板一致；写入路径幂等；风控门在断网/重启/权益过期时 fail-closed |

**这两件事的验收完全不同。** 工程做对 ≠ 能过；能过的打法也未必需要网格。

---

## 2. Propr 是什么

### 2.1 账户参数（Classic 1-Step，取自规则原文）

| 项 | 值 | 备注 |
|---|---|---|
| 账户规模 | $5,000 | 另有 10k/25k/50k/100k/200k |
| 评估费 | $60 | 不可退 |
| 利润目标 | $500（10%） | 无时限 |
| 日损上限 | 3% = $150 | **每天 00:00 UTC 以当日 balance 快照重算**；权益瞬时触碰即触发 |
| 最大回撤 | 6% = $300（静态） | 地板固定 $4,700，不随盈利上移 |
| 杠杆 | BTC 规则表 10x / 卡片 5x / API 5x | 三处不一致，见 §2.3 |
| 交易费率 | API 文档 0.075% maker 与 taker | 与规则页冲突，见 §2.3 |
| 可交易 | HL 全部永续，含 HIP-3（`xyz:AAPL` 等） | BTC 最小量 0.001 |
| 其余 | 无一致性规则、无最少交易日、无新闻/周末限制、允许 scalping/网格/bot | 规则 §14 |

### 2.2 合规红线（规则 §15，违者封号且无 payout）

1. **禁止跨 CEX/DEX/prop 账户对冲**同一标的**或相关标的**（例：Propr 做多 ETH、外部做空 SOL）。→ **不得用 HL 主账户对冲 Propr 敞口**，这条最容易犯。
2. **禁止同家庭/同设备/同 IP 操作多个账户**。→ 同一时间只能有一个 attempt 在跑，不能"网格一个 + 方向性一个"。
3. 禁止利用 Propr 价格源与 HL 链上执行之间的延迟（latency sniping）、自我成交/wash、刷评估费。
4. 执行模型是 **A-book/B-book 混合**，平台可自行决定是否真上链；PnL 对交易者一致，但**不要指望"链上可验证"意味着你的单一定进市场**。

### 2.3 三处官方自相矛盾（P0 实测项）

| # | 冲突 | 为什么要紧 |
|---|---|---|
| 1 | API 文档：maker **0.075%**、taker 0.075%；规则页：**"HL 标准费率原样透传、无加价"**（HL base maker 0.015%、taker 0.045%） | 差 5 倍。**网格的生死线是"间距 > 2×费率"**：7.5bp 时保本间距 15bp，1.5bp 时只要 3bp |
| 2 | 规则：**"杠杆自动应用，交易者不能改"**；API：`PUT /margin-config/{configId}` 可改；文档表格 BTC 10x、卡片 BTC 5x | 决定"1x"这个参数是否成立（附件假设可设 1x） |
| 3 | 文档：`GET /challenges` 标注 "No Auth"；实测 **401 `{code:10002}`** | 说明文档与实现有漂移，**任何"文档说"都要当假设** |

> 处理原则：**以实测为准，文档只作线索。** 三项都进 §7 的 M0 探针清单。

---

## 3. API 事实与坑

### 3.1 端点全景（OpenAPI 3.0.3，13 条 path）

```
GET  /health | /health/services                     无鉴权
GET  /users/me
GET  /challenges                                    文档说无鉴权，实测 401
GET  /challenge-attempts[?status=active]  → accountId
GET  /challenge-attempts/{attemptId}
GET  /accounts/{accountId}/orders                   支持 status=open 等过滤，默认 limit 20
POST /accounts/{accountId}/orders                   一次请求只允许 1 个入场单
POST /accounts/{accountId}/orders/{orderId}/cancel   成功返回 201（不是 200）
GET  /accounts/{accountId}/positions                含 markPrice/liquidationPrice/marginUsed
GET  /accounts/{accountId}/trades                   逐笔成交，含 fee/feeRate/liquidityType
GET  /accounts/{accountId}/margin-config/{asset}
PUT  /accounts/{accountId}/margin-config/{configId}
GET  /leverage-limits/effective
WS   wss://api.propr.xyz/ws   （X-API-Key 头；order.* / position.* / account.updated / trade.created）
```

**未文档化但 SDK 在用**：`GET /accounts/{accountId}` 返回 `balance / equity / availableBalance / totalUnrealizedPnl / highWaterMark` 等（Python SDK `get_account()`）。**这是唯一的 REST 权益来源**，OpenAPI 里没有它，必须实测其字段与语义。

### 3.2 十条硬约束（决定架构，不是实现细节）

| # | 事实 | 后果 |
|---|---|---|
| 1 | `positionSide` 有 long / short 两套；**卖单不带 `reduceOnly` 是开新空仓，不是平多** | 中性网格会同时持多空 → 双倍保证金、两个强平价、双向被套。**必须只跑单向网格** |
| 2 | 同一请求只允许 1 个入场单（`13066 MULTIPLE_ENTRY_ORDERS`） | `placeLimitOrders` 必须串行 fan-out；要处理"部分成功" |
| 3 | `GET /orders` **不能按 intentId 过滤** | 超时后无法"查单确认"，只能同 intentId 重发探活 |
| 4 | 相同资产同方向的多个订单会**合并成一个 position**，`positionId` 不变 | 不能靠 position 区分"我的单"；必须内部记账 |
| 5 | 全平后可能残留 `quantity:"0"` 且 `status:"open"` 的仓位 | 所有读取都要过滤 `quantity != 0` |
| 6 | 一个用户**只有 1 个 API key**，重新生成即失效旧的 | **换 key = 旧程序立刻 401**，这是最干净的写入锁 |
| 7 | 官方 JS SDK 的 `cancelAllOrders` 默认只取 20 条；`closePosition` 只平 `positions[0]` | 不能直接用 SDK；平仓要按方向分别平 |
| 8 | 官方 grid 示例用 `reduceOnly:false` 的卖单 | 照抄就在 5k 账户上开出双边仓 |
| 9 | `GET /trades` 没有 `since` 参数 | 增量同步要按 `tradeId` 去重 + 分页，不能按时间窗拉 |
| 10 | 费率 7.5bp 双边、`GTX` 支持、限频 1200 req/min | GTX 省不了手续费，只省点差与逆向选择；限频对 5s 轮询绰绰有余 |

### 3.3 与附件方案的逐条差异

| 附件判断 | 实际 | 影响 |
|---|---|---|
| "Propr 是 net 单向净仓" | **错**。双边独立持仓，卖单不带 reduceOnly 即开空 | 中性网格会双边持仓。**采纳附件提的 `positionEffect` 重构是过度设计**：只跑 long/short，现成的 `isReduceOnly()` 已经正确，核心代码一行不改 |
| "有 `getBalance()/getEquity()/getAccountState()`" | 文档 14 个端点里没有；只有未文档化的 `GET /accounts/{id}` 与 WS `account.updated` | 风控必须自己记总账 + 定期校准；取不到就 fail-closed |
| "批量 `placeOrders(orders)`" | 一次只能一个入场单 | 串行 fan-out；批量语义要自己承担 |
| "按 `intentId` 查询确认" | `GET /orders` 无 intentId 过滤 | 只能同 id 重发；`13084` 的真实语义要实测 |
| "杠杆 1x" | 规则说杠杆自动、不可改；API 有 PUT | **删掉这个参数**，用仓位控风险，杠杆只读不改 |
| "writer lease / 分布式租约" | 单 key + 换 key 即锁 + pid 锁文件足够 | 少写一层 |
| "19 项缺失 / 8–11 天" | 复用 `bot.js`/`audit.js`/`resume-guard.js` 后约 5–6 工日 | 排期砍半 |

**附件最大遗漏不是代码，是没算经济性**（§4）。

---

## 4. 可行性算术

### 4.1 网格：每格净利与所需格数

以 BTC ≈ $79,700、附件参数（0.004 BTC/格、间距 0.67%、费率 7.5bp/边）为例：

```
每格毛收入 = 间距 × 数量 = 536 × 0.004        = $2.14
每格手续费 = 2 × 0.075% × (0.004 × 79,700)   = $0.48
每格净利   =                                    $1.66
+$500 需要 = 500 / 1.66                       ≈ 300 格
保本间距   = 2 × 费率                         = 0.15%
```

**你自己的 23 天实测反推**：净 +$0.25、两次突破 −$16.68 → 毛收入 ≈ $16.9 → **约 8–10 个格** = **0.44 格/天**。按此节奏，300 格需 **≈ 2 年**。

### 4.2 180 天 1 小时回测（脚本 `challenge_baseline.py` + `grid_sim2.py`）

假设：HL 1h OHLC（BTC 57,768–87,471）、费率 7.5bp/边、突破边界 ±0.5% 即平仓 + 6h 冷却后重开、下一根 K 才武装补单（保守）、忽略资金费与部分成交。

| 参数（格数/间距/数量） | 60 天中位 | 23 天中位 | 23 天达标率 | 60 天格数 |
|---|---|---|---|---|
| 6 / 0.67% / 0.004（当前） | −$59 | −$19 | 0% | 53 |
| 12 / 0.67% / 0.003 | +$4 | −$0 | 0% | 60 |
| **20 / 0.50% / 0.002（最好）** | **+$26** | **+$0** | **0%** | 90 |
| 20 / 0.30% / 0.004 | −$152 | −$53 | 0% | 190 |
| 10 / 0.40% / 0.004 | −$155 | −$49 | 0% | 118 |

分解（6 格组，60 天）：毛格差收入约 **+$113**，突破平仓吃掉约 **−$172**。**手续费只有 $37，不是主要矛盾。**

> 结论：网格的收益被"区间外平仓"支配，而不是被费率或杠杆支配。加密 180 天里趋势占多数，网格赚的是小众行情。

### 4.3 挑战难度基线：被动杠杆多头（非策略，是零假设）

随机时点入场、持到 +10% / −6% / 单日 −3% / 60 天：

| 杠杆 | 通过率 | 触 6% 地板 | 触日损 | 中位过关天数 |
|---|---|---|---|---|
| 1x | 21.4% | 5.6% | **73.0%** | 11.2 |
| 2x | 14.6% | 4.6% | **80.9%** | 3.1 |
| 3x | 15.4% | 5.6% | 79.0% | 1.5 |
| 5x | 11.9% | 12.9% | 75.3% | 0.7 |

**日损 3% 是真正的杀手**：2x 多头只要 BTC 日内回撤 1.5% 就死。BTC 30 天收益中位 +3.0%，64% 的窗口 |涨跌| > 5%——方向不缺，缺的是"不在回撤里被扫掉"。

### 4.4 判定

| 打法 | 收益结构 | 与规则的关系 | 结论 |
|---|---|---|---|
| 网格 | 高频小赢 + 尾部大亏（短波动率） | 6% 硬地板把尾部变成死刑；300 次小赢才能换 1 次过关 | **能过，但要 ~2 年，且中途爆仓概率不低** |
| 被动杠杆 | 赌方向 | 日损线先于目标触发 | 不可行 |
| 小额多次方向性（≤1% 风险/笔，2–3R） | 低频中等赢 + 可控小亏 | 单笔风险 $40–50 天然不碰 $150 日损；6 次连亏才碰地板 | **唯一与规则形状匹配的结构** |

一句话：**网格不是"不够快"，是"赔率结构反了"。** 要过关，网格只能当"验证链路 + 极慢积累"的沙盒，不能当主武器。

---

## 5. 架构方案（工程接入）

### 5.1 目录

```
src/exchange/pr/
  index.js        createExchange(cfg.pr) → paper | propr
  propr.js        EventEmitter 适配器：轮询、状态、事件（对齐 hl/va 的写法）
  client.js       fetch 封装：X-API-Key、超时、错误分类、限频、重试
  mapper.js       order/position/trade → bot 结构；positionSide / reduceOnly 策略
  market.js       BTC 元数据（0.001 最小量）、价格与 K 线（来自 HL 公共接口）
  paper.js        本地模拟（真实行情、虚拟 5,000）
  errors.js       错误分类：retryable / terminal / benign / may-exist
src/risk/
  pr-risk.js      挑战风控门（纯函数 + 状态机 + 持久化）
docs/propr/       官方文档快照（api.md / websocket.md / rules.txt / openapi.json）
```

### 5.2 适配器契约（对齐 `GridBot` 现有用法）

```js
class ProprExchange extends EventEmitter {
  mode = 'paper' | 'shadow' | 'live';
  feeRate = 0.00075; displayFeeRate = 0.075;   // 实测后改
  balance = null; equity = null; realizedPnl = 0;   // 属性，不是方法
  supportsSafeOpeningRetry = true;
  orderBatchSize = 1;          // 服务端限制：一次一个入场单
  orderBatchPaceMs = 120;

  async init(); async reconnect();
  async getMarkets(); async getMarket(id);
  async getPrice(id);                          // HL allMids
  async getCandles(id, intervalSec, n);        // HL candleSnapshot（Propr 无行情接口）
  getPosition(id);                             // 返回净仓：{ side, sizeBase, entryPrice, ... }
  async fetchOpenOrders(id); getOpenOrders(id);
  adoptOrder(o); forgetOrder(id); forgetOrders(id);
  async placeLimitOrder(o); async placeLimitOrders(list);   // 内部串行
  async cancelOrder(id, orderId); async cancelAll(id);
  async closePosition(id);                     // 多空两侧分别平
  async setLeverage() { /* no-op：规则不允许交易者改杠杆 */ }
  start(); stop(); setPollLight(v);
}
// 事件：'fill' {orderId, marketId, side, price, sizeBase, levelIndex}
//       'price'{marketId, price} | 'error' Error
```

### 5.3 订单语义映射（写死成策略，不留自由发挥）

| 场景 | side | positionSide | reduceOnly | closePosition |
|---|---|---|---|---|
| 多头网格开仓 | buy | long | false | false |
| 多头网格平仓 | sell | long | **true** | false |
| 空头网格开仓 | sell | short | false | false |
| 空头网格平仓 | buy | short | **true** | false |
| 紧急全平 | 反向 | 现有方向 | true | **true** |

**不变量（代码里断言 + 启动检查）：**

1. `PR_MODE=live` 时 `gridMode=neutral` **启动即失败**（改用 long / short）。
2. 同一标的同一时刻最多一个方向的持仓；发现双向持仓 → 告警并只减不加。
3. 每个订单必须有 intentId 且落盘；重试复用同一 id。
4. 平仓腿必须 `reduceOnly`；返回"无仓可减"→ 丢单，不重试。
5. equity 缺失或过期 > 15s → 只允许撤单/平仓。
6. 杠杆只读不改。

### 5.4 风控门（`src/risk/pr-risk.js`）

| 参数 | 值 | 依据 |
|---|---|---|
| 官方日损 | $150 | 3% × 当日 00:00 UTC balance |
| 内部日软线 | $50 | 1/3 官方，触发降档 |
| 内部日硬线 | $100 | 留 $50 给瞬时穿透与估值误差 |
| 官方静态地板 | $4,700 | 6% |
| 内部总回撤线 | equity ≥ $4,850（$150） | 留 $150 缓冲 |
| 单侧最大库存 | `PR_MAX_INV_BTC`，默认 0.02 | 2% 逆行 = $32 |
| equity 新鲜度 | ≤ 15s | 超过则禁开仓 |

状态机：`NORMAL → THROTTLE(仅减仓) → HALT_NEW(只撤不平) → CLOSE_ALL → STOPPED`

- 只拦**开仓**，任何状态都允许撤单与平仓。
- 每天 00:00 UTC 用当时的 `balance` 重锚日损基准；锚点落盘，重启不丢。
- 每分钟检查一次 `challenge-attempts`：状态不是 `active` → 立即 STOPPED + 撤单 + 告警（被 breach 后继续挂单毫无意义）。

### 5.5 幂等与对账

- **intentId**：ULID，存在快照 `pendingIntents`；超时重发同一 id；若返回 `13084`，按"可能已存在"处理 → 拉 `status=open` 全量列表按 `(side, price, quantity)` 匹配。
- **撤单**：`status=open&limit=100` 分页拉全，逐张撤，再拉一次确认（复用 `bot.js` 的 `_cancelVerify*`）。
- **成交**：`GET /trades` 分页 + `tradeId` 去重；用 `feeRate` / `liquidityType` 校准真实费率。
- **仓位**：每次轮询取 long/short 两侧，过滤 `quantity=0`，合成净仓。
- **对账**：沿用 30s 节奏；重启后先"采纳"现有挂单（`adoptOrder`），再走 `resume`。

### 5.6 交接与写入锁（这是最容易出事的地方）

1. 旧程序停掉后，**在 Propr Settings 重新生成 API key** → 旧 key 立刻 401，物理上无法再写。
2. 新 bot 启动时校验三件事：`/users/me` 的 userId 与配置一致、`attempts?status=active` 只有一个、`accountId` 与 `PR_ACCOUNT_ID` 一致；任一不符 → 拒绝以 live 启动。
3. 本地 `pid` 锁文件 + 心跳；检测到另一个活进程持锁 → 拒绝启动。
4. **首次写入只允许发生在 free 账户**；付费挑战账户在 shadow 通过前保持只读。

### 5.7 server / dashboard 接线

`server.js` 已有 `BOTS` 注册表与按 prefix 的通用路由，接 `pr` 是 6 处小改：config 块、`createPrExchange`、`GridBot` 实例、`restore`、注册表、`resumeIfWasRunning`。

`public/index.html`（189KB / 3235 行 / 562 处 `va`）是唯一脏点。**v1 只加最小卡片**（余额/权益/持仓/挂单/启停/风控状态），不做全量美化。

---

## 6. 两条路线

### 路线 A：网格沙盒（工程验证，1–2 周）

- 目的：把适配器、风控门、交接、续跑在真实账户上跑通；**不指望过关**。
- 规模：0.001–0.002 BTC/格（$80–160 名义/格），满仓 ≤ $500 名义。
- 成功标准：连续 7 天无幻影单、无失控重试、重启能接管、风控线不误触发。
- 产出：一个"能安全挂在 5k 模拟账户上"的 Propr 适配器，之后接任何策略都能用。

### 路线 B：过关引擎（新模块，需先做研究）

- 结构：单笔风险 0.5–1%（$25–50），止损硬编码在交易所（`stop_market` + `reduceOnly`），目标 2–3R；日内累计亏损触 $50 即停手当天。
- 关键：**先证明有 edge 再上账户**。用本项目已有的回测框架在 BTC/ETH 1h–4h 上做 walk-forward；没有 >0.1R/笔的稳定 edge，就不要动 5k 账户。
- 注意：这条线**不能与网格账户并行**（规则禁止同 IP 多账户），必须二选一。

### 取舍建议

先做 A（工程资产，确定性高），B 单独评估。**不要在付费挑战账户上做 A 的第一次写入。**

---

## 7. 里程碑与验收

| # | 内容 | 工日 | 验收 |
|---|---|---|---|
| M0 | 只读探针（free 账户）：13 个端点 + WS，落 `docs/propr/PROBE.md` | 0.5 | 拿到真实字段；确认 feeRate、杠杆、`/accounts/{id}`、`13084`、双边持仓行为 |
| M1 | 适配器读路径 + paper + fixture 单测 | 1.5 | `npm test` 全绿；paper 能跑 1 小时无异常 |
| M2 | 写路径（下单/撤单/平仓/幂等） | 1.0 | mock 服务端覆盖部分成功、超时、13084、无仓可减 |
| M3 | 风控门 + 持久化 + 日切 + 重启 | 1.0 | 单测覆盖：日切、权益过期、breach 检测、重启重锚 |
| M4 | server/dashboard 接线 | 0.5 | 面板能启停、能看到风控状态 |
| M5 | shadow 24–48h（live 只读） | 1（日历） | 与官方面板逐项对齐，误差 < $0.5 |
| M6 | 交接 + free 账户小额写入 | 0.5 | 撤旧单 → 确认平仓 → 0.001 单格往返一次 |
| 合计 | | **≈5 工日 + 2 天日历** | |

M0 的探针清单（**全部只读，不含下单**）：

1. `GET /users/me`、`/challenge-attempts?status=active` → accountId、attempt 状态
2. `GET /accounts/{id}` → 字段全量（balance/equity/HWM/available）
3. `GET /accounts/{id}/positions` → 是否有双边、`quantity=0` 残留
4. `GET /accounts/{id}/orders?status=open&limit=100` → 6 张挂单的真实形态
5. `GET /accounts/{id}/trades?limit=100` → `feeRate`、`liquidityType`、`realizedPnl` 是否含费
6. `GET /margin-config/BTC`、`/leverage-limits/effective` → 实际杠杆
7. WS 连 60s → 事件形态、心跳、`account.updated` 的字段

---

## 8. 风险清单

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| 双边持仓 | 中性模式 / 误用 reduceOnly | 启动断言 + 只跑单向 |
| 订单黑洞 | 超时重发但服务端已建单 | intentId 复用 + 全量对账 |
| 权益估值漂移 | 未文档化端点变更 / WS 断 | 三源交叉（REST/WS/自记账）+ fail-closed |
| 瞬时穿透 | 权益贴线时 BTC 急动 | 内部线比官方线早 $50–150 |
| 费率误判 | 7.5bp vs 1.5bp | M0 用真实成交校准；间距下限按 2×实测费率 |
| 合规封号 | 跨所对冲 / 多账户 | 写进 README 与启动检查 |
| 平台风险 | B-book、规则单方解释、出金审核 | 只投评估费；不把大资金放进去 |

---

## 9. 待确认

1. free 账户的 `accountId` 与它是否也在 live 环境（决定 M0 落点）。
2. 付费挑战账户的旧程序什么时候停、由谁停；确认后我再动写入。
3. 只做 BTC，还是同时开 ETH/SOL（影响市场元数据与风控参数）。
4. 通知渠道沿用现有 `notify.js` 的 `source: 'pr'`？
5. 路线 B 是否立项（需要先做研究，不占本次工期）。

---

## 10. 附录

| 文件 | 内容 |
|---|---|
| `docs/propr/api.md` | 官方 REST 文档快照 |
| `docs/propr/websocket.md` | 官方 WS 文档快照 |
| `docs/propr/rules.txt` | 规则页纯文本（含费率、杠杆、红线原文） |
| `docs/propr/openapi.json` | OpenAPI 3.0.3 |
| `docs/propr/fetch_btc_1h.py` | 拉 180 天 BTC 1h K 线（HL 公共接口，免密钥） |
| `docs/propr/challenge_baseline.py` | 被动杠杆过关率基线 |
| `docs/propr/grid_sim2.py` | 网格 180 天滚动模拟（含突破/重启/费率敏感性） |

复跑：

```bash
python3 docs/propr/fetch_btc_1h.py        # 生成 docs/propr/btc_1h.json（已 gitignore）
python3 docs/propr/challenge_baseline.py  # 过关难度基线
python3 docs/propr/grid_sim2.py           # 网格滚动模拟
```

> 数据口径提醒：1h K 线、下一根 K 才武装补单、忽略资金费/部分成交——**回测偏保守**（真实成交次数可能更高），但结论方向不受影响：网格的瓶颈是区间外平仓，不是手续费。