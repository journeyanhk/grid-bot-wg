# M1 设计决议（对 Review 的采纳与驳回）

> 2026-10-26 ｜ 基线 `feat/propr-adapter@6cf2ed8` ｜ 输入：M0 Review 报告
> 原则：**能写进代码 + 单测的约束，不写成散文。**

---

## 0. 基线（先量，再改）

| 项 | 结果 |
|---|---|
| `npm ci` | 通过（128 包） |
| `npm test` | **通过**（含 `va-auth` / HTML 交叉核对） |
| `npm run lint` | **可执行：0 error / 7 warning**（全是既有 `no-unused-vars`） |

> Review 里"lint 无法执行"是 checkout 没装依赖，不是代码问题。M1 的验收线：**error 保持 0，warning 不新增**。

---

## 1. 采纳（直接进代码）

### 1.1 `placeLimitOrders` 的返回契约（这是最要紧的一条）

Review 提议返回 `[{inputIndex, intentId, orderId, accepted, error}]`。方向对，但**必须补一条硬约束**：

```js
// src/bot.js _placeMany()
if (!Array.isArray(results) || results.length !== chunk.length) throw new Error('交易所批量下单返回数量不一致。');
```

即：**必须等长、同序**。少一项或乱序 → bot 判定整批失败 → 整批进重试队列 → **重复下单**。
所以适配器约定：

```js
// 永不抛整批错误；逐项返回，失败的项给 error 且不带 orderId
[{ orderId, price, sizeBase }, { error, code }, ...]   // 长度 === 入参长度
```

`inputIndex` 不必要（顺序即索引）。`orderBatchSize = 1`，把"批量"彻底退化成单发。

### 1.2 持仓：不要过早合并成"净仓"

采纳 Review 意见，拆成两个读法：

```js
getPositions(marketId)   // → { long, short }  原始两侧，含 liquidationPrice / marginUsed / leverage
getNetPosition(marketId) // → { sizeBase, dominantSide, long, short }  仅供展示与容量计算
getPosition(marketId)    // → 当前网格所管理的那一侧（GridBot 契约），并附 dualSide 标志
```

`dualSide === true` 时风控进 `REDUCE_ONLY`，只减不加。

> 顺带修正我自己在方案文档里的措辞：Propr "双边独立持仓"目前是**官方文档明写、实测未验证**的（M0 只看到 3 张 long 买单 + 3 张 short 卖单并存，没看到两个非零仓位并存）。设计按最坏情况做，但在写测之前不要把"已确认"写进结论。

### 1.3 Shadow 独立入口，不接 `server.js`

采纳。M1 只出 `scripts/pr-shadow.mjs`：只读、只打印对账摘要、退出码反映是否通过。
`server.js` 的通用路由（start/stop/cancel）会把安全边界搞复杂，M4 再接。

### 1.4 `writeAttemptCount` 硬计数器

采纳，放在 client 唯一的请求函数里：非 GET 先 `++writeAttemptCount` 再抛 `ProprReadOnlyError`。
shadow 退出时断言 `=== 0`；非 0 直接非零退出码。

### 1.5 错误层：3 类 + 分类函数（不采纳 7 类）

```js
ProprApiError      // status, code, endpoint, retryable, mayExist
ProprReadOnlyError // shadow 下的写尝试
ProprStaleError    // 快照过期
classify(err) → { retryable, terminal, benign, mayExist }
```

Review 提的 `SchemaError` / `PaginationError` **不该是 API 错误类型**：它们是我们的 bug，应当直接抛 `Error` 让单测红掉，而不是被上层"优雅重试"。

### 1.6 批量执行的落点

`src/exchange/pr/batch.js`：`placeBatch()` 串行执行 + 逐项聚合，`assertBatchShape()` 校验等长同序，`toBotResults()` 转成 bot 形态。M1 只测契约，M2 把 `placeOne` 换成真实 `POST /orders`。

### 1.7 分页与去重

- 订单/持仓：`limit=100` 循环到不足一页；**记录页数**，超过上限（默认 20 页）抛 pagination 异常，不静默截断。
- 成交：`tradeId` 为主键去重（不按时间戳）；维护 `seenTradeIds` LRU（上限 5,000）。
- 持仓过滤：`quantity != 0` **且** `status != 'closed'`（实测残留是 `closed`，与文档写的不一样）。

---

## 2. 驳回（并说明理由）

### 2.1 "当前杠杆不是 1x 就拒绝启动"

**驳回。** 三个理由：

1. 规则明说杠杆"由平台自动应用"，用户/平台随时可能改；硬拒绝会让 bot 在非风险状态下起不来。
2. 全仓（cross）模式下杠杆只影响**保证金占用与最大名义**，不改变权益风险曲线；权益风险由仓位大小决定。
3. 付费账户交接时杠杆可能已被旧程序改过，硬门槛会直接卡住切换。

替代做法：**读杠杆 → 算容量 → 夹住库存**，且**容量不随平台杠杆扩张**：

```text
maxOpenNotional = min(PR_MAX_INV_USD,
                      availableBalance × min(leverage, PR_CAPACITY_LEVERAGE) × 0.8)

PR_MAX_INV_USD      = 1500   # 固定风险上限
PR_CAPACITY_LEVERAGE = 1     # 平台报 10x 也只按 1x 算
leverage > 3x → 告警（不是拒绝，也不放大）
```

实现：`src/exchange/pr/shadow.js computeCapacity()`，单测 `test/propr-shadow.test.js`。

### 2.2 "active attempt 不唯一就拒绝启动"

**驳回（会直接卡住你自己的账户）。** 当前用户有 **2 个 active attempt**：free-trial（D7D3…）与 Starter 1-Step（CRG9…），这是平台允许的状态。

正确校验：

```text
1. PR_ACCOUNT_ID 必须精确命中 attempts 里的某一个 accountId
2. 该 attempt 的 status 必须是 active
3. 若同一 accountId 命中多条 → 拒绝（异常状态）
4. 不要求"全局只有一个 active attempt"
```

另外加一条**运行期**检查（比启动检查更有用）：每 60s 读一次 attempt 状态，非 active → `STOPPED` + 撤单 + 告警。

### 2.3 "paper 要模拟 GTX / 部分成交"

**部分驳回。** paper 的职责是**策略与账本**，不是撮合保真度：

- 要模拟：long/short 两本账、`reduceOnly` 无仓可减时拒单、按 `feeRate` 扣费、成交去重。
- 不模拟：部分成交、GTX 排队、盘口深度——这些在 paper 里造假，只会让人误判真实成交率；部分成交的**处理**逻辑用 mapper 单测覆盖（喂 `cumulativeQuantity` 分段的 fixture）。

### 2.4 "先写一份设计决策文档再动代码"

**形式采纳、位置调整。** 不新开一份纯散文文档，直接落在这里 + 代码断言 + 单测三条腿。文档会漂移，测试不会。

---

## 3. M1 验收（可机检）

| # | 判据 | 检查方式 |
|---|---|---|
| 1 | shadow 期间 `writeAttemptCount === 0` | 进程退出码 + 摘要行 |
| 2 | 远端 open orderId 集合与本地快照一致 | 每轮 diff，连续 3 轮为 0 |
| 3 | long/short 两侧数量、均价、强平价与快照一致 | 每轮 diff |
| 4 | 分页无截断（订单/成交） | 记录页数；不足一页才停 |
| 5 | `tradeId` 无重复计费 | seen 集合 + 重复计数 = 0 |
| 6 | 断网/401/429 后能恢复，且状态降级为 `stale` 而非继续"假装正常" | 注入故障 |
| 7 | 重启后能接管同一 accountId，且不重复计数 | 重启一次对比 |
| 8 | `marginBalance` 与成交增量自洽 | `Δbalance ≈ Σpnl − Σfee + funding`，容差 $0.5 |

> 第 8 条替换 Review 的"与 dashboard 差异 < 0.5"：dashboard 没有机器可读接口，无法自动验收。实测已知账本残差来自资金费（trades 无 funding 字段），所以只能做**增量自洽**，不能做绝对值对齐。

---

## 4. 仍然未验证的三件事（写测前不要写进结论）

1. 双边持仓能否**同时非零**存在（文档说会，实测未见）。
2. `POST /orders` 命中相同 `intentId` 时返回原单还是 `13084`。
3. `PUT /margin-config` 是否真的被接受（规则说不可改）。

这三条都必须在 **Free Trial 账户**上用最小单验证，且各只发 1–2 次写请求。