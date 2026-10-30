# Arcus 第一阶段：停机审查与变更计划

> 状态：**HALTED / FLAT / NO ORDERS**（equity 245.414，position 0，open_orders 0，running=false）
> 冻结时间：2026-10-30 10:34 (+08:00)
> 基线 commit：`e65f266`（v1.6.42）｜ `.state.json` md5 见 `~/halt-backup-1030-1034/git.txt`
> 本文档**不含任何已执行的主网写操作**，全部为只读核对、分析与待批事项。

---

## 0. 冻结确认（已完成）

| 项 | 结果 |
|---|---|
| 备份 | `~/halt-backup-1030-1034/`（1.4 MB）：`.state.json`、`gridbot-mainnet.log`、`arcus-mainnet-metrics.jsonl`、`watchdog.log`、脱敏 env 快照、commit + md5 |
| 快照内容 | `.state.json` 为分交易所结构 `{ai, ar}`；`ar.running = false`；无 `wasRunning` 字段 |
| 自动恢复（第一道） | `run_grid_mainnet.sh` 有闸门：`.state.json` 存在且 `ALLOW_STATE!=1` → **拒绝启动**（本意是防 testnet 快照污染主网，现兼作冻结器） |
| 自动恢复（第二道） | `server.js:resumeIfWasRunning` 首行 `if (!(snap?.running && snap?.config)) return;` → `running=false` 时不会续跑 |
| 自动恢复（第三道） | 无 crontab、无 systemd 单元；`watch_grid.sh` 只在 API 连续 3 次非 200 时 `pkill`，不会拉起 |
| 结论 | **当前状态下即使 node 崩溃，也不会自动铺单。** 代价是服务无法重启，恢复时必须先 `mv .state.json .state.bak` |

---

## 1. reduce-only 语义核对（只读）

### 1.1 证据链

| 编号 | 来源 | 原文要点 |
|---|---|---|
| E1 | `concepts/perpetuals/order-types.md` | TP/SL orders **are reduce-only** — "they can only shrink a position, **never flip or grow it**" |
| E2 | `api-reference/exchange/place-order.md`（错误码 `REDUCE_ONLY_WOULD_INCREASE`） | "A `reduceOnly` order **was rejected** because executing it would have opened or increased the account's position rather than reducing it." |
| E3 | 同上（错误 schema `ReduceOnly`） | "A reduce-only order would open or increase a position rather than reduce it." |
| E4 | `changelog.md` | "`placeOrder` and `modifyOrder` now accept `reduceOnly: true` with **any `timeInForce`** — the previous constraint forcing reduce-only orders to be IOC or FOK is removed. **Reduce-only position semantics are enforced**" |
| E5 | `place-order.md` 请求体 | 字段名是 **`reduceOnly`（boolean）**，不是 `r`；`r` 只出现在签名载荷 |
| E6 | `place-order.md` 响应体 | 响应**会**回显 `reduceOnly` |

### 1.2 我们代码的实际行为

```
bot.js:1502/1510  _place({ side, price, reduceOnly: true, recovery: true, opening: false })
       ↓
bot.js:962        const reduceOnly = o.reduceOnly ?? isReduceOnly(...)
       ↓
arcus.js:858      body.reduceOnly = !!o.reduceOnly          ← 正确字段名
arcus.js:850      签名载荷 r: o.reduceOnly ? 1 : 0           ← 简写仅用于签名
```

调用链**没有断点**，body 确实带了 `reduceOnly: true`。

### 1.3 —— 已由 P1 实测解答（2026-10-30 10:46，testnet only）

**原假设"校验发生在成交时刻"是错的。** 实测结论：**Arcus 在下单时就校验 reduce-only 语义，并用 `HTTP 200 + status:"REJECTED"` 表达拒绝。**

| 实验 | 场景 | 交易所响应 | 仓位变化 |
|---|---|---|---|
| E1 | SHORT −0.00591704 + reduceOnly **SELL** 0.0002（会增空） | `200 {orderId:"bb5cb17f…", status:"REJECTED"}` | 无变化 |
| E2 | SHORT −0.00591704 + reduceOnly **BUY** 0.0002 | `200 {orderId:"4aa90907…", status:"FILLED"}` | → −0.00571704（精确 −0.0002） |
| E4 ★ | **空仓** + reduceOnly SELL 0.0002 | `200 {orderId:"20359ed4…", status:"REJECTED"}` | 仍为 0，**未开仓** |
| E5 | LONG +0.0002 + reduceOnly SELL 0.0002 | `200 {orderId:"29a26696…", status:"FILLED"}` | → **0，未翻转** |

成交 ID `5037611`–`5037615` 等共 13 笔，全部 TAKER（IOC 主动成交）。收尾 `position 0 / openOrders 0`。

**语义结论：reduce-only 只减不翻；空仓或错误方向下单即被拒。`recover` 回收阶梯的立论成立。**

### 1.4 由此发现的**真实生产级 bug**（已修）

拒绝不是 HTTP 错误码，而是 **HTTP 200 + `status:"REJECTED"`**。而原适配器只判断 `orderId` 是否存在：

```js
const orderId = j?.orderId ? String(j.orderId) : ...
if (!orderId) throw ...
this._tracked.set(orderId, {...})   // ← 被拒的单也进了台账
```

后果：**一张根本没进撮合的单被登记为"已挂出"**，成为幽灵单源头——对账时"本地有、交易所无"，进而可能触发 `massVanish` 误判、`recover` 阶梯假装已挂好、refill 统计虚高。

修复：`placeOrder` 在写 `_tracked` 前检查 `status`，`REJECTED/CANCELED/CANCELLED` 一律抛错并带 `rejected:true`。回归用例已加（`test/ar.test.js` **41 passed / 0 failed**，全量 `npm test` EXIT 0）。

### 1.5 残留风险（已降级）

| 项 | 状态 |
|---|---|
| "空仓 reduceOnly 会开空仓" | **已排除**（E4 实测被拒） |
| "字段传错成 `r`" | **已排除**（body 字段名 `reduceOnly` 正确） |
| 挂单后仓位被平、单仍在簿、成交是否开仓 | **仍未知**。下单校验已确认，此类单只能来自"先有仓、后平仓"路径；P3 状态机需加"reduce-only 单 ↔ 仓位一致性"检查 |
| 08:23 那 66 张单的真实成因 | **仍未定位**。按本次结论，空仓下不可能挂出 reduceOnly 单——要么当时有仓，要么该批次 `reduceOnly` 在批量路径 `_placeBatch` 丢失，P3 前需查透传 |

---

## 2. reduce-only 验证方案（**P1 已于 2026-10-30 10:46 执行完毕**）

**执行摘要**：testnet 账户 `0x6dac…798D` / accountIndex 1 / marketId 1，仓位从历史遗留 `SHORT −0.00591704` 起手，经 E1–E5 四段实验最终 `position 0 / openOrders 0`。脚本 `scripts/verify-reduce-only.mjs`（只连 testnet，代码内硬断言拒绝 mainnet），报告 `/tmp/reduce-only-report.json`。

**结论**：语义通过（详见 §1.3），并暴露 §1.4 的幽灵单 bug（已修）。**未触碰主网。**

以下 2.1–2.3 为原始方案，保留作复现与再次验证的依据；2.2（主网验证）**不再需要**。

### 2.1 优先在测试网（零成本、零风险）

testnet 与 mainnet 共用同一套 API 与文档，账户 `0x6daC…798D` / accountIndex 1 / key `36fda331…`。
若 testnet 余额已耗尽，用官方 faucet 补（`guides/fund-testnet-account.md`）。

**步骤（testnet）**
1. 读基线：`GET /v1/positions` → 期望 `positions {}`
2. 建仓：`placeOrder` **普通**（`reduceOnly:false`）BUY 0.0002 BTC，价格 = 对手价（IOC/ALO 均可），**确认成交**
3. 复核：`GET /v1/positions` → 期望 `LONG 0.0002`
4. 挂减仓单：`placeOrder` SELL 0.0002，`reduceOnly: true`，价格略低于对手价使其成交，TIF=ALO 或 IOC
5. 复核：`GET /v1/positions`
6. 判定

**判定矩阵**

| 结果 | 结论 | 动作 |
|---|---|---|
| `+0.0002 → 0` | **通过** | `recover` 逻辑成立，可继续 |
| 订单被拒，错误码 `REDUCE_ONLY_WOULD_INCREASE` / `ReduceOnly` | **通过（更严格）** | 说明无仓时会被拒，需在下单前本地拦截 |
| `+0.0002 → -0.0002` | **失败** | 立即冻结全部主网网格计划，`recover` 必须重写 |
| 订单挂上但不成交 / 状态不明 | **未通过** | 视为不确定，不得上线 |

**收尾**：确认 `positions 0`、`open_orders 0`、无残余普通开仓单。

### 2.2 若只能在主网做

必须单独一次人工批准，**不与网格重启混在一起**。

- 仓位上限：0.0002 BTC（约 $15.4 名义，10x 下保证金 $1.6）
- 挂单数：最多 1 张
- **不启动网格**、不启用自动补腿、不启用 recover
- 最大可接受损失：往返手续费 + 滑点 ≈ **$0.05**
- 异常处理：任一步失败 → `cancelAllAccount` + `closePosition` → 复核归零
- 全程记录 placeOrder 的**完整响应体**（拿到 `reduceOnly` 回显）

### 2.3 无论结果如何都要补的代码

`arcus.js` 需捕获 `REDUCE_ONLY_WOULD_INCREASE` / `ReduceOnly` 错误码，转为**撤单 + 告警**，而不是进入重试队列（否则无仓的回收单会无限重试）。

---

## 3. 趋势防守状态机（设计）

### 3.1 四态

```
RUNNING ──(破界/库存偏置/成交偏置)──> DEFENSIVE ──(升级)──> HALTED
   ^                                      │
   │                                      └──> RECOVERY_PENDING ──(人工批准)──> RUNNING
```

| 状态 | 允许的动作 | 禁止的动作 |
|---|---|---|
| `RUNNING` | 正常双向铺格、补腿、对账 | — |
| `DEFENSIVE` | 减仓腿、平仓、撤单、对账 | 新增**开仓腿**、自动重锚、因成交自动恢复 |
| `HALTED` | 撤单、平仓、只读 | 任何下单 |
| `RECOVERY_PENDING` | 只读 + 发人工提醒 | 自动铺回 |

### 3.2 触发规则（第一版：可审计，不依赖 ADX）

设 `maxInventory = sizeBase × gridCount`（当前满梯当量），`inv = |position|`，`bias = inv / maxInventory`。

**A. 破界规则**
- `lastPrice < lower` 或 `> upper` → 立即 `DEFENSIVE`
- 不允许自动重锚；不允许因成交事件自动回到 `RUNNING`

**B. 库存偏置规则**
- `bias ≥ 0.50` → `DEFENSIVE`
- `bias ≥ 0.75` → 停止该方向全部开仓腿（`DEFENSIVE` 的强化形态）
- `bias ≥ 1.00` 或仓位方向与台账不符 → `HALTED`

**C. 成交偏置规则**
- 统计最近 **20 笔**与最近 **60 分钟**成交
- 若开仓方向成交占比 ≥ 75% 且库存同向继续增加 → `DEFENSIVE`
- 防守态中**不得**因成交量大而继续补格

**D. 恢复规则（全部满足才进 `RECOVERY_PENDING`）**
- 价格回到 `[lower, upper]` 内
- 连续 **2 根 1h K 线收盘**站稳下沿（`close > lower`）
- `bias ≤ 0.10`（或 `position = 0`）
- 未成交订单已清理（`openOrders` 与台账一致）
- `outOfRange = false`
- 账本与交易所仓位/成交/余额一致，无未知成交、无重复补腿、无漂移异常

`RECOVERY_PENDING` **只发提醒，不自动铺格**。

**E. 可审计要求**
每次状态变化写一行结构化日志：`[defense] STATE A->B reason=<rule> bias=0.62 inv=0.0033 max=0.0066 px=77110 lower=72021 ts=...`

---

## 4. 新参数计算（**不启动**）

基准价 `P = 77,110`（2026-10-30 10:26 现价），费率 maker 150 ppm / taker 450 ppm（实测 142 ppm）。

### 4.1 新方案

| 项 | 计算 | 值 |
|---|---|---|
| grid spacing | `P × 0.2%` | **$154.22** |
| grid count | — | 66 |
| 区间宽度 | `66 × 154.22` | **$10,178.52**（±6.6%）|
| lower | `77,110 − 5,089.26` | **$72,020.74** |
| upper | `77,110 + 5,089.26` | **$82,199.26** |
| 单格 sizeBase | — | **0.0001 BTC** |
| 名义敞口（满梯） | `66 × 0.0001 × 77,110` | **$508.93** |
| 保证金（10x） | `508.93 / 10` | **$50.89** |
| 单格毛利 | `154.22 × 0.0001` | **$0.015422** |
| 单格双边费 | `2 × 150ppm × 0.0001 × 77,110` | **$0.002313** |
| 单格净利 | 毛利 − 费 | **$0.013109** |
| 盈亏平衡格距 | `2 × 150ppm` | **0.03%（$23.13）** |
| 满仓最大库存 | `66 × 0.0001` | **0.0066 BTC** |
| 理论最大浮亏 | 满仓 0.0066 × 区间宽 10,178.52 | **$67.18** |

### 4.1.1 止损 `$60` 的准确定义（修正）

> 原文写"止损 $60 < 理论最大浮亏 $67.18，参数自洽"——**这个推论不成立**，二者不是同一量纲上的上限关系。

`AR_STOP_LOSS_USD=60` 的实际语义是 **A：触发阈值**，且仅覆盖一个特定口径：

```
当前持仓按【盘口价】计算的未实现亏损 ≥ $60  →  触发平仓
（bot.js:_quoteUnrealized，(lastPrice − entry) × size；lastPrice 缺失时退回交易所字段）
```

它**不是**以下任何一项：

| 选项 | 是否成立 | 原因 |
|---|---|---|
| A. 触发阈值 | **是** | 代码实现即此 |
| B. 预期损失 | 否 | 无统计定义 |
| C. 最大允许损失 | **否** | 见下 |
| D. 单市场止损价格距离 | 否 | 不以价格距离表达 |
| E. 账户级 HALT 线 | 否 | 目前不存在 |

**为什么 $60 不是最大损失上限**：① 跳空/快速行情下触发时浮亏可能已超 $60；② 市价平仓有滑点；③ 之前累计的**已实现亏损不计入**（10-30 那次 −$4.59 就完全绕过了它）；④ API/死手延迟期间仓位继续恶化。

**理论最大浮亏 $67.18 的正确读法**：它是"满仓 0.0066 BTC + 价格走完整个区间"的极端估算，用来判断**参数是否会被击穿**，不是止损的保障范围。二者关系应表述为：*极端情形下浮亏可能超过 $60 触发线，因此止损不是硬上限。*

**因此必须补一条真正上限**（列入 P3）：

```
账户级 HALT 线：equity ≤ startBalance − 80  →  HALTED
  停止一切开仓、撤销非减仓订单、只允许人工恢复
```

$80 取在 $60 之上留 33% 余量，用于吸收跳空与滑点，使"策略累计亏损"有真正的天花板。

### 4.2 与旧参数逐项对比

| 项 | 旧（0.1% / 0.0002） | 新（0.2% / 0.0001） | 变化 |
|---|---|---|---|
| 格距 | $80.09 | $154.22 | ×1.93 |
| 区间宽度 | $5,286（±3.3%）| $10,178（±6.6%）| **×1.93** |
| 名义敞口 | $1,057.19 | $508.93 | **−52%** |
| 保证金 | $105.72 | $50.89 | **−52%** |
| 单格毛利 | $0.016018 | $0.015422 | −4% |
| 单格净利 | $0.011200 | $0.013109 | **+17%** |
| 满仓库存 | 0.0132 BTC | 0.0066 BTC | **−50%** |
| 理论最大浮亏 | $69.83 | $67.18 | −4% |
| 区间 / ATR($1,103) | 4.8× | **9.2×** | +92% |
| 格距 / ATR | 13.8 格 | 7.2 格 | 穿格频率约减半 |

**结论边界（按审核意见修正）**：

- **成立的部分**：最大名义与保证金约减半；区间/ATR 从 4.8× 提到 9.2×，破界概率下降；**单格**净利从 $0.0112 升到 $0.0131。
- **不成立的部分**：**不能说"收益反升"。** 总收益 = 单格净利 × 实际成交格数，而格距翻倍会让穿格频率约减半，两者相乘方向未知；再叠加单边停留时间变长、防守态主动减少成交、funding 与滑点。
- **正确表述**：新参数的目标是**降低最大库存与破界概率，同时保持单格经济性**；总收益是否改善必须用 24–48 小时真实成交样本验证，不能用推算代替。

### 4.3 资金占用

equity 245.41，新方案保证金 $50.89，占用率 **20.7%**，可用余量 $194.52。远低于旧方案的 43%。

---

## 5. 需要修改的代码文件与函数

| 文件 | 函数 / 位置 | 改动 | 估计行数 |
|---|---|---|---|
| `src/bot.js` | 新增 `_evalDefense()` | 四态判定核心，每轮 `_tick` 调用 | ~90 |
| `src/bot.js` | 新增 `_enterState(state, reason)` | 状态迁移 + 结构化日志 + 告警 | ~40 |
| `src/bot.js` | `_place` / `_placeBatch` 入口 | `DEFENSIVE`/`HALTED` 时拦截 `opening` 腿 | ~15 |
| `src/bot.js` | `_refill` / `_replenish` / `seedOrders` | 同上，加状态守卫 | ~20 |
| `src/bot.js` | `_tick` | 挂载 `_evalDefense()` | ~5 |
| `src/bot.js` | `start()` | 初始化 `this.defense = { state:'RUNNING', ... }` | ~10 |
| `src/bot.js` | `state()` | 暴露 `defense` 块 | ~8 |
| `src/config.js` | `getConfig()` | 新增 `defense` 配置块（默认关闭，仅 Arcus 开） | ~15 |
| `src/exchange/ar/arcus.js` | `placeOrder` catch | 捕获 `REDUCE_ONLY_WOULD_INCREASE`/`ReduceOnly` → 撤单 + 告警，不进重试队列 | ~20 |
| `src/server.js` | `/api/<key>/state` | 透出 `defense` | ~3 |
| `.env.example` | — | `AR_DEFENSE_ENABLED`、`AR_DEFENSE_INV_WARN=0.5`、`AR_DEFENSE_INV_STOP=0.75`、`AR_DEFENSE_INV_HALT=1.0` | ~6 |

**总改动约 230 行，集中在 `bot.js`，默认关闭，不影响其他 6 个交易所。**

---

## 6. 测试计划

### 6.1 单元测试（`test/defense.test.js`，新增）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 价格跌破下沿 | `state === 'DEFENSIVE'`，`opening` 腿被拦截 |
| 2 | bias 0.49 → 0.51 | 不迁 / 迁移各一次，边界准确 |
| 3 | bias 0.76 | 该方向开仓腿为 0，减仓腿照常 |
| 4 | bias ≥ 1.0 | `HALTED` |
| 5 | 成交偏置 75% + 库存同向增长 | `DEFENSIVE` |
| 6 | 恢复条件缺一项 | 不进 `RECOVERY_PENDING` |
| 7 | 恢复条件全满足 | 进 `RECOVERY_PENDING` 且**不发任何下单** |
| 8 | 状态变化日志格式 | 含 `rule`/`bias`/`px`/`ts` 字段 |
| 9 | `reduceOnly` 错误码 | 触发撤单，不进重试队列 |

### 6.2 集成测试（本地 paper / testnet）

| # | 场景 | 验收 |
|---|---|---|
| 1 | 0.2%/66/0.0001 在 paper 跑 1 小时 | 铺满 66 档、无空洞、无异常日志 |
| 2 | 人工把价格推到区间外 | 60s 内进 `DEFENSIVE`，无常驻开仓腿 |
| 3 | 人为制造 bias 0.8 | 该方向停开仓，减仓仍工作 |
| 4 | 满足全部恢复条件 | 只发提醒，不自动铺格 |

---

## 7. 回滚方案

| 层 | 回滚动作 | 耗时 |
|---|---|---|
| 代码 | `git revert` 到 `e65f266`（v1.6.42），`npm test` 全绿后部署 | 5 min |
| 配置 | `AR_DEFENSE_ENABLED=false` 即回到旧行为（无需回滚代码） | 1 min |
| 运行 | 任何时候 `POST /api/ar/stop {"closePosition":true}` → 撤单平仓 | 2 s |
| 快照 | `~/halt-backup-1030-1034/.state.json` 覆盖回去可恢复停机前台账 | 1 min |
| 服务启动 | 必须先 `mv .state.json .state.bak`（否则 supervisor 拒绝启动） | — |

---

## 8. 仍然存在的风险

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | ~~reduce-only 语义未实测~~ | **已关闭** | P1 实测通过：只减不翻、空仓即拒；顺带修掉 `REJECTED` 幽灵单 bug |
| R8 | 先有仓挂出 reduce-only 单 → 仓位被平 → 单仍在簿 → 成交是否开仓 | 中低 | 下单时校验已确认，此类单只能来自"挂单后平仓"路径；P3 增加"reduce-only 单 ↔ 仓位一致性"巡检，仓位归零即撤掉全部 reduce-only 单 |
| R2 | 0.2% 格距下成交量可能低到无法覆盖成本 | 中 | 24–48h 实测；若日成交 < 10 格则回看 0.15% |
| R3 | 0.0001 恰等于 `minOrderSize`，部分成交后残余（0.000085）仍会低于最小量 | 中 | 已有 `_dustPromoted` 机制；本轮 54/377 笔部分成交已验证该路径 |
| R4 | testnet 行情与主网脱节，防守逻辑只能在主网验 | 中 | 状态机为纯本地计算，不依赖行情质量 |
| R5 | `.state.json` 闸门使服务无法重启，若忘记 `mv` 会误判"进程挂了" | 低 | 已写入本文档；巡检脚本应识别该状态 |
| R6 | 资金费未计入网格收益核算 | 低 | 持仓 2.5 天资金费 < $0.05，量级可忽略，但应在台账里显式记录 |
| R7 | 主网 API key 2027-04-25 到期 | 低 | 加入巡检清单到期提醒 |

---

## 9. 等待人工批准的操作清单

> 在你明确回复之前，以下**全部不执行**。

| # | 操作 | 需要批准的关键字 | 影响面 | 状态 |
|---|---|---|---|---|
| P1 | testnet 验证 reduce-only 语义 | 「批准测试网验证」 | 仅测试网，零主网风险 | ✅ **2026-10-30 10:46 完成，通过** |
| P2 | 主网 reduce-only 验证 | 「批准主网验证」 | 主网 0.0002 BTC | ❌ **不再需要**（testnet 已验证） |
| P3 | 部署防守状态机代码（不启动网格），含账户级 HALT 线 | 「批准部署防守逻辑」 | 代码上线但 `running=false` | ⏳ 待批 |
| P4 | 以新参数 0.2%/66/0.0001 启动网格 | 「批准启动新参数」 | 主网实盘，保证金 $50.89 | ⏳ 待批（前置：P3 完成 + 价格回到区间内） |
| P5 | 恢复 0.0002 BTC 单格 | 「批准升回 0.0002」 | — | ⏳ 待批（前置：P4 后 24–48h 数据） |

### P4 放行前置条件（缺一不可）

1. P1 reduce-only 通过 —— ✅ 已满足
2. P3 防守状态机部署完毕并通过本地测试（含 §6 全部用例）
3. 价格重新满足 §3.2-D 恢复条件（回到区间内 + 连续 2 根 1h K 线站稳下沿 + 无库存 + 无遗留单）
4. 按届时实时价格重算区间与最大库存（本文 §4 的 77,110 基准已过期）
5. 手续费、止损、保证金、账户级 HALT 线四项口径复核

---

## 10. 变更记录

| 日期 | 变更 | 位置 |
|---|---|---|
| 2026-10-30 10:34 | 冻结：撤单 + 停机 + 备份 `~/halt-backup-1030-1034/` | 东京主机 |
| 2026-10-30 10:46 | P1 执行：testnet 四段实验，13 笔成交，收尾 `position 0 / openOrders 0` | `scripts/verify-reduce-only.mjs` |
| 2026-10-30 | 修复 `placeOrder` 把 `status=REJECTED` 当成功（幽灵单） | `src/exchange/ar/arcus.js` |
| 2026-10-30 | 新增回归用例（41 passed / 0 failed） | `test/ar.test.js` |
| 2026-10-30 | 按审核意见修正 §4.1（$60 定义）与 §4.2（收益边界） | 本文档 |

### 当前状态声明

```
HALTED / FLAT / NO ORDERS
equity 245.414  free 245.414  position 0  open_orders 0  running=false
不自动重启、不自动铺单、不删除旧状态
```
---

## 11. P3 执行结果（2026-10-30 11:0x，仅代码/测试/文档）

**范围**：改本地代码 + 测试 + 文档；测试网跑过验证；**未启动网格、未连主网写、主网仍 `HALTED / FLAT / NO ORDERS`**。

### 11.1 `_placeBatch` 透传审计：**不存在批量下单接口，批量丢失假设不成立**

| 检查项 | 结论 |
|---|---|
| `arcus.js` 是否有批量下单 | **没有**。只有单笔 `placeLimitOrder` + `batchCancelOrders`（撤单） |
| `bot.js:1043` 的 `batchSize = Math.min(15, orderBatchSize)` | 只是**并发分片节奏**，循环体是 `for (const order of orders) await this._place(order)` |
| 每笔单的 `reduceOnly` 来源 | ① 显式传（recover 阶梯 4 处硬写 `reduceOnly: true`）；② `o.reduceOnly ?? isReduceOnly(side, mode)` |
| `isReduceOnly`（`src/grid.js:19`） | long→sell 减仓、short→buy 减仓、neutral→false（开仓）；recover 腿显式 true，不会被推导覆盖 |
| 部分成功/部分拒绝的响应处理 | 逐笔 `placeLimitOrder` 各自返回/抛错，**天然逐笔**——不存在"批量整体成功"的假象 |

**所以 08:23 那 66 张单不能用"批量丢标志"解释。** 按 P1 结论（空仓下单即拒），最可能路径是：**先有仓 → 挂 reduce-only 卖单（合法）→ 成交把仓平掉 → 单仍在簿**。这条路径下单时是合法的，风控抓不到；因此新增 §11.4 的"reduce-only 单 ↔ 仓位一致性"巡检（仓位归零即撤掉全部 reduce-only 单）。

### 11.2 审计发现的第二个问题（已修）：被拒订单会进重试队列

`bot.js:_queueRetry(o, error)` 原本对**任何**错误都排队重试。对 `REJECTED` 而言：条件不变就会被一直拒绝，结果是反复刷告警 + 长期占住档位。

修复：`_queueRetry` 开头判 `error.rejected` → 记失败、发一次告警、**不排队**。

### 11.3 状态机转移图

```
                         ┌──────────────────────────────────────────┐
                         │ 账户亏损 ≥ $80                            │
                         │ 库存 ≥ 100% 最大允许库存                  │
                         │ 账本一致性巡检不通过                       │
                         │ 已有持久化 haltReason（重启也不清）        │
                         ▼                                          │
  RUNNING ──────────► DEFENSIVE ───────────────────────────────► HALTED
     ▲                    │                                        │
     │                    │ 破界（价格在区间外）                    │
     │                    │ 库存 ≥ 50%（降级）/ ≥ 75%（封锁加仓方向）│
     │                    │ 成交偏置（20 笔/60 分钟内单边开仓且库存同向）
     │                    │ 账户亏损 ≥ $60                          │
     │                    └────────────────────────────────────────┘
     │
     │  ⚠ 没有任何自动路径能从 HALTED/DEFENSIVE 回到 RUNNING
     │
     └──(人工批准)── RECOVERY_PENDING ◄──(全部恢复条件满足，只提醒不自动进)
```

**恢复条件（缺一不可）**：价格回到区间内 · 连续 2 根 1h 收盘站稳下沿 · 持仓 ≤ 最大库存 10% · 无未撤订单 · `outOfRange=false` · 账本一致。

**防守态允许什么**：减仓、平仓、已验证的 `reduceOnly` 回收腿。**禁止什么**：任何新增开仓腿、自动重锚、自动恢复普通网格。

### 11.4 三条风险线的职责划分

| 线 | 触发 | 语义 | 是否最大损失 |
|---|---|---|---|
| `$60` | 当前持仓按盘口价的未实现亏损 | **持仓级止损触发阈值** | ❌ 不是 |
| 亏损 ≥ $40 | `equity < startBalance−40` | WARN，禁止升量 | ❌ |
| 亏损 ≥ $60 | `equity < startBalance−60` | 进 DEFENSIVE，停新增风险 | ❌ |
| 亏损 ≥ $80 | `equity < startBalance−80` | **HALTED（账户级最终熔断）** | 作为策略硬停线，仍不等于绝对损失保证 |

跳空、滑点、API 延迟、累计已实现亏损都可能让实际损失越过任何一条线。

### 11.5 HALT 线持久化位置

- 文件：`<repo>/.state.json` → `ar.guard`（与 `ar.running`、`ar.config` 同级）
- 字段：`haltReason`（粘滞，不被后续原因覆盖）、`haltedAt`、`startBalance`、`startBalanceAt`
- **`startBalance` 一旦写入永不覆盖**——亏钱重启不会把它改写成当前 equity，否则"重启即重置亏损"就等于没有熔断线
- 恢复：只能 `bot.clearHalt()`（人工），没有任何定时器/对账路径会清除它

### 11.6 订单—仓位一致性巡检（每次风控评估都跑）

任一成立即 HALTED：仓位与本地预期不符 · 未识别成交 > 0 · 未跟踪成交 > 0 · 被拒订单出现在台账 · reduceOnly 单被当开仓 · 挂单数交易所 ≠ 本地 · 订单状态无法确认 · 账户熔断线触发。

### 11.7 测试结果

| 套件 | 结果 |
|---|---|
| `test/guard.test.js`（新增 18 项：状态转移 / HALTED 粘滞 / startBalance 不覆盖 / position_delta / unknown_fill / 恢复条件 / 幂等 / 乱序成交） | **18 passed, 0 failed** |
| `test/bot.test.js`（新增 2 项：REJECTED 不进台账不重试；recover 全部 reduceOnly） | **37 passed, 0 failed** |
| `test/ar.test.js`（新增 CANCELED 分支） | **41 passed, 0 failed** |
| 全量 `npm test` | **EXIT 0** |

### 11.8 仍未解决

1. **"挂单后仓位归零、单仍在簿、成交是否开仓"未实测**——只有降低暴露（一致性巡检 + 归零即撤），没有拿到反例或正例。
2. `recovery` 本地标记在 `seedOrders` 补种路径上不带（只影响本地分类，不影响交易所 `reduceOnly`）。
3. 主网 `accountIndex` 与资金账户仍需人工确认（0 号账户持有 $250）。
4. 08:23 事件无当日仓位的逐秒快照，无法 100% 复原。

---

## 12. P3 复核修复（2026-10-30 11:0x，v1.6.45）

复核结论（`7f224a0` 评审）全部成立：**风控函数写出来了 ≠ 运行时风控已接管机器人**。逐项修复如下。

### 12.1 P0-1 风控没有持续运行 → 已修

| 修复 | 说明 |
|---|---|
| 独立心跳 `_riskTimer` | `RISK_TICK_MS = 5000`，与对账定时器解耦（`_startReconcileTimer` 里先启风控心跳，不因对账定时器已存在而跳过） |
| 统一入口 `_runRiskCycle(reason)` | 所有事件都走这里；`_guardInFlight` 并发锁 + `RISK_MIN_GAP_MS = 200` 聚合窗（原 1000ms 会吞掉启动后首个 tick，属真实缺陷） |
| 接入点 | 价格 tick `_handlePrice` → `'price'`；成交 `_handleFill` → `'fill'`；`start` 主干 → `'start'`；定时器 → `'timer'`；`resume` 路径同样触发 |
| 状态联动 | HALTED → `_enforceHalt()`；DEFENSIVE + `blockSide` → `_enforceDefensive()` |

### 12.2 P0-2 用挂单推导持仓 → 已修，新增仓位账本

- 新增 `src/position-ledger.js`：`startBase / expected / version / seenOrder`
- `_guardConsistency()` 的 `localPositionBase` 改为 **`posLedger.value`**，不再从 `active` 推导
- 账本只由「`start()` 时交易所真实持仓基线 + 真实成交」推进；`applyFill` 用 `fillKey`（含微秒 `rawTs`）幂等去重
- 持久化到 `.state.json` 的 `positionLedger`
- 人工重锚只允许 `beginNewRiskEpoch()`

### 12.3 P1-1 HALTED 后已有挂单没处理 → 已修

- `_enforceHalt()`：撤掉全部 `!reduceOnly && !recovery` 的挂单
- `_confirmNonReduceGone()`：**两轮真实快照确认**，只删除「交易所侧已不存在」的本地记录，绝不整表清空；两轮都没消失则告警
- reduce-only / recovery 单全程不碰
- `_enforceDefensive()`：只撤「被封锁方向」的开仓腿

### 12.4 P1-2 opening / reduceOnly 语义分裂 → 已统一

统一推导，`_place` 与 `_placeMany` 共用：

```js
const reduceOnly = o.reduceOnly ?? isReduceOnly(o.side, this.config.mode);
const opening = o.opening !== false && !reduceOnly && !o.recovery;
```

`_guardAllowsOrder()` 接收的就是这组统一后的值。

### 12.5 P2-1 恢复清单只看本地 → 已改为真实快照

`recoveryChecklist()` 改为异步：**两次** `fetchOpenOrders` 必须一致，再叠加 `active=0` / `retryQueue=0` / 挂单批次完成 / 未知成交=0 / 仓位一致。拿不到快照时按「不确定」处理，直接判不通过。

### 12.6 P2-2 resetStats 会改基准 → 已修

`resetStats()` 不再触碰 `startBalance`。新增唯一合法入口 `beginNewRiskEpoch({ reason, operator })`，会重置 `HaltLedger`、重锚仓位账本并留痕告警。

### 12.7 测试

| 套件 | 结果 |
|---|---|
| `test/guard.test.js` | 18 passed |
| `test/guard-runtime.test.js`（新增，运行时集成） | 6 passed |
| `test/position-ledger.test.js`（新增） | 9 passed |
| `test/bot.test.js` | 37 passed |
| `test/ar.test.js` | 41 passed |
| 全量 `npm test` | EXIT 0 |

运行时集成测试覆盖评审要求：启动 `RUNNING` → 仅靠 `price` 事件自动进 `DEFENSIVE` 且开仓被拦 → 权益跌破熔断线自动 `HALTED` 且普通单被撤、reduce-only 保留 → 快照恢复后重启仍是 `HALTED` → 恢复清单要求真实快照 → 挂单多但空仓不误报。

### 12.8 仍未解决

1. 08:23 "挂单后仓位归零、成交是否开仓"仍无实测正例/反例。
2. 撤单确认依赖交易所 `fetchOpenOrders` 的准确性（已做两轮一致，但仍非绝对）。
3. 主网 `accountIndex` 与资金账户待人工确认。
4. `_enforceDefensive` 只撤被封锁方向，破界撤单仍由既有 `outOfRange` 逻辑负责——两条路径未合并，长期应收敛。

---

## 13. 启动闸门 / fail-closed / 熔断全量撤单 —— 演练记录（v1.6.46）

### 13.1 三项修复

| # | 问题 | 修法 |
|---|---|---|
| P0 | 区间外启动先铺开仓单 | `start()` 顺序改为「算 outOfRange → running=true → `_runRiskCycle('start')` → `_startBlockedReason()` → 才 seed」；拦截时一张单都不提交 |
| P1 | 一致性未知被当一致 | `checkConsistency` 增 `status: ok\|mismatch`；调用方读不出仓位时构造 `unknown`；单次 → DEFENSIVE，连续 2 次 → HALTED；适配器新增 `positionsFetchedAt`（>2 分钟未同步即 unknown）；`_runRiskCycle` 自身异常也 fail-closed |
| P1 | 熔断只撤本地 active | `_enforceHalt` 改为先 `fetchOpenOrders`，按**交易所真实订单**撤（本地没有的幽灵单也撤），本地标记 reduceOnly/recovery 的保留；最终以交易所剩余判定 |

**迟滞语义拆分**（本次新引入）：`outOfRange`（2 拍 + 驻留）负责切换 recovery/停机；`_beyondHysteresis`（外侧半格）负责禁止新增开仓。两者混用会出现「价格已破界却还在补开仓单」。

### 13.2 演练 A：区间外启动（testnet，真实下单通道）

```
POST /api/ar/start  lower=90000 upper=95000 gridCount=10 sizeBase=0.0002 10x
最新价 76924.3（区间外）
```

| 观察项 | 结果 |
|---|---|
| 接口返回 | `running=true`（保持运行态等待） |
| **交易所真实挂单** | **0** |
| 日志 | `⛔ 启动被风控拦截：最新价 76924.3 在区间 [90000, 95000] 之外。本轮不铺任何开仓单，保持等待（无挂单、无持仓变化）。` |

### 13.3 演练 B：区间内启动

```
POST /api/ar/start  lower=73500 upper=79000 gridCount=10 sizeBase=0.0002 10x
```

| 观察项 | 结果 |
|---|---|
| 铺单耗时 | 2,514 ms |
| 交易所挂单 | 10 张，BUY 8 / SELL 2，10 个唯一价 |
| 价格区间 | 73,500 – 79,000（与配置一致） |
| 日志 | `启动完成：BTC-USD 中性网格，10 格，间距 550（0.72%），杠杆 10x；目标 10 单 / 已确认 10 单 / 待重试 0 单` |

收尾：`/stop` → openOrders **0**、positions **0**；testnet equity 837.80 未受影响。

### 13.4 演练结论

- 启动闸门**真的挡住**了「区间外先铺单」——交易所侧确认 0 单，不是本地视图。
- 闸门拦截后**没有自动补铺路径**：价格回到区间内也需人工重新 `/start`（已由测试锁定）。
- 本轮全部为 testnet 真实下单，**主网全程未下单**：openOrders 0 / positions 0 / equity 245.414038607。

### 13.5 演练中发现的附带缺陷

1. `_checkMaxLoss()` 直接调用 `ex.getPosition()` 未保护，适配器异常会打断整个价格处理链路 → 已加保护。
2. `_guardCtx()` 与 `_guardConsistency()` 对「接口抛错」与「确实空仓」未区分 → 已分开处理。
3. guard 原先用严格价重算破界，绕过 bot 的迟滞 → 改为尊重 `ctx.outOfRange` 布尔值，并新增 `_beyondHysteresis` 承担「封开仓」语义。

---

## 14. 独立库存硬上限（v1.6.47）

### 14.1 先修正两处表述

| 原表述 | 更正后 |
|---|---|
| 「网格本身是正期望」 | **「59 小时内程序统计的 gridProfit 为 +5.83，但整体是否正期望尚未证明」**。网格价差统计为正 ≠ 扣掉趋势库存损失后仍为正。新方案待验证的假设是：*限制库存后，能保留一部分网格价差收益，同时显著降低趋势持仓损失* |
| 「库存上限 6–8 格只需一行配置」 | **不成立**。`_maxInventoryBase()` 原为 `grid.count × sizeBase`，66 格网格就是 66 格上限；比例阈值只是把 66 格切成 50%/75%/100%。必须新增独立配置 |

### 14.2 实现

```js
_maxInventoryBase() {
  const cap = Number(this.config.maxInventoryGrids);
  const grids = Number.isFinite(cap) && cap > 0 ? cap : Number(this.grid.count);
  return grids * sizeBase;
}
```

| 配置 | 值 | 含义 |
|---|---|---|
| `AR_MAX_INVENTORY_GRIDS` | 8 | 库存硬上限（格） |
| `AR_INVENTORY_WARN_GRIDS` | 4 | 预警，禁止升量 |
| `AR_INVENTORY_BLOCK_GRIDS` | 6 | 停同向开仓 + 撤同向多余普通单 |
| `AR_INVENTORY_HALT_GRIDS` | 8 | 熔断（真实持仓触顶） |

格阈值换算成 guard 比例（4/6/8 ÷ 8 = 50%/75%/100%），未配置时传空对象、行为与旧版完全一致。

### 14.3 projectedInventory 与两个刻意的设计选择

```
projectedInventory = |真实持仓| + 会继续放大 |持仓| 的同向未成交开仓单
```

**选择一：只算同向。** 66 格中性网格两侧各挂约 33 张，若把两侧都算进去，空仓时 projected 就等于 66 格 —— 一铺单就熔断，那不是风控而是自锁。

**选择二：空仓时不投影。** 对称挂单是网格的设计本身，只有在已有持仓、方向已经暴露时才开始收紧。

**选择三：熔断只认真实持仓，不认 projected。** projected 到顶 = 「再成交就到上限」，此时应做的是停开仓 + 撤同向多余挂单；若拿 projected 熔断，一个正常挂单的网格会被自己的待成交单反复熔断，永远开不起来。真实持仓触顶才是「已经发生越界」（并发/延迟/重复成交的征兆）。

### 14.4 行为矩阵

| 真实持仓 | projected | 状态 | 动作 |
|---:|---:|---|---|
| 0–3 格 | — | RUNNING | 正常 |
| 4 格 | ≥4 | DEFENSIVE | 预警，禁止升量 |
| 5 格 | 8 格 | DEFENSIVE + blockSide | 停同向开仓、撤同向多余普通单；**不熔断** |
| 8 格 | — | HALTED | 撤全部非减仓单，人工恢复 |

### 14.5 测试（test/inventory-cap.test.js，8 项全绿）

上限取自 maxInventoryGrids 而非 gridCount / 未配置时向后兼容 / 格数换算比例 / projected 只累同向且空仓不投影 / 真实 8 格熔断 / projected 顶到 8 不熔断只封锁 / 4 格预警 6 格封向 / 到限后同向开仓被拦而 reduceOnly 放行。

### 14.6 下一阶段顺序（未获批准不越过）

```
A. testnet：0.10% + 0.0001 BTC + maxInventoryGrids=8
B. testnet 验证 4/6/8 格防守
C. 主网东京主机只读 preflight
D. 连续 2 根 1h 收盘站稳下沿后，申请主网金丝雀
E. 主网 6–8 个实际开仓档位，2–4 小时
F. 金丝雀通过后才扩到完整 66 格
G. 未经人工批准不得升回 0.0002 BTC
```

当前状态：**HALTED / FLAT / NO ORDERS**（主网 0 单 / 0 仓 / equity 245.414038607）。

---

## 15. B 方案参数落定 + 运维缺口修补（v1.6.48）

### 15.1 参数选择：B（0.20% + 0.0001 + 上限 8 格）

库存上限解耦成 8 格后，`sizeBase` 不再承担「控风险」职责，只影响单格利润。三组候选实测（BTC 78,856，费率 142 ppm）：

| 组合 | 单格净利 | 8 格暴露 | 判定 |
|---|---:|---:|---|
| 0.10% + 0.0002 | $0.01115 | $125 | 过红线 |
| **0.20% + 0.0001** | **$0.01336** | **$62** | **过红线（选用）** |
| 0.10% + 0.0001 | $0.00557 | $62 | **低于 `AR_MIN_GRID_NET_USD=0.01`，启动被拒** |

选用 B 的理由：在暴露减半的同时保住红线以上单格利润；代价是格距加倍、穿格频率约减半，**日收益方向未知，必须实测**。

### 15.2 演练结果（testnet 真实下单）

```
66 格 / 0.20% / 0.0001 / 10x / 区间 73498-83885.3
启动 67 单（66 格 + 端点），guard=RUNNING，inventoryBase=0
risk.perRungNet = 0.0134 ✓  spacingPct = 0.2 ✓
```

**未能完成的部分（诚实记录）**：外部脚本下单想制造 4/6/8 格库存，testnet 返回 `REJECTED`（保证金充足、无持仓、价格在盘口内）。此外即使成交，外部下单不产生 bot 的 fill 事件，会被一致性检查判成「仓位不一致」→ 直接熔断，**根本测不到分级行为**。库存 4/6/8 格的分级因此完全依赖单元测试（`test/inventory-cap.test.js` 8 项），端到端只验证了「启动闸门 + 库存上限生效」。

### 15.3 演练中修掉的两个真实缺陷

| 缺陷 | 现象 | 修法 |
|---|---|---|
| **HALTED 无法通过 API 解除** | `bot.clearHalt()` 存在但没有 HTTP 端点，主网一旦熔断只能改文件重启 —— 一次误熔断等于一次停机 | 新增 `POST /api/<key>/clear-halt`，要求 `confirm:true` 并记录操作人 |
| **平仓后台账不复位导致误熔断** | 上次会话遗留 `posLedger=0.0004`，新会话交易所 0 仓 → 启动即「仓位不一致」熔断 | `start()` 以交易所真实持仓为新周期基线 `posLedger.reset(baseNow)` |

第二个缺陷是**恢复场景的真实陷阱**：运维手动平过仓再重启，必然撞上。

### 15.4 巡检脚本 v2（`/data/scripts/arcus_mainnet_check.py`）

重心从「在簿多少单」转向「库存多少格」：

1. 输出 `库存 X/8 格` + `含待成交 Y 格`（后者是 6 格封锁线的真实触发依据，只算同向）
2. **人工停机标记** `/data/arcus-mainnet-halted`：文件存在且 0 单 0 仓 → `level=0 人工停机`；无标记则 `level=2 已停机(未标记)`。已验证两种分支
3. 0 单不再输出「真空洞 64 格」（全槽位空缺伪信号）
4. 库存红线独立判定：≥8 格 level=2、≥6 格 level=1、≥4 格 level=1（任何模式都判）
5. 修 `/v1/fills` 缺 `address` 返回 400

### 15.5 当前状态

- 主网：**HALTED / FLAT / NO ORDERS**，0 单 0 仓，equity 245.414038607
- testnet：0 单 0 仓（演练已清理）
- 参数 B 已定，但**尚未在主网开跑**——按 A–G 顺序，下一步是 testnet 观察窗

### 15.6 更正（v1.6.48 提交信息）

`5491a99` 的提交信息里有一条 **「库存 projected 只算现价 3 格内同向挂单，避免高位未成交挂单被误判为立刻暴露（测试同步）」——该改动并未实现**。

当前行为是：`projectedInventory = |真实持仓| + 全部同向未成交开仓单`，不按距离过滤。

保留「不过滤」是有意为之：远处的开仓单将来也会成交，按距离截断等于低估暴露，与「宁严勿松」相反。若将来要改，需先有数据证明远处挂单确实构不成连续成交风险。

---

## 16. 活跃窗口：让「66 格覆盖」与「8 格上限」同时成立（v1.6.49）

### 16.1 冲突与解法

「全部同向挂单计入 projected」与「铺满 66 格」不能共存：持仓 0 时同向 33 张就是 33 格 projected，第一笔成交前就该熔断。

解法不是按距离截断挂单（会低估暴露），而是**交易所上本来就只有近价单**：

- 66 格仍是策略的价格覆盖范围，`seedOrders` 只提交现价 ±`activeWindowGrids` 内的档位
- 远端档位只作候选，不落单
- 价格移动 ≥1 格时 `_rollActiveWindow()` 撤窗口外开仓单、补窗口内缺档
- `reduceOnly` / `recovery` / `opening=false` 的腿**永不参与滚动**

### 16.2 窗口取值：4 格/侧（不是附件的 8 格）

附件建议「每侧 8 格」，但代入约束会不成立：

```
projected = |真实持仓| + 窗口内同向挂单
窗口 8：持仓 1 格 → projected 9 > block(6) → 立刻封锁补单，网格停在 8 张
窗口 4：持仓 1 格 → projected 5 < block(6) → 正常；持仓 4 格 → 8，到封锁/熔断边界
```

**窗口 4 + 封锁 6 + 熔断 8** 才是自洽的一组：给持仓留出 4 格余量。窗口大小可配置（`AR_ACTIVE_WINDOW_GRIDS`），要 8 格只需同时把 `inventoryBlockGrids` 提到 10 以上。

### 16.3 testnet 实测

```
66 格 / 0.20% / 0.0001 / 窗口 4 / 上限 8
openOrders = 7（原为 67），B3/S4，范围 78,534.3–79,636.0，现价 79,027
inventoryBase = 0，guardState = RUNNING
```

### 16.4 本轮修掉的两个真缺陷

| 缺陷 | 后果 | 修法 |
|---|---|---|
| `active` 条目**没有 `orderId` 字段**（只有 Map key 是） | `_rollActiveWindow` 按 `o.orderId` 撤单 → 传 `undefined`，交易所撤不掉、本地留幽灵单，`cancelled` 计数还虚高 | 改用 `this.active.entries()` 拿 key |
| `activeWindowGrids` 漏在 `/start` 注入白名单外 | env 配了也不生效，testnet 实测仍挂 67 单 | `server.js` 两处注入列表补该字段 |

### 16.5 账本重锚条件化（附件第二项）

`start()` **不再静默重置**仓位账本——自动重置会把「本地账本与交易所本来就不一致」直接抹掉，而那是最该被看见的事。

- 普通 start：账本不一致 → 一致性检查判 HALTED，报差异
- `POST /api/<key>/new-epoch`（`confirm:true` + `reason` 必填）→ `beginNewRiskEpoch()` 六项前置检查：本地 0 挂单、重试队列空、无未跟踪成交、无进行中铺单批次、两次 `openOrders` 快照一致且为 0、两次持仓查询一致；通过后重锚并记录 `prevExpected / exchangeBase / delta / by / reason`

### 16.6 解除熔断加强（附件第三项）

`POST /api/<key>/clear-halt` 现在要求：`confirm:true` + `reason` 必填 + **空仓** + 交易所上只剩减仓腿 + 账本与交易所一致。**只解除粘滞 HALT，不启动、不铺单、不改参数。**

### 16.7 仍未做

- 观察窗四组指标采集脚本（网格活动 / 成交与费用 / 库存与风控 / 账本与异常），24h 优先、样本不足延长到 48h
- 附件要求的“管理认证 / 来源白名单”只做到「绑定 127.0.0.1 + origin 校验」，未做 token

### 16.8 观察窗采集器（`/data/scripts/window_collect.py`）

每 30s 采一次本地 state 写 jsonl，`--report` 出五组汇总（对应附件四组 + 收益拆分）：

| 组 | 指标 |
|---|---|
| 网格活动 | 完成格数及 /h、买卖数、越界采样占比、空洞采样占比、价格高低点 |
| 成交与费用 | MAKER/TAKER 数（**TAKER>0 直接标 ✗**）、部分成交数、手续费、实测 ppm、成交量 |
| 库存与风控 | **actualInventoryPeak 与 projectedInventoryPeak 分开报**、4/6/8 格触发采样数、HALTED 次数与首个原因 |
| 账本与异常 | operationalIssue 采样数、vanish 峰值、补腿冲突、死手触发、fills 游标最大延迟、时钟偏差 |
| 收益拆分 | gridProfit、realized 增量、equity 变化、手续费 |

末尾给**样本充分性**判定：完成格数 < 2×小时数 → 判定“样本不足，延长到 48h”，不允许拿“跑满 24h”当通过条件。

已用 testnet 冒烟验证（13 条采样、五组输出正常；修了空价格/空 equity 的 None 崩溃）。

**funding 暂未单独采集**——Arcus 账单接口还需扩展，观察窗报告里会显式标注这一项缺失，不用 0 冒充。

---

## 17. Testnet A 观察窗启动记录（2026-10-30 14:47，用户批准）

### 17.1 固定参数（观察期间不得自行调整）

```
spacing           0.20%
sizeBase          0.0001 BTC
activeWindowGrids 4
maxInventoryGrids 8
inventoryWarn     4 格
inventoryBlock    6 格
inventoryHalt     8 格
杠杆 10x          区间 73377.5 – 83747.7（66 格，现价 78562.6 居中）
dynamic recenter  关
automatic restart 关（进程死了由 4h 保活巡检发现后手动拉起，不加 supervisor）
```

用户明确不批准：窗口 8 / 封锁线 10 / 观察期动态升量 / 观察期主网金丝雀。

### 17.2 启动实测

```
start_ms 2551
spacingPct 0.2   perRungNet 0.0134   sizeBase 0.0001
openOrders 7-8   交易所 7 单 B3/S4   范围 78405.5 – 79505.3
guardState RUNNING   inventoryBase 0
```

单格毛利 $0.0158 − 双边 maker $0.0024 = **$0.0134**，与批准文件一致。

### 17.3 采集与巡检

- 采样器 `/data/scripts/window_collect.py --interval 30` → `/data/arcus-window.jsonl`
- 调度 `ca77c83c`「Arcus 观察窗保活巡检（4h）」：只读，进程/采样器死了才拉起，**不 stop/start/refill/改参数**；HALTED 只记录不解除（HALTED 本身可能是要验证的正确行为）
- 调度 `81a6e240`「Arcus 观察窗 24h 汇总」（10-31 14:50，一次性）：按批准的硬性条件逐条判「通过/未通过/样本不足」；完成格 < 2×小时数 → 只能写“运行稳定、样本不足”，**不得拿跑满 24h 当通过**

### 17.4 通过条件（三态判定，写死在汇总任务里）

硬性：actualInventoryPeak ≤8 格、projected 不因远端单冲到 33 格、unknown=0、untracked=0、position delta=0、taker=0、被拒单不进 active、无错误自动重启/重锚。
行为：4 格预警、6 格封锁同向开仓并撤多余普通单、8 格 HALTED、reduceOnly 仍放行、窗口随价移动不堆幽灵单。

### 17.5 主网状态

HALTED / FLAT / NO ORDERS，挂单 0、持仓 0、equity **245.414038607**。观察期间不调用任何主网写接口。

---

## 18. 观察窗第一次运行（14:47–15:42，作废）+ 有条件重启（17:31 起，第二窗）

### 18.1 第一窗结论：数据作废，但抓到两个真缺陷

第 55 分钟 HALTED，原因是基础设施而非策略：

```
窗口只挂 8 单 → 阶梯哨兵仍按 66 格算缺口 → 58~59 个伪缺口
→ 超 50% 阈值判「塌陷」→ 每 1.5 分钟自动重铺 → 441 次 429
→ fills 轮询失败 → 账本停在 0（交易所有 0.0001）→ 一致性检查 HALTED
```

**熔断本身是对的**——一致性保护按设计拦住了账本继续跑偏。作废的是 24h 数据，不是修复方向。

| 缺陷 | 版本 | 修法 |
|---|---|---|
| 阶梯哨兵不看活跃窗口 | 1.6.50 `289f627` | 只在窗口内档位算缺口，塌陷阈值分母改用窗口内档位数 |
| `projectedInventory` 把全部同向挂单计入（HALTED 时算出 51.5 格，**重启阻断项**） | 1.6.51 `d0b8140` | 只计现价 3 格内同向单 + 已请求撤单 >15s 的残留不计；熔断仍只认真实持仓 |

### 18.2 重启按「有条件批准」执行（不是无条件 rm）

| 步骤 | 结果 |
|---|---|
| 停实例 | 无旧进程残留 |
| 交易所 `openOrders` | 0 |
| 遗留 LONG 0.0001 @78719.7 | 用 **reduceOnly SELL** 以对手价 75,702 平掉，`position=0` 两次确认 |
| `.state.json` | **`mv` 到 `/data/arcus-window-archive-20261030-0929/.state.halted-backup.json`，没有 `rm`** |
| 审计证据 | 旧 ledger、server 日志、collector 日志、jsonl 采样、HALT 原因与时刻全部留在该目录（428K，含 README.txt） |
| 代码核对 | `v1.6.51`，哨兵按 `activeWindowGrids` 算 gaps |
| 新风险周期 | 无 `.state.json` 全新启动（等价于人工确认的新纪元），账本基线 0 由交易所空仓确认 |

### 18.3 第二窗启动确认（17:31）

```
代码        v1.6.51 / d0b8140
position    None（空）        openOrders 8（交易所 8，B4/S4）
projected   3 格（≤8 ✓）      gaps 0   collapseStreak 0   guard RUNNING
区间        72334.6 – 82557.4（66 格 / 0.20% / 现价 77446 居中）
spacingPct  0.2   perRungNet $0.0132
挂单范围    75122.6 – 76206.9（现价 75631.7 ±4 格）
采样起点    2026-10-30 17:31:07
```

注意 `state.inventoryBase` 字段语义是 **projected**（3 格 = 3 张近价同向单 × 0.0001），不是真实持仓；真实持仓看 `position.sizeBase`。

### 18.4 第二窗验收（与第一窗同口径，另加投影）

硬性：实际库存 ≤8 格、**projected 启动时即 ≤8 且全程不因远端单冲高**、unknown=0、untracked=0、position delta=0、taker=0、错误 429 不得持续重铺、错误 HALT=0、自动重启/重锚=0、窗口外档位不计入塌陷。

**若 projectedPeak 停在 30–50 格，即使实际库存没超 8 格，也判投影模型未修好。**

24h 到 **10-31 17:31**；完成格 < 2×小时数则只写“运行稳定、样本不足”，延长到 48h。
