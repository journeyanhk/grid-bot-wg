# Propr Shadow 验收报告（任务 9.1）

- **日期:** 2026-09-23 21:32 → 2026-09-24（连续运行 ≥16h 后人工停机）
- **环境:** VPS（Ubuntu）· Caddy 反代 · `PR_MODE=shadow` · `PR_PROXY` 独立代理（per-client）
- **账户:** Propr Free Trial（`urn:****qwbh`）· 真实权益 4999.5x USDC
- **结论:** ✅ **通过**（11 项验收清单全部满足）

## 一、验收清单

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | Propr 写请求 | ✅ 始终 0 | `exchangeInfo.writeRequests = 0` |
| 2 | 账户绑定 | ✅ 掩码与目标一致 | `accountIdMasked = urn:****qwbh` |
| 3 | 权益来源 | ✅ 权威字段 | shadow 用 `proprEquity`（`marginBalance/balance/availableBalance/highWaterMark`）；`initialRealEquity = 4999.603532` |
| 4 | 真实账户零接触 | ✅ | `proprNetPosition = null`（全程无真实持仓/挂单） |
| 5 | 权益/持仓快照 | ✅ 无持续 stale | `proprAccountStale=false` / `proprPositionStale=false` / 错误 `null` |
| 6 | API 新鲜度 | ✅ 持续更新 | 行情/账户/持仓三个 `*LastOkAt` 均在最近数秒内；`lastOkAgeMs≈764ms`、`priceStale=false` |
| 7 | 本地重复下单 / 漏补 / 未知态 | ✅ 均 0 | `health.status=ok`、`placeFails=0`、alerts 仅启停记录 |
| 8 | 断网恢复 | ✅（人工演练） | 停代理 90s → 恢复：行情与账户快照自动续上、无假锁定、看门狗未误报 |
| 9 | 进程重启 | ✅（人工演练） | 重启后网格保持「未运行」、不误自动续跑、无重复订单 |
| 10 | 越界 close | ✅ | Shadow 期间未越界；以窄区间在 Propr paper 适配器（同一 GridBot 链路）强制触发通过：`价格突破上边界 → 撤单 + 平仓 + 停止 → ✅ 已确认仓位已平` |
| 11 | 总览口径 / 未连接拒绝启动 | ✅ | Propr 独立卡片不并入三所汇总；`dataSource==null` 时 `/api/propr/start` 被拒（代码 + 单测） |

## 二、运行时表现

- 参数：**15 格中性网格 · 间距 406.67（0.47%）· 每格 0.0015 BTC · 1x · 越界 close · 动态网格未启用**
- 成交：**18 笔（11 买 / 7 卖）**、**6 个完整格**、网格利润 **3.66 USDC**、成交量 2278.21（均价 ≈84.4k）
- 行情路径：85,846 → 83,813（-2.4%）后 83,813–84,626 横盘约 12h —— 先积累多仓、再靠震荡收割
- 全程**零 error/warn 告警**；停机后挂单 0 / 持仓 0（干净）

## 三、Shadow 未覆盖、已由 sim-write 冒烟补齐的部分

真实 `createOrders` / intentId 幂等 / 撤单终态 / 成交确认 / reduce-only 真实平仓 / 断线补偿
→ 见任务 9.2 前 5 步（`scripts/propr-smoke.mjs`：readonly / far-order / fill / reconnect / grid，全绿）。

## 四、验收期间发现的契约事实（已回填 `docs/propr-api-contract.md`）

1. **价格带限制**：`13107 order_price_is_too_far_from_the_market_price`（2× 远价被拒、0.5× 可接受）
2. **批量开仓不可用**：多笔需顶层 `orderGroupId`（`13059`，须 ULID），带组后仍 `13066 only_one_entry_order_allowed_per_request` → 改为逐笔串行铺单
3. **`intentId` 必须 ULID 字符串**：纯数字（GridBot 的 `clientOrderId`）会被框架层 400 → 适配器自生成 ULID 并留档 `clientRef`
