# Changelog

本文件记录项目所有重要变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.7.0] - 2026-09-22

### 新增（Propr 挑战账户适配 · Review 1 基础层）
- 四模式运行配置 `PR_MODE=paper|shadow|sim-write|challenge`（刻意不用 live，避免与"真实资金"
  混淆）：`paper` 本地模拟 / `shadow` 只读 Propr+本地模拟 / `sim-write` 写 Free Trial /
  `challenge` 写付费挑战；含账户白名单 `PROPR_ALLOWED_ACCOUNT_IDS` 与付费双确认
  `PR_ALLOW_CHALLENGE=YES`（`src/config.js` 的 `validateProprConfig`）
- vendor Propr 官方 JS SDK 为 ESM（`src/exchange/propr/propr-sdk.js`，npm 无 propr-sdk 包），
  新增运行时依赖 `ulid`（intentId 幂等键）；所有下单须走 `createOrders`（官方 `createOrder`
  会覆盖 intentId）
- Propr 错误语义层与内部类型（`src/exchange/propr/{errors,types}.js`）：超时/限频/5xx 可重试判定、
  只读写拦截、未知订单态、鉴权/拒单分类
- 日志与异常脱敏（`src/redact.js`，平台层）：`pk_live_*`/Bearer/key=value 全抹除、
  accountId 仅前 4+后 4；`PROPR_API_KEY` 纳入子进程凭证隔离清单（`src/exchange/secret-env.js`）
- 方案包 `helloagents/plan/202609221928_propr-exchange/`（why/how/task，分批 Review 交付）
- Day-0 契约探针 `scripts/propr-probe.mjs`：只读链 + 写权限门（`--allow-write`）的订单/幂等/持仓链；
  绝不盲撤单/盲平仓，仅处理本探针创建的订单与开出的仓位增量

### 新增/修复（Propr 控制台 tab 与 Shadow 部署补齐，2026-09-23）
- 新增 **Propr 控制台 tab**（复用通用 `makeExchangeCtrl`）：市场与趋势、策略配置（模式/风格/智能填充/边界/格数/每格数量/杠杆/越界策略/动态网格）、启动/停止/调整区间/撤销挂单/补格、账户状态、孤儿持仓处理、价格与网格图；概览卡片加「进入 Propr 控制台 →」
- **阻断修复**：GridBot 市场解析由 `m.marketId === Number(cfg.marketId)` 改为字符串比较
  （`_start` / `startRecovery`），`_closeWithConfirm` 保持 marketId 原类型，前端 start/startRecovery 原值透传——
  Propr 的字符串 marketId（`'BTC'`）此前必然报「找不到该市场」，网格无法启动
- Shadow `getCandles` 改用真实 HL K 线（此前继承 paper 合成价，趋势监测/智能填充显示的是 100.x 假价）
- 验证：`npm test` 全绿 + lint 0 error + HTML 核对通过；**Shadow 端到端**（启动 6 档本地网格 →
  写请求 0 / Propr 真实账户零接触 → 停止清空）通过

### 修复（Review6-1 复审：fail-closed 与基准持久化，2026-09-23）
- P0 **fail closed**：风控对象构造即 `LOCKED`（原因「等待首次权益风控评估」）并设置
  `exchange.riskGateEnabled=true` + 写入 `riskState`；适配器开仓门改严格判断——风控已启用时
  状态缺失/未评估（null）也拒绝，不再用 `status &&` 放行
- P0 server 在 Propr init 完成后**立即执行首次风控 tick**；非 OK/WARNING 时告警并保持 LOCKED
- P1 高风险动作失败锁：HALT/BREACHED 动作失败后即使权益短暂恢复也维持该级别并持续重试，
  动作成功后才回到实际评估状态（避免"动作没做完却显示 OK"）
- P1 日初权益持久化：`riskDayKey/startOfDayEquity/initialEquity` 写入 `.state.json`（key=`proprRisk`），
  同 UTC 日重启沿用原基准（否则重启会重置日损、漏报亏损），跨日重建
- P1 reduce-only 降风险操作在 `tradingLocked` / 快照不完整 / 风控非正常下**均放行**（含全 reduce-only 批量）
- 测试补齐 5 类场景；`npm test` 全绿 + lint 0 error；真实 sim-write 冒烟显示「首次风控评估通过（OK）」

### 修复（Review6 复审：风控硬约束，2026-09-23）
- P0 风控硬拦截：适配器新增 `_assertRiskAllowsOpening()`，REDUCE_ONLY/HALT/LOCKED/BREACHED 一律拒绝
  **开仓**（reduce-only 降风险操作放行）；`setLeverage` 仅 OK/WARNING 允许——bot 未运行或手动 `/start`
  都无法绕过（风控不再是"可计算可展示"，而是不可绕过的交易约束）
- P0 `/api/propr/start` 提前拒绝：风控非 OK/WARNING（或存在 actionError）时直接 400，不进入铺单流程
- P1 权益口径统一为 `equity`（`account.marginBalance`，含未实现盈亏），缺失才回退 `balance`；
  字段更名 `currentEquity/startOfDayEquity`；未实现亏损现在能正确触发风控
- P1 动作失败不静默：`actionError` 记录 + critical 通知 + 面板透出 + **后续 tick 自动重试**降风险动作
- P1 恢复解除暂停：新增 `GridBot.resumeOpening()`，LOCKED/REDUCE_ONLY → OK 时显式清除风控暂停
- P1 `init()` 完成后即置 `lastApiOkAt`（重连成功的时间语义准确）
- 测试：`propr-risk.test.js` 重写（权益口径/未实现亏损/动作失败重试/恢复解除暂停）、
  `propr-order-state.test.js` 增硬拦截用例、`bot.test.js` 增「未运行时忽略 fill」用例；
  `npm test` 全绿 + lint 0 error + HTML 核对通过
- 真实 sim-write 冒烟：HALT 在发往 API 前拒绝开仓；REDUCE_ONLY 下 reduce-only 放行

### 新增（Propr 风控层 + 对账恢复，2026-09-23）
- `src/risk/propr-challenge.js` 挑战风控层：UTC 日切（00:00 UTC 重置日初权益）、权益可用性/新鲜度、
  日损与总回撤分级（纯函数 `evaluateRisk`，优先级 BREACHED > LOCKED > HALT > REDUCE_ONLY > WARNING > OK）；
  分级动作：REDUCE_ONLY → `pauseOpening` 至 UTC 日切（仅减仓）、HALT → 撤单+平仓+停机、
  LOCKED → 暂停开仓待恢复、BREACHED → 停机不平仓；状态写入 `exchange.riskState` 并经 `exchangeInfo` 透传
- `server.js`：`PR_MODE=sim-write|challenge` 时启用风控层（paper/shadow 不启用），新增 `/api/prpro/risk` 路由；
  `PR_RISK_POLL_MS` 可配
- 对账恢复：`reconnect()` → `init({resume:true})` 用全量成交对账并**补偿断线期间缺失的 fill**
  （tradeId 去重，绝不重复补单）；进程重启走 seed 路径不补发历史成交，由 `bot.resume` 对账接管；
  部分成交按实际成交量发 fill（bot 侧据此补同量对腿）
- 适配器新增 `attemptStatus` / `startingBalance`（取自 `ChallengeAttempt.account/phases`）
- 前端 Propr 卡片新增「挑战风控」行：状态 + 日损/回撤使用率 + 原因（按级别着色）
- 测试新增 `test/propr-risk.test.js`（日切边界/分级/优先级/动作编排/日切重置）与
  `propr-reconcile.test.js` 的重连补偿、部分成交用例；`npm test` 全绿 + lint 0 error
- 真实 sim-write 冒烟：`/api/prpro/risk` 返回 OK（起始 5000、回撤用量 0.26%、权益来源 propr_account）

### 修复（Review4 复审：接入安全，2026-09-23）
- P1 新鲜度分离：新增 `lastPriceOkAt`（HL 公开行情）与 `lastApiOkAt`（Propr 订单/持仓/成交/权益）；
  `_pollPrice` 只推进行情时间戳，server 看门狗对 Propr 改用 `lastOkKey='lastApiOkAt'`——
  杜绝「Propr API 失联但行情正常 → 看门狗不告警」的误判
- P1 总览隔离：前端抽取 `renderExchangeCard()`，汇总循环恢复为原六所；Propr 独立渲染，
  **不计入余额/盈亏/运行数**（修复 `4/3 运行中` 与账户口径混入）
- P1 代理竞态：`ProprClient` 支持 per-client `dispatcher`（undici），Propr/Shadow 不再调用
  `setGlobalDispatcher`，HL 行情亦走同一 dispatcher；启动日志标注「Propr 使用独立代理（per-client）」；
  `setupProxies` 注明忽略 PR_PROXY
- P2 `getPublicInfo()` 移除 `attemptId`；Shadow 新增 `marketLastOkAt/proprAccountLastOkAt/proprPositionLastOkAt`
- P2 新增 server 集成测试 `test/server-propr.test.js`（真实拉起 server，覆盖 overview/state/markets/stream/reconnect）
  与适配器级新鲜度分离用例；eslint 补 `TextDecoder/TextEncoder` 全局
- 验证：`npm test` 全绿 + lint 0 error + HTML 核对通过；真实 shadow 冒烟三项时间戳均置位且无 attempt 泄漏

### 新增（Propr Review 4：接入 GridBot 与 server，2026-09-23）
- `src/server.js` 第 7 所完整接入：Propr 四模式预检查（失败给可操作提示后退出）、工厂实例化、
  `propr` 快照键 restore、错误监听、日历暂停、Liveness 看门狗（`liveModes=['sim-write','challenge']`）、
  SSE 客户端、`/api/propr/*` 路由、overview（API/SSE 初值/推送）、初始化、续跑、续跑看门狗、孤儿持仓探测、
  启动横幅、`PR_PROXY` 纳入代理配置与 `/api/env` 白名单
- `src/bot.js`：`getState()` 透传 `exchangeInfo`（适配器公开信息，`getPublicInfo()`）
- `ProprExchange/ShadowExchange.getPublicInfo()`：模式、掩码账户、持仓模式、交易锁定/原因、
  挂单快照完整性、权益来源与新鲜度、本地意图/挂单计数、价格（**不含任何凭证**）
- 前端 `public/index.html`：新增独立「Propr 挑战账户」总览卡片（常驻显示于 paper 之外），
  含 SHADOW/SIM-WRITE/CHALLENGE 文案、掩码账户、锁定/快照状态、Propr 真实权益（并注明余额/权益栏为本地模拟账户）、
  重连按钮；不并入三所汇总口径
- 说明：AI 服务快照/提示词按 5 所硬编码，Propr 本阶段不并入（登记 task 7.4）
- 验证：`npm test` 全绿 + lint 0 error + HTML 交叉核对通过；server 级 shadow 与 sim-write 双模式冒烟通过
  （shadow 写请求 0、价格 86563.5；sim-write 权益取真实账户 4999.60、未锁定）

### 修复（Review3 复审：写路径安全，2026-09-23）
- P0 `cancelOrder` 权威复核：不依赖未验证的 `orderId` 过滤器——orderId 直查 + **全状态分页扫描**兜底，
  返回三态 `found/missing/query_failed`；仅「查到且终态」或「查不到但有成交佐证」才为 true，
  查询失败置 `ordersSnapshotStale` 并返回 false（宁可重试也不误报已撤）
- P0 活动订单快照**部分失败即视为不完整**：保留旧快照 + `ordersSnapshotStale/Error`，
  `_assertCanOpen` 直接拒绝开仓（避免失败状态的订单"消失"→ 重复铺单），恢复后自动清除
- P1 `closePosition` 复用统一 intent 恢复：新增 `_placeReduceOnlyMarket` 走 `_recoverIntent`，
  平仓超时/13084 先按 intentId 对账（已成交不重复发单），无法确认则锁定开仓并继续 reduce-only 重试
- P1 成交游标顺序修正：先按上一轮游标分页，**tradeId 去重为唯一标准**，不再用时间窗口丢弃未见过的成交
  （漏一笔成交=漏一条补单）
- P1 `cancelAll` 快照失败时不以旧快照下结论（尽力撤已知单但返回 false）
- P2 `placeLimitOrders` 逐个校验 `marketId`；`positionSide` 注释明确为订单意图字段而非独立持仓腿
- 测试补齐 5 项：orderId 过滤器不可用不误报、快照部分失败保留旧快照并禁开仓、平仓超时已成交对账恢复、
  平仓超时未确认锁定、成交跨重叠窗口不丢单；`npm test` 全绿 + lint 0 error
- 真实 sim-write 平仓链路冒烟：市价开多 0.001 → `closePosition` → 净仓归零、未锁定

### 新增（Propr Review 3：写路径 + intentId 幂等 + 对账，2026-09-23）
- `propr.js` 写路径：`placeLimitOrder/placeLimitOrders`（统一走 `createOrders` + 自有 ULID intentId，
  批量结果与输入等长）、`cancelOrder/cancelAll`（撤单后按实况复核，不信任官方 400 吞并）、
  `closePosition`（自实现全平：遍历全部持仓逐个市价 reduceOnly，循环复核至空）、`setLeverage`
- 幂等与锁定：下单异常（超时/网络/429/5xx/13084）**先按 intentId 跨全部状态对账**，命中即返回既有订单
  绝不重复创建；对账不到即 `TRADING_LOCKED` + `UnknownOrderStateError`；明确 400 参数错误视为未创建。
  锁定只拦开仓/改杠杆，撤单/平仓等降风险操作始终放行
- `reconcileOrders()`：刷新活动挂单并按 intentId 回填意图，返回未匹配订单供 GridBot 接纳
- vendor SDK 官方 `createOrder()` 改名 `createOrderRaw()` 并标注项目内禁用（防误用导致幂等键失效）
- 测试新增 `test/propr-order-state.test.js`（超时/13084 对账、未知态锁定、批量部分成功、部分成交、杠杆上限）
  与 `test/propr-reconcile.test.js`（撤单复核、全平、重启不重复补单、intent 对账）；`npm test` 全绿 + lint 0 error
- 真实 sim-write 冒烟通过：自有 intentId 下单 → reconcile 命中 → 撤单复核 → 无残留挂单/持仓

### 修复（Review2 复审：只读可靠性强化，2026-09-23）
- P1 活动挂单纳入 `pending/open/partially_filled`（只查 `open` 会漏刚提交/部分成交单 → 对账误判
  不存在 → 重复补单）；任一状态查询失败不致命，全部失败才抛出
- P1 成交轮询改「分页 + 时间游标 + 30s 重叠窗口」：常规轮询最多 5 页（500 条），重连/恢复走全量
  （最多 20 页），不再只取最近 50 条
- P1 shadow 账户/持仓读取失败保留上次快照并标 stale（`proprAccountStale/proprPositionStale` +
  `proprPositionError`），**不再把失败伪装成空仓**
- P1 Propr/Shadow 的 error 事件统一走 `mapProprError`（分类 + 脱敏），事件被 server/SSE/通知/AI 消费也安全
- P2 `PR_FEE_RATE` 默认留空 → 优先实测 maker 费率 0.00015（不再被 0.0005 覆盖）；`getTrades` 返回
  内部统一视图，新增 `getRawTrades` 保留原始口径
- P2 `netPositionFromViews` 明确仅适用于 net 模式，多条同向时按数量加权 entryPrice，并注释禁止复用于 hedge
- 测试新增 `test/propr-shadow.test.js`（失败不假报空仓/脱敏事件/写请求恒 0）；`propr.test.js` 增补
  活动状态完整性、150 条成交全量、内部视图、脱敏事件；`npm test` 全绿 + lint 0 error

### 新增（Propr Review 2：net 只读适配器 + Shadow + 精度/权益探测，2026-09-23）
- `src/exchange/propr/market.js`：市场构建（net/stepSize 1e-5/stepPrice 0.1/minNotional $10/maker 0.00015）
  与取整工具；**精度与最小名义由适配器本地强制**（探针证实 API 层完全不校验）
- `src/exchange/propr/mapper.js`：订单/持仓/成交/保证金/错误映射（positionSide 保真、状态机双向、
  净仓聚合、错误分类 + 脱敏）
- `src/exchange/propr/propr.js`：启动校验链（health→user→严格绑定账户→margin/leverage→权益/持仓/挂单/成交种子）
  + 只读路径 + **全量分页**（`getAllOrders/Trades/Positions`）+ HL 行情/K 线（ADR-007）+
  权威权益与 `equityFreshAt` 新鲜度 + 成交事件去重（重启不重复补单）
- `src/exchange/propr/shadow.js`：`createReadOnlyClient()` 写方法一律抛 `ProprReadOnlyError`（写请求恒为 0）
  + 真实行情驱动本地撮合
- `src/exchange/propr/index.js`：四模式工厂补全（paper/shadow/sim-write/challenge）
- ADR-007：Propr 无行情端点，价格/K 线取自 HL 公开 API（allMids/candleSnapshot）
- 真实链路冒烟：shadow 与 sim-write 的 init 均无写请求，市场/权益/价格读取正常
- 测试：新增 `test/propr-mapper.test.js`、`test/propr.test.js`；扩展 `test/propr-modes.test.js`
  （shadow 写请求数=0、四模式工厂）；`npm test` 全绿 + lint 0 error

### 修复（Review2 复审：探针安全强化，2026-09-23）
- P0 asset fallback 收敛：仅明确 400 参数错误才换口径；超时/网络/429/5xx 一律先按 intentId 对账，
  对账不到即报未知订单态并停止创建（杜绝重复下单）
- P0 持仓链改 try/finally：以真实 `getPositions()` 循环平至空仓（最多 4 轮），残留则 P0 告警 + 非零退出码
- P0 非 `discover` 命令严格绑定 `PROPR_ACCOUNT_ID`（抛 `ProprStartupError`），禁止静默回退 `active[0]`
- P1 权益检测修正到 `challengeAttempt.account` + `balance` 硬断言
- P1 幂等/撤单复核改为跨全部订单状态 + cancel 响应/终态/成交数多重信号
- P1 `13084` 识别兼容字符串；契约文档拆分「已冻结 / 待验证」并收窄权益措辞
- 新增 `equity` 命令实测权益刷新时效：`balance`/`availableBalance` 即时、`unrealizedPnl` ≤30s、
  ⚠️ `account.updatedAt` 粒度粗不可作新鲜度依据（须用本地 `equityFreshAt`）

### 变更（Day-0 探针实测冻结，2026-09-23）
- 契约冻结 `docs/propr-api-contract.md`：**Propr 为 net 单向净仓**（`sell/positionSide=short` 被归一化为
  `type=reduce`，反向单直接减仓）→ 阶段 5A（net）生效、5B（hedge）取消，GridBot 无需改造
- **权益权威可得**：`getChallengeAttempt().account` 含 `balance/marginBalance/highWaterMark/availableBalance`
  → ADR-004 由「派生+降权」升级为「权威字段+新鲜度校验」
- 幂等实测：同一 intentId 重复提交 → HTTP 500 + code 13084 `order_saga_idempotency_check_failed`，
  无重复订单；`errors.js` 新增 `isIdempotencyConflict()`，分类 `idempotency_conflict` 且不可重试
- `asset` 口径 = `"BTC"`；maker 0.00015 / taker 0.00045；quantity 0.001 与 1 位小数价格实测接受
- 网络：`api.propr.xyz` 本机 DNS 被污染，探针新增 `PR_PROXY` 代理支持（undici dispatcher）
- 探针新增 `discover` 命令定位正确 accountId（原 `.env` 误填 userId 导致 403）

### 修复（Review1 复审 P0/P1）
- P0 启动护栏接入真实入口：新增 `src/exchange/propr/index.js` 工厂，`createExchange()` 先执行
  `validateProprConfig()` 再分流，脚本/测试/未来入口均无法绕过
- P0 脱敏接入真实输出链路：日志边界统一脱敏（`src/log.js` 对 msg/ctx 调 `redactSecrets`/
  `redactRecord`）；vendor SDK 抛出 `ProprAPIError` 前对 API 返回消息脱敏；新增 `safeError()`
- P1 `accountId` 纳入结构化脱敏（前 4+后 4）；深度超限返回 `[REDACTED_DEPTH_LIMIT]` 不再透传原值
- P1 非法 `PR_MODE` 改为 fail closed（拒绝启动，不再静默降级为 paper）
- P1 `package-lock.json` 版本对齐 1.7.0
- 新增 `src/exchange/propr/paper.js`（本地 BTC 模拟适配器），paper 模式端到端可用

### 测试
- 新增 `test/propr-redact.test.js`：脱敏、四模式启动护栏、错误分类、日志边界、深度上限、safeError
- 新增 `test/propr-modes.test.js`：真实入口护栏、非法 PR_MODE fail closed、paper 撮合契约
- `npm test` 全绿 + lint 0 error

## [1.6.9] - 2026-09-22

### 修复（Review23：v1.6.8 续跑看门狗复审）
- P1 巡检重入竞态：tick 无重入保护，checkOne 耗时分钟级（重连+对账+撤单确认）时
  下一轮 60s tick 会叠加——并发 resume 抛"已在运行"幽灵失败垫高 resumeAttempts、
  并发 recoverStrayOrders 双倍撤单风暴 -> 加 busy 标志（上一轮未完成跳过本轮）
- P2 resume 监听器重复附着：resume()/_resumeRecovery() 在 running 置位前附着
  fill/price 监听，若 ex.start() 抛错则看门狗重试会再挂一遍 -> 事件双倍处理；
  改为先 off 再 on（对齐 _resumeTradingRuntime 既有模式）

### 测试
- resume-guard.test.js 增"巡检重入保护"（慢 resume 挂起期间第二次 tick 直接返回，不叠加接管）
- bot.test.js 增"resume 失败重试不重复附着监听器"（start 抛错后重试，listenerCount 恒为 1）
- 两项修复均经"临时移除修复 -> 测试失败 -> 还原 -> 通过"有效性验证；npm test 13 项全绿 + lint 干净

## [1.6.8] - 2026-09-22

### 新增
- 续跑看门狗（Review22 / 9·21"重启跳过续跑留裸梯"事故修复，`src/resume-guard.js`）：
  - ① 自动退避重连：1/2/5/15 分梯度、封顶后每 15 分钟永续（适配器 dataSource 无自愈，"待下次连接"永远等不来）；连上后同轮自动补续跑
  - ② 响亮化：接管缺失态即 bot 级 operationalIssue（卡片红）+ notify 每 30 分钟重复；重连/续跑计数进日志与健康详情（"重连中（第 N 次）"）
  - ③ 兜底撤单（10 分钟，三护栏）：接管严格优先（≥3 次 resume 尝试）；计时起点=交易所已连接且接管失败（离线不计时）；只撤单、永不动仓位（recoverStrayOrders 走确认链路，孤儿仓位走遗留持仓提示人工接手）；撤单失败每 5 分钟重试
- bot.js：`setOperationalIssue`（bot 级 issue 优先于交易所级）；server.js：引导续跑移交看门狗、手动重连路由复用共享 `tryResumeBot`

### 测试
- test/resume-guard.test.js 8 例（离线不计时/退避梯度、resume 优先、兜底条件、仓位零接触、撤单失败重试、外部解除静默、告警节流、市场名缺失）；npm test 全绿 + lint 干净 + 集成冒烟（引导续跑回归）

### 观察项（本次不带，避免混变量）
- 回收阶梯撤销条件偏松（"价格回到区间内"即时撤）：83k 边界 chop 下 18 分钟 10 轮挂撤；建议方向"回到区间内 ≥0.5 格 或驻留 ≥60 秒"

## [1.6.7] - 2026-09-20

### 新增
- 补 `recenterEnabled` 独立开关（动态网格分支 A 放行闸门，Review21 欠账）：
  - 语义：分支 A 执行条件 = `!shadow && recenterEnabled`（默认 false）；未放行时仍记录"本应重定"影子样本（注明"漂移重定未启用"），支持"先 B 后 A"毕业路径
  - 分支 B（自动重启）不受该开关影响：`shadow=false + recenterEnabled=false` 即"B 实盘 + A 影子"中间态
  - 观测：`_dynModeText()` 用于启动告警/监督器心跳/总览摘要（影子 / 实盘·自动重启 / 实盘·自动重启+漂移重定）
  - 前端 6 控制台动态面板增"漂移重定"复选框（默认未勾选）+ localStorage 持久化 + 总览分支状态显示

### 测试
- dynamic.test.js 4 用例补显式放行 + 3 新用例（A 开关关闭记样本 / B 独立 / 文案矩阵）；npm test 全绿 + lint 干净

## [1.6.6] - 2026-09-08

### 修复（review4：429 治理——分级节拍 + 读取侧退避）
- HL info 限额 ~1200 权重/分/IP，原 2s 全量轮询 ~1500 权重/分超支 -> 间歇 429
- 分级节拍：每 2s 价格走 allMids（~2 权重，替代 metaAndAssetCtxs 取价）；每 5s 账户+挂单+成交（clearinghouseState/frontendOpenOrders/userFillsByTime）；每 60s 市场元数据（metaAndAssetCtxs）——预算 ~1500 -> ~585 权重/分
- 读取侧 429 退避：2-5 秒 backoff + 抖动（原裸 250ms 重试）

### 测试
- hl.test.js 新增：allMids 价格更新（带 dex）、分级节拍（5s/60s 内不重复拉重端点）；npm test 9 项全绿 + lint 干净

## [1.6.5] - 2026-09-08

### 紧急修复（review3：14 单变 42 单事故）
- frontendOpenOrders 补 dex:"io" 参数：HL 默认挂单查询不返回 builder-dex 订单 -> 快照恒空 -> 安全重试两次快照校验也被骗过 -> 按档位去重认为全空 -> 原样重挂 3 波（14x3=42 单），第 4 波被保证金预检拦停；撤单也因查不到 oid 而"无单可撤"
- 纵深防御：bot.js _drainRetryQueueNow 加空快照守卫——期望有单（active+retryQueue>=10）但交易所返回 0 单视为快照不可信，本轮不重挂（宁可慢不可翻倍），四所通用（EX 空快照骗过 gone 判定、HL 骗过重试校验，同类欺骗补齐所有信任快照的地方）
- HIP-3 铁律写入适配器文件头：每个按 user 查询的端点都要问"它认不认 dex 参数"

### 测试
- bot.test.js 新增重试空快照守卫测试（空快照轮不重挂/不新增挂单/重试项保留/发暂缓告警）；npm test 9 项全绿 + lint 干净

## [1.6.4] - 2026-09-08

### 修复（review2：钱在 spot 口袋里 + RHC 面板被误删）
- HL clearinghouseState 查询补 dex:"io" 参数（hyperliquid.js:174）：HIP-3 建设者市场有独立清算账户，不带 dex 读的是核心 Perps -> io dex 的保证金/持仓永远显示 0（"当前可用 0 USDC" 的代码层根因之一）
- 恢复 tab-lr 面板（上轮清理前端残骸时误删整段，switchTab('lr') 拿 null 崩在 1565 行）：从 dev004-dy 提取完整面板插回 tab-hl 之前

### 变更
- scripts/check-html.mjs 升级为四项核对：重复 id / 缺失面板（tab 数组前缀逐一验证面板+导航+控制台+徽章）/ P() 引用核对（面板内引用的 ${prefix}-* id 必须存在于 DOM）/ 残缺标签

### 部署层说明（资金路径）
- HL 资金三级口袋：链上钱包 -> 核心 Perps -> io dex（HIP-3 独立清算账户）
- 用户需在 Entropy(io dex) 页面把资金从核心 Perps 划入 io dex，否则 io:ANTH 无保证金

### 测试
- npm test 8 套件 + check:html 四项全绿 + paper 冒烟（5 所 overview + RHC 路由正常）

## [1.6.3] - 2026-09-08

### 修复（review1：总览无数据 + 可用 0 USDC 诊断）
- 前端残骸清除：index.html 628 行起残留整段残缺重复块（丢 < 的 ov-card lr + 未闭合 </div<，22 个重复 id）导致 DOM 错乱、总览渲染写入被打断的卡片 -> 删除残骸，保留完整 lr/hl 卡片
- config.js hl 块 chainId 421614 -> 42161（v1.6.1 只改了 market.js，config 漏网；421614 是 Sepolia 测试网）

### 变更
- 新增 scripts/check-html.mjs（npm run check:html）：交叉核对重复 id/残缺标签/未闭合标签，并挂入 npm test 串联——v1.4.2 与 v1.6.0 两次前端插卡漏检事故的一劳永逸防线

### 部署层说明（代码层已确认正常）
- "当前可用 0 USDC" 是部署配置问题：新 VPS .env 显式写了 PAPER_BALANCE=0 或 HL 未配 live；总览"PAPER 徽标"= HL_MODE 未设 live
- 正确配置：HL_MODE=live + HL_ACCOUNT_ADDRESS + HL_AGENT_PRIVATE_KEY（官网已 approve 的 agent 私钥）+ PAPER_BALANCE=10000 或删掉该行

### 测试
- npm test 8 套件 + check:html 全绿（9 项）+ paper 冒烟总览 5 所数据完整

## [1.6.2] - 2026-09-07

### 修复（review20：三颗"过得了 health、死在第一单"的运行时地雷）
- ① Tif.Gtc 抛 AttributeError：Tif 是类型别名（Union[Literal['Alo'],'Ioc','Gtc']）非枚举 → 删 Tif 导入，limit_type 直接用字符串 "Gtc"/"Ioc"
- ② bulk_cancel 签名不符：SDK 是 bulk_cancel(cancel_requests: List[CancelRequest])，元素 {"coin","oid"} 字典 → worker 侧把 (coin, oids) 转为字典列表
- ③ Cloid 格式不匹配：Cloid.from_str 强制 0x+32 位 hex（16 字节），JS 生成的 g<base36> 字符串直接 TypeError → JS 侧改为 randomBytes(16) 生成合规 cloid，外部非法格式归一化；tracked 记录下单实际提交的 clientOrderId（与成交匹配同源），_refreshFills 增加 cloid 兜底匹配
- 连带修复：cancelAll 里 market 变量被 lint 误删导致 ReferenceError（本评审自检发现）
- 新增测试：cloid 合规生成/归一化/保留、cloid 成交匹配、bulk_cancel 请求结构

### 验证
- 签名器请求级冒烟（假 key 真实走 SDK）：place_order 带合规 cloid 签名上送成功（asset=200001 确认 io:ANTH 寻址）、非法 cloid 优雅报错不崩、bulk_cancel 字典列表上送、update_leverage 上送 —— 四命令全过
- npm test 8 套件全绿 + lint 干净

## [1.6.1] - 2026-09-07

### 修复（review19：HL 外部契约实测校准）
- P0 签名器五处 SDK 错误（实测 SDK 0.24.0 校准）：
  - 移除不存在的 OrderSide/OrderTimeInForce 导入（改为 Cloid/Tif）
  - Info/Exchange 构造加 perp_dexs=["io"]（实测正确解析 io 市场，asset id 偏移 200000）
  - Exchange wallet 改为 eth_account.Account.from_key（不再传裸私钥字符串）
  - order 改位置参数签名（实测 exchange.order(name,is_buy,sz,limit_px,order_type,...)）
  - 无 cancel_all → 用 bulk_cancel；cancel oid 改 int；update_leverage 参数名 is_cross
- P1 市场元数据四处（实测 metaAndAssetCtxs 返回数组 [meta, ctxs]）：
  - parseMarkets 改数组解构；maxLeverage 从 universe 读取（SNDK 10x 不再被压到 6）
  - stepPrice = 10**-(6-szDecimals)（无 pxDecimals 字段）+ 5 位有效数字报价取整校验
  - 费率改 0.00015/0.00045（HL 基础档，deployerFeeScale 1.0）
  - HL_MAINNET_CHAIN_ID 421614 → 42161（421614 是 Sepolia 测试网）
- P2 逻辑：userFills 无 cursor → 改 userFillsByTime + startTime 增量；_filledSeen 环形上限 5000；closePosition 改 ±5% IOC；清理 _cloids 死代码
- 新增 requirements-hl.txt 锁定 SDK 0.24.0
- 实测探针结论：签名器真实启动成功（health 通过）、io:ANTH asset id=200001、metaAndAssetCtxs/candleSnapshot 结构确认

### 测试
- hl.test.js 同步更新（数组市场结构/费率/priceDecimals/游标推进/环形裁剪）；npm test 8 套件全绿 + lint 干净

## [1.6.0] - 2026-09-07

### 新增
- 第5交易所 Entropy（Hyperliquid io dex，HIP-3 建设者市场）：`src/exchange/hl/` 六文件（market/signer_worker/signer/hyperliquid/paper/index）
  - io:ANTH 美股网格试点（1,880-2,100 / 22 格 / $10 间距 / 0.005/格 / 3x 逐仓 / recover+$30 / $150 本金）
  - 签名器用 agent wallet（可交易不可提现），命令面白名单（place/cancel/cancel_all/update_leverage isolated）
  - userFills 游标为成交权威源，无需 EX/LR 的三层证据链与穿越推定
  - 空快照守卫 + droppedLevels 死亡计数（对齐 EX 监控口径）
- 总览页过滤：只展示有金额在运行的交易所（live + balance>0 + running），隐藏 paper/无资金/未运行卡片；汇总区动态化并顺带修复 tot-modes 漏 lr 的历史 bug
- 前端/后端全链路接线：config.js hl 块、server.js 全触点、index.html 全套 hl 前缀（tab/面板/卡片/徽章/CSS/JS）

### 变更
- dev004-dy → dev005 分支承载全部开发
- test/hl.test.js 加入 npm test 串联（现 8 套件）

### 测试
- hl 适配器单测：市场解析（io dex 过滤）/ 逐仓字段 / userFills 游标去重 / 空快照守卫
- 全量 npm test 退出码 0 + lint 干净 + paper 冒烟（/api/overview 5 所、/api/hl/markets io:ANTH）

## [1.5.11] - 2026-09-05

### 修复（review18：动态网格零输出诊断）
- 根因：前端"启用"复选框无默认 checked（影子/自动重启有），页面刷新即回未勾选 -> payload enabled:false -> _dynCheck 首行 return，影子期空转两周
- ① 四处控制台（de/ex/rs/lr）动态"启用"默认勾选
- ② start() 启动告警追加动态状态（"动态网格：启用（影子）/未启用"）；_startDynTimer() 增加"动态监督器已启动"心跳日志——启动日志自报状态，配置失误无处遁形
- ③ 动态面板 localStorage 持久化（勾选+数值），修复"刷新即失忆"陷阱（与 9·4 做多网格误启动同源）

### 教训入账
- 任何新功能必须在启动日志里自报状态——查不到的配置迟早变成查不出的事故

## [1.5.10] - 2026-09-04

### 紧急修复（review17，生产事故回滚）
- RHC `accountInactiveOrders?limit=250` 被服务端拒收（400 invalid param，上限未公开实测 <250）：
  - v1.5.8 的 limit=100→250 导致整轮 `_refreshOrders` 抛错中断 → inactive 确认/穿越推定/死亡计数全部停摆 → LR 成交无法确认 → bot 对账误清失效档位（127→125 衰减、6 格库存漂移告警均为断链产物）
  - 热修复：改回 limit=100（穿越推定本为窗口溢出准备的第三证据源，恢复后即可兜底）
  - 教训入账：交易所 API 参数边界改动须"部署前用真实凭据 curl 探测"后再进代码

## [1.5.9] - 2026-09-04

### 修复（dev004-dy review16，补 EX v1.5.4 的两道防线）
- P1 重现清零 goneFirstAt：LR 订单在活跃快照重现时清零 goneFirstAt——此前快照毛刺启动计时、重现后残留、二次毛刺时 90s"已满"触发幻影推定成交（RHC 刚补挂近价单多带穿越标记，比 EX 更危险，会主动制造重复挂单+库存记账错误）
- P2 空快照守卫：RHC 曾出现 502/空数组，一次 200+空数组给全梯同时启动计时；现空快照+本地跟踪>=10 时本轮不做任何 gone 判定，持续>3 分钟升级 operationalIssue（对齐 EX _emptyStreakStart 模式）

### 变更
- 测试新增：重现清零计时 / 空快照轮不删跟踪不启动计时不触发推定

## [1.5.8] - 2026-09-04

### 修复（dev004-dy review15）
- RHC Lighter 三项移植（对齐 Extended 防护水平）：
  - ① 价格穿越推定：fast 行情下 inactive 查不到 + 市场价曾穿越其价 + 90s 未决 -> 推定成交并发 fill 补挂对腿（crossInferredFills 计数）；LR 证据链本就强（inactive 带 filled_base_amount），推定为第三道保险
  - ② inactive 查询 limit 100->250：快速行情批量成交时 100 条查证窗口溢出 -> 漏认成交 -> 档位静默死亡（9·4 LR 141->105 的 36 格衰减根因）
  - ③ droppedLevels 死亡计数：订单出簿 10 分钟仍无法经 inactive 确认且未穿越 -> 响亮告警 + 计数（对齐 EX 监控口径，仅计数不删跟踪不重复补挂）

## [1.5.7] - 2026-09-04

### 修复（dev004-dy review14）
- Extended 证据链第二击穿：9·3 单边上涨中 36+ 卖单真成交，因 history/trades 端点持续滞后被误判"取消"丢档。新增**价格穿越推定**第三证据源：maker 单从簿消失 + 市场价格曾穿越其价位 + 90 秒双端点仍无答案 -> 推定成交（按挂单价记账并补挂对腿）；未穿越的照旧走 10 分钟耐心判取消（9·1 前夜 2 单真取消场景保持正确）。补挂延迟从 10 分钟压到 1.5 分钟；误判方向与真成交相反，库存审计会立即报反向漂移做闭环校验
- 新增 `crossInferredFills` 独立计数（经 getState 观测端点滞后频率；若常态化偏高应接 Extended WS 成交流做战略修复）
- 影子门拦截日志：分支 A 漂移达标但被库存门拦截时输出节流负样本日志（每小时一条，第 7 天评审可参考）

### 变更
- 测试新增：价格穿越推定成交 / 未穿越保持耐心

## [1.5.6] - 2026-09-03

### 修复（dev004-dy review13）
- 审计重校准：恢复/续跑路径旧快照缺省时，不再"只重置锚点却沿用旧基线"（基线锚点不同步会把合法积累库存当假漂移，第四形态假警）；改为打 `_auditNeedsRebase` 标记，首次观测时基线与锚点同刻校正到当前持仓+成交计数，本轮不审计、从下轮起干净对账，并持久化新基线（下次重启不再回退）

### 变更
- 测试新增"恢复后首轮重校准不误报"用例

## [1.5.5] - 2026-09-02

### 修复（dev004-dy review11+12）
- 审计锚点：start() 与库存基线同刻锚定 _auditBuysBase/_auditSellsBase（成交计数跨重启累计，重启前成交被双重计数成假漂移）；快照持久化、旧快照缺省=从恢复时刻重新对账
- 审计公式改全带符号（修空头基线假警/方向翻转漏报）；告警带所名（两所同时叫时分得清）
- 空快照升级为健康事件：Extended 空快照持续 >3 分钟置 operationalIssue（仪表盘变红/哨兵可见），快照恢复时清除

### 变更
- 盲飞期间暂停开仓侧补单：暂缓（review12 建议观察一次完整自愈周期后再定）

## [1.5.4] - 2026-09-02

### 修复（dev004-dy review10）
- P1 订单重现清除 gone 状态：Extended 订单在 open-orders 快照中重现时，同步清零 goneFirstAt/_lastProbeAt（此前只清了 goneAttempts，10 分钟耐心被一次预热毛刺预支，后续瞬时快照抖动会"零等待"批量判死档位）
- P2 适配器层空快照守卫：Extended _poll 在"快照为空但本地跟踪≥10"时视为接口异常快照，本轮跳过 gone 判定（不启动/累积耐心计时），镜像 bot 层 reconcile 的 massVanish 逻辑，消除服务重启预热期批量误判
- 修复 1/2 共同闭合"服务重启后 10 分钟惊吓"的缺口（随常规发版，不为此单独重启）

### 变更
- (review9 判定挂单 136-140 震荡为正常不变量，无需改动)

## [1.5.3] - 2026-09-02

### 修复（dev004-dy review8）
- P1-a 库存审计阈值：容忍从 gridCount 格(140→无意义)改为 max(2, gridCount×3%)（140格→5格），能抓住 21 格事故；新增 _invBase 库存基线（start/resume 记录、快照持久化），保留持仓重启不误报已知遗留库存
- P1-b 费率：`Number(...)||0.0005` 吞掉合法零费率 → 改 Number.isFinite 区分"零"与"未知"，Extended/RHC 虚假手续费告警真正消除
- P2-a 成交流水探测 30s 节流（避免 20 单未决时每秒 8 请求加剧 API 滞后为限流雪崩）
- P2-b goneFirstAt 复活后清零（二次消失重新计时）
- P2-c 确认撤销恢复事件（措辞含"取消"命中撤单熔断，Extended 撤单风暴不失明）

### 变更
- 测试新增：带基线重启不误报；库存审计测试改用新容差语义

## [1.5.2] - 2026-09-02

### 修复（Extended 挂单衰减，Review7）
- _resolveGone 耐心改为时间制（10 分钟），修复夜间 API 结算滞后下把"实际已成交的买单"误判为"已撤销"导致档位永久空洞 + 库存漂移（Starknet 成交确认，21 档被丢根因）
- 新增成交流水第二证据源（/api/v1/user/trades，尽力而为：命中即确认成交并按真实价/量入账）
- 静默丢弃改响亮告警 + droppedLevels 计数（明确"该档位已空洞，请核对并考虑重启补齐"）
- 修复 2：30 秒对账新增库存漂移审计（实际持仓 vs 成交流水推导，超容差告警，把静默漏气变可见）
- 修复 3：Extended 展示费率与签名 maxFee 分离（displayFeeRate=maker0），消除"间距不足手续费"虚假告警

### 变更
- 测试新增：库存漂移审计（±N 格容差 / 超阈值告警）

## [1.5.1] - 2026-09-01

### 修复（dev004-dy review6）
- P1-a: restore() 现在启动动态监督器——崩溃重启后持久化恢复的自动停机态可被冷静门消费（此前监督器失联，"跨重启自动重启"失效）
- P1-b: stats 重建基对象包含 recenters/autoRestarts，修复旧快照缺失键导致 NaN 计数静默丢失；resetStats 保留动作计数（非盈亏统计）
- P2-a: 分支 A 漂移重定排除 outOfRange/recover 态（回收阶梯挂着时不重定，状态机不被搅浑）
- P2-b: width 显式取 upper-lower；alignToStep 分支 A 传 this.grid.spacing、分支 B 仅按 stepPrice 对齐（buildGrid 重算 spacing）

### 变更
- P3-②: 分支 B 统一读 as.config（停机时点配置），防停机态后再改 config 造成不一致
- 测试新增 P1-a 例（restore 后监督器工作）

## [1.5.0] - 2026-08-31

### 新增
- 动态网格（基于 90 天回测：冷静门控自动重启为价值主体，漂移重定影子优先）：
  - 分支 B：破界/止损自动停机后，冷静门（近 5 日动量 ≤3%）满足才自动重启，区间以现价居中（走完整 start()，继承保证金预检/撤单确认/AIMD 配速）
  - 分支 A：价格漂移 + 净库存平 + 冷静门 + 冷却满足才漂移重定（默认影子模式，只告警不执行）
  - 安全语义：动态层零新增下单路径，仅复用 start()/adjustRange()
- 配置：dynamic { enabled/shadow/driftFrac/invGateGrids/recenterCooldownMin/restartEnabled/restartCooldownMin/calmWindowH/calmMaxMovePct }
- 自动停机语义：手动 stop/撤单/平仓取消自动重启（永不自动重启）；自动停机状态随快照持久化跨重启保留
- 前端：四所控制台"动态网格"折叠区 + 总览卡动态计数/自动重启待命状态

### 变更
- 配置数值解析用 Number.isFinite 尊重显式 0（原 || 兜底把 0 当未设置）

## [1.4.6] - 2026-08-31

### 修复
- 虚假手续费告警：RHC 零费率（maker/taker=0）不再被默认 0.0005 覆盖条件跳过，_loadMarkets 在有市场费率数据时一律覆盖 feeRate

### 变更
- 平仓腿优先级：重试队列出队时 reduce-only/平仓腿排最前，限额紧张时止盈腿不被远端铺单饿死
- AIMD 自适应配速：批间间隔从固定 1.5s 改为自适应——撞限乘性减半（封顶 40s）、成功向基线收敛，自动贴合 RHC 真实限额
- 批量 429 日志降噪：限流不再走告警通道，改 INFO 聚合（"剩余 X 单待铺"）
- 启动预估时长改用自适应配速现算（消除"预计 40 秒、实际 5 分钟"落差）

## [1.4.5] - 2026-08-31

### 修复
- market.js 浮点缺陷：三处 `10 ** -decimals` 改为 `1 / 10 ** decimals`（平台无关）——`10 ** -N` 在部分 V8 下产生 `0.00000999…` 污染 stepSize/stepPrice 元数据，并导致 npm test 在换机器时红
- setPollLight 恢复改为反映剩余铺单进程数（避免重试 drain 与成交补单重叠时提前恢复重轮询）

### 变更
- 无

## [1.4.4] - 2026-08-31

### 修复
- RHC 铺单限流自激（429 风暴）：批量配速从 0 加到 1.5s、重试地板 1s→5s、_confirmAccepted 由单次 350ms 改为多轮等待（合计 ~5.7s）部分确认、铺单期间轮询降载（setPollLight）、写请求最小间隔 ~1.1s 保险带
- 启动铺单按"离现价近者优先"排序（限流时首批即能开始工作）
- 启动告警标注预期铺单时长（限流保护配速，勿中途停止）

### 变更
- SAFE_GRID_BATCH 10→15（与 MAX_BATCH 对齐，140 单 14 批→10 批）

## [1.4.3] - 2026-08-31

### 修复
- RHC 市场下拉无数据：header 缺失 hdr-lr / hdr-lr-dot 徽标，loadMarkets 中 $('hdr-lr').textContent 抛 null 错误导致市场列表加载中断
- loadMarkets 加防御守卫：header 徽标缺失时不再阻断市场加载（避免同类半接线再次中断）

## [1.4.2] - 2026-08-31

### 修复（dev004 review2 反馈）
- **RHC 前端面板整体缺失（阻断级）**：补齐 tab-lr 面板（克隆自 rs 面板，全部 lr-* 控件）、导航按钮、dot-lr/panel.lr/ov-card.lr CSS 与 --lr-color 变量、switchTab 数组加 lr——此前 makeExchangeCtrl('lr') 因 $('lr-modes') 为 null 抛 TypeError 导致全站脚本崩溃（总览 SSE 不刷新）
- 防御性守卫：makeExchangeCtrl 入口缺面板时跳过初始化（不再中断后续脚本）；两处 start payload 的 max-loss 加 null 守卫
- 图表颜色补 lr 分支（不再落到 RISEx 同色）

## [1.4.1] - 2026-08-31

### 修复（dev004 review 反馈）
- 破界硬止损真正可用：前端新增硬止损输入框（max-loss）并注入 start / start-recovery payload；_checkMaxLoss 门条放开，覆盖独立回收模式（outOfRange=false 场景）
- 总览 1s SSE 广播补上 lr（此前 RHC 总览卡首帧后永不刷新）
- 尘埃仓守卫：部分成交低于最小下单量时跳过补挂对腿（避免对腿被拒 + 无意义重试 + 告警噪音）

### 变更
- start() config 增加 minOrderSize（尘埃仓守卫数据源）；独立回收模式支持 recoverMaxLossUsd
- 测试新增 3 例：recover 硬止损 / 独立回收硬止损 / 尘埃仓守卫

## [1.4.0] - 2026-08-31

### 新增
- **RHC Lighter 交易所接入**（Robinhood Chain，第 4 所）：配置/服务端/前端接线、Python 签名器（signer_worker.py 离线签名）、测试
- **破界出口纪律**：recover 模式新增 `recoverMaxLossUsd` 硬止损——未实现亏损达到上限自动撤单+平仓+停止（recover 本身不止损，此值为单边行情提供硬退出线）
- 部分成交记账修复：Lighter 订单"部分成交后被撤"现补发 fill，消除库存静默漂移

### 变更
- Lighter 轮询 5s→2s，降低成交/补单延迟（完整 /stream WS 推送需 RHC 协议文档，暂以快速轮询替代，已标注）
- 快照/对账/AI 快照扩展到 4 所；outOfRangeAction 新增 recoverMaxLossUsd 参数

### 注意
- RHC 实盘需 Python 环境 + lighter-sdk（1.1.2）；部署见 README

## [1.3.1] - 2026-08-20

### 修复
- 登录弹窗重复弹出：并发 apiFetch 在鉴权模式探测完成前收到 401，误走旧的令牌 prompt 分支导致多次弹窗。改为 401 先等待模式探测（authProbe）再分流，非 token 模式不弹 prompt，登录框幂等（已在显示则不重复弹）

## [1.3.0] - 2026-08-19

### 新增
- 账号密码鉴权（DASHBOARD_USER/DASHBOARD_PASS）：/api/login 换取会话令牌（默认 12h，DASHBOARD_SESSION_MS 可调），登录弹窗 UI + 退出按钮；DASHBOARD_TOKEN 静态令牌模式保留为兼容回退
- 主题自动切换：跟随系统 prefers-color-scheme 白天/夜晚，header 图标按钮可手动覆盖（localStorage 记忆）
- 极简扁平化：统一圆角变量、按钮去除渐变、弱化立体感
- 移动端响应式（iPhone）：网格单列化、触控目标放大、iOS 聚焦防缩放、小屏隐藏次要信息

### 变更
- /api/version 豁免鉴权（仅元数据，供前端探测鉴权模式）

## [1.2.3] - 2026-08-19

### 修复
- Decibel 第 1+2 层死循环防护：
  - 撤单重试：cancelAll/cancelOrder 单笔失败 1s/2s 退避重试 3 次（链上瞬时拥堵常见），不再一失败就中止整个停止流程
  - 幽灵单快速清理：_resolveGone 提交后未被交易所确认的订单 3 轮（约 6-8s）即清理，明确"不视为成交、不补单、不撤单"
  - 回收阶梯撤单跳过幽灵单：只对交易所真实挂单簿中存在的订单发链上撤单，避免对不存在订单发撤单被拒、浪费 gas 并累积错误

### 变更
- 测试新增 decibel-safety（5 例），总计 49 例

## [1.2.2] - 2026-08-18

### 变更
- 对齐原版保守设计：移除 Extended/RISEx（live + paper）适配器的 supportsSafeOpeningRetry，开仓单失败不再自动重试（缺格通过挂单进度可见 + 一键补格人工补齐），消除挂单快照抖动下重复挂单的风险

### 修复
- 无

## [1.2.1] - 2026-08-18

### 新增
- 总览页持仓展示：每所卡片显示当前持仓（方向/数量/杠杆、均价、强平价、未实现盈亏）
- 总览页运维异常提示（operationalIssue + API Wallet 地址），与单所控制台一致

## [1.2.0] - 2026-08-18

### 新增
- 移植原作者最新版安全机制：一键补格 refillGrid、撤单确认（_cancelAllConfirmed 轮询交易所确认消失）、开仓单安全重试 + 挂单进度跟踪（placementProgress，两次权威快照去重）
- 适配器安全增强：撤单失败保留本地跟踪（确认后 forgetOrder 清理）、malformed 挂单快照不视为 0 单
- Decibel 友好错误翻译（operationalIssue）：gas 不足时仪表盘直接显示中文原因 + API Wallet 地址可一键复制
- 持仓展示增强：强平价（liquidationPrice）显示
- 前端：三个控制台"一键补格"按钮、挂单进度/交易所核实挂单数展示
- 测试：cancel-safety（10 例）+ safety-progress（5 例，补格/进度/安全重试/停止中止），总计 44 例

### 变更
- 保留既有安全与修复：VPS 鉴权、XSS 转义、结构化日志、ESLint、RISEx 余额/杠杆/撤单三项修复

## [1.1.3] - 2026-08-14

### 修复
- RISEx 杠杆设置失效：risex-client SDK 的 `updateLeverage` 请求体键名与服务端协议不匹配（发 `permit`，服务端要求 `permit_params`，实测 400），且杠杆值需 WAD 放大（×1e18）。已绕开 SDK 该方法，用其签名原语自组装请求

## [1.1.2] - 2026-08-14

### 修复
- RISEx 余额单位再修复：`balance` 字段单位在账户间不一致（有的原始 18 位单位、有的直接人/币单位），改为阈值启发式归一化（>1e12 视为原始单位 ÷1e18），并记录原始值便于排查

## [1.1.1] - 2026-08-14

### 修复
- RISEx 余额单位换算 bug：余额接口返回原始 18 位小数单位，此前直接当作人/币单位导致余额显示天文数字、保证金预检失效；现除以 1e18 并做 NaN 防御
- RISEx 余额读取失败不再静默：写入结构化日志，便于排查"无法读取余额"（账户无余额记录时接口返回 500）

### 新增
- 版本号机制：/api/version 端点 + 仪表盘右上角展示当前版本（随 package.json 自动更新）

## [1.1.0] - 2026-08-14

### 新增
- HTTP 鉴权：DASHBOARD_TOKEN 静态令牌（前端会话保存、SSE 支持 query token）+ Origin 白名单 + Host 回环校验，阻断 DNS rebinding / CSRF / 未授权访问
- 前端 XSS 转义：esc() 统一转义外部数据（交易所市场名、AI 输出、错误消息）
- bot.js 核心逻辑单元测试（内存 mock 交易所：铺单/补单链/风控/reconcile/resume/保证金）
- ESLint（flat config）与 npm run lint
- 结构化日志模块 src/log.js（JSON lines + 按天轮转 + LOG_LEVEL/LOG_DIR）
- README VPS 部署安全建议章节

### 修复
- 依赖漏洞：ws（ethers ← risex-client 传递依赖）内存泄露/DoS 漏洞修复

### 变更
- 全部 /api/* 端点受鉴权保护（配置 DASHBOARD_TOKEN 时）
- 关键事件日志从 console 迁移至结构化日志

### 移除
- （无）
