# 交易所能力矩阵（阶段0 探针结论）

> 探针日期：2026-09-22 · 探针脚本：`scripts/probe/probe-hl-trigger.py`（触发单）、`scripts/probe/probe-data-sources.mjs`（数据源）
> 结论随用户侧实弹探针（testnet/主网 tiny real）更新。

## 结论（阶段0）

```
PRIMARY_EXECUTION_VENUE = Hyperliquid BTC 永续（待用户侧实弹探针确认受理与触发行为）
PRIMARY_SIGNAL_SOURCE   = Hyperliquid（同源零基差；Binance 合约作旁路对照，经代理可达）
FALLBACK_EXECUTION_VENUE = Extended BTC（UNTRIGGERED 线索待探针；有现成 BTC 网格基建）
```

## Hyperliquid（首选场地）

| 能力 | 状态 | 证据 |
|---|---|---|
| 原生触发单（trigger/tpsl） | ✅ SDK 构造+签名 dry-run 通过 | 官方 SDK 0.24.0：`OrderType.TriggerOrderType`/`Tpsl('sl'\|'tp')`；wire = `{"trigger":{"isMarket":true,"triggerPx":"90000","tpsl":"sl"}}`，action 含 `r:true`（reduce-only） |
| 触发单实盘受理/可见/撤单/触发 | ⏳ 待用户侧实弹探针 | testnet 未入金账户被拒（`User or API Wallet ... does not exist`，账户需先领水）；用 `probe-hl-trigger.py --network testnet --with-entry` 跑通后留档 |
| reduce-only 语义 | ✅ 构造支持 | action `r:true`；reduce-only 触发单通常要求已有反向持仓（探针 `--with-entry` 已覆盖该场景） |
| 单向持仓 | ✅ 天然单向（净头寸模型） | HL 账户模型为净头寸（szi 带符号），无双开 |
| 逐仓/隔离 | ✅ 可用 | 核心 BTC `onlyIsolated` 无强制（可选逐仓）；io 系强制逐仓（既有实测） |
| 成交回报 | ✅ 字段齐备 | Fill 含 `crossed`(true=Taker)/`fee`/`feeToken`/`dir`(Open/Close)/`closedPnl`/`startPosition`/`oid` —— Maker/Taker 可直接统计 |
| 资金费率 | ✅ | `metaAndAssetCtxs` → `ctx.funding`（每小时费率，探针实测 ~0.0000193/h） |
| BTC 永续市场 | ✅ 核心市场 index=0 | `szDecimals=5, maxLeverage=40`，5M/1H/4H K线 201 根可得、边界对齐 |
| 盘口深度 | ✅ | `l2Book`：`levels[0]=bids, levels[1]=asks`，各 20 档 `{px,sz,n}` |
| 重启接管 | ✅ 已验证 | 既有 HL 适配器（io dex）跑通 userFillsByTime 游标 + 空快照守卫 |
| **适配器缺口** | ⚠️ 需改造 | 现有 `src/exchange/hl/market.js` 硬编码 `io:` 前缀过滤核心市场 → 方向策略需支持 `dex:''`（核心）或独立数据通道 |

### 用户侧实弹探针清单（放行前必做）
1. HL testnet：`app.hyperliquid-testnet.xyz` 领水入金 → 运行
   `HL_ACCOUNT_ADDRESS=0x… HL_AGENT_PRIVATE_KEY=0x… .hl-venv/bin/python scripts/probe/probe-hl-trigger.py --network testnet --with-entry`
   预期：远价入场单受理 → 触发止损单受理 → frontendOpenOrders 可见（含触发字段）→ 双单撤销成功
2. 触发行为验证（testnet）：保留一张距现价 1% 的触发单，等待价格触发（或用小号主动打价格），确认触发后成交且持仓归零
3. 主网 tiny real（**需用户确认**）：子账户最小名义（~$11）复跑，留档原始返回

## Extended（备选场地）

| 能力 | 状态 | 证据 |
|---|---|---|
| 触发单线索 | ⏳ 待探针 | 订单状态机含 `UNTRIGGERED`（`src/exchange/ex/extended.js` 状态正则）→ 大概率支持触发单，需实测受理/reduce-only/可见/撤单 |
| BTC 网格基建 | ✅ | 现有主力所之一（BTC-USD 中性网格运行中） |
| 账户隔离 | ⏳ 待确认 | 子账户/API key 隔离能力需核对 |
| 数据源 | ✅ | 既有适配器 K 线可用（历史验证过） |

## 其余四所（DE/RS/LR/VA）

- 均无原生触发单实现痕迹（grep 命中均为 `stop()` 方法等假阳性）
- 方向策略的硬需求是"原生触发止损"，故不列为首发候选；若 HL/EX 均不达标，再评估"本地止损"路线（文档2 列为最后选项）

## 数据源探针（实测）

| 项 | 结果 |
|---|---|
| HL 5M/1H/4H K线 | ✅ 边界对齐（5M 整点、1H/4H 整点），最后一根在途（消费方需丢弃未收盘） |
| HL l2Book | ✅ 20 档双边 |
| HL 资金费率 | ✅ 每小时费率可得 |
| Binance 合约（fapi） | ✅ 经代理可达（本机直连被地区限制；VPS 需代理） |
| HL vs Binance 同根 5M 收盘偏差 | **平均 ~9.8bps（7 样本，8.3–10.4bps）**——持续为正 = HL 对 Binance 永续溢价（与正资金费率一致）；**单一信号源原则的直接依据**（信号与执行同源可消除该基差噪声） |

## 成交属性字段映射（CostModel 输入）

| 需求 | HL 字段 |
|---|---|
| Maker/Taker | `fill.crossed`（true = Taker） |
| 手续费 | `fill.fee` / `fill.feeToken` |
| 成交方向/用途 | `fill.dir`（如 `Open Long` / `Close Short`） |
| 已实现盈亏 | `fill.closedPnl` |
| 成交价/量 | `fill.px` / `fill.sz` |
| 持仓起点 | `fill.startPosition` |
