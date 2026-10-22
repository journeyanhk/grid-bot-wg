# 任务清单: 续跑看门狗（接管缺失态防护）

目录: `helloagents/plan/202609221131_resume-guard/`

---

## 1. 看门狗核心（src/resume-guard.js 新建）
- [√] 1.1 `tryResumeBot` 共享续跑助手（市场名重解析 marketId），验证 why.md#需求-接管缺失态防护-场景-连接恢复后接管成功
- [√] 1.2 状态机：接管缺失检测 + 相位 A 退避重连（1/2/5/15 分封顶永续）+ 相位 B 补续跑，验证 why.md#需求-接管缺失态防护-场景-交易所未连接重启跳过续跑
- [√] 1.3 兜底三护栏：≥3 次接管尝试 + 已连接且失败起算 10 分钟 + 只撤单不动仓位（recoverStrayOrders，失败 5 分钟重试），验证 why.md#需求-接管缺失态防护-场景-已连接但接管持续失败
- [√] 1.4 响亮化：bot 级 operationalIssue（"重连中（第 N 次）"）+ notify 稳定 key/30 分钟重复节流

## 2. bot.js 支持
- [√] 2.1 `setOperationalIssue(issue)` + getState/_health 以 bot 级 issue 优先于交易所级
- [√] 2.2 回归检查：不影响既有健康态语义与快照字段

## 3. server.js 接线
- [√] 3.1 引导 `resumeIfWasRunning`：跳过/失败移交看门狗（不再立即撤单）
- [√] 3.2 手动"重连交易所"路由改用共享 `tryResumeBot`（消除双份逻辑）
- [√] 3.3 看门狗创建 + `start()`（6 所 bots/exchanges 映射）

## 4. 安全检查
- [√] 4.1 EHRB 兜底撤单：三护栏（接管优先/连接才计时/仓位零接触）；撤单走 `_cancelAllConfirmed` 确认链路；notify 先行可人工拦截

## 5. 文档更新
- [√] 5.1 更新 `helloagents/CHANGELOG.md`（1.6.8）
- [√] 5.2 更新 `helloagents/wiki/modules/bot.md` 变更历史
- [√] 5.3 更新 `helloagents/history/index.md` + 迁移方案包

## 6. 测试
- [√] 6.1 `test/resume-guard.test.js` 8 例（离线不计时/退避、resume 优先、兜底条件、仓位零接触、撤单失败重试、外部解除、告警节流、市场名缺失）
- [√] 6.2 加入 `npm test` 串联；全量绿 + lint 干净
- [√] 6.3 集成冒烟：构造 running 快照启动 paper 服务，验证"引导续跑成功 + 看门狗不误报"

## 7. 提交与推送
- [√] 7.1 提交 dev004-dy（v1.6.8）并推送

---

## 任务状态符号
- `[ ]` 待执行 / `[√]` 已完成 / `[X]` 执行失败 / `[-]` 已跳过 / `[?]` 待确认
