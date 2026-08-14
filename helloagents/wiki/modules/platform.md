# platform 模块（基础层）

## 目的
配置加载、状态持久化、代理管理、技术分析、结构化日志等基础设施。

## 模块概述
- **职责:** config（.env 加载与校验）、persist（.state.json 原子快照）、proxy（undici dispatcher + 手写 SOCKS5 握手 + 出口 IP 检测）、trend/indicators（K线趋势分析）、log（JSON lines 结构化日志）
- **状态:** ✅稳定
- **最后更新:** 2026-08-14

## 规范

### 需求: 快照原子持久化
**模块:** platform
#### 场景: 崩溃恢复
- 前置: 运行中进程崩溃
- 预期结果: .state.json 上次快照可恢复（tmp+rename 原子写，500ms 防抖，unref 不阻塞退出）

### 需求: 代理连通性保护
**模块:** platform
#### 场景: 实盘启动代理不通
- 前置: live 模式 + 代理无法联网
- 预期结果: 中止启动（防断网挂单失控）

### 需求: 结构化日志
**模块:** platform
#### 场景: 日志写入与轮转
- 前置: 运行中产生日志
- 预期结果: JSON lines 写入 logs/app-YYYY-MM-DD.log，按天轮转，LOG_LEVEL 过滤，控制台同步可读输出

## 数据模型
见 [data.md](../data.md)。

## 依赖
- 无外部依赖（node:fs/path/crypto/net/tls/url）

## 变更历史
- [202608141349_vps-hardening](../../history/2026-08/202608141349_vps-hardening/) - 新增 log.js 结构化日志模块

## VPS 部署
- systemd 服务模板: `deploy/grid-bot.service`（安装步骤见文件头注释）
- 部署要求: 项目在 /root/grid-bot-wg，`npm install --omit=dev`，.env 配置 `HOST=0.0.0.0` + `DASHBOARD_TOKEN` + `PUBLIC_ORIGIN` + HTTPS 反代
