# ai 模块（AI 助手）

## 目的
可选 AI 能力：风控哨兵、每日复盘、市况分析、对话操控、出区间建议。

## 模块概述
- **职责:** provider 协议适配（openai/anthropic/gemini）、定时任务调度（1 分钟节拍）、状态快照喂 AI、Telegram/Webhook 通知
- **状态:** ✅稳定
- **最后更新:** 2026-08-14

## 规范

### 需求: AI 永不直接操作交易
**模块:** ai
#### 场景: 对话操控
- 前置: 用户要求 AI 调区间/停止
- 预期结果: AI 仅返回 action 提议（白名单 type + 合法交易所），前端弹确认框，用户确认后走现有 REST 接口执行

#### 场景: 状态快照隐私
- 前置: 配置 AI 后
- 预期结果: 账户权益/仓位/挂单快照会发送给第三方 AI 服务商（README 已披露）；AI 调用失败安全降级不影响交易

## API接口
aiChat（openai/anthropic/gemini 三协议）/ notify（Telegram + Webhook，失败不抛）/ extractJson（稳健 JSON 提取）。

## 数据模型
- 哨兵结果: {t, level: ok|warn|critical, summary, detail, per}
- 市况分析: {t, source, market, price, regime, suitable, recommendMode, suggestedRange, ...}
- 日报基线: {t, per: {de:{equity, realizedPnl, completedRungs, volume}, ...}}

## 依赖
- bot（状态）、exchange（K线）、persist（快照）、provider（AI 调用）

## 变更历史
- 无（本方案未改动）
