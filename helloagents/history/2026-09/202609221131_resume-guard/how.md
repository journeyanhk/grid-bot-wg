# 技术设计: 续跑看门狗（接管缺失态防护）

## 技术方案

### 实现要点

**新模块 `src/resume-guard.js`**（可注入时钟/通知/日志，独立可测）

- `tryResumeBot(bot, exchange, snap, key, logger)`：共享续跑助手（按市场名重解析 marketId 后 `bot.resume`）——手动"重连交易所"路由与看门狗共用，杜绝两套逻辑漂移。
- `createResumeGuard({ bots, exchanges, loadSnapshot, notifier, logger, now, ...timings })`：
  - 每 60s 巡检全部交易所：`snap.running && !bot.running` 即进入"接管缺失"状态机。
  - 相位 A（未连接）：按 `backoffFor(attempts)` 退避重连（0 次=首轮立即；1/2/5/15 分，封顶永续）；`setIssue` + `notify`（bus 按 `cooldownMs=30min` 节流重复）。
  - 相位 B（已连接）：每轮尝试 `tryResumeBot`；成功 → 清状态 + 成功告警；失败 → 计数。
  - 兜底：`attempts ≥ 3 && now-firstResumeFailAt ≥ 10min` → `bot.recoverStrayOrders()`（仅撤单）；失败每 5 分钟重试。
  - 外部解除（bot 已运行/快照转非运行）：静默清理，不冒功。

**bot 级 operationalIssue**（响亮化通道）

- `GridBot.setOperationalIssue(issue)`：外部组件设置/清除；`getState().operationalIssue` 与 `_health()` 均以 bot 级优先于交易所自身的 `ex.operationalIssue`（后者会被适配器每轮成功轮询清空，不能承载持久告警）。

**server.js 接线**

- 引导 `resumeIfWasRunning`：跳过/失败不再就地放弃或立即撤单 → 记录日志并移交看门狗。
- 看门狗在引导续跑之后创建并 `start()`（启动即巡检一次，不等首个 60s）。
- 手动重连路由改用共享 `tryResumeBot`。

## 架构决策 ADR

### ADR-1: 兜底动作 = 撤单（10 分钟），不是平仓
**上下文:** 无人管理的遗留挂单是裸梯风险；仓位另有出路。
**决策:** 只调 `recoverStrayOrders`（撤单，内部走 `_cancelAllConfirmed` 确认链路）；永不动仓位。
**理由:** 撤单错误成本 ≈0（可重挂）；平仓不可逆。孤儿仓位由既有"遗留持仓提示"人工接手（review21 已确立该人工通道）。
**影响:** 兜底后快照 running=false（recoverStrayOrders → _changed → saveSnapshot），看门狗不会重复触发。

### ADR-2: 计时起点 = 已连接且接管失败
**上下文:** 进程启动即计时会误伤"交易所整夜离线"场景（离线时无法撤单，计时毫无意义且可能在恢复瞬间立刻撤单，跳过接管机会）。
**决策:** `firstResumeFailAt`（= 已连接后的首次 resume 失败时刻）为 10 分钟窗口起点；同时要求 ≥3 次尝试。
**影响:** 离线期间只重连不计时；恢复后先尝试接管，最坏 10 分钟后兜底。

### ADR-3: bot 级 operationalIssue 优先于交易所级
**上下文:** 适配器每轮成功轮询会清空 `ex.operationalIssue`，无法承载"接管缺失"这类持续性告警。
**决策:** `GridBot._operationalIssue` 由看门狗设置/清除，展示与健康均以它优先。
**影响:** 通知/展示语义清晰；解除即清空；不改适配器行为。

## 安全与性能
- **安全:** 兜底撤单为 EHRB 级动作，已带三护栏 + notify 先行；撤单走确认链路；仓位零接触由测试锁定。
- **性能:** 60s 巡检 + 每所每轮 ≤2 次 API 调用（重连或 resume），退避后更低；`timer.unref()` 不阻塞退出。

## 测试与部署
- **测试:** `test/resume-guard.test.js` 8 例：离线不计时/退避梯度、重连后 resume 优先、兜底条件（≥3 次+10 分钟）、仓位零接触、撤单失败 5 分钟重试、外部解除静默、重复告警节流（真实总线）、市场名缺失兜底。
- **部署:** 主 VPS 拉 dev004-dy 重启；**用户实弹演习**：人为断网 → 重启服务 → 观察"重连中（第 N 次）"卡片与恢复接管（review 要求的验收）。

---

## 2026-09-22 review23 修复记录（P1 重入竞态 + P2 监听器重复附着）

- P1：`tick` 加 `busy` 重入保护（checkOne 可能分钟级；叠加会导致并发 resume 幽灵失败垫高计数、并发撤单风暴）
- P2：`resume()`/`_resumeRecovery()` 附着 fill/price 前先 `off`（看门狗分钟级重试会反复执行附着点）
- 测试：resume-guard 增重入保护用例、bot 增 listenerCount 用例；均经"移除修复→失败→还原→通过"验证
- 详见 CHANGELOG 1.6.9
