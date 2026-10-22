# 任务清单: 补 recenterEnabled 独立开关

目录: `helloagents/plan/202609201323_dyn-recenter-switch/`

---

## 1. 后端（bot.js）
- [√] 1.1 配置归一化增 `recenterEnabled`（默认 false），验证 why.md#需求-分支-A-独立放行-场景-中间态b-实盘--a-影子
- [√] 1.2 分支 A 执行条件改 `!shadow && recenterEnabled`；未放行时仍记影子样本（注明"漂移重定未启用"）
- [√] 1.3 getState 暴露 recenterEnabled/restartEnabled；新增 `_dynModeText()` 并接入启动告警与监督器心跳日志

## 2. 前端（public/index.html）
- [√] 2.1 6 个控制台（de/ex/rs/lr/hl/va）动态面板增"漂移重定"复选框（默认未勾选），依赖 1.1
- [√] 2.2 localStorage 持久化列表纳管 dyn-recenter（保存/恢复/监听三处）
- [√] 2.3 两处 start payload 带 `recenterEnabled`；renderDynSummary 显示分支放行状态

## 3. 安全检查
- [√] 3.1 缺省安全：旧快照/旧前端缺字段 = A 不放行（不执行）；无新增下单路径（仍只复用 start/adjustRange）

## 4. 文档更新
- [√] 4.1 更新 `helloagents/CHANGELOG.md`（1.6.7）
- [√] 4.2 更新 `helloagents/wiki/modules/bot.md`（变更历史）
- [√] 4.3 更新 `helloagents/history/index.md` + 迁移方案包

## 5. 测试
- [√] 5.1 dynamic.test.js：4 既有用例补显式放行 + 3 新用例（A 开关关闭记样本/B 独立/文案矩阵）
- [√] 5.2 `npm test` 全绿（含 check:html）+ `npm run lint` 干净

## 6. 提交与推送
- [√] 6.1 提交 dev004-dy（v1.6.7）并推送

---

## 任务状态符号
- `[ ]` 待执行 / `[√]` 已完成 / `[X]` 执行失败 / `[-]` 已跳过 / `[?]` 待确认
