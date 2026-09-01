# 任务清单: 动态网格（冷静门自动重启 + 漂移重定）

## bot.js 核心
- [√] 1.1 config.dynamic 块（enabled/shadow/driftFrac/invGateGrids/冷却/restartEnabled/冷静门参数）
- [√] 1.2 构造 state：_dynTimer/_dynInFlight/_lastDynActionAt/_autoStopped + stats 计数器
- [√] 1.3 自动停机：破界 close/_checkMaxLoss 置 _noteAutoStop；手动 _start 清空
- [√] 1.4 _dynCheck（60s 节拍）：分支A 漂移重定 / 分支B 冷静门自动重启，均走 start/adjustRange
- [√] 1.5 snapshot/restore 持久化 _autoStopped；resume 重启 dynTimer；getState 暴露 dynamic

## server.js
- [√] 2.1 手动 stop/cancel-orders/close-position 调 cancelAutoRestart；pick() 透传 dynamic

## 前端
- [√] 3.1 四所控制台动态网格折叠区 + start payload dynamic 注入 + 总览计数渲染；id 交叉核对通过

## 测试
- [√] 4.1 test/dynamic.test.js 7 例：漂移重定/库存门/冷静门/影子/自动停机记录/冷静重启居中/手动停止清空
- [√] 4.2 npm test 退出码 0 全绿 + lint 干净

## 版本与文档
- [√] 5.1 version 1.5.0；CHANGELOG；wiki；提交推送 dev004-dy
