# strategy 模块（趋势单边网格）

## 目的
趋势方向策略的验证与执行体系。当前处于**阶段1 影子验证**：只记录假设交易，不产生任何真实订单。

## 模块概述
- **职责:** 多周期特征/市场状态过滤/影子假设交易记录/成本建模/决断门评估
- **状态:** 🚧开发中（阶段1 影子；阶段2-6 过决断门后施工）
- **最后更新:** 2026-09-22

## 规范

### 需求: 信号影子验证
**模块:** strategy
在零资金风险下前向验证 R2 Fast 信号是否具备可持续 edge（回测显示 Balanced 样本外转亏、R2 Fast 对成本敏感）。

#### 场景: 影子记录完整假设交易
- 前置: HL 公共行情接入（5M/1H/4H）、regime 产生信号
- 预期结果: 三组参数各自产生 SIGNAL→ENTRY→ADD→TP/STOP→CLOSED 全生命周期记录（含 MFE/MAE、四档成本、盘口滑点采样）

#### 场景: 决断门评估
- 前置: ≥7 天且 ≥30 笔完整假设交易
- 预期结果: 输出 PF/DD/收益回撤比/日损/方向样本报告；达标进入阶段2，不达标停止执行层开发并保留复用件

### 需求: 能力探针与隔离
**模块:** probe/strategy
执行场地的原生触发止损能力与账户隔离前置确认。

#### 场景: 触发单能力确认
- 前置: HL 子账户 + agent key
- 预期结果: 能力矩阵给出 PRIMARY_EXECUTION_VENUE / PRIMARY_SIGNAL_SOURCE / FALLBACK

## API接口
### GET /api/strategy/shadow/state
**描述:** 影子运行状态（只读）：最近信号、三组参数持仓/统计、决断门进度、基差采样
**输入:** 无
**输出:** `{ enabled, symbol, startedAt, lastBarKey, gate, recorder, binance }`

## 数据模型
### .strategy-shadow.json（独立落盘，不触碰 .state.json）
| 字段 | 类型 | 说明 |
|------|------|------|
| version | number | 数据版本 |
| startedAt | number | 影子起始时间（决断门计时基准） |
| runner | object | lastBarKey/lastHourKey/日报日期/binance 偏差采样 |
| recorder | object | evaluations/signals 环/perConfig{trades,stats,position} |

## 依赖
- indicators（ADX/EMA/ATR/斜率）、notify（日报推送）、server（同进程接线）
- **零交易依赖**：不引用任何交易所适配器/签名器（安全检查与测试锁定）

## 变更历史
- [202609221630_directional-grid](../../history/2026-09/202609221630_directional-grid/) - 阶段0 探针 + 阶段1 信号影子系统（dev006）
