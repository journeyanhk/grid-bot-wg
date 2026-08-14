# Changelog

本文件记录项目所有重要变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
