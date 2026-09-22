# 变更提案: 接入 Propr 挑战账户（BTC 中性网格 + 挑战风控）

## 需求背景

当前项目已通过统一的交易所适配层接入 6 家交易所（de/ex/rs/lr/hl/va），核心 `GridBot` 复用同一套铺单/补单/对账/恢复逻辑。现需接入 **Propr**（`https://www.propr.xyz`）——一家基于 Hyperliquid 的 prop-firm 挑战账户平台，新增第 7 个适配器，先在 BTC 上运行中性网格，并叠加 Propr 特有的 Challenge 风控。

与普通交易账户不同，Propr 账户受平台规则约束：

- 挑战账户有**最大日亏损**与**最大总回撤**硬限制（如 1-Step Classic：3% / 6%），越界即失败；
- 所有账户（含 Funded）均为**模拟账户**，下单经 Propr 路由到 Hyperliquid 真实市场；
- SDK 为**复制粘贴源码**分发（`propr-sdk` 不在 npm），且**没有账户权益端点**；
- 下单是否支持真正的双向（hedge）持仓**未经实测验证**，直接影响中性网格的实现方式。

用户现有 **$5K Free Trial（体验期）API Key**：可做真实 API 调用与写入（Propr 模拟账户），但**不等于付费 Challenge**，也不产生真实资金交易。因此本变更**明确区分四种运行模式**，把"是否访问 API"与"是否产生真实交易"解耦，避免把体验期配置误切到付费账户。

本变更的交付终点为 **Shadow 只读 24h → Free Trial `sim-write` 24–72h → 付费 Challenge 实测**（付费阶段需购买账户并逐项通过"付费前人工确认清单"后启动）。

## 变更内容

1. 新增 `src/exchange/propr/` 适配器（vendor 官方 SDK 源码为 ESM + `ulid` 依赖），实现只读与交易全路径。
2. **四级运行模式**（替代 paper/live 二分）：
   ```
   paper      本地模拟，不访问 Propr
   shadow     读取 Propr，所有订单只在本地模拟（硬禁止任何写请求）
   sim-write  写入 Propr Free Trial 模拟账户
   challenge  写入付费 Challenge 模拟账户（需额外显式确认）
   ```
3. 新增 Day-0 **契约探针**（`scripts/propr-probe.mjs`）：只读探测 + 远离市场测试限价单 + 幂等复测 + hedge/net 验证，产出 `docs/propr-api-contract.md`。
4. **positionSide 保真**：订单/持仓/成交在适配器内保留原始 `positionSide`，**不默认聚合成净仓**；据探针结果二选一落地：hedge → 双向持仓适配；net → 降级单向净库存模型。
5. 新增 `src/risk/propr-challenge.js` 挑战风控层：UTC 日切、内部日损/总回撤、breach、权益新鲜度、`REDUCE_ONLY`/`TRADING_LOCKED`。
6. 幂等与对账增强：以自生成 `intentId` 作为幂等键（经 `createOrders` 批量接口），超时/未知态一律进入交易锁定并走对账恢复。
7. 安全护栏：`PROPR_ALLOWED_ACCOUNT_IDS` 账户白名单、`challenge` 模式硬确认、日志脱敏（禁止输出 Authorization/API Key/Cookie/完整认证信息）。
8. 接入 `src/server.js`（第 7 所注册）与仪表盘，独立展示 Propr 面板（含模式与账户标识）。
9. 分批交付 Review（Review 1–5），三层验收（Shadow → sim-write → 付费前人工确认清单）。

## 影响范围

- **模块:** exchange（新增 propr）、risk（新增）、bot（仅在 hedge 分支做最小能力扩展）、web/server（注册第 7 所）、platform（config 新增 propr 块与模式校验）
- **文件:**
  - 新增：`src/exchange/propr/{index,propr,paper,shadow,market,mapper,errors,types,propr-sdk}.js`、`src/risk/propr-challenge.js`、`scripts/propr-probe.mjs`、`test/propr*.test.js`、`docs/propr-api-contract.md`、影子盘/体验期验收报告
  - 修改：`src/config.js`、`src/server.js`、`.env.example`、`package.json`、`helloagents/*`
- **API:** 仪表盘新增 `/api/propr/*`（复用现有 handler 工厂）
- **数据:** `.state.json` 新增 `propr` 快照键；新增 `logs/` 结构化事件（脱敏）
- **依赖:** 新增运行时依赖 `ulid`；vendor 的 `propr-sdk.js` 为项目内源码

## 核心场景

### 需求: 四级运行模式与安全护栏
**模块:** exchange / platform
模式决定"是否访问 API"与"是否写账户"，并由配置层强制护栏。

#### 场景: Shadow 模式绝对只读
`PR_MODE=shadow` 下：
- 允许 health/getUser/getChallenges/getChallengeAttempts/getOrders/getPositions/getTrades/getMarginConfig/getLeverageLimits
- **禁止** createOrder/createOrders/cancelOrder/cancelAllOrders/setLeverage/closePosition，调用即抛错并进入锁定
- Propr 行情用于本地模拟成交，Propr 账户不被改变

#### 场景: sim-write 模式写入 Free Trial
`PR_MODE=sim-write` + `PROPR_ALLOWED_ACCOUNT_IDS` 含当前账户：
- 允许真实 API 读写（账户为 Propr 模拟账户）
- 仪表盘明确标注"Propr API 写入 / Free Trial / 市场模拟 / 非真实资金"
- 账户不在白名单 → 启动即失败

#### 场景: challenge 模式硬确认
`PR_MODE=challenge` 时必须显式 `PR_ALLOW_CHALLENGE=YES` 且手动确认，否则拒绝启动，防止误切付费账户。

### 需求: Propr 只读适配器（契约探测）
**模块:** exchange
在不发写请求的前提下读取市场、账户、持仓、挂单、成交、杠杆/保证金配置，并据此冻结字段映射与持仓模式。

#### 场景: Day-0 契约探测
提供 `PROPR_API_KEY` 后运行 `scripts/propr-probe.mjs`：
- 只读链：health → healthServices → getUser → setup → getChallenges → getChallengeAttempts → getChallengeAttempt → getPositions → getOrders → getTrades → getMarginConfig("BTC") → getLeverageLimits
- 订单链：远离市价最小量限价单 → 查 open → 校验 side/positionSide/reduceOnly → cancel → 复查消失
- 幂等链：固定 intentId → createOrders → 重复发送 → 查 open/trades → 确认无重复
- 持仓链：极小多仓 → 查持仓 → 极小空仓 → 再查 → 按 positionSide 读 long/short → 分别 reduce-only 平仓 → 确认独立消失
- 产出 `docs/propr-api-contract.md`，明确 hedge/net、`asset` 口径、精度、时间戳单位、错误结构、权益可得性

### 需求: Propr 交易适配器
**模块:** exchange
实现 `getMarkets/getPrice/getPosition(s)/setLeverage/placeLimitOrder(s)/fetchOpenOrders/cancelOrder/cancelAll/closePosition/adoptOrder/forgetOrder(s)/start/stop` 全接口。

#### 场景: 批量铺网与幂等
一次性铺设网格阶梯：
- 批量走 `createOrders([...])`，每笔携带自生成 `intentId`
- 下单请求超时/网络错误 → 不立即重试，先对账；确认无对应订单后才允许重试
- 出现无法确认的订单状态 → 进入 `TRADING_LOCKED`

#### 场景: 多空并存（hedge 分支）
若探针确认 hedge：
- 买/卖订单携带正确的 `positionSide`
- 多空持仓分别跟踪，不被错误合并
- `closePosition` 自实现全平（官方 `closePosition` 只平 `positions[0]`）

### 需求: Propr Challenge 风控
**模块:** risk
按 UTC 日切计算日损与总回撤，达到内部阈值时分级降权，平台越界前主动停手。

#### 场景: 内部日损触发
当日亏损达到内部日损停止线：
- 撤销所有开仓单，仅保留 reduce-only 平仓
- 状态置 `REDUCE_ONLY`，仪表盘与告警可见

#### 场景: 权益来源不可信
若权益只能由本地成交推算（`equitySource="derived"`）或数据过期：
- 降低交易权限（禁止新开仓）
- 明确标注来源与新鲜度，异常进入 `TRADING_LOCKED`

## 风险评估

- **风险:** Propr 实际为 hedge，适配器按 net 设计导致返工 → **缓解:** positionSide 全程保真 + 探针前置门（ADR-001），hedge 适配作为独立分支任务。
- **风险:** 下单超时重复挂单（第一笔已成功、响应丢失）→ **缓解:** `intentId` 幂等 + 超时先对账 + 未知态锁定（ADR-003）。
- **风险:** 无官方权益端点，日损/回撤口径偏差导致提前/滞后停手 → **缓解:** 权益派生并标 `derived` 降权，内部阈值留足安全边际（1% / 3%）。
- **风险:** `cancelAllOrders` 逐笔非原子、`cancelOrder` 吞 400 → **缓解:** 自建撤单确认与对账，不信任单次返回。
- **风险:** 误绑定错误账户/误把体验期配置切到付费账户 → **缓解:** 显式 `PROPR_ACCOUNT_ID` + 账户白名单 + challenge 硬确认（ADR-006）。
- **风险:** Free Trial 与付费 Challenge 规则不完全一致 → **缓解:** 明确验收边界（体验期只证明 API/机器人可靠性，不证明付费必过），购买前执行人工确认清单。
- **风险:** 平台是否允许持续自动化网格 → **缓解:** Day-0 与规则确认，sim-write 阶段观察是否触发风控/限制。
- **EHRB:** 涉及 API 密钥与交易写操作。密钥仅经 `.env`（不入库、不贴对话、不入日志）；`shadow` 硬禁止写；`sim-write` 账户为模拟盘不涉真实资金；`challenge` 需显式确认 + 人工确认清单全通过后方可启动（ADR-006）。
