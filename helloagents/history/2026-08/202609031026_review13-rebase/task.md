# 任务清单: review13 审计重校准

## 修复
- [√] 1.1 restore/resume 旧快照缺省时打 _auditNeedsRebase 标记（不再只重置锚点沿用旧基线）
- [√] 1.2 _auditInventoryDrift 首轮观测：基线与锚点同刻校正到当前持仓+成交计数，本轮不审计，持久化新基线

## 测试
- [√] 2.1 新增"恢复后首轮重校准不误报"用例；npm test 退出码 0 + lint 干净
- [√] 2.2 version 1.5.6；CHANGELOG/wiki；提交推送 dev004-dy
