# market-gate 模块（市场三绿看门）

## 目的
把"是否适合重开网格"从人工判断变成三盏灯：为总览与推送提供 BTC 三绿指标（重开窗口指示）。

## 模块概述
- **职责:** 三绿指标计算（振幅/斜率/极值）、5 分钟轮询、转绿/转红事件推送、总览小卡数据
- **状态:** ✅稳定
- **最后更新:** 2026-09-24

## 规范

### 需求: 重开窗口指示
**模块:** market-gate

#### 场景: 三绿达成/破坏
- 前置: 公共 K 线可得（Binance 主源，适配器兜底）
- 预期结果: 连续 2 次检查全绿 -> "🟢 重开窗口开启"推送；破坏 -> "🔴 三绿破坏"推送（冷却 6h）；总览小卡实时红绿

## API接口
### GET /api/market-gate
**描述:** 三绿快照（symbol/allGreen/greens/values/thresholds/source/lastGreenAt/lastRedAt/gaps）
**输出:** 见 `src/market-gate.js snapshot()`

## 数据模型
无持久化（内存态；重启后重新采集）。

## 依赖
- platform（log）、notify（推送）、server（接线 + 兜底源）、被测指标口径与回测一致

## 变更历史
- [202609241000_market-gate](../../history/2026-09/202609241000_market-gate/) - 三绿看门（振幅/斜率/极值 + 推送 + 总览小卡 + AI 日报行）
