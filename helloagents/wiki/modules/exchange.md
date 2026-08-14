# exchange 模块（交易所适配器）

## 目的
统一三交易所（Decibel/Extended/RISEx）的 live 与 paper 接入，向 bot 提供一致的接口与事件。

## 模块概述
- **职责:** 市场/价格/K线、下单（签名或 API）、撤单、持仓/余额、成交检测（轮询 + 正向确认）、重连、paper 模拟撮合
- **状态:** ✅稳定
- **最后更新:** 2026-08-14

## 规范

### 需求: 成交正向确认
**模块:** exchange
#### 场景: 挂单从盘口消失
- 前置: 跟踪中的挂单从 open-orders 消失
- 预期结果: 查 order history，filledQty>0 才 emit fill；未知状态多轮重查后按"未成交"停止跟踪（不补单）；价格路径佐证（RISEx）

### 需求: 行情可靠性
**模块:** exchange
#### 场景: 行情源滞后
- 前置: Decibel 索引器价格与持仓推算价偏离 >0.25%
- 预期结果: 风控改用持仓推算价，出区间风控不失效

### 需求: 轮询健壮性
**模块:** exchange
#### 场景: 轮询卡死
- 前置: 单轮轮询 >90s 未完成
- 预期结果: watchdog 强制解锁继续轮询

### 需求: paper 模拟
**模块:** exchange
#### 场景: 模拟撮合
- 前置: paper 模式
- 预期结果: 真实行情（拿不到退化为合成行情并标注 dataSource）+ 虚拟资金撮合 + 模拟手续费

## API接口
适配器统一接口：init/reconnect/getMarkets/getPrice/getCandles/setLeverage/placeLimitOrder/cancelOrder/cancelAll/fetchOpenOrders/adoptOrder/getPosition/closePosition/start/stop/equity/balance/realizedPnl/feeRate/dataSource/mode；事件：fill/price/error。

## 数据模型
- 市场对象: marketId/name/displayName/symbol/lastPrice/stepSize/stepPrice/maxLeverage/minOrderSize（+ 各所扩展字段）
- 挂单跟踪: _tracked Map[orderId → {marketId,levelIndex,side,price,sizeBase,seen,placedAt,goneAttempts,resolving}]
- 持仓: _pos Map[marketId → {sizeBase(带符号),entryPrice,unrealizedPnl,leverage}]

## 依赖
- @decibeltrade/sdk + @aptos-labs/ts-sdk（de）、starkcrypto.js 零依赖签名（ex）、risex-client（rs，非官方 SDK）、undici 代理 dispatcher、log

## 已知问题
- risex-client 无订单状态/成交端点：成交判定靠连续 3 轮消失 + 价格路径佐证，无法正向确认
- undici 全局 dispatcher：三所无法真正独立代理（仅全局/首个有效代理生效）
- RISEx 余额接口对无余额记录账户返回 500（"failed to get cross margin balance"）：适配器记录 warn 日志并保持 balance=null，由保证金预检拦截
- RISEx 余额 `balance` 字段单位账户间不一致（原始 18 位 vs 人/币单位）：适配器用阈值启发式归一化（>1e12 ÷1e18）

## 变更历史
- [202608141916_risex-balance-unit](../../history/2026-08/202608141916_risex-balance-unit/) - 余额单位启发式归一化
- [202608141857_risex-balance-fix](../../history/2026-08/202608141857_risex-balance-fix/) - 修复 RISEx 余额 1e18 单位换算 + 读取失败日志化
- [202608141349_vps-hardening](../../history/2026-08/202608141349_vps-hardening/) - 依赖漏洞修复（undici 6.28.0 / ws 8.21.3 override，npm audit 归零）、结构化日志接入
