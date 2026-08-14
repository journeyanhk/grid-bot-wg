# 任务清单: RISEx 余额修复 + 版本号机制（轻量迭代）

目录: `helloagents/plan/202608141857_risex-balance-fix/`

---

## 1. RISEx 余额修复
- [√] 1.1 在 `src/exchange/rs/risex.js` 中修复 `_refreshAccount` 余额单位换算（÷1e18）与 NaN 防御，读取失败写 warn 日志不再静默
- [√] 1.2 验证：lint + 全部测试通过

## 2. 版本号机制
- [√] 2.1 在 `src/server.js` 中读取 package.json 版本、启动日志带版本、新增 `/api/version` 端点
- [√] 2.2 在 `public/index.html` 中 header 展示版本号（apiFetch 拉取）

## 3. 版本与文档
- [√] 3.1 package.json 版本 1.1.0 → 1.1.1；CHANGELOG.md 登记 [1.1.1]
- [√] 3.2 知识库同步：project.md 版本管理约定、exchange.md/web.md 变更历史、api.md 新增 /api/version

## 4. 验证
- [√] 4.1 npm test + npm run lint + 前端语法检查 + 启动冒烟（/api/version 返回 1.1.1）
- [√] 4.2 提交推送 GitHub

## 5. 安全检查
- [√] 5.1 复查：无敏感信息入日志/入库，鉴权端点覆盖 /api/version（已在守卫内）
