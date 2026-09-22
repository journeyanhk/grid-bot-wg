# 变更提案: 趋势单边网格（方向策略）— 影子优先 + 决断门

## 需求背景

用户提出基于 dev004-dy 开发"趋势单边网格"能力，提供两份技术文档：
- **文档1（完整技术改造方案）**：R2 Fast 信号 + LowRisk 仓位、RegimeFilter/RiskEngine/CostModel/DirectionalStrategyController、状态机、方向网格、4 周排期。
- **文档2（评审修订版）**：纠正开发顺序——**先验证信号（影子系统 + 第一周决断门），再决定是否建设执行层**；并补充：交易所原生触发单能力前置确认、独立账户/子账户隔离、单一信号源 + DEGRADED 态。

回测证据：Balanced 样本外转亏（不可作默认）；R2 Fast 验证集仍盈利但对 Maker 成交率/滑点敏感，**edge 尚未被证实**。因此不能按"已验证的盈利策略"立项。

### 用户拍板项（2026-09-22）
1. 开发顺序：**影子优先 + 决断门**（不过门则停，保留复用件）
2. 执行场地：**先探针后定，HL 优先**（HL SDK 原生触发单已实测；EX 备选待探针）
3. 隔离级别：**子账户 + 同进程**（省一套 systemd/端口；代码级边界 + 影子期零交易权限）
4. 影子期增强：**真实盘口滑点采样（HL l2Book）** + **三组参数对照（R2 Fast/Balanced/Strict）**
5. 影子期形态：纯服务端 + 日报推送（不做前端面板）

## 变更内容

### 本次动工（阶段0 + 阶段1）
1. **阶段0（Day 1）能力探针 + 隔离**：
   - HL 触发单能力探针（testnet 优先，tiny real 兜底）：原生 Stop / reduce-only / 单向持仓 / 成交回报 / Maker-Taker 标记 / 资金费率 / 重启接管
   - EX 备选探针（UNTRIGGERED 线索验证）
   - 数据源探针（HL/Binance 5M/1H/4H 可得性、边界、偏差）
   - HL 子账户 + 独立 agent key（只交易不提现）；同进程独立配置块 `HL_DIR_*`
2. **阶段1（3-5 天开发 + ≥7 天观察）信号影子系统**（纯行情、零交易密钥）：
   - `indicators.js` 增 ADX；`src/strategy/features.js` 多周期特征
   - `src/strategy/regime.js` 四态 + score + 双确认防抖
   - `src/strategy/shadow-recorder.js` 三组参数假设交易全生命周期
   - `src/strategy/shadow-cost-model.js` 四档成本 + 真实盘口滑点采样
   - `src/strategy/shadow-persistence.js` 落盘 + 日报 + `GET /api/strategy/shadow/state`
   - 部署观察：≥7 天且 ≥30 笔完整假设交易 → **决断门评估报告**

### 过门后（阶段2-6，文档1施工图）
数据集中化+DEGRADED → RiskEngine+状态机 → 方向网格执行层（原生止损/反转冷却/禁 recover）→ CostModel+最小前端+Paper（14天/50笔）→ 极小资金实盘（0.05-0.1% 起步）。

## 影响范围

- **模块**: 新增 strategy（regime/features/shadow-*）、indicators 扩展、server 接线、docs/strategy、scripts/probe
- **文件**: `src/strategy/*`(新), `src/indicators.js`, `src/server.js`, `docs/strategy/*`(新), `scripts/probe/*`(新), `test/regime.test.js`(新), `test/shadow-recorder.test.js`(新)
- **API**: `GET /api/strategy/shadow/state`（影子期只读）
- **数据**: 影子数据独立落盘（`data/strategy-shadow.json` 或同类），不触碰 `.state.json` 既有键

## 核心场景

### 需求: 信号影子验证
**模块:** strategy

#### 场景: 影子记录完整假设交易
- 前置: 多周期行情接入、regime 产生信号
- 预期结果: 三组参数各自产生 SIGNAL→ENTRY→ADD→TP/STOP→CLOSED 全生命周期记录（含 MFE/MAE、四档成本、盘口滑点采样）

#### 场景: 决断门评估
- 前置: ≥7 天且 ≥30 笔完整假设交易
- 预期结果: 输出 PF/DD/收益回撤比/日损/方向样本/延迟报告；达标进入阶段2，不达标停止执行层开发并保留复用件

### 需求: 能力探针与隔离
**模块:** probe/strategy

#### 场景: 触发单能力确认
- 前置: HL 子账户 + agent key
- 预期结果: 矩阵文档给出 PRIMARY_EXECUTION_VENUE / PRIMARY_SIGNAL_SOURCE / FALLBACK

## 风险评估

- **风险**: 策略无可持续 edge（回测已现不稳定）
  - **缓解**: 决断门硬性拦截（PF≥1.30/1.10、DD≤6%、长短均有样本）；不过门即停，不因"代码已写"继续投入
- **风险**: 同进程隔离弱（用户拍板省运维）
  - **缓解**: 影子期零交易权限（无资金风险）；执行层代码级边界（独立模块/adapter 实例/状态键；策略异常内部降级不抛主进程）；子账户+独立 API key 保证资金与持仓归属清晰
- **风险**: HL 触发单探针失败或 io/核心市场兼容问题
  - **缓解**: EX 备选探针（UNTRIGGERED 线索）；再退化为本地止损（文档2列为最后选项，需额外评估）
- **风险**: 信号数据源（HL/Binance）在 VPS 网络下不可达或不一致
  - **缓解**: 阶段0 数据源探针；单一信号源原则 + 偏差记录（HL 优先同源，Binance 旁路对照）
- **风险**: 回测过拟合/未来函数
  - **缓解**: 仅用已收盘 K 线；双确认防抖；训练/验证分离沿用；影子为实时前向验证
