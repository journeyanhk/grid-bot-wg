# 技术设计: VPS 部署安全加固 + 测试与工程化

## 技术方案

### 核心技术
- Node.js ≥20 原生能力（无新增运行时依赖）：node:http、node:crypto（timingSafeEqual）、node:test（不用，沿用自研 runner 保持一致性）
- ESLint 9 flat config + @eslint/js（devDependency）
- 自研日志模块（零依赖）

### 实现要点

#### 1. HTTP 鉴权（server.js / config.js）
- `config.js` 新增读取：`DASHBOARD_TOKEN`（可选）、`PUBLIC_ORIGIN`（可选，逗号分隔的允许 Origin 列表）
- `server.js` 请求处理顶部插入统一守卫（静态文件 index.html 可免 token，其余 /api/* 全部校验）：
  1. **Origin 校验**：请求带 Origin 头时，必须匹配白名单（回环来源 + PUBLIC_ORIGIN 列表），否则 403。防 CSRF/跨站读取
  2. **Host 校验**：未配置 DASHBOARD_TOKEN 时，Host 必须为回环（localhost/127.0.0.1/[::1] + 配置端口），否则 403。防 DNS rebinding 兜底
  3. **Token 校验**（已配置 DASHBOARD_TOKEN 时）：`X-Auth-Token` header 或 `?token=` query（SSE 用）必须与配置值 timingSafeEqual 比较，否则 401
- SSE 端点（/api/*/stream、/api/overview/stream）接受 query token
- 鉴权失败返回 JSON `{error: '未授权'}`（401）或 `{error: '来源被拒绝'}`（403），SSE 在未授权时不建立连接
- token 为空/未配置 → 跳过 token 校验（保持本地零配置体验，Host 校验兜底）

#### 2. 前端 token 处理（index.html）
- 新增 `apiFetch(url, opts)` 封装：统一带 `X-Auth-Token` header；401 时清除 sessionStorage 令牌并弹登录输入
- 新增 `authToken` 模块级变量：优先 sessionStorage
- 所有 SSE 连接（3 个所 + overview）URL 追加 `?token=`（encodeURIComponent）
- 首次进入若 401 → 弹出令牌输入框 → 存 sessionStorage 后重试
- 登录输入框用简单 modal 而非 window.prompt（可接受，prompt 也可，选 modal 样式一致）

#### 3. XSS 转义（index.html）
- 新增 `esc(s)`：转义 `& < > " '`
- 外部数据注入点替换（约 15 处关键点）：markets 下拉（displayName）、alerts 列表、fills 列表、AI 对话渲染（reply/action 参数）、代理检测错误消息、orphan 持仓提示、趋势分析 detail 文本
- 本地受控数字（价格/盈亏）不转义（无风险，保持可读性）

#### 4. 依赖修复
- 先 `npm ls ws ethers` 分析依赖树
- 尝试 `npm audit fix`，若破坏 risex-client 兼容性则回退，评估手动升级范围
- 修复后 `npm test` 全量回归

#### 5. bot.js 单元测试（test/bot.test.js）
- 新建 `MockExchange`（EventEmitter）：实现 GridBot 依赖的全部接口（getMarkets/placeLimitOrder/cancelOrder/cancelAll/fetchOpenOrders/getPrice/setLeverage/getPosition/closePosition/adoptOrder/start/stop/equity/balance/feeRate/dataSource/mode），内置迷你撮合引擎（限价单挂单簿，价格变动时按限价成交，emit fill + 从簿删除）
- 测试用例：
  1. 启动铺单：neutral/long/short 三模式的 side/reduceOnly/价格正确性、跳过带
  2. 成交补单链：buy fill → sell replacement 单价格/方向正确；rung 统计累加
  3. 出区间 close：价格突破上边界 → 自动 cancelAll + closePosition + running=false
  4. 出区间 recover：挂出 reduce-only 回收阶梯；价格回区间 → 撤销阶梯
  5. reconcile：prune（连续两轮消失）、trim（同层重复单）、adopt（接管孤儿单）、massVanish 保护（0 单快照不清理）
  6. resume：从快照恢复续跑并接管挂单
  7. 风控：保证金不足拒绝启动
- `package.json` test 脚本改为运行两个测试文件

#### 6. ESLint
- 新增 `eslint.config.js`（flat config）：js.configs.recommended + 少量定制（no-unused-vars 保留、浏览器 globals 仅用于前端文件——前端单文件 2000 行跳过 lint，只 lint src/ 与 test/）
- `npm run lint` 脚本
- 清理存量告警（预期少量，如未使用变量）

#### 7. 结构化日志（src/log.js）
- 导出 `logger`：`info/warn/error` 三方法，输出 JSON lines：`{"t":ISO时间,"level":"info","module":"bot","msg":"...","ctx":{...}}`
- 同时写控制台（可读格式）与 `logs/app-YYYY-MM-DD.log`（JSON lines，按天轮转，附加 mode: 'a'）
- 环境变量：`LOG_LEVEL`（默认 info）、`LOG_DIR`（默认 logs/）
- 替换关键 console 调用（server 启动/恢复/错误、各适配器错误与重试、bot 的 _alert 同步写日志、下单/撤单/成交关键点加 info 日志）
- 不替换前端相关 console（无）
- 日志目录加入 .gitignore（已有 `*.log` 覆盖 logs/ 内文件，目录本身需要忽略 `logs/`）

## 架构设计

```mermaid
flowchart TD
    Client[浏览器] -->|请求+Token| Guard[server.js 鉴权守卫]
    Guard -->|Origin/Host 校验| API[/api/* REST/SSE]
    Guard -->|401/403| Reject[拒绝响应]
    API --> Bot[GridBot]
    Bot -->|event| Logger[src/log.js JSON lines]
    Logger --> File[logs/app-YYYY-MM-DD.log]
    Bot --> Mock[MockExchange 测试]
```

## 架构决策 ADR

### ADR-001: 鉴权采用静态令牌 + Origin/Host 校验，而非会话/Cookie
**上下文:** VPS 公网暴露的交易控制台需要认证；单用户个人应用；无用户体系
**决策:** 环境变量 DASHBOARD_TOKEN 静态令牌（前端 sessionStorage 保存，请求头携带），叠加 Origin 白名单与 Host 校验
**理由:** 零依赖、无状态、实现简单；静态令牌对本机单用户场景足够；Origin/Host 校验封堵 DNS rebinding 与 CSRF 主路径
**替代方案:** 会话 Cookie → 需要 session 管理，复杂度不匹配单用户场景
**影响:** 令牌以 query 形式出现在 SSE URL（会进反代访问日志），建议配合 HTTPS 使用；令牌泄露可通过改 .env 重置

### ADR-002: 日志采用自研 JSON lines 模块，不引入 pino
**上下文:** 需要结构化日志与轮转；项目保持依赖精简
**决策:** 自研约 50 行 logger（JSON lines 文件 + 按天轮转 + 控制台可读输出）
**理由:** 功能需求简单（写入/轮转/级别过滤），零依赖可审计
**替代方案:** pino → 新增依赖与轮转插件，收益有限
**影响:** 无第三方日志生态；可后续按需替换

### ADR-003: bot.js 测试沿用自研 runner，不迁移 node:test
**上下文:** 现有 test/grid.test.js 使用自研断言 runner（16 个用例）
**决策:** 新测试沿用同一风格（同步 assert + 计数输出），npm test 串联两个文件
**理由:** 保持一致性、零迁移成本
**影响:** 无 CI 集成（个人项目）

## API设计

无 API 路径变更。新增鉴权语义：

### 所有 /api/* 请求
- **401**: 配置了 DASHBOARD_TOKEN 且请求未携带有效令牌
- **403**: Origin 不在白名单 / （未配置令牌时）Host 非回环

## 数据模型

无变更。`.env` 新增可选配置项：`DASHBOARD_TOKEN`、`PUBLIC_ORIGIN`。

## 安全与性能
- **安全:** 令牌比较用 `crypto.timingSafeEqual`；令牌禁止为空字符串配置；Origin 校验覆盖 SSE 端点；静态资源 index.html 不要求令牌（无敏感数据），API 全部要求
- **性能:** 鉴权为常量时间操作，无感知开销；日志写入为 append（批量落盘由 OS 缓冲），轮转检查为按天文件名

## 测试与部署
- **测试:** `npm test`（grid + starkcrypto + proxy 原有 16 例 + bot 新增用例）+ `npm run lint`
- **部署建议（写入 README）:** VPS 上建议 Nginx/Caddy 反向代理 + HTTPS（Let's Encrypt），设置 `HOST=0.0.0.0`、`DASHBOARD_TOKEN=<强随机串>`、`PUBLIC_ORIGIN=https://你的域名`；防火墙仅开放 80/443
