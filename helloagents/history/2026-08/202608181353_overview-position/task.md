# 任务清单: 总览页持仓展示移植（轻量迭代）

## 1. 服务端
- [√] 1.1 `src/server.js` pick() 增加 position/operationalIssue/apiWalletAddress 字段

## 2. 前端
- [√] 2.1 `public/index.html`：ov-position/operation-issue 样式、三卡片持仓+异常区块、renderOverviewPosition 渲染（esc 转义）

## 3. 验证与版本
- [√] 3.1 lint + 44 例测试 + 前端语法通过；version 1.2.1；CHANGELOG/wiki 同步
- [√] 3.2 提交推送 dev003（代理 10808）
