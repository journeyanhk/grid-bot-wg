# bot 模块（网格机器人核心）

## 目的
编排单个市场的等差网格：铺单、成交补反向单、风控、对账、崩溃恢复。

## 模块概述
- **职责:** start/stop/adjustRange/resetStats、成交补单链（replacementFor）、出区间处置（close 平仓 / recover 只减仓回收阶梯）、30s 挂单对账（prune/trim/adopt/massVanish 保护）、快照持久化钩子、resume 续跑、健康状态
- **状态:** ✅稳定
- **最后更新:** 2026-08-14

## 规范

### 需求: 网格铺单与补单
**模块:** bot
#### 场景: 三模式铺单
- 前置: 启动中性/做多/做空网格
- 预期结果: 现价下方挂买/上方挂卖（中性双向、long 只买、short 只卖），跳过带（0.25 间距）不挂；reduceOnly 标记正确
#### 场景: 成交补反向单
- 前置: 买单成交于 i 格
- 预期结果: 在 i+1 格挂卖单（做多模式为 reduce-only），rung 统计累加 spacing*size

### 需求: 出区间风控
**模块:** bot
#### 场景: close 策略
- 前置: 价格突破边界，outOfRangeAction=close
- 预期结果: 撤单 + 平仓（3 次重试确认）+ 停止
#### 场景: recover 策略
- 前置: 价格突破边界，outOfRangeAction=recover
- 预期结果: 在现价与被冲边界间挂 reduce-only 阶梯单；价格回区间自动撤销

### 需求: 挂单对账
**模块:** bot
#### 场景: 对账清理
- 前置: 本地跟踪单在交易所消失
- 预期结果: 连续两轮确认后 prune；同层重复单 trim 撤销；孤儿单 adopt 接管；交易所返回 0 单快照（massVanish）不清理

### 需求: 崩溃恢复
**模块:** bot
#### 场景: 重启续跑
- 前置: 快照 running=true
- 预期结果: 重建挂单跟踪、接管交易所真实挂单、立即对账、恢复运行

### 需求: 保证金预检
**模块:** bot
#### 场景: 启动拒绝
- 前置: 名义敞口/杠杆所需保证金 > 可用
- 预期结果: 启动报错拒绝，不挂任何单

## 数据模型
见 [data.md](../data.md) 快照结构（config/stats/active/recovery/pnlBase）。

## 依赖
- grid（纯函数：buildGrid/seedOrders/replacementFor）、exchange 适配器（事件源）、persist（onChange 钩子）、log

## 变更历史
- [202608191510_decibel-safety-l12](../../history/2026-08/202608191510_decibel-safety-l12/) - 回收阶梯撤单跳过幽灵单
- [202608181326_vps-hardening-v12](../../history/2026-08/202608181326_vps-hardening-v12/) - v1.2.0 移植：补格/撤单确认/安全重试/进度跟踪
- [202608141349_vps-hardening](../../history/2026-08/202608141349_vps-hardening/) - 引入 MockExchange 单元测试、结构化日志
