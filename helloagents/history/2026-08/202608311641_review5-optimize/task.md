# 任务清单: review5 三个优化点

## 优化一 虚假手续费告警（必修）
- [√] 1.1 lighter.js _loadMarkets：有市场费率数据时一律覆盖 feeRate（零费率不再被跳过）

## 优化二 平仓腿优先级
- [√] 2.1 bot.js _drainRetryQueueNow：ready 按 reduce-only/平仓腿优先排序

## 优化三 AIMD 自适应配速
- [√] 3.1 lighter.js：_adaptivePaceMs + getter；成功×0.85 向基线收敛；429/405 时×2 减速（封顶 40s）
- [√] 3.2 批量 429 日志降 INFO 聚合；启动预估用自适应配速现算

## 验证
- [√] 4.1 npm test 退出码 0 六套件全绿 + lint 干净
- [√] 4.2 version 1.4.6；CHANGELOG/wiki；提交推送 dev004
