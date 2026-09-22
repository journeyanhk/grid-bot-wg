# 任务清单: 趋势单边网格 — 影子优先 + 决断门

目录: `helloagents/plan/202609221630_directional-grid/`
分支: `dev006`（从 dev004-dy 切出）

---

## 0. 分支与准备
- [ ] 0.1 创建 dev006 分支并落地方案包（本任务）
- [ ] 0.2 版本号 1.6.9 → 1.7.0（新功能 minor+1，进入阶段1 时执行）

## 1. 阶段0：能力探针 + 隔离（Day 1）
- [ ] 1.1 HL 触发单探针（testnet 优先；tiny real 需用户确认）：reduce-only trigger SL 受理/可见/撤单/触发；输出原始返回留档，验证 why.md#需求-能力探针与隔离-场景-触发单能力确认
- [ ] 1.2 EX 备选探针：UNTRIGGERED 线索验证触发单支持（沿用适配器签名路径）
- [ ] 1.3 数据源探针：HL/Binance 5M/1H/4H 可得性、K线边界、偏差采样（VPS 代理下）
- [ ] 1.4 成交属性探针：Maker/Taker 标记、费用、资金费率字段映射
- [ ] 1.5 HL 子账户 + 独立 agent key（只交易不提现）+ 配置块 `HL_DIR_*`（同进程独立实例预留）
- [ ] 1.6 交付 `docs/strategy/exchange-capability-matrix.md` + `docs/strategy/account-isolation.md` + 探针脚本；给出 PRIMARY_EXECUTION_VENUE / PRIMARY_SIGNAL_SOURCE / FALLBACK

## 2. 阶段1：指标与市场状态（3-5 天）
- [ ] 2.1 `src/indicators.js` 增 ADX（+ 单测，对齐既有 ema/atr/normalizedSlope 风格）
- [ ] 2.2 新建 `src/strategy/features.js`：4H/1H/5M 多周期特征（EMA/ADX/ATR 归一化斜率/结构高低点）+ 仅已收盘 K 线对齐，验证 why.md#需求-信号影子验证-场景-影子记录完整假设交易
- [ ] 2.3 新建 `src/strategy/regime.js`：四态 + score + 双确认防抖 + 退出阈值 + 结构化 signal 输出
- [ ] 2.4 新建 `test/regime.test.js`：防未来函数（截断重算一致）/ 边界时间 / 阈值附近不抖动 / 四态切换

## 3. 阶段1：影子记录与成本
- [ ] 3.1 新建 `src/strategy/shadow-recorder.js`：三组参数（R2 Fast/Balanced/Strict）假设交易全生命周期（SIGNAL→ENTRY→ADD→TP/TRAIL/STOP→CLOSED）+ MFE/MAE + 订单意图模型先行定义，依赖 2.3
- [ ] 3.2 新建 `src/strategy/shadow-cost-model.js`：四档成本情景 + HL l2Book 真实盘口滑点采样（信号时触发）+ 资金费率累计
- [ ] 3.3 新建 `src/strategy/shadow-persistence.js`：独立数据文件（滚动窗口）+ 日报（复用 notify）+ `GET /api/strategy/shadow/state`（只读）
- [ ] 3.4 新建 `test/shadow-recorder.test.js`：生命周期完整性 / 部分成交 / 重复事件去重 / 三组隔离
- [ ] 3.5 `src/server.js` 接线：同进程独立 timer 启动影子（零交易密钥）+ 只读路由；异常边界（策略异常内部降级不抛主进程）

## 4. 安全检查
- [ ] 4.1 影子期零交易权限核验（无下单路径/无账户密钥调用）；子账户 key 只交易不提现；探针 tiny real 前需用户确认

## 5. 部署与观察（阶段1 验收）
- [ ] 5.1 部署（实验或主 VPS 同进程）；日报推送验收
- [ ] 5.2 观察 ≥7 自然日且 ≥30 笔完整假设交易（不足则延长，不为按时决策降样本）
- [ ] 5.3 决断门评估脚本/报告：PF（基准≥1.30/保守≥1.10）/净收益/DD≤6%/收益回撤比>0.7/日损≤1%/长短样本/延迟≤1个5M周期/无未保护虚拟仓位
- [ ] 5.4 决断门结论：过门 → 进入阶段2；不过门 → 停执行层开发 + 复用件清单（regime 接 AI 哨兵 / 成本模型 / 触发单评估）

## 6. 阶段2-6（过门后施工，文档1施工图 + 文档2修订）
- [ ] 6.1 阶段2：数据集中化（central-feed/timeframe-aggregator/data-health）+ DEGRADED 态
- [ ] 6.2 阶段3：RiskEngine + PositionSizer + 策略状态机（FLAT/LONG_*/SHORT_*/COOLDOWN/DEGRADED/PAUSED/HALTED）
- [ ] 6.3 阶段4：方向网格执行层（OrderManager/原生止损先确认再加仓/反转冷却/禁 recover/outOfRangeAction=close）
- [ ] 6.4 阶段5：CostModel 实盘 + 最小前端 + Paper（14 天/50 笔）
- [ ] 6.5 阶段6：极小资金实盘（0.05-0.1% 风险起步，20-30 笔后再评估升档）

## 7. 文档更新
- [ ] 7.1 更新 `helloagents/CHANGELOG.md`（1.7.0，阶段1 交付时）
- [ ] 7.2 新增 `helloagents/wiki/modules/strategy.md`（阶段1 完成后）
- [ ] 7.3 更新 `helloagents/history/index.md` + 迁移方案包（本方案为多阶段，迁移时机 = 决断门结论落档时）

---

## 任务状态符号
- `[ ]` 待执行 / `[√]` 已完成 / `[X]` 执行失败 / `[-]` 已跳过 / `[?]` 待确认
