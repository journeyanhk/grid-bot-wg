# 任务清单: review14 修复（价格穿越推定 + 影子门拦截日志）

## 修复 1 (extended.js) 价格穿越推定
- [√] 1.1 placeLimitOrder/adoptOrder init _crossedUp/_crossedDown
- [√] 1.2 _poll 价格回调更新 crossing
- [√] 1.3 _resolveGone 90s 穿越推定成交（fillPrice=t.price，fillSize=t.sizeBase）+ crossInferredFills 计数

## 修复 2 (bot.js) 影子门拦截日志
- [√] 2.1 分支 A 漂移达标但库存门拦截时输出节流负样本日志（每小时一条）

## 测试
- [√] 3.1 新增：穿越推定成交 / 未穿越保持耐心；npm test 退出码 0 + lint 干净
- [√] 3.2 version 1.5.7；CHANGELOG/wiki；提交推送 dev004-dy
