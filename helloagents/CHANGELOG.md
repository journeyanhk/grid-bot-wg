# Changelog

本文件记录项目所有重要变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.2.0] - 2026-08-18

### 新增
- 移植原作者最新版安全机制：一键补格 refillGrid、撤单确认（_cancelAllConfirmed 轮询交易所确认消失）、开仓单安全重试 + 挂单进度跟踪（placementProgress，两次权威快照去重）
- 适配器安全增强：撤单失败保留本地跟踪（确认后 forgetOrder 清理）、malformed 挂单快照不视为 0 单
- Decibel 友好错误翻译（operationalIssue）：gas 不足时仪表盘直接显示中文原因 + API Wallet 地址可一键复制
- 持仓展示增强：强平价（liquidationPrice）显示
- 前端：三个控制台"一键补格"按钮、挂单进度/交易所核实挂单数展示
- 测试：cancel-safety（10 例）+ safety-progress（5 例，补格/进度/安全重试/停止中止），总计 44 例

### 变更
- 保留既有安全与修复：VPS 鉴权、XSS 转义、结构化日志、ESLint、RISEx 余额/杠杆/撤单三项修复

## [1.1.3] - 2026-08-14

### 修复
- RISEx 杠杆设置失效：risex-client SDK 的 `updateLeverage` 请求体键名与服务端协议不匹配（发 `permit`，服务端要求 `permit_params`，实测 400），且杠杆值需 WAD 放大（×1e18）。已绕开 SDK 该方法，用其签名原语自组装请求

## [1.1.2] - 2026-08-14

### 修复
- RISEx 余额单位再修复：`balance` 字段单位在账户间不一致（有的原始 18 位单位、有的直接人/币单位），改为阈值启发式归一化（>1e12 视为原始单位 ÷1e18），并记录原始值便于排查

## [1.1.1] - 2026-08-14

### 修复
- RISEx 余额单位换算 bug：余额接口返回原始 18 位小数单位，此前直接当作人/币单位导致余额显示天文数字、保证金预检失效；现除以 1e18 并做 NaN 防御
- RISEx 余额读取失败不再静默：写入结构化日志，便于排查"无法读取余额"（账户无余额记录时接口返回 500）

### 新增
- 版本号机制：/api/version 端点 + 仪表盘右上角展示当前版本（随 package.json 自动更新）

## [1.1.0] - 2026-08-14

### 新增
- HTTP 鉴权：DASHBOARD_TOKEN 静态令牌（前端会话保存、SSE 支持 query token）+ Origin 白名单 + Host 回环校验，阻断 DNS rebinding / CSRF / 未授权访问
- 前端 XSS 转义：esc() 统一转义外部数据（交易所市场名、AI 输出、错误消息）
- bot.js 核心逻辑单元测试（内存 mock 交易所：铺单/补单链/风控/reconcile/resume/保证金）
- ESLint（flat config）与 npm run lint
- 结构化日志模块 src/log.js（JSON lines + 按天轮转 + LOG_LEVEL/LOG_DIR）
- README VPS 部署安全建议章节

### 修复
- 依赖漏洞：ws（ethers ← risex-client 传递依赖）内存泄露/DoS 漏洞修复

### 变更
- 全部 /api/* 端点受鉴权保护（配置 DASHBOARD_TOKEN 时）
- 关键事件日志从 console 迁移至结构化日志

### 移除
- （无）
