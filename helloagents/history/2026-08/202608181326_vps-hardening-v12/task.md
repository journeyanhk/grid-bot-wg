# 任务清单: v1.2.0 原版安全机制移植（标准开发）

## 1. bot.js 移植
- [√] 1.1 整体替换为原版 bot.js（撤单确认/安全重试/进度跟踪/refillGrid/暂停恢复运行时），重应用 logger 定制与 lint 修复

## 2. 适配器增强
- [√] 2.1 三所 live+paper 适配器：supportsSafeOpeningRetry、forgetOrder/forgetOrders、撤单失败保留跟踪
- [√] 2.2 Decibel 整体替换（operationalIssue/错误翻译/malformed 快照防御），重应用 logger
- [√] 2.3 Extended/RISEx 增量：liquidationPrice、malformed 快照防御（保留 RISEx 余额/杠杆修复）

## 3. 服务端与前端
- [√] 3.1 server.js /refill 路由
- [√] 3.2 前端：补格按钮、进度/核实挂单数、强平价、运维异常展示（保留鉴权/XSS 转义）

## 4. 测试
- [√] 4.1 移植 cancel-safety.test.js（10 例）、新增 safety-progress.test.js（5 例），npm test 串联
- [√] 4.2 全量 44 例通过 + lint 干净 + 启动冒烟

## 5. 版本与文档
- [√] 5.1 version 1.2.0；CHANGELOG；wiki 同步
