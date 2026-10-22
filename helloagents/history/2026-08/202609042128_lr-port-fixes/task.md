# 任务清单: review15 LR 三项移植

## LR 移植（对齐 EX 防护）
- [√] 1.1 穿越推定：placeLimitOrders/adoptOrder init crossing + _poll 价格更新 + _refreshOrders 90s 推定成交跨（crossInferredFills 计数）
- [√] 1.2 inactive limit 100->250（快速批量成交查证窗口溢出 -> 漏认 -> 档位静默死亡）
- [√] 1.3 droppedLevels 死亡计数：10 分钟无法经 inactive 确认且未穿越 -> 响亮告警（仅计数不删跟踪）

## 测试
- [√] 2.1 lighter 新增穿越推定用例；npm test 退出码 0 + lint 干净
- [√] 2.2 version 1.5.8；CHANGELOG/wiki；提交推送 dev004-dy
