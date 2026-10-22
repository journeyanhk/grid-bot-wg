# 任务清单: Extended 成交确认修复（Review7）

## 修复 1 _resolveGone
- [√] 1.1 耐心改时间制 10min（订单已不在簿，多等无重复挂单风险）
- [√] 1.2 成交流水第二证据源（/api/v1/user/trades 尽力而为）
- [√] 1.3 静默丢弃改响亮告警 + droppedLevels 计数

## 修复 2 库存漂移审计
- [√] 2.1 reconcile 加 _auditInventoryDrift（实际持仓 vs 成交流水推导，超容差告警，1h 节流）

## 修复 3 费率分离
- [√] 3.1 extended displayFeeRate=maker0，bot.start 优先 displayFeeRate（消除虚假手续费告警）

## 测试
- [√] 4.1 新增库存漂移审计测试；npm test 退出码 0 全绿 + lint 干净
- [√] 4.2 version 1.5.2；CHANGELOG/wiki；提交推送 dev004-dy
