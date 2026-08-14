# 任务清单: RISEx 余额单位启发式归一化（轻量迭代）

## 1. 修复
- [√] 1.1 在 `src/exchange/rs/risex.js` 中把余额换算改为阈值启发式（>1e12 视为原始 18 位单位 ÷1e18，否则视为人/币单位），保留原始值日志

## 2. 版本与文档
- [√] 2.1 package.json 1.1.1 → 1.1.2；CHANGELOG 登记 [1.1.2]
- [√] 2.2 知识库同步：exchange.md 已知问题与变更历史

## 3. 验证
- [√] 3.1 npm test + npm run lint 通过
- [√] 3.2 提交推送 GitHub
