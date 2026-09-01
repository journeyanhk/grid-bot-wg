# 任务清单: 动态网格 review6 修复（P1-a/P1-b + P2 + P3-②）

## P1 必修
- [√] 1.1 P1-a: restore() 启动动态监督器（崩溃重启后自动停机态可被消费）
- [√] 1.2 P1-b: stats 五处基对象含 recenters/autoRestarts，旧快照缺失默认 0；resetStats 保留动作计数

## P2
- [√] 2.1 P2-a: 分支 A 漂移排除 outOfRange/recover 态
- [√] 2.2 P2-b: width 显式 upper-lower；alignToStep 分支A用 this.grid.spacing / 分支B仅 stepPrice

## P3
- [√] 3.1 P3-②: 分支 B 统一读 as.config

## 测试
- [√] 4.1 新增 P1-a 例（restore 后监督器工作影子告警），dynamic 8 例全绿；npm test 退出码 0 + lint 干净

## 版本与文档
- [√] 5.1 version 1.5.1；CHANGELOG；wiki；提交推送 dev004-dy
