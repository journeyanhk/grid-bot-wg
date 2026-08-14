# 任务清单: VPS 部署安全加固 + 测试与工程化

目录: `helloagents/plan/202608141349_vps-hardening/`

---

## 1. HTTP 鉴权（P0）
- [√] 1.1 在 `src/config.js` 中读取 `DASHBOARD_TOKEN`、`PUBLIC_ORIGIN` 配置并导出，验证 why.md#需求-vps-部署后控制面板安全访问
- [√] 1.2 在 `src/server.js` 中实现鉴权守卫（Origin 白名单校验 → Host 回环校验 → timingSafeEqual 令牌校验，SSE 支持 query token），验证 why.md#需求-vps-部署后控制面板安全访问
- [√] 1.3 在 `public/index.html` 中实现令牌输入与保存（sessionStorage）、`apiFetch` 封装统一带 header、SSE 连接追加 token、401 自动重登，验证 why.md#需求-vps-部署后控制面板安全访问，依赖任务 1.2
- [√] 1.4 更新 `.env.example` 与 `README.md`（新增 DASHBOARD_TOKEN/PUBLIC_ORIGIN 说明 + VPS 部署安全建议章节），验证 why.md#需求-vps-部署后控制面板安全访问

## 2. 前端 XSS 转义（P0）
- [√] 2.1 在 `public/index.html` 中新增 `esc()` 转义函数，替换外部数据（交易所市场名、alerts、fills、AI 输出、代理/错误消息）的全部 innerHTML 注入点，验证 why.md#需求-交易所数据注入-xss-防护

## 3. 依赖漏洞修复（P0）
- [√] 3.1 分析依赖树（`npm ls ws ethers`）与 `npm audit fix` 影响，执行修复
- [√] 3.2 修复后运行 `npm test` 全量回归 + 启动冒烟验证；若破坏 risex-client 兼容性则回退并在 how.md ADR-004 记录决策

## 4. bot.js 核心测试（P1）
- [√] 4.1 在 `test/bot.test.js` 中实现 `MockExchange`（EventEmitter + 迷你撮合引擎，覆盖 GridBot 全部依赖接口）
- [√] 4.2 实现测试用例：启动铺单三模式、成交补单链、出区间 close/recover、reconcile（prune/trim/adopt/massVanish）、resume 恢复、保证金拒绝启动
- [√] 4.3 更新 `package.json` test 脚本串联新测试文件，全量通过

## 5. ESLint（P1）
- [√] 5.1 新增 `eslint.config.js`（flat config，仅覆盖 src/ 与 test/）+ `npm run lint` 脚本
- [√] 5.2 运行 lint 并清理存量告警至零

## 6. 结构化日志（P1）
- [√] 6.1 新增 `src/log.js`（JSON lines + 按天轮转 + LOG_LEVEL/LOG_DIR 配置）
- [√] 6.2 替换 server.js / bot.js / 三个适配器中的关键 console 调用为 logger（启动/恢复/错误/下单/撤单/成交/风控事件）
- [√] 6.3 更新 `.gitignore`（忽略 logs/）与 `.env.example`（LOG_LEVEL/LOG_DIR 说明）

## 7. 安全检查
- [√] 7.1 复查：令牌不落日志、不落 .state.json；鉴权不遗漏 SSE 端点；错误响应不含敏感信息（G9 输入验证/敏感信息处理）

## 8. 知识库与文档
- [√] 8.1 创建知识库（CHANGELOG.md、project.md、wiki/overview.md、wiki/arch.md、wiki/api.md、wiki/data.md、wiki/modules/*）
- [√] 8.2 按知识库同步规则更新受影响模块文档（web/bot/exchange 模块规范、api.md 鉴权说明、arch.md ADR）

## 9. 最终验证
- [√] 9.1 运行 `npm test` + `npm run lint` 全量通过
- [√] 9.2 启动冒烟：无 token 本地访问正常；配置 token 后 401/正确 token 200；Origin 伪造 403；SSE 带 token 正常推送
- [√] 9.3 迁移方案包至 `helloagents/history/2026-08/` 并更新 `history/index.md`
