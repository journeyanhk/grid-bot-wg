# 变更提案: VPS 部署安全加固 + 测试与工程化（P0/P1）

## 需求背景

项目将部署到 VPS（公网服务器）运行。现状：

1. **HTTP 服务零鉴权**：所有 `/api/*`（下单/平仓/撤单/改 .env）无任何认证。默认绑 127.0.0.1 只是缓解——VPS 上必须绑 0.0.0.0，此时任何知道 IP 的人可直接控制真金白银；即使仅本地监听，**DNS rebinding 攻击**也可让恶意网页绕过同源策略调用交易接口。无 Origin/Host 校验、无 CSRF 防护。
2. **前端 XSS 注入面**：`index.html` 约 38 处 `innerHTML` 直接渲染外部数据（交易所返回的市场名、AI 输出、错误消息），存在 XSS 风险。
3. **依赖漏洞**：`npm audit` 检出 3 个漏洞（2 high：ws 未初始化内存泄露/内存耗尽 DoS，经 ethers ← risex-client 引入）。
4. **测试覆盖不足**：16 个测试只覆盖纯函数，`bot.js`（960 行交易编排核心）与三个交易所适配器、AI 服务均无测试。
5. **无 ESLint**：无静态检查。
6. **无结构化日志**：console.log 为主，无轮转、无审计留存，VPS 上出问题无法复盘。

## 变更内容

### P0（资金安全，必做）
1. HTTP 鉴权：`DASHBOARD_TOKEN`（环境变量配置，前端输入一次存 sessionStorage，所有 API/SSE 请求带令牌）+ Origin/Host 校验（阻断 DNS rebinding 与跨站请求）
2. 前端 XSS 转义：新增 `esc()`，外部数据注入点统一转义
3. 依赖漏洞修复：`npm audit` 修复 + 验证

### P1（可靠性/工程化）
4. `bot.js` 核心逻辑单元测试（内存 mock 交易所）
5. 引入 ESLint（flat config）并清理存量问题
6. 自研轻量结构化日志模块（JSON lines + 按天轮转）

## 影响范围
- **模块:** server.js / config.js / public/index.html / 新增 src/log.js / 新增 test/bot.test.js / 新增 eslint.config.js / package.json / .env.example / README.md
- **API:** 全部 /api/* 增加鉴权（配置了 DASHBOARD_TOKEN 时）
- **数据:** 无数据模型变更

## 核心场景

### 需求: VPS 部署后控制面板安全访问
**模块:** web（server + 前端）
**场景: VPS 公网访问**
- 管理员在 .env 配置 `DASHBOARD_TOKEN`
- 浏览器打开 `https://域名` 首次输入令牌，会话内无需重复输入
- 无令牌或令牌错误 → 401 提示重新输入，不返回任何交易数据

**场景: DNS rebinding 攻击**
- 恶意网页域名解析到本机/VPS IP 并发起 API 请求
- 无有效令牌 → 403；有 Origin 头但非白名单 → 403
- 交易接口不被触发

**场景: 无令牌配置（纯本地使用）**
- 仅允许回环 Host（localhost/127.0.0.1/::1）访问，非回环 Host 一律 403

### 需求: 交易所数据注入 XSS 防护
**模块:** web（前端）
**场景: 恶意市场名 / AI 输出**
- 交易所返回的 `displayName` 或 AI 回复含 `<script>` 等标签
- 页面渲染为纯文本，不执行任何脚本

### 需求: 交易核心回归保护
**模块:** bot
**场景: 网格全生命周期（模拟）**
- 内存 mock 交易所下：启动铺单 → 成交触发补反向单 → 对账清理/接管 → 出区间风控（平仓/回收阶梯）→ 崩溃恢复续跑，全部可自动断言
- 保证金不足/格距过小拒绝启动

### 需求: 结构化日志
**模块:** web / bot / exchange
**场景: VPS 问题复盘**
- 日志写入 `logs/app-YYYY-MM-DD.log`（JSON lines），按天轮转
- 关键事件（下单/撤单/成交/风控/连接/错误）可检索回溯

## 风险评估
- **风险:** Token 方案若前端实现缺陷（SSE 忘记带 token）导致功能不可用
- **缓解:** 服务端回环 Host 免 token 兜底（仅本地回环来源可无 token），VPS 上必须 token
- **风险:** `npm audit fix` 升级 ethers/ws 可能破坏 risex-client 兼容性
- **缓解:** 先分析依赖树，升级后运行全部测试与启动冒烟；若破坏则记录决策（接受风险并在文档标注）
- **风险:** ESLint 存量告警量大
- **缓解:** 采用保守规则集，必要时对个别规则降级
