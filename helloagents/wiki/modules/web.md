# web 模块（HTTP 服务 + 前端）

## 目的
提供浏览器仪表盘（REST + SSE 实时推送）与统一鉴权入口。

## 模块概述
- **职责:** HTTP 路由（server.js）、SSE 1s 推送、静态资源服务（public/index.html 单文件）、鉴权守卫、.env 白名单写入（/api/env）
- **状态:** ✅稳定
- **最后更新:** 2026-08-14

## 规范

### 需求: 控制面板鉴权
**模块:** web
VPS/公网部署下，交易控制 API 必须受保护。

#### 场景: Token 认证
- 前置: `.env` 配置了 `DASHBOARD_TOKEN`
- 预期结果:
  - REST 请求携带 `X-Auth-Token` 有效令牌 → 200
  - 无/错令牌 → 401 JSON，不返回任何交易数据
  - SSE 请求 `?token=` 有效 → 正常推送
- 前置: 未配置令牌（纯本地）
- 预期结果: 仅回环 Host 可访问，非回环 Host → 403

#### 场景: 跨站与 DNS rebinding 防护
- 前置: 请求带 Origin 头但不在白名单（回环 + PUBLIC_ORIGIN）
- 预期结果: 403，接口不触发

### 需求: XSS 注入面收敛
**模块:** web
#### 场景: 外部数据渲染
- 前置: 交易所市场名/AI 输出/错误消息含 HTML 标签
- 预期结果: 页面以纯文本渲染，不执行脚本

## API接口
见 [api.md](../api.md)。鉴权失败语义：401（令牌）/ 403（来源）。

## 数据模型
无独立数据；依赖 .env（DASHBOARD_TOKEN / PUBLIC_ORIGIN / HOST / PORT）。

## 依赖
- config（.env 加载）、bot（状态来源）、exchange（数据源）、ai（AI 接口）、persist（快照）、log（日志）

## 变更历史
- [202608141857_risex-balance-fix](../../history/2026-08/202608141857_risex-balance-fix/) - 版本号机制（/api/version + 前端展示）
- [202608141349_vps-hardening](../../history/2026-08/202608141349_vps-hardening/) - 鉴权 + XSS 转义 + 结构化日志接入
