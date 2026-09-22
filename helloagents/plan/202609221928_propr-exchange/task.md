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
- [ ] 2.1 在 `scripts/propr-probe.mjs` 实现只读链探针（health/healthServices/getUser/setup/getChallenges/getChallengeAttempts/getChallengeAttempt/getPositions/getOrders/getTrades/getMarginConfig/getLeverageLimits），输出原始结构与脱敏摘要，验证 why.md#需求-Propr-只读适配器契约探测-Day-0-契约探测，依赖任务 1.1、1.3
- [ ] 2.2 在 `scripts/propr-probe.mjs` 实现订单链探针（远离市价最小量限价单 → 查 open → 校验 side/positionSide/reduceOnly → cancel → 复查消失），依赖任务 2.1
- [ ] 2.3 在 `scripts/propr-probe.mjs` 实现幂等链探针（固定 intentId → createOrders → 重复发送 → 查 open/trades 确认无重复），依赖任务 2.2
- [ ] 2.4 在 `scripts/propr-probe.mjs` 实现持仓链探针（极小多仓/空仓 → 按 positionSide 读取 → 分别 reduce-only 平仓 → 确认独立消失），依赖任务 2.2
- [ ] 2.5 在 `docs/propr-api-contract.md` 冻结结论：①hedge vs net（含"返回 positionSide 但实际聚合"情况 C）②`asset` 用 `BTC` 还是 `BTC/USDC` ③quantity/price 精度与最小名义 ④intentId 幂等实测 ⑤时间戳单位/错误结构/权益可得性；依赖任务 2.1–2.4
- [ ] 2.6 依据 2.5 确定 `PR_POSITION_MODE` 落地路径（net 走阶段 5A / hedge 走阶段 5B），并回填 how.md#ADR-001；依赖任务 2.5

## 3. 只读适配器与 Shadow（Review 2）
- [ ] 3.1 在 `src/exchange/propr/market.js` 实现 `buildMarket()` 与精度取整工具，验证 how.md#实现要点，依赖任务 2.5
- [ ] 3.2 在 `src/exchange/propr/mapper.js` 实现 `mapProprOrder/mapProprPosition/mapProprTrade/mapProprMargin/mapProprError` 纯函数，依赖任务 1.4、2.5
- [ ] 3.3 在 `src/exchange/propr/propr.js` 实现 `init()` 启动校验链与只读方法 `getMarkets/getPrice/getCandles/getPositions/getPosition/getOrders/getTrades/setLeverage`，依赖任务 3.1、3.2
- [ ] 3.4 在 `src/exchange/propr/paper.js` 实现本地 paper 适配器（不访问 Propr），依赖任务 3.1
- [ ] 3.5 在 `src/exchange/propr/shadow.js` 实现 ShadowExchange（读 Propr + 本地撮合，写方法一律抛 `ProprReadOnlyError` 并锁定），验证 why.md#需求-四级运行模式与安全护栏-Shadow-模式绝对只读，依赖任务 3.3
- [ ] 3.6 在 `src/exchange/propr/index.js` 实现 `createExchange(cfg)` 四模式工厂，依赖任务 3.4、3.5
- [ ] 3.7 【Review1 复审要求】分页处理：官方默认 `limit:20/offset:0`，BTC 网格挂单与成交会超页，需实现 `getAllOrders/getAllTrades/getAllPositions`（或适配器内显式翻页），不得默认结果完整，依赖任务 3.3

## 4. 写路径与幂等（Review 3）
- [ ] 4.1 在 `src/exchange/propr/propr.js` 实现 `placeLimitOrder/placeLimitOrders`（统一走 createOrders+自有 intentId，结果与输入等长），验证 why.md#需求-Propr-交易适配器-批量铺网与幂等，依赖任务 3.3
- [ ] 4.2 在 `src/exchange/propr/propr.js` 实现 `cancelOrder/cancelAll/closePosition`（撤单先查实况、平仓自实现全平），依赖任务 4.1
- [ ] 4.3 在 `src/exchange/propr/propr.js` 实现订单状态机与 `UnknownOrderStateError → TRADING_LOCKED` 路径，依赖任务 4.1
- [ ] 4.4 在 `src/exchange/propr/propr.js` 实现本地 intent 日志与 `reconcileOrders()`（按 intentId 匹配），依赖任务 4.3
- [ ] 4.5 【Review1 复审要求】适配器不对外暴露官方 `createOrder()`（会覆盖 intentId），统一走 `createOrders()`；如需保留原始能力则改名 `createOrderRaw()` 并标注禁用，依赖任务 4.1

## 5A. 持仓模式落地 — net 分支（仅当探针=net）
- [ ] 5A.1 在 `src/exchange/propr/propr.js` 实现 `getPosition` 返回带符号净仓，`positionMode='net'`，验证 how.md#ADR-001，依赖任务 2.6
- [ ] 5A.2 在 `test/propr.test.js` 覆盖净值降级补单方向正确性，依赖任务 5A.1

## 5B. 持仓模式落地 — hedge 分支（仅当探针=hedge）
- [ ] 5B.1 在 `src/exchange/propr/propr.js` 暴露 `positionMode='hedge'` 与双边 `getPositions()`，下单携带正确 `positionSide`，验证 why.md#需求-Propr-交易适配器-多空并存hedge-分支，依赖任务 2.6
- [ ] 5B.2 在 `src/bot.js` 以能力位（默认关闭）最小扩展 hedge 下单与双边净库存控制，不影响现有 6 家适配器，依赖任务 5B.1
- [ ] 5B.3 在 `test/propr.test.js` 覆盖多空并存不误合并、reduce-only 方向正确，依赖任务 5B.2

## 6. 接入 GridBot 与 server（Review 4）
- [ ] 6.1 在 `src/server.js` 完成第 7 所注册全部插入点（import/校验/实例化/restore/错误监听/AI 映射/日历/Liveness/SSE/路由分区/初始化/续跑/孤儿检测/启动横幅），验证 why.md#影响范围
- [ ] 6.2 在 `src/server.js` + 前端标注 Propr 模式与账户（如"Propr API 写入 / Free Trial / 市场模拟 / 非真实资金"），依赖任务 6.1
- [ ] 6.3 打通 `PR_MODE=shadow` 与 `sim-write` 启动冒烟，确认 Propr 卡片与市场列表可见，依赖任务 6.1、3.6

## 7. Challenge 风控层
- [ ] 7.1 在 `src/risk/propr-challenge.js` 实现 UTC 日切、权益派生（`equitySource`）、日损/回撤计算，验证 how.md#实现要点
- [ ] 7.2 在 `src/risk/propr-challenge.js` 实现分级 OK/WARNING/REDUCE_ONLY/HALT/LOCKED/BREACHED 与向 bot 下发指令，依赖任务 7.1
- [ ] 7.3 在 `src/server.js` + 前端接入 Propr 面板（账户/模式/状态/日损/回撤/净仓/延迟/锁定原因），依赖任务 6.1、7.2

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
- [ ] 12.1 在 `test/propr-mapper.test.js` 覆盖字段/精度/positionSide/reduceOnly/状态机映射
- [ ] 12.2 在 `test/propr-modes.test.js` 覆盖四模式写白名单（shadow 写请求数=0）、账户白名单、challenge 硬确认
- [ ] 12.3 在 `test/propr-order-state.test.js` 覆盖超时幂等、未知态锁定、部分成交、已成交不重复补单
- [ ] 12.4 在 `test/propr-reconcile.test.js` 覆盖断线恢复、重启恢复、重复补单保护
- [ ] 12.5 在 `test/propr-risk.test.js` 覆盖 UTC 日切、内部日损/回撤分级、derived 降权
- [√] 12.6 在 `test/propr-log-redact.test.js` 覆盖日志脱敏（密钥不出现）
- [ ] 12.7 在 `package.json` 的 `test` 脚本串联新增测试，`npm test` 全绿 + `npm run lint` 干净
