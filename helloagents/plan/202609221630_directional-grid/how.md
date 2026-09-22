# 技术设计: 趋势单边网格 — 影子优先 + 决断门

## 技术方案

### 总体架构（本次动工范围 = 阶段0 + 阶段1）

```text
行情层（单一信号源，HL 优先 / Binance 旁路对照）
  └── 5M / 1H / 4H K线（仅已收盘）+ 标记价 + 盘口（l2Book 采样）+ 资金费率
        ↓
指标/特征层
  └── indicators.js(+ADX) + strategy/features.js（EMA/ATR/ADX/斜率/结构高低点）
        ↓
市场状态层
  └── strategy/regime.js（TREND_UP / TREND_DOWN / RANGE / VOLATILE + score + 双确认防抖）
        ↓
影子记录层（零交易权限）
  ├── strategy/shadow-recorder.js（三组参数：R2 Fast 决断 + Balanced/Strict 对照）
  ├── strategy/shadow-cost-model.js（四档成本 + 真实盘口滑点采样）
  └── strategy/shadow-persistence.js（落盘 + 日报 + GET /api/strategy/shadow/state）
        ↓
[决断门评估] → 过门 → 阶段2-6（施工图见文档1 + 文档2修订）
```

### 关键设计

**1. RegimeFilter（strategy/regime.js）**
- 多周期：4H 大方向 / 1H 确认 / 5M 入场（仅用已收盘 K 线，杜绝未来函数）
- 多头条件：4H EMA20>EMA50 且 1H EMA20>EMA50 且 1H ADX≥18 且（4H或1H斜率为正）且 5M EMA20>EMA50 且价格位于短周期趋势方向
- score 模型（初版可解释）：`htf*25 + mtf*25 + adx*15 + slope*15 + entry*10 + priceLoc*10`
- 四态：TREND_UP / TREND_DOWN / RANGE / VOLATILE；**趋势不明确 → FLAT/NO TRADE（不回退中性网格）**
- 防抖：`score ≥ +50 连续两次 5M 检查` 或 `1H 收盘确认一次`；退出阈值 `score < +15`（多头）/ `> -15`（空头）
- 输出结构化 signal（timestamp/regime/score/confidence/direction/adx/atrPct/对齐标记/reason[]）

**2. ShadowRecorder（三组参数并行）**
- 参数组：R2 Fast（entry 50/exit 15/ADX 18/spacing 0.5ATR/stop 1.0ATR，决断对象）；Balanced（60/20/20/0.8ATR/1.5ATR，对照）；Strict（低交易频率对照，参数冻结于文档）
- 假设交易生命周期：`SIGNAL → VIRTUAL_ENTRY → VIRTUAL_ADD_1/2（最多3层）→ VIRTUAL_TP（0.8R/1.5R/2.2R 分批）/ TRAILING_STOP / STOP → CLOSED`
- 记录：tradeId/side/entry/stop/TP 阶梯/sizeBase/grossPnl/feeEstimate/fundingEstimate/slippageEstimate/netPnl/exitReason/MFE/MAE
- 与未来实盘状态机同构（FLAT/LONG_ARMED/LONG_ACTIVE/LONG_EXITING/SHORT_*/COOLDOWN），阶段3/4 直接复用
- 订单意图模型先行定义（kind: OPEN|ADD|TP|STOP|EXIT / side / reduceOnly / levelIndex / strategyId / reason），执行层复用

**3. ShadowCostModel**
- 四档成本情景：乐观 80% Maker@1.5bps / 基准 50%@2bps / 保守 20%@4bps / 全 Taker@4bps
- **真实盘口滑点采样**（用户拍板增强）：信号/入场/退出时采样 HL l2Book 深度，按假设 size 估算实际滑点，与固定档位并列记录（决断门以基准+保守档为准，盘口采样作可信度校验）
- 资金费率按持仓时长累计；Maker/Taker 属性按"入场用限价（Maker 假设）、止损用触发市价（Taker 假设）"建模

**4. 持久化与报表**
- 独立数据文件（不触碰 `.state.json` 既有键）；`GET /api/strategy/shadow/state` 只读
- 日报：复用 notify 总线（Telegram/Webhook），内容：信号数/完整交易数/四档 PF/DD/方向分布/盘口滑点 vs 假设

**5. 同进程隔离设计（用户拍板：子账户+同进程）**
- 影子期：无交易密钥、无账户调用 → 零资金风险
- 执行期（过门后）：独立 HL adapter 实例（子账户 `HL_DIR_*` 配置块）+ 独立状态键 + 独立模块边界；策略异常一律内部降级（告警/PAUSED），**不允许抛到主进程**
- 主力 6 所中性网格代码路径零改动

### 阶段0 探针设计

| 探针 | 方法 | 输出 |
|---|---|---|
| HL 触发单 | testnet 优先：开 tiny 仓 → 挂 reduce-only trigger SL → 验证受理/可见/撤单/触发；testnet 能力缺失则主网 tiny real（最小名义） | 能力矩阵条目 + 原始返回留档 |
| EX 触发单 | UNTRIGGERED 状态线索：直接 REST 探针（沿用适配器签名路径），验证触发单受理与 reduce-only | 能力矩阵条目 |
| 单向持仓/隔离 | HL 子账户创建 + agent key 授权（只交易不提现）；确认持仓/保证金隔离 | 账户隔离文档 |
| 数据源 | HL 与 Binance 的 5M/1H/4H 可得性、K线边界时间、同一时刻偏差采样（VPS 代理下） | 数据源结论 + 偏差记录 |
| 成交属性 | 成交回报是否含 Maker/Taker 标记、费用、资金费率字段 | 成本模型字段映射 |

**阶段0 结论格式**：`PRIMARY_EXECUTION_VENUE=... / PRIMARY_SIGNAL_SOURCE=... / FALLBACK_EXECUTION_VENUE=...`

### 决断门评估（阶段1 结束）

条件（全部满足）：≥7 自然日 且 ≥30 笔完整假设交易；基准成本 PF ≥ 1.30；保守成本 PF ≥ 1.10；净收益 > 0；最大回撤 ≤ 6%；收益/回撤 > 0.7；单日亏损 ≤ 1%；长短方向均有样本；无未保护虚拟仓位；信号→入场延迟 ≤ 1 个 5M 周期。
不过门：停止执行层开发；保留 regime（接 AI 哨兵）、成本模型、触发单评估结论（中性网格复用）。

## 架构决策 ADR

### ADR-1: 影子优先 + 决断门（顺序）
**上下文:** 回测显示 edge 未证实（Balanced 样本外转亏、R2 Fast 成本敏感）；文档1 原计划先建 4 周执行层再验证。
**决策:** 采纳文档2顺序：阶段0 探针 → 阶段1 影子（≥7天/≥30笔）→ 决断门 → 过门才建执行层。
**理由:** 用 1 周低成本验证替换 4 周高风险投入；不过门仍有复用件（regime/成本/触发单评估）。
**替代方案:** 文档1 全量先建 → 拒绝原因: 策略不成立时执行层白建。

### ADR-2: 子账户 + 同进程（用户拍板）
**上下文:** 文档2 要求独立账户/子账户 + 独立进程/VPS；用户选择省运维的同进程方案。
**决策:** HL 子账户 + 独立 agent key（资金/持仓归属清晰）+ 主进程内独立模块/adapter/状态键。
**理由:** 子账户保证账务隔离（核心诉求）；同进程省一套 systemd/端口；影子期零交易权限使风险为零。
**影响:** 执行期需代码级异常边界（策略异常不抛主进程）；进程级崩溃隔离缺失（主进程崩 = 方向策略也停，但看门狗/续跑机制已覆盖主力所）。
**替代方案:** 独立进程 8088 → 用户拒绝原因: 运维面翻倍。

### ADR-3: 单一信号源（HL 优先，Binance 对照）
**上下文:** 多所各自计算信号会产生边界/指标差异；执行在 HL 时信号同源可消除偏差。
**决策:** 单一信号源；HL 优先（同源），Binance 作为旁路对照并记录偏差（价格/5M 收盘/ATR/评分/延迟）。
**理由:** 消除信号漂移；偏差记录为阶段2 数据集中化提供依据。
**影响:** 阶段0 需探针确认 HL K 线质量与 Binance 可达性（VPS 代理）。

### ADR-4: 三组参数对照影子
**上下文:** R2 Fast 为唯一决断对象，但 Balanced/Strict 作为对照可低成本获得参数对比。
**决策:** 影子记录器并行跑三组参数（同一信号流，各自独立假设交易）。
**理由:** 零边际成本；第一周即得"哪套更稳"的对比数据；防止单组过拟合误判。
**影响:** 数据结构按 (configId, tradeId) 组织；报表分组呈现。

## 安全与性能
- **安全:** 影子期零交易密钥；探针使用子账户 tiny real（主网探针需用户确认后执行）；agent key 只交易不提现；同进程策略异常硬边界
- **性能:** 5M 轮询（与主进程现有 2s 级轮询相比可忽略）；l2Book 采样仅信号时触发；影子数据独立文件限长（滚动窗口）

## 测试与部署
- **测试:** `test/regime.test.js`（防未来函数/边界时间/防抖/四态）、`test/shadow-recorder.test.js`（生命周期/部分成交/去重/三组隔离）；npm test 串联
- **部署:** 同进程随主服务发布；阶段1 部署到实验或主 VPS 观察 ≥7 天；日报推送验收
