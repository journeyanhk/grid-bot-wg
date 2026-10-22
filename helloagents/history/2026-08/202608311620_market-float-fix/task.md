# 任务清单: market.js 浮点缺陷修复（review4）

## 修复
- [√] 1.1 market.js 三处 `10 ** -decimals` -> `1 / 10 ** decimals`（平台无关）
- [√] 1.2 bot.js setPollLight 恢复改为 `_placementPasses > 0`（重叠铺单不提前恢复轮询）

## 验证
- [√] 2.1 npm test 退出码 0（六套件全绿）+ lint 干净
- [√] 2.2 version 1.4.5；CHANGELOG/wiki 同步；提交推送 dev004
