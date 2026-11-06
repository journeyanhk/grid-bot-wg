# AR 主网运维 Runbook

> 2026-11-06 限流事故后建立。每一条都对应一次真实事故，不是推测。
> 遇到不确定时：**先取证，再动手；绝不用「看着像真的」的账继续跑。**

---

## 1. 重启（最常走的路径）

**第一行先看这个**：启动脚本检测到 `.state.json` 会拒绝启动，并打印摘要：

```
state: namespaces={ai,ar}  ar.startBalance=150.004038607  ar.ledger.startBase=-0.0008  ar.ledger.expected=-0.0006  ar.running=True  mtime=2026-11-06T12:48:02Z
拒绝启动：疑似别的网络快照。确认无误请用 ALLOW_STATE=1 重跑。
```

看到三行数字后**两秒钟判断**：

- `namespaces={ai,ar}`、`ar.startBalance` 与你记忆中的基线一致 → 这是**自己的账本**，用 `ALLOW_STATE=1` 重跑。
- 命名空间不认识、或 `startBalance` 是别的数字 → **停下**，先搞清楚这个文件从哪来。

```bash
cd ~ && ALLOW_STATE=1 setsid nohup bash ~/run_grid_mainnet.sh >> ~/supervisor.log 2>&1 < /dev/null &
```

**不要归档 `.state.json`**——里面存着 `startBalance` 和 `positionLedger`，归档等于丢基线，下次开局会用当时的 equity 重算，盈亏口径断掉。

**重启后必须核对三件事**（进程活着不等于账对上了）：

1. `startBalance` 是否仍是原值
2. `position.sizeBase` 与 `posLedger.expected` 是否一致（不一致 → 见第 3 节）
3. `ladderGaps` 是否为 0

---

## 2. `new-epoch` / `clear-halt` 返回 400

**这两个端点会「操作成功、返回失败」。** 原因：日志行引用了未定义的 `key` 变量（`server.js` L396 / L409），抛 `ReferenceError` 被 catch 成 400，而 `bot.clearHaltSafe` / `bot.beginNewRiskEpoch` 早已执行完毕。

代码已在 `9a8d396` 修复，但**修复要重启才生效**。

### 遇到 400 时的正确动作

```bash
# 1. 不许重试，不许手工改 .state.json
# 2. 先看状态是否已经是目标值
curl -s http://127.0.0.1:8098/api/ar/state | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('guardState:', d.get('guardState'))
print('guardReason:', d.get('guardReason'))
print('posLedger.expected:', (d.get('positionLedger') or {}).get('expected'))
print('position.sizeBase:', (d.get('position') or {}).get('sizeBase'))
"
```

- `guardState=RUNNING` 且账本已是目标值 → **操作已生效**，400 是日志行的 bug，忽略。
- 状态没变 → 才考虑是真的失败，且**先查日志找真实原因**，不要盲目重试。

> **为什么这条比修代码更急**：一次成功的危险操作被报告成失败，会教会操作员两件事——不信任 API 返回，以及必要时绕过 API 手工改状态。后者是唯一能把「可恢复的事故」变成「不可恢复的事故」的路。

---

## 3. 账本不一致 / 熔断（HALTED）

**熔断是粘滞的**：`reconcile` 追平后 guard 不会自动解除，必须走 `new-epoch` 人工重置。

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"confirm":true,"reason":"<必填：为什么要重锚>","by":"operator"}' \
  http://127.0.0.1:8098/api/ar/new-epoch
```

**前置检查**（`beginNewRiskEpoch` 内部，全过才执行）：

- 必须已停机（`running=false`）
- 必须没有活跃挂单（`active.size === 0`）
- 其余四项见代码

所以**顺序永远是**：`stop` → 等 DMS → 确认 `openOrders` 空 → `new-epoch` → `start`。

**不要在有挂单时重试 `new-epoch`**——会被第一道检查挡掉（`active.size > 0`）。

### 3.1 先分辨「抢跑」还是「真错账」（Δ 恰好一格时必做）

2026-11-06 21:29 的事故形态：WS 重连后交易所先推来一份**新鲜仓位快照**（−0.0002），
而 REST 的 fills 轮询还没把 2 秒前那笔 0.0002 的卖单送到 —— `positionsFetchedAt`
刚更新，stale 守卫判定"不 stale"，于是一路走到"账本不一致"直接熔断。
**2 秒后成交到达，`expected` 自己就对齐了。**

判据：**Δ 恰好等于一格（`sizeBase`，本例 0.0002）时，先等 60 秒再判断。**

```bash
# 1) 等 60 秒（不要立刻停进程、不要立刻 new-epoch）
sleep 60
# 2) 单发查两边（间隔 2s，避免叠加限流）
curl -s "https://api.arcus.xyz/v1/positions?address=$AR_ACCOUNT_ADDRESS&accountIndex=$AR_ACCOUNT_INDEX" | jq '.positions["1"] | {side,size}'
curl -s http://127.0.0.1:8098/api/ar/state | jq '{pos:.position.sizeBase, guard:.guardState}'
# 3) 读磁盘账本（API 不暴露这个字段）
jq '.ar.positionLedger | {startBase,expected,resetCount}' ~/repos/gridbot/.state.json
```

- **已对齐**（`expected == 交易所 size`）→ 抢跑，属"已自愈"。仍要 `new-epoch` 解除
  粘滞熔断，但**不必走停机 + 等 DMS**：先 `stop`（挂单会被撤，本来也是空的）→
  `new-epoch` → `start`，全程 2 分钟。
- **仍不一致** → 真错账，走完整的 `stop` → 等 DMS → 取证三份 → `new-epoch` 流程。

**为什么不能靠"连续 N 轮"解决**：那是又一层计时器。真正该用的是"两本账不一致"
这个事实本身 —— 明早的修复形态是「一旦观测到 mismatch，先强制拉一次 fills +
一次新鲜仓位，重跑一轮；强制拉取后仍不一致才熔断」（见第 7 节末尾）。

---

## 4. DMS（死手开关）：只撤单，不平仓

**2026-11-06 两次单发取证确认**：

```
停止进程 → 等 6 分钟（deadline 280s + 余量）
GET /v1/openOrders  → {"orders":[],"total":0}        # 撤干净
GET /v1/positions   → SHORT -0.0008  avgEntry=76026.5 # 仓位原样保留
```

**这是唯一不依赖读盘就能保证清场的手段。** 当交易所接口不可用、拿不到挂单快照时，DMS 是最后的保证。

- 停进程后 **必须等满 6 分钟** 再确认，不要 2 分钟就下结论。
- DMS 触发有配额：**每日最多 10 次**（`DMS_TRIGGER_QUOTA`），别当常规手段用。

---

## 5. 限流（429）

**2026-11-06 事故**：`FILL_POLL_MS=1000` × weight 20 = **1200 权重/分钟**，超过 AR 的 IP 级额度，持续 1 小时 429，导致成交确认漏记、本地账本 −0.0006 vs 交易所 −0.0008、假熔断。

### 当前预算（改后）

| 端点 | weight | 间隔 | 每分钟权重 |
|---|---|---|---|
| `/v1/fills` | 20 | 3000ms | **400** |
| `/v1/account` + `/v1/positions` | 2+2 | 5000ms | 48 |
| `/v1/openOrders` | 20 | 30000ms（对账） | 40 |
| `/v1/bbo`（WS 掉线兜底） | 2 | 2000ms | 60（仅掉线时） |
| `/v1/markets` | 20 | 5min | 4 |
| **稳态合计** | | | **≈ 490/min**（改前 1312）|

### 三条规则

1. **总预算留 30% 余量。**
2. **巡检与取证永远给交易让路**——冲突时它们退让。
3. **任何脚本进入循环重试前先问一句**：「我是不是在跟封禁搏斗？」AR 不返回 `Retry-After` / `X-RateLimit-*`，额度只能靠「零 429」反推。

### 升级规则（不再讨论）

重开后 **24 小时内再出现一次持续 >2 分钟的 429** → `FILL_POLL_MS` 直接降到 **5000**（240/min）。

### 巡检自限（已实现）

`~/arcus_inspect.py` 在每次运行开始时检查最近 10 分钟的日志：

- 有 429 → 置 `THROTTLED=True`，**跳过所有交易所读取**，只报本地字段，并打印「限流观察中」。
- 巡检永远不会成为把额度吃干的那个人。

---

## 6. 缺格（ladderGaps）

**`缺格 = 0` 是唯一的机械健康证据，每轮必看。**

- **对账只清理/接管，从不重铺** → 补腿被拒 = **永久空洞**，只能靠 `/api/ar/refill` 人工补。
- 零散缺口（1–2 格）需人工补；连续 4 轮大面积缺格才自动重铺。
- 补腿失败的常见原因：价格偏离、`minOrderNotional`（BTC-USD 是 **$5**）、ALO 无法撮合。

---

## 7. 部分成交的跟踪（已修，待重启生效）

**2026-11-06 20:47:46 实测 bug**：0.0002 的买单先成交 0.00015103（正常），40ms 后再成交 0.00004897 → 此时 `_tracked` 已被第一笔删掉 → 打出「未跟踪订单的成交（可能来自网页手动下单）」并把 `health.status` 钉在 `error`。

修复在 `bc03c0f`：改为累计 `filledBase`，只有完全成交才移除跟踪。**重启后生效。**

**在那之前**，看到「未跟踪成交」先查 `posLedger.seenOrder`——如果 orderId 在里面，就是自己的部分成交，不是外部下单。

---

## 7.1 明早待交付：mismatch 强制拉取（不要今天写）

```js
// 风控周期内，判定 mismatch 之前：
if (mismatch && !this._mismatchRefetched) {
  this._mismatchRefetched = true;
  await this.ex.pollFillsNow?.();        // 强制拉一次（复用游标，不额外花权重）
  await this.ex.getPositionFresh?.(mid); // 再读一次仓位
  return this._runRiskCycle('mismatch-refetch');  // 用新数据重跑一轮
}
if (mismatch) → HALT
```

三条约束：① 每次 mismatch 只强制拉一次（防风暴）；② 用游标增量拉，不重复花权重；
③ 强制拉取后仍不一致 = 真不一致，照样熔断，fail-closed 不放松。

**为什么不在当天改**：它动的是"什么时候熔断"这条线，2026-11-06 这条线已经付了
三次学费（stale 分支、openOrders 重试、null+1），日终不改安全路径。

---

## 8. 巡检报告怎么读

固定 A-I 模板，**ERROR / 429 / 401 计数自本次重启以来**（不是历史累计，否则旧异常会永久挂在眼前，训练你忽略这个字段）。

| 段 | 看什么 | 红线 |
|---|---|---|
| C | bbo mid 的 age（应 <2s）、`lastTrade` 与 mid 偏差 | age >10s 或偏差 >0.3% → 价格陈旧，勿用 |
| E | taker > 0 | AR 是 ALO 策略，出现 taker 说明挂单逻辑或费率假设破了 |
| F | `haltReason` 非空 | 立刻取证，三份材料落地后才允许 `clearHaltSafe` |
| H | `缺格`、`429`、`拒单` | 缺格持续 >0 或 429 ≥1 次 |

---

## 9. 绝对不做

- 不手工改 `.state.json`（要改先停机、先备份、先说明为什么）
- 不在 `outOfRange` / `recovery` 期间动挂单
- 不用「看着像真的」的账继续跑（EX 的 HTML-200 教训）
- 不在熔断后先清再看（必须先 dump 三份材料）
- 不为两行日志付一次重启 + 重锚的代价（攒到维护窗）