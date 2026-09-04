# 任务清单: review17 RHC limit 400 紧急回滚

## 根因
- v1.5.8 limit=100->250 被 RHC accountInactiveOrders 拒收（400 invalid param）
- _refreshOrders 抛错 -> 整轮成交确认中断（inactive/穿越推定/死亡计数全停）-> 档位静默死亡 + 库存漂移告警

## 动作
- [√] 1.1 lighter.js limit=250 -> 100
- [√] 1.2 测试/lint 全绿；version 1.5.10
- [√] 1.3 提交推送 dev004-dy
