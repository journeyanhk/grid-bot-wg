# 任务清单: RISEx 杠杆设置修复（轻量迭代）

## 1. 修复
- [√] 1.1 在 `src/exchange/rs/risex.js` 中绕开 SDK updateLeverage 自组装请求：permit_params 键名 + WAD 放大（×1e18），复用 SDK encodeLeverage/createPermit 签名原语

## 2. 版本与文档
- [√] 2.1 package.json 1.1.2 → 1.1.3；CHANGELOG 登记 [1.1.3]
- [√] 2.2 知识库同步：exchange.md 已知问题（已规避）与变更历史

## 3. 验证
- [√] 3.1 lint + 全部测试 + 语法检查通过
- [√] 3.2 提交推送 GitHub（端到端签名验证需 VPS 实测：启动网格观察日志不再出现杠杆 400）
