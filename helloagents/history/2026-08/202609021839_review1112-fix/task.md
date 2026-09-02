# 任务清单: review11+12 修复

## review11 审计锚点
- [√] 1.1 start() 同刻锚定 _auditBuysBase/_auditSellsBase；snapshot/restore/resume 持久化（旧快照缺省=从恢复时刻对账）
- [√] 1.2 审计公式全带符号；告警带所名

## review12 空快照健康事件
- [√] 2.1 extended 空快照 >3min 置 operationalIssue，恢复时清除
- [√] 2.2 盲飞暂停开仓补单：暂缓（观察自愈后再定）

## 测试
- [√] 3.1 新增"跨重启带历史 stats 不误报"用例；npm test 退出码 0 + lint 干净
- [√] 3.2 version 1.5.5；CHANGELOG/wiki；提交推送 dev004-dy
