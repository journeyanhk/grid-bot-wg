# Propr API 契约（Day-0 实测冻结）

- **日期:** 2026-09-23
- **环境:** Production `https://api.propr.xyz/v1`（Propr 官方：所有账户均为模拟账户）
- **账户:** $5K Free Trial（`type=paper`，`exchange=hyperliquid`，`currency=USDC`）
- **方法:** `scripts/propr-probe.mjs`（discover / readonly / order / idempotency / position）
- **结论一句话:** 接口可用、intentId 幂等有效、**持仓为 net（单向净仓）**、**权益字段权威可读**（更新时效已实测）。

---

## 0. 访问与网络

| 项 | 值 |
|---|---|
| Base URL | `https://api.propr.xyz/v1` |
| WS | `wss://api.propr.xyz/ws` |
| 认证 | `X-API-Key: pk_live_...`（1 key/用户，全账户权限） |
| 限频 | 1200 req/min |
| 健康 | `/health` → `{status:"OK"}`；`/health/services` → `{core:"OK"}` |

⚠️ **本机网络必须走代理**：`api.propr.xyz` 的 DNS 被污染（解析到 `127.0.0.1` / `1.1.1.1`，7ms 拒连），
`www.propr.xyz` 正常。实测系统代理 `http://127.0.0.1:10808` 可用。
Node fetch 不读系统代理，需 `PR_PROXY=http://127.0.0.1:10808`（探针已支持；适配器 Review 2 接入）。

⚠️ **accountId 不是 userId**：`.env` 误填 `urn:prp-user:...` 会导致 `403 does not own account`。
正确值来自 `getChallengeAttempts({status:'active'})[].accountId`（形如 `urn:prp-account:...`）。
探针 `discover` 命令可自动定位（完整值写 `.runtime/propr-discover.json`，已 gitignore）。

---

## 1. 账户与权益（对 ADR-004 的重大修正）

`getChallengeAttempt(attemptId)` 返回体包含 **`account` 权益对象**，无需本地派生：

```jsonc
{
  "account": {
    "type": "paper", "exchange": "hyperliquid", "currency": "USDC",
    "balance": "5000",
    "marginBalance": "5000",
    "crossWalletBalance": "5000",
    "availableBalance": "5000",
    "maxWithdrawAmount": "5000",
    "highWaterMark": "5000",
    "totalUnrealizedPnl": "0",
    "crossPositionMargin": "0", "crossOrderMargin": "0", "crossUnrealizedPnl": "0",
    "isolatedPositionMargin": "0", "isolatedOrderMargin": "0",
    "totalMaintenanceMargin": "0", "totalInitialMargin": "0",
    "marginLevel": null
  }
}
```

- `phases[]` 另有 `startingBalance` / `endingBalance`（active phase 下 `endingBalance="0"`，**不可当权益用**）。
- ⇒ 权益字段权威可读：日损 = `balance − 当日 UTC 起点 balance`；回撤 = `highWaterMark − balance`（或 `marginBalance`）。
- ⇒ ADR-004 升级为「权威字段 + 新鲜度校验」；派生逻辑仅作降级兜底。

### 1.1 权益刷新时效（2026-09-23 实测，`equity` 命令）

| 采样点 | balance | availableBalance | marginBalance | uPnL |
|---|---|---|---|---|
| baseline | 4999.776345 | 4999.776345 | 4999.776345 | 0 |
| 开仓 +0s | 4999.737402 | **4913.196402** | 4999.737402 | 0 |
| 开仓 +10s | 4999.737402 | 4913.196402 | 4999.737402 | 0 |
| 开仓 +30s | 4999.737402 | 4913.168902 | **4999.709902** | **−0.0275** |
| 开仓 +60s | 4999.737402 | 4913.191902 | 4999.732902 | −0.0045 |
| 平仓 +10s | 4999.682466 | 4999.682466 | 4999.682466 | 0 |

结论：

- **`balance`（已实现盈亏+手续费）即时更新**：开仓瞬间扣 taker 费、平仓瞬间结算 realizedPnl；
- **`availableBalance`（保证金占用）即时更新**：开仓立即锁定 ~86.5 USDC，平仓立即释放；
- **`unrealizedPnl` / `marginBalance` 延迟 ≤30s**（+0/+10s 为 0，+30s 出现，+60s 再次变化）；
- ⚠️ **`account.updatedAt` 粒度粗，不可作为权益新鲜度依据**：跨 +0/+10/+30/+60s 四次采样保持
  `02:47:37.739Z` 不变，仅在平仓后才跳到 `02:49:22.495Z`。新鲜度必须用**本地拉取时间戳** `equityFreshAt`。
- ⇒ 风控实现：`equitySource='propr_account'`、`equityFreshAt=本地拉取时刻`、超时未刷新 → `TRADING_LOCKED`；
  日损用 `balance`（即时可信），回撤用 `highWaterMark − balance`（可信），浮亏判断用 `marginBalance`（容忍 ≤30s 延迟）。

---

## 2. 市场、杠杆与费率

| 项 | 实测值 |
|---|---|
| `asset` 口径 | **`"BTC"`**（`"BTC/USDC"` 未测，且不需要）；`base=BTC` `quote=USDC` `productType=perp` |
| marginConfig | `{configId, asset:"BTC", marginMode:"cross", leverage:"1"}` |
| leverageLimits | `defaults:{crypto:2, equity:4, pre_ipo:4, index:5, commodity:5, fx:25}`；`overrides:{BTC:10, ETH:10, SOL:10, xyz:*:8~10}` |
| BTC maxLeverage | 10（平台上限；挑战规则另行收敛，第一版 1x） |
| maker 费率 | `0.00015`（限价单 `tradingFeeRate`） |
| taker 费率 | `0.00045`（市价成交 `feeRate`） |
| 数量精度 | `0.001 BTC` 实测接受；**探针发现 1e-7 也被接受**（API 层不校验） |
| 价格精度 | `43242.3`（1 位小数）实测接受；**探针发现 5 位小数也被接受** |
| 精度校验 | ⚠️ **API 层完全不校验**：1e-7 数量、5 位小数价格、名义 $0.87 的限价单均被接受且 4s 后仍 `open`（`exchangeOrderId=null`） |
| 适配器采用值 | **stepSize `1e-5` / stepPrice `0.1` / minOrderNotional `$10`**（HL BTC 保守规格，由适配器本地强制，`market.js: assertOrderPrecision`） |

---

## 3. 下单

- **`createOrders([...])` 保留调用方 `intentId`**（实测回显一致）→ 幂等键可用；`createOrder()` 会覆盖 intentId（项目禁用，见 task 4.5）。
- ⚠️ **`intentId` 必须是 ULID 字符串（2026-09-24 实测）**：传纯数字/非 ULID 会被框架层拒绝
  （`400 {"message":"Bad Request Exception"}`，无业务 code）。GridBot 传的是纯数字 `clientOrderId`
  （`bot.js:895`）→ 适配器必须自生成 ULID 并把原值留档为 `clientRef`（合法 ULID 才沿用）。
- ⚠️ **一次请求只允许 1 笔开仓单（2026-09-24 实测）**：多笔请求必须带**顶层** `orderGroupId`
  （ULID 格式，否则框架 400；不带则 `400/13059 order_group_id_required_for_multiple_orders`），
  带组后仍命中 `400/13066 only_one_entry_order_allowed_per_request`——实测「1 开仓 + 1 平仓」
  也被拒。⇒ **批量铺网不可用**：项目改为**串行逐笔下单**（适配器 `orderBatchSize=1`，
  `placeLimitOrders` 内部逐笔循环，对外仍返回与输入等长的结果数组）。
- ⚠️ **价格带限制（2026-09-23 实测）**：离市价过远的限价单会被拒——
  `[400] 13107: order_price_is_too_far_from_the_market_price`。
  实测 `0.5×`（-50%）可接受、`2×`（+100%）被拒；**边界未细测**，冒烟与网格一律用 ±10% 内。
- 限价单默认 `timeInForce=GTC`；市价单 `IOC`。
- 返回 `Order[]` 与输入等长。
- 订单字段（实测）：`orderId, intentId, orderGroupId, exchangeOrderId, positionId, exchange, productType, asset, base, quote, type, side, positionSide, timeInForce, quantity, price, reduceOnly, closePosition, cumulativeQuantity, cumulativeQuote, averageFillPrice, cumulativeTradingFees, tradingFeeRate, status, createdAt, updatedAt`。
- 创建瞬间 `exchangeOrderId=null`（异步路由到 Hyperliquid）。

---

## 4. 持仓模式 = net（单向净仓）【关键结论，情况 C】

实测步骤（账户基线空仓）：

1. 市价 `buy 0.002 / positionSide=long / reduceOnly=false` → 持仓 `long 0.002`。
2. 市价 `sell 0.001 / positionSide=short / reduceOnly=false` →
   - 成交记录：`{type:"reduce", side:"sell", positionSide:"long", positionSizeBefore:"0.002", quantity:"0.001"}`
   - 持仓变为 `long 0.001`（**反向单直接减仓，未产生独立空腿**）。

**结论：Propr 是净仓（one-way）模式**，`positionSide` 会被服务端按当前净仓方向归一化（情况 C：字段存在但实际聚合）。

影响：

- 中性网格必须实现为 **「双向挂单 + 净库存控制」**，不得宣称真正多空对冲；
- 方案阶段 **5A（net 降级）生效，5B（hedge 双向适配）不做**；
- `getPositions({base,status:'open'})` 最多 1 条净仓（`excludeZero` 默认 true）；
- 成交 `type` 枚举：`open` / `reduce` / `close`（可用于对账口径）；
- `reduceOnly` 仍生效（平仓链路实测通过）。

---

## 5. 幂等（intentId）

| 操作 | 结果 |
|---|---|
| 第 1 次提交固定 intentId | 成功，`orderId=urn:prp-order:...` |
| 第 2 次提交同一 intentId | **HTTP 500 + code 13084 `order_saga_idempotency_check_failed`** |
| 复查 open orders | 仅 1 条，**无重复** |

⇒ 幂等机制有效；但 **13084 是"冲突"语义，绝不能当 5xx 盲目重试**。已落地
`errors.js: isIdempotencyConflict()` → 分类 `idempotency_conflict`、`isRetryable=false`，
正确处置是**按 intentId 对账并返回既有订单**。

---

## 6. 订单状态与已知限制

- 文档枚举：`pending | open | partially_filled | filled | cancelled | rejected | expired`；实测见 `open`。
- `cancelOrder` 官方吞 400（视为已成交/已撤销）→ 适配器必须查实况复核。
- `cancelAllOrders` 逐笔循环、非原子。
- `closePosition` 官方只平 `positions[0]`（net 模式下够用，仍自实现并复核）。
- 分页默认 `limit:20/offset:0`，`getOrders/getTrades/getPositions` 需显式翻页（task 3.7）。

---

## 7. 冻结状态

### 已冻结（有实测依据）

1. Propr 账户为模拟账户（`type=paper`、`exchange=hyperliquid`、`currency=USDC`）
2. Base URL 与认证方式（`X-API-Key`，1200 req/min）
3. `accountId` 必须使用 challenge account ID（**不是 userId**，误填导致 403）
4. **positionMode = net（单向净仓）**
5. `positionSide` 不是独立 hedge leg（服务端按净仓归一化）
6. `createOrders` 保留调用方 `intentId`
7. 重复 `intentId` 不产生重复订单
8. `13084` 为幂等冲突，不可按 5xx 重试
9. `account` 对象含权威权益字段，且**刷新时效已实测**（`balance`/`availableBalance` 即时，
   `unrealizedPnl`/`marginBalance` ≤30s，`updatedAt` 不可作新鲜度依据）
10. BTC `asset` 口径 = `"BTC"`
11. 精度：API 层不校验（1e-7 / 5 位小数 / $0.87 均接受）；适配器采用 HL BTC 保守值
    `stepSize 1e-5 / stepPrice 0.1 / minNotional $10` 并本地强制
12. 本机访问必须走代理（`PR_PROXY`）

### 待验证（Review 2 专项）

1. ~~`stepSize` / `minOrderSize` / `minNotional` 精确边界~~ → 已完成：API 不校验，改用保守值本地强制
2. `highWaterMark` 更新规则（需盈利场景观测）
3. Free Trial 与付费 Challenge 的风控差异
4. 部分成交更新时机（`partially_filled` 与 `cumulativeQuantity`）
5. WebSocket 事件语义（`order.filled` / `trade.created` / `position.updated`）
6. 订单列表分页完整性（`limit:20/offset:0`）→ 适配器已实现全量翻页（`getAllOrders/Trades/Positions`）
7. 市价单在快速行情下的成交与滑点
8. 挑战日损/回撤日切是否与 UTC 一致（Free Trial 无风控约束，需付费账户验证）
9. 限价单 `exchangeOrderId` 何时落值（4s 后仍为 null；疑为路由/成交后才写）
