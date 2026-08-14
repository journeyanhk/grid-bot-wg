# 三交易所网格交易机器人

> 本文件包含项目级别的核心信息。详细的模块文档见 `modules/` 目录。

---

## 1. 项目概述

### 目标与背景
本机/VPS 运行的加密货币永续合约网格交易机器人，同时支持 Decibel（Aptos）、Extended（Starknet）、RISEx 三家去中心化交易所，统一浏览器仪表盘监控与操控，支持 paper（模拟）/ live（实盘）双模式。部署场景含公网 VPS，安全与容错是设计重心。

### 范围
- **范围内:** 等差网格交易（中性/做多/做空）、风控（保证金预检/格距校验/出区间处置/对账）、崩溃恢复续跑、AI 助手（哨兵/日报/市况/对话操控/出区间建议）、Telegram/Webhook 通知、代理配置、HTTP 鉴权
- **范围外:** 提币/存款、多币种对冲策略、移动端 App、多用户体系

### 干系人
- **负责人:** 用户（个人项目，单用户）

---

## 2. 模块索引

| 模块名称 | 职责 | 状态 | 文档 |
|---------|------|------|------|
| web | HTTP 服务 + SSE 推送 + 前端仪表盘 + 鉴权 | ✅稳定 | [web](modules/web.md) |
| bot | 网格机器人核心（铺单/补单/风控/对账/恢复） | ✅稳定 | [bot](modules/bot.md) |
| exchange | 三交易所适配器（live + paper + 签名） | ✅稳定 | [exchange](modules/exchange.md) |
| ai | AI 助手（provider 适配 + 哨兵/日报/对话） | ✅稳定 | [ai](modules/ai.md) |
| platform | 基础层（配置/持久化/代理/K线分析/日志） | ✅稳定 | [platform](modules/platform.md) |

---

## 3. 快速链接
- [技术约定](../project.md)
- [架构设计](arch.md)
- [API 手册](api.md)
- [数据模型](data.md)
- [变更历史](../history/index.md)
