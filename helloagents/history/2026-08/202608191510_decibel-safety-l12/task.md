# 任务清单: Decibel 第 1+2 层死循环防护（轻量迭代）

## 1. 适配器（decibel.js）
- [√] 1.1 cancelAll/cancelOrder 撤单重试：单笔失败 1s/2s 退避重试 3 次（cancelRetryMs 可配置）
- [√] 1.2 _resolveGone 幽灵单 3 轮快速清理 + 明确文案（不视为成交/不补单/不撤单，不触发暂停补单正则）

## 2. bot.js
- [√] 2.1 _cancelRecoveryLadder 只对交易所真实挂单簿中存在的订单发撤单（幽灵单跳过），其余由对账/成交确认清理

## 3. 测试与版本
- [√] 3.1 新增 test/decibel-safety.test.js（5 例：重试成功/重试耗尽/单笔重试/幽灵单清理/回收跳过幽灵）
- [√] 3.2 全量 49 例通过 + lint 干净；version 1.2.3；CHANGELOG/wiki 同步
- [√] 3.3 提交推送 dev003（代理 10808）
