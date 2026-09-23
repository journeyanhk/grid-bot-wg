# 任务清单: 接入 Propr 挑战账户（BTC 中性网格 + 挑战风控）

目录: `helloagents/plan/202609221928_propr-exchange/`

> 前置：分支 `dev-propr`（已从 dev004-dy 创建）。用户持 $5K Free Trial API Key。
> 交付终点：Shadow 24h → Free Trial `sim-write` 24–72h → 付费 Challenge 实测（需购买账户 + 人工确认清单全通过）。
> Review 1–5 为分批交付门：每批完成后暂停，等待人工 Review 再进入下一批。
> 部分任务依赖探针结论（hedge/net），未确认前不得进入对应分支实现。

---

## 1. 配置、模式与 SDK 引入（Review 1）
- [√] 1.1 在 `src/config.js` 新增 `propr` 配置块（四级 `PR_MODE`、`PROPR_*`、`PR_*`）并暴露到 `getConfig()`，在 `.env.example` 增加 `PR_*` 说明，验证 how.md#四级运行模式ADR-006
- [√] 1.2 在 `src/config.js` 实现账户护栏：显式 `PROPR_ACCOUNT_ID`、`PROPR_ALLOWED_ACCOUNT_IDS` 白名单、`challenge` 需 `PR_ALLOW_CHALLENGE=YES`，依赖任务 1.1
- [√] 1.3 在 `src/exchange/propr/propr-sdk.js` vendor 官方 JS SDK 源码为 ESM（保留出处/版本注释，去除 TS 类型标注），并 `npm install ulid`、更新 `package.json` 依赖
- [√] 1.4 在 `src/exchange/propr/{errors.js,types.js}` 定义错误映射（400/401/403/404/429/500、`ProprReadOnlyError`、`UnknownOrderStateError`）与内部类型，依赖任务 1.3
- [√] 1.5 落实日志脱敏（禁止 Authorization/API Key/Cookie/完整认证信息；accountId 仅前 4+后 4），验证 why.md#需求-四级运行模式与安全护栏，依赖任务 1.4
- [√] 1.6 运行 `npm test` + `npm run lint` 基线全绿（确认本批未破坏现有 6 所）
- [√] 1.7 【Review1 复审 P0】新增 `src/exchange/propr/index.js` 工厂，`createExchange()` 先 `validateProprConfig()` 再分流，护栏接入真实入口
- [√] 1.8 【Review1 复审 P0】脱敏接入真实链路：`src/log.js` 日志边界统一脱敏、vendor SDK 错误消息脱敏、新增 `safeError()`；脱敏模块上移至平台层 `src/redact.js`
- [√] 1.9 【Review1 复审 P1】`accountId` 结构化脱敏（前 4+后 4）；深度超限返回 `[REDACTED_DEPTH_LIMIT]`
- [√] 1.10 【Review1 复审 P1】非法 `PR_MODE` fail closed（拒绝启动）
- [√] 1.11 【Review1 复审 P1】`package-lock.json` 对齐 1.7.0；新增 `src/exchange/propr/paper.js`（paper 端到端可用）

## 2. 契约探测与冻结（探针门）
> 已完成（2026-09-23）：`discover` 修正 accountId（原误填 user id → 403）；`readonly`/`order`/`idempotency`/`position`
> 全部跑通。契约冻结于 `docs/propr-api-contract.md`。关键结论：**net 净仓**、**权益权威可得**、
> **intentId 幂等有效（冲突码 13084）**、**asset="BTC"**、maker 0.00015 / taker 0.00045、**必须走 PR_PROXY**。
- [√] 2.1 在 `scripts/propr-probe.mjs` 实现只读链探针（health/healthServices/getUser/setup/getChallenges/getChallengeAttempts/getChallengeAttempt/getPositions/getOrders/getTrades/getMarginConfig/getLeverageLimits），输出原始结构与脱敏摘要，验证 why.md#需求-Propr-只读适配器契约探测-Day-0-契约探测，依赖任务 1.1、1.3
- [√] 2.2 在 `scripts/propr-probe.mjs` 实现订单链探针（远离市价最小量限价单 → 查 open → 校验 side/positionSide/reduceOnly → cancel → 复查消失），依赖任务 2.1
- [√] 2.3 在 `scripts/propr-probe.mjs` 实现幂等链探针（固定 intentId → createOrders → 重复发送 → 查 open/trades 确认无重复），依赖任务 2.2
- [√] 2.4 在 `scripts/propr-probe.mjs` 实现持仓链探针（多空独立性判定 + 只平净额清理），依赖任务 2.2
- [√] 2.5 在 `docs/propr-api-contract.md` 冻结结论：①hedge vs net=**net** ②`asset`=**"BTC"** ③精度（0.001/1 位小数实测接受）④intentId 幂等=**有效，13084 冲突码** ⑤时间戳/错误结构/权益=**account 权威字段**；依赖任务 2.1–2.4
- [√] 2.6 依据 2.5 确定 `PR_POSITION_MODE` 落地路径：**net 走阶段 5A，5B 取消**，已回填 how.md#ADR-001；依赖任务 2.5

## 2R. Review2 复审修复（探针安全强化，2026-09-23）
- [√] 2R.1 【P0】asset fallback 仅允许明确 400 参数错误触发；超时/网络/429/5xx 一律先按 intentId 对账，对账不到即报未知订单态并停止创建
- [√] 2R.2 【P0】`probePosition()` 改 try/finally，清理以真实 `getPositions()` 为准循环平至空仓（最多 4 轮），残留则 P0 告警 + 非零退出码；移除对内存 `openedLegs` 的依赖
- [√] 2R.3 【P0】非 `discover` 命令严格绑定 `PROPR_ACCOUNT_ID`（`bindConfiguredAccount()` 抛 `ProprStartupError`），禁止回退 `active[0]`
- [√] 2R.4 【P1】权益字段检测修正到 `challengeAttempt.account` + `balance` 硬断言；`equityFieldsPresent` 用 `Object.hasOwn`
- [√] 2R.5 【P1】幂等/撤单复核改为跨全部状态查询（`pending/open/partially_filled/filled/cancelled/rejected/expired`），并增加 cancel 响应/终态/成交数多重信号
- [√] 2R.6 【P1】`13084` 识别兼容字符串（`String(err?.code) === '13084'`）
- [√] 2R.7 【Review2 新增】`equity` 命令：开/持仓/平仓后按 0/10/30/60s 采样权益刷新时效（实测：balance/available 即时、uPnL ≤30s、`updatedAt` 不可用）
- [√] 2R.8 契约文档收窄措辞并拆分「已冻结 / 待验证」两节（`docs/propr-api-contract.md#7`）

## 2S. Review2 复审修复（只读可靠性，2026-09-23）
- [√] 2S.1 【P1】活动挂单纳入 `pending/open/partially_filled`（`Promise.allSettled` 多状态 + 去重；全失败才抛）
- [√] 2S.2 【P1】成交轮询改分页 + 时间游标 + 30s 重叠窗口（常规 ≤5 页/500 条，重连走全量 ≤20 页）
- [√] 2S.3 【P1】shadow 账户/持仓读取失败保留上次快照并标 stale，不再假报空仓
- [√] 2S.4 【P1】Propr/Shadow 的 error 事件统一走 `mapProprError`（分类 + 脱敏）
- [√] 2S.5 【P2】`PR_FEE_RATE` 默认留空 → 优先实测 maker 费率；`getTrades` 返回内部视图 + 新增 `getRawTrades`
- [√] 2S.6 【P2】`netPositionFromViews` 注释明确仅适用 net，多条同向按数量加权 entryPrice
- [√] 2S.7 新增 `test/propr-shadow.test.js`；`propr.test.js` 增补活动状态/150 条成交/内部视图/脱敏事件

## 3. 只读适配器与 Shadow（Review 2）
> 已完成（2026-09-23）：`market.js`/`mapper.js`/`propr.js`（只读）/`shadow.js`/`index.js` 全量落地，
> 真实链路冒烟通过（shadow 与 sim-write 的 init 均无写请求）。`setLeverage` 属写路径，移至 Review 3（4.6）。
- [√] 3.1 在 `src/exchange/propr/market.js` 实现 `buildMarket()` 与精度取整工具，验证 how.md#实现要点，依赖任务 2.5
- [√] 3.2 在 `src/exchange/propr/mapper.js` 实现 `mapProprOrder/mapProprPosition/mapProprTrade/mapProprMargin/mapProprError` 纯函数，依赖任务 1.4、2.5
- [√] 3.3 在 `src/exchange/propr/propr.js` 实现 `init()` 启动校验链与只读方法 `getMarkets/getPrice/getCandles/getPositions/getPosition/getOrders/getTrades`（`setLeverage` 移至 4.6），依赖任务 3.1、3.2
- [√] 3.4 在 `src/exchange/propr/paper.js` 实现本地 paper 适配器（不访问 Propr），依赖任务 3.1
- [√] 3.5 在 `src/exchange/propr/shadow.js` 实现 ShadowExchange（读 Propr + 真实行情本地撮合，`createReadOnlyClient()` 写方法一律抛 `ProprReadOnlyError`），验证 why.md#需求-四级运行模式与安全护栏-Shadow-模式绝对只读，依赖任务 3.3
- [√] 3.6 在 `src/exchange/propr/index.js` 实现 `createExchange(cfg)` 四模式工厂，依赖任务 3.4、3.5
- [√] 3.7 【Review1 复审要求】分页处理：`getAllOrders/getAllTrades/getAllPositions`（`_paginate`，默认 100/页、上限 20 页），依赖任务 3.3
- [√] 3.8 【探针遗留】精度专项探测：**API 层完全不校验**（1e-7/5 位小数/$0.87 均接受）→ 适配器改用 HL BTC 保守值本地强制，已回填契约文档
- [√] 3.9 【探针发现】代理接入：`init()` 支持 `PR_PROXY`（undici dispatcher），真实链路冒烟通过，依赖任务 3.3
- [√] 3.10 【探针发现】权益读取：`getChallengeAttempt().account` 权威字段 + `equitySource='propr_account'` + 本地 `equityFreshAt` 新鲜度（`isEquityStale`），依赖任务 3.2
- [√] 3.11 【探针遗留】权益刷新时效专项探测（`equity` 命令，0/10/30/60s 采样），结论已回填 `docs/propr-api-contract.md#1.1`

## 4. 写路径与幂等（Review 3）
> 已完成（2026-09-23）：真实 sim-write 冒烟通过（自有 intentId 下单 → reconcile 命中 → 撤单复核 → 无残留）。
- [√] 4.1 在 `src/exchange/propr/propr.js` 实现 `placeLimitOrder/placeLimitOrders`（统一走 createOrders+自有 intentId，结果与输入等长），验证 why.md#需求-Propr-交易适配器-批量铺网与幂等，依赖任务 3.3
- [√] 4.2 在 `src/exchange/propr/propr.js` 实现 `cancelOrder/cancelAll/closePosition`（撤单先查实况、平仓自实现全平），依赖任务 4.1
- [√] 4.3 在 `src/exchange/propr/propr.js` 实现订单状态机与 `UnknownOrderStateError → TRADING_LOCKED` 路径，依赖任务 4.1
- [√] 4.4 在 `src/exchange/propr/propr.js` 实现本地 intent 日志与 `reconcileOrders()`（按 intentId 匹配），依赖任务 4.3
- [√] 4.5 【Review1 复审要求】适配器不对外暴露官方 `createOrder()`（会覆盖 intentId），统一走 `createOrders()`；如需保留原始能力则改名 `createOrderRaw()` 并标注禁用，依赖任务 4.1
- [√] 4.6 【Review2 移交】`setLeverage` 实现（`getMarginConfig` → `updateMarginConfig`），含杠杆上限与挑战规则收敛校验，依赖任务 4.1

## 4R. Review3 复审修复（写路径安全，2026-09-23）
- [√] 4R.1 【P0】`cancelOrder` 权威复核：orderId 直查 + **全状态分页扫描**兜底；仅「查到且终态」或「查不到但有成交佐证」返回 true；查询失败置 stale 并返回 false（不误报已撤）
- [√] 4R.2 【P0】活动订单快照**部分失败即不完整**：保留旧快照 + `ordersSnapshotStale` + `_assertCanOpen` 禁止开仓，恢复后自动清除
- [√] 4R.3 【P1】`closePosition` 复用统一 intent 恢复路径（`_placeReduceOnlyMarket` → `_recoverIntent`）：超时已成交对账恢复不重复发单；无法确认则锁定开仓并返回 false
- [√] 4R.4 【P1】成交游标顺序修正：先按上一轮游标分页、**tradeId 去重为唯一标准**，不再用时间窗口丢弃未见过的成交
- [√] 4R.5 【P1】`cancelAll` 快照失败不使用旧快照下结论（尽力撤已知单但返回 false）
- [√] 4R.6 【P2】`placeLimitOrders` 逐个校验 `marketId`（不再静默改成 BTC）
- [√] 4R.7 测试补齐：orderId 过滤器不可用不误报、快照部分失败保留旧快照并禁开仓、平仓超时已成交/未确认、成交跨窗口不丢单
- [√] 4R.8 真实 sim-write 平仓链路冒烟：市价开多 0.001 → `closePosition` → 净仓归零、未锁定

## 5A. 持仓模式落地 — net 分支（探针已确认，本分支生效）
- [√] 5A.1 在 `src/exchange/propr/propr.js` 实现 `getPosition` 返回带符号净仓，`positionMode='net'`，验证 how.md#ADR-001，依赖任务 2.6
- [√] 5A.2 在 `test/propr.test.js` 覆盖净值降级补单方向正确性（空仓→null、多仓正、空仓负、双条净额），依赖任务 5A.1

## 5B. 持仓模式落地 — hedge 分支（探针结论为 net，本分支取消）
- [-] 5B.1 在 `src/exchange/propr/propr.js` 暴露 `positionMode='hedge'` 与双边 `getPositions()`
  > 备注: 探针实测 Propr 为 net 净仓（反向单被归一化为 reduce），无 hedge 语义，本分支取消。
- [-] 5B.2 在 `src/bot.js` 以能力位最小扩展 hedge 下单与双边净库存控制
  > 备注: 同上，GridBot 无需改造，降低回归风险。
- [-] 5B.3 在 `test/propr.test.js` 覆盖多空并存不误合并、reduce-only 方向正确
  > 备注: 同上，改为在 5A.2 覆盖净仓补单方向。

## 6. 接入 GridBot 与 server（Review 4）
> 已完成（2026-09-23）：后端 ~20 处插入点全部接入；前端新增独立 Propr 挑战账户卡片
> （模式/账户/锁定态/权益来源，不并入三所汇总）；server 级 shadow 与 sim-write 双模式冒烟通过。
- [√] 6.1 在 `src/server.js` 完成第 7 所注册全部插入点（import/预检查/实例化/restore/错误监听/AI 注释/日历/Liveness/SSE/路由分区/overview/初始化/续跑/看门狗/孤儿检测/启动横幅/代理配置）
- [√] 6.2 在 `src/server.js` + 前端标注 Propr 模式与账户（卡片含 SHADOW/SIM-WRITE/CHALLENGE 文案、掩码账户、锁定/快照状态、权益来源；余额/权益栏注明为本地模拟账户）
- [√] 6.3 打通 `PR_MODE=shadow` 与 `sim-write` 启动冒烟，确认 Propr 卡片与市场列表可见（shadow 写请求 0、sim-write 权益取真实账户）

## 6R. Review4 复审修复（接入安全，2026-09-23）
- [√] 6R.1 【P1】新鲜度分离：`lastPriceOkAt`（HL 公开行情）与 `lastApiOkAt`（Propr API）分开计时；`_pollPrice` 只推进行情时间戳，看门狗改用 `lastOkKey='lastApiOkAt'`，杜绝"行情正常=Propr 健康"误判
- [√] 6R.2 【P1】前端隔离：抽取 `renderExchangeCard()`；汇总循环恢复为 6 所（Propr 不计入余额/盈亏/运行数，避免 `4/3 运行中`），Propr 卡片独立渲染
- [√] 6R.3 【P1】代理竞态：`ProprClient` 支持 per-client `dispatcher`，适配器不再调用 `setGlobalDispatcher`；HL 行情也走同一 dispatcher；启动日志标注 Propr 独立代理；`proxy.js` 注明忽略 PR_PROXY
- [√] 6R.4 【P2】`getPublicInfo()` 移除 `attemptId`（仅保留掩码账户等非关联标识）
- [√] 6R.5 【P2】Shadow 新鲜度细分：`marketLastOkAt` / `proprAccountLastOkAt` / `proprPositionLastOkAt`
- [√] 6R.6 【P2】新增 `test/server-propr.test.js`：真实拉起 server（全 paper），覆盖 `/api/overview` 含 propr、`/api/propr/state|markets|stream|reconnect`
- [√] 6R.7 适配器级测试补新鲜度分离用例（API 全挂但行情正常 → `lastApiOkAt` 不前进）

## 7. Challenge 风控层
- [ ] 7.1 在 `src/risk/propr-challenge.js` 实现 UTC 日切、权益派生（`equitySource`）、日损/回撤计算，验证 how.md#实现要点
- [ ] 7.2 在 `src/risk/propr-challenge.js` 实现分级 OK/WARNING/REDUCE_ONLY/HALT/LOCKED/BREACHED 与向 bot 下发指令，依赖任务 7.1
- [ ] 7.3 在 `src/server.js` + 前端接入 Propr 面板（账户/模式/状态/日损/回撤/净仓/延迟/锁定原因），依赖任务 6.1、7.2
  > 备注: 总览卡片（模式/账户/锁定态/权益来源/真实账户权益）已在 Review 4 完成；待风控层落地后补齐日损/回撤使用率与一键解锁
- [ ] 7.4 【可选】AI 集成：Propr 目前独立于 AI 快照流（`EXNAMES` 与 per-key JSON 按 5 所硬编码，且 marketId 为字符串），如需纳入需扩展 AI 提示词与面板

## 8. 对账、恢复与异常
- [ ] 8.1 在 `src/exchange/propr/propr.js` 实现断线重连与成交补偿（基于 getTrades 恢复，且只补一次反向单），依赖任务 4.4
- [ ] 8.2 在 `src/exchange/propr/propr.js` 处理部分成交（按已成交量补反向单，余量本地跟踪），依赖任务 4.4
- [ ] 8.3 在 `src/exchange/propr/propr.js` 处理重启恢复（从 orders/trades 重建状态），依赖任务 8.1、8.2

## 9. 四层验收（Review 5）
- [ ] 9.1 Shadow 24h 验收：0 写请求、行情/持仓持续刷新、本地模拟网格正常、断线恢复、异常锁定，产出报告，依赖任务 6.3、7.3
- [ ] 9.2 Free Trial `sim-write` 24–72h 验收：批量挂单/撤单/成交/补单/部分成交/对账/重启恢复/手动停止/自动越界/多空持仓/reduceOnly/实际限频，按 how.md 验收指标表逐项达标，依赖任务 9.1
- [ ] 9.3 编写"付费前人工确认清单"并评审（8 项，见 how.md#测试与部署），依赖任务 9.2
- [ ] 9.4 付费 Challenge 实测（1x/close/无 recover）：购买账户 + 清单全通过后，`PR_MODE=challenge` + `PR_ALLOW_CHALLENGE=YES` + 白名单启动，人工每日检查，产出实测报告，依赖任务 9.3

## 10. 安全检查
- [ ] 10.1 执行安全检查（按 G9：密钥仅 .env、日志脱敏、accountId 白名单、shadow 写禁止、challenge 硬确认、EHRB 规避）

## 11. 文档更新
- [ ] 11.1 更新 `helloagents/wiki/{overview,arch,api,data}.md` 与 `wiki/modules/exchange.md`（新增 propr 模块、第 7 所、四模式、ADR 索引）
- [ ] 11.2 更新 `helloagents/CHANGELOG.md` 与 `package.json` 版本号（1.7.0，注意与 dev006 的 1.7.x 冲突）

## 12. 测试
- [√] 12.1 在 `test/propr-mapper.test.js` 覆盖字段/精度/positionSide/reduceOnly/状态机映射
- [√] 12.2 在 `test/propr-modes.test.js` 覆盖四模式写白名单（shadow 写请求数=0）、账户白名单、challenge 硬确认
- [√] 12.3 在 `test/propr-order-state.test.js` 覆盖超时幂等、未知态锁定、部分成交、已成交不重复补单
- [√] 12.4 在 `test/propr-reconcile.test.js` 覆盖断线恢复、重启恢复、重复补单保护
- [ ] 12.5 在 `test/propr-risk.test.js` 覆盖 UTC 日切、内部日损/回撤分级、derived 降权
- [√] 12.6 在 `test/propr-log-redact.test.js` 覆盖日志脱敏（密钥不出现）
- [ ] 12.7 在 `package.json` 的 `test` 脚本串联新增测试，`npm test` 全绿 + `npm run lint` 干净
