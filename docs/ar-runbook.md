# AR 主网运维 Runbook

> 2026-11-06 限流事故后建立。每一条都对应一次真实事故，不是推测。
> 遇到不确定时：**先取证，再动手；绝不用「看着像真的」的账继续跑。**

> **第 0 条（2026-11-07 起，最高优先级）**
> **任何人（包括 operator、包括 code review、包括 AI）基于状态字段下的结论，
> 都必须先被一次单发实测复核过，才能写进报告、才能作为行动依据。**
>
> 这条不是流程洁癖。11-06 那 14 小时里，`state.exchangeOpenOrders=8` 让每一个
> 看过报告的判断都变成「8 张脱管挂单在跑」，而单发 `GET /v1/openOrders` 一秒就
> 证明交易所一张单都没有——**报告自己在制造事故**。
> 状态字段是缓存、是快照、是别人算完的结论；**只有单发请求是此刻的事实。**
> 判据：字段（尤其是带 cache/age/last 语义的）→ 单发核实 → 才能引用。

> **第 0 条之二（2026-11-13 起）：一个字段在它不适用的状态下，仍然输出一个看起来能用的值。**
>
> 这类字段比报错更危险，因为它连「我错了」都不会说。已收的四个样本：
> `balance ≠ cash`（把已占用保证金当可用）、`status='placing'` 僵尸（永远停在进行中）、
> `lastPrice=null`（停机时冻结成假价）、`perRungNet` 毛当净（`feeRate=0` 同时表示「免费」与「还没加载」）。
> 判据：**名字里带语义的字段（net/current/live/available）必须有一个测试证明它真的满足那个语义；
> 状态字段在「不适用」时必须输出 null + 理由，不许输出一个能参与计算的数。**

> **第 0 条之三（2026-11-13 起）：一个传感器只接了触发线，没接复位线。**
>
> 只增不减的计数器、只判不复位的判据、只记不幂等的入口 —— 它们会自己把自己焊死在报警态。
> 已收的四个样本：`_untrackedFills` 无清空路径、`haltReason` 无过期语义、
> `reconcile` 无凭据（抄账）、`deferredOpenings` 无计数（拦下的腿没人知道要补）。
> 判据：**任何「进入某状态」的路径，必须同时写出「离开该状态」的路径，并各有一条测试。**

> 这两条合起来是一句话：**一个只会朝里开的门，不是门。**

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

**`结构性缺格 = 0` 才是健康证据；`缺格` 字段本身会含边界残留，不能直接当故障数。**

2026-11-07 起按四类拆分（巡检 H 段第二行直接打印）：

| 类别 | 含义 | 进 Tier 0？ |
|---|---|---|
| 结构性 | 窗口内、不贴边、不在 skipBand，近期无窗口滚动 | **是** |
| 活段轮换 | 近期有窗口滚动/重铺，属重铺中间态 | 否 |
| 抖动 | 落在 skipBand（0.25 格）近价带，本来就不该挂 | 否 |
| 窗口外沿滞后 | 贴窗口内沿 0.5 格内；`seedOrders` 用 `> win` 排除，起铺那刻差 0.008 格就会空着 | 否 |

**实例（2026-11-07 19:00）**：31 档距现价 −4.0 格，被记为「窗口外沿滞后」。
两小时后它自己补上了（`openByLevel['31']='buy'`，`ladderGaps=0`）——**边界残留会随
1 格漂移自愈，不要为它 refill，也不要把它算进任何「缺格」统计。**

- **对账只清理/接管，从不重铺** → 补腿被拒 = **永久空洞**，只能靠 `/api/ar/refill` 人工补。
- 补格的安全边界（2026-11-07 加固）：`refillGrid` 会先算种子，**要铺的档数 >
  `inventoryHaltGrids`（AR 是 34）就直接拒绝**。原因是窗口可能没配（`activeWindowGrids`
  为 null → `win = Infinity`），66 档会一次全铺，这一单出去就是必熔断。
  （注：四个 `seedOrders` 调用点自 v1.6.49 `ea65980` 起**都已传 `windowGrids`**，
  review 里「refill 没传」的说法对当前代码不成立，用 `seedOrders` 数值可一眼证伪：
  传 4 → 7 单，不传 → 65 单。）
- 补腿失败的常见原因：价格偏离、`minOrderNotional`（BTC-USD 是 **$5**）、ALO 无法撮合。

---

## 7. 部分成交的跟踪（已修，待重启生效）

**2026-11-06 20:47:46 实测 bug**：0.0002 的买单先成交 0.00015103（正常），40ms 后再成交 0.00004897 → 此时 `_tracked` 已被第一笔删掉 → 打出「未跟踪订单的成交（可能来自网页手动下单）」并把 `health.status` 钉在 `error`。

修复在 `bc03c0f`：改为累计 `filledBase`，只有完全成交才移除跟踪。**重启后生效。**

**在那之前**，看到「未跟踪成交」先查 `posLedger.seenOrder`——如果 orderId 在里面，就是自己的部分成交，不是外部下单。

---

## 7.1 mismatch：限时收敛（2026-11-10 定稿，替代「强制拉取一次就判」）

### 判据为什么又改了一次

`25f2659` 的「先强制拉取再判」在 11-09 17:05 第一次实战就失效了：强制拉取那一拍，
REST `/v1/fills` 里那笔成交**还没出现**，于是重判仍然不一致 → 照样熔断。

四次形如「交易所与本地差一笔」的熔断（11-06 21:29 / 11-06 22:36 / 11-09 17:05 /
11-09 21:34）**全部在数秒内自行对齐，零次真错账** —— 假阳性率 100%。机制是数据源时序：
`position` 快照比 `fills` 事件早约 4–5 秒可见，单拍比对读到的必然是中间态。

结论：**用一个瞬间的差，去判定一个尚未完成的动作**，这个判据形状本身就是错的。

### 现在的行为

```
判定不一致（mismatch）
  → 进入 DEFENSIVE：禁新增开仓 / 不撤单 / 不动仓位（窗口内最多 90 秒）
  → 强制重拉 0s / 30s / 60s 共三次（pollFillsNow + getPositionFresh）
  → 90s 内任一拍对齐 → 回 RUNNING，留一条「已在 Ns 内自行对齐」告警
  → 90s 后仍不一致 → HALTED（fail-closed 不放松）
```

三条边界（缺一不可）：

1. **已在熔断时不开窗口**：HALTED 是粘滞的，任何自动逻辑都不许把它降级成 DEFENSIVE。
2. **适配器无法重拉时不开口子**：拿不到新数据就按原判据当场熔断。
3. **窗口期被拦下的开仓腿必须补**：`_place` 被 `blockOpening` 拦下时进 `_deferredOpenings`，
   风控一恢复立刻补铺（`_drainDeferredOpenings`）。不补就等于让那笔成交的对手腿
   永久消失 —— 那不是「少赚一格」，是一条没有出口的裸腿。

### 代价对照

窗口内 90 秒可能按旧库存多铺一格；相对的代价是 4–12 小时的完全停摆 + 裸仓无腿。
2026-11-09 那两次停摆（4h01m、12h26m）里，交易所一张单都没有，唯一在涨的是
未实现浮盈，而它无法被结算。

### 巡检怎么读熔断

`haltReason` 是一段**冻结的字符串**，它描述熔断那一瞬的事实，之后账本常常早已自己对齐。
把它当现值读，报告里就会出现「本地 0.0018」和实时「expected 0.0016」并排的矛盾
（2026-11-09 21:34 那次就是这样误导了一整天）。所以 `GET /api/ar/state` 现在同时给：

| 字段 | 含义 |
|---|---|
| `haltReasonAt` | 熔断发生的时刻（ISO） |
| `haltAgeMs` | 熔断持续了多久 |
| `haltLiveCheck` | **此刻重新算一遍**：`aligned` / `mismatch` / `unknown` / `stale` |
| `haltResolved` | `isHalted && haltLiveCheck === 'aligned'` —— 熔断原因已不成立 |

`haltResolved === true` 只说明「原因消失了」，**不自动解除**：解除仍然要走 `new-epoch`
（它还要校验两次持仓一致、交易所 0 挂单、无在铺批次）。

### 未跟踪成交（`_untrackedFills`）

成交到达但本地 `active` 里没有这张单（撤单竞态 / 重启丢单 / 非本机下单）→ 记一条，
最多保留 20 条，跨重启保留，并出现在 state 的 `untrackedFills` 里。
它**不是**重锚的硬前置：这类成交照样由 `applyFill` 记进账本，拦住恢复只会
让事故期多一道假闸门。此前这个数组全项目只有读、没有写，等于传感器从未接线。

### 预授权（章程）

6 轮档位若 `haltLiveCheck === aligned` **且** 交易所挂单为 0 **且** `retryQueue` 为空，
允许直接执行 `new-epoch`，不再等人工；报告首行必须写明 `prevExpected / exchangeBase / delta`。
理由：这是**可逆的重锚**（不改仓位、不改敞口政策、一次 API 调用），不是不可逆的开关。

---

## 7.2 停机期间的成交必须入账（2026-11-13，根因确认）

`_handleFill` 开头曾有一行 `if (!this.running) return;`。破界平仓是「**先停、后成交**」：
10:14:32 `stop()` 把 `running=false` 并落盘快照（`expected=0.0056`），10:14:33 成交事件才到。
那一行把成交整条吞掉 → 账本冻结 → 重启一致性检查读成「账本不一致」→ 恢复只剩 `new-epoch`。

**它是一个通用吞单口，不只是「平仓缺陷」**：任何停机/重启窗口内到达的成交都会消失。

修复（`f36e61b` / `28e4c8a` / `f4f7e66`）：

1. 停机分支改为 `_applyFillWhileStopped`：**只入账 + 留痕**（`lastStopFill`），不碰完成格 / 格利 / 补腿。
   未知 orderId 标 `whileStopped` 进 `_untrackedFills` —— 传感器不许被蒙住。
2. 回放保护：`_handleFill` 与 `_applyFillWhileStopped` 共用 `PositionLedger` 的 `fillKey`
   （`orderId + rawTs + side + size + price`，`seenOrder` 跨重启持久化）。重复只 `duplicateFills++`。
   **这条不是洁癖**：游标重启会重新对齐（实测落后 1247ms），回放一次平仓成交就能把
   `expected` 推成 −0.0056，制造一次「修好入账之后才出现」的假熔断。
3. `reconcile` 改成**有凭据的重锚**：`why` 白名单（`close-confirmed` / `manual-close` /
   `auto-reanchor`），且差额必须等于本次平仓量（容差 1e-8）。不吻合 → 拒绝 + BLOCKING，
   不许「改成一致就算了」—— 对账要求差额能被解释，抄账只要求差额消失。

### 11-10 那 17h17m 的「未识别成交」：根因**排除**这条早退

那次 `unknownFills>0` 的成因是**拆单**：一笔 0.0002 买单被交易所拆成
0.00013971 + 0.00006029 两块、同一个 orderId；第一块命中 `active` 后当场 `delete(id)`，
5 秒后第二块到达时查无此单 → 记进 `_untrackedFills`。当时 `running === true`，
**不经过停机分支**，所以与这行早退无关。

同理 11-09 那两次 mismatch（差一笔、4–5 秒后自行对齐）也不是它 —— 那是
`position` 快照比 `fills` 早约 4–5 秒可见（§7.1），且同样发生在运行态。

三族事故（`stale` / `mismatch` / `unknownFills`）的共同祖先因此**不是**同一行代码，
而是同一个形状：**传感器只接了触发线，没接复位线/去重线**（只增不减、只判不复位、只记不幂等）。
这条早退属于第四种同族形态：**在不适用的状态下仍然输出一个看起来能用的结果**。

### 事故库（三列：触发原因 / 修复提交 / 验证方式）

「根因排除」只说明它不是 A，不说明 B 已经修好；「已经修好」和「有人记得它修过」也是两件事。
所以每条事故必须能指出提交与验证方式，否则它迟早会以同一个形状回来。

| 事故 | 触发原因 | 修复提交 | 验证方式 |
|---|---|---|---|
| 11-06 21:29 / 22:36、11-09 17:05 / 21:34 假熔断 | `position` 快照比 `fills` 事件早 4–5s 可见，单拍比对读到中间态 | `25f2659` → 11-10 改为限时收敛（§7.1） | `test/mismatch-refetch.test.js` / `mismatch-converge.test.js`；四次实盘均数秒自愈、零真错账 |
| 11-10 18:42 停摆 17h17m（`unknownFills>0`） | 同 orderId 拆单：首块命中 `active` 后 `delete(id)`，次块成孤儿 | `6bab227`（11-12） | `test/partial-fill-continuation.test.js` 4 例：同单续成交不进未识别 / 真陌生 orderId 仍计入 / 台账上限 / 重锚清空 |
| 11-13 10:14 破界平仓后账本冻结 | 平仓「先 stop、4s 后成交」，`if (!running) return` 吞单 | `f36e61b` + `28e4c8a` + `f4f7e66`（11-13） | `test/close-fill-applies-to-ledger.test.js`（8 例，含 why 归一化、delta-mismatch 拒绝）/ `test/stopped-fill-dedupe.test.js`（3 例回放去重） |

---

## 8. 巡检报告怎么读

固定 A-I 模板，**ERROR / 429 / 401 计数自本次重启以来**（不是历史累计，否则旧异常会永久挂在眼前，训练你忽略这个字段）。

| 段 | 看什么 | 红线 |
|---|---|---|
| C | bbo mid 的 age（应 <2s）、`lastTrade` 与 mid 偏差 | age >10s 或偏差 >0.3% → 价格陈旧，勿用 |
| E | taker > 0（**分列网格/平仓**） | 网格腿出现 taker 说明挂单逻辑或费率假设破了；平仓腿/人工减仓本来就是 taker，别混算 |
| F | `haltReason` 非空 | 立刻取证，三份材料落地后才允许 `clearHaltSafe` |
| H | `结构性缺格`、`429`、`拒单` | 结构性缺格持续 >0，或 429 ≥1 次（**只在本次启动的日志段里数**） |

### D 段的恒等式与「借入」的符号（2026-11-07 校准）

`借入`（Arcus 的 `borrowedCapital`）是**带符号的仓位名义额**：**空头为正、多头为负**。
所以恒等式是：

```
balance = equity + 借入 − uPnL
```

实测核对（2026-11-07 19:03）：`119.84 = 150.20 + (−30.272) − 0.0941` ✓
即「多头时 |借入| ≈ 仓位名义额」，`|−30.272| = 0.0004 × 75,920 ≈ $30.37` ✓。

巡检里打印的 `equity = balance − 借入 + uPnL` 是同一个式子的移项，两者等价；
但**报告里解释时要按 `balance = equity + 借入 − uPnL` 说**，否则读者会把负号读反。

---

## 9. 绝对不做

- 不手工改 `.state.json`（要改先停机、先备份、先说明为什么）
- 不在 `outOfRange` / `recovery` 期间动挂单
- 不用「看着像真的」的账继续跑（EX 的 HTML-200 教训）
- 不在熔断后先清再看（必须先 dump 三份材料）
- 不为两行日志付一次重启 + 重锚的代价（攒到维护窗）
---

## 10. 工况自检：别把自己的仪表当成真相（2026-11-07）

11-06 那 14 小时熔断里，巡检每小时都报「8 张挂单脱管」，直到单发 `GET /v1/openOrders`
才看到真相：`{"orders":[],"total":0}`——**交易所一张单都没有**。
`state.exchangeOpenOrders=8` 是熔断那一刻冻结的缓存字段（对账停摆就再没人更新它）。
同一份报告里还有两个同族错误：`pgrep -f` 把自己的 wrapper 当成 node（于是`ppid=1`
看起来像"崩溃后无人拉起"，其实进程树完好）；日志行只有 `HH:MM:SS` 不带日期，脚本把
"昨天 23:59" 算成"今天 23:59"这个未来时刻，于是「最近 10 分钟有 429」永远成立。

**四条纪律：**

1. **缓存字段必须带 age 才允许展示**。`exchangeOpenOrders` 现在配套
   `exchangeOpenOrdersAgeMs`，>2 分钟就不要再当交易所事实读。
2. **`pgrep -f <串>` 会命中自己的命令行**。查进程一律读 `/proc/<pid>/cmdline` 做精确匹配；
   判据是 `node.ppid == supervisor.pid`，不是"两个字段都非空"。同理，远程 `kill` 时
   不要用会匹配自身命令串的 `pgrep`（11-07 就因此把自己的 ssh 会话杀了）。
3. **限流/异常的匹配用行级精确匹配**：`(?<!\d)429(?!\d)`，不要 `"429" in line`
   （`1404`、`14295` 全会命中）。
4. **无日期的日志行要归一到"不晚于现在的最近一次"**（`if t > now: t -= 1 day`），
   否则未来时刻永远落在窗口内。

---

## 11. 告警分级（2026-11-07 起生效）

- **同一个「需决策」连续 3 轮未解决 → 报告首行打 `⛔ BLOCKING(n轮)`**，禁止再写"同前"。
- **连续 6 轮未解决 → 执行预授权兜底**：`stop {closePosition:false}` → 停进程让 DMS 清场
  → 停手等人工。理由：该动作**不改变敞口、可逆、成本有界**；停摆不赚钱，但脱管挂单会亏钱。
- **`local openOrders != exchange openOrders` 持续 >30 分钟 → 直接升级为 BLOCKING**。
  读这个比较时必须先看 `exchangeOpenOrdersAgeMs`：缓存超过 2 分钟就该单发核实，而不是报警。

### 11.1 「连续 N 轮」计数器的通用戒律（2026-11-09 立）

**任何「连续 N 轮」的计数器，都必须绑定一把与被测对象**不同量级**的尺子。**

2026-11-09 05:45 的假熔断就是反面教材：`stale` 判据 `positionsFetchedAt < lastFillAt`
连续 12 轮（5s/轮 ≈ 60s）→ HALTED。但 fills 与 positions 是两条 **同为 ~5s 的独立轮询**，
谁先谁后随机；成交密集时 `lastFillAt` 每几秒被刷新一次，于是「缓存落后最后成交」可以
连续成立几十秒，**真实滞后只有 1.8s**。12 轮 × 5s 和两条 5s 轮询同量级，尺子与被测对象
一样粗，测出来的只是相位，不是故障——方向还正好相反（平静期不触发、剧烈期必触发）。

落地：`stale` 自 2026-11-09 起**只降级 DEFENSIVE + 禁开仓，永不熔断**（轮数仅进
`metrics.consistencyStaleStreak` 供观测）。缓存真卡死由 mismatch 的强制重拉
（`getPositionFresh` + `pollFillsNow`）复核后熔断，读不出仓位则落 `unknown`（2 轮熔断）。
回归用例：`test/consistency-stale.test.js`「stale 连续 12 轮也不熔断」。

### 11.2 G 段怎么读：`最近续期` 是相位，不是延迟

`dmsRenewAgeMs` = **距上次续期过去了多久**。节拍 20s，所以它天然在 0–20000ms 锯齿内摆动，
**不是「续期花了多久」**。健康判据只看两条：`triggers24h == 0` 且 `deadline 剩余` 满额
（约 270–290s）。别把锯齿相位读成「爬升/回落」（2026-11-07 04:00–07:00 我连错三轮；
2026-11-13 的 review 又把 4,431→10,950→16,232ms 读成「续期耗时涨了 3.7 倍」——
那是相位，不是延迟）。
真正的耗时自 `28e4c8a` 起由 bot 计时：`dmsRenewMs`（最近一次）/ `dmsRenewMsSamples`（24h）；
巡检打印 p50/p95/max，p95 > 60s 预警。**单点值不足以判断趋势。**

### 11.3 重启后先看 `reconcile.timerActive`，再说别的

**2026-11-09 10:20 定稿的结论（推翻本文档上一版的猜测）**：重启后对账停摆，
不是 `fetchOpenOrders` 失败被静默 `catch` 掉，而是**定时器压根没启动**。
证据是启动日志第 10834 行：

```
09:19:15 ⛔ 启动被风控拦截：已有熔断记录：仓位缓存连续 12 轮落后于成交…
```

`_start()` 里这道闸门（`if (blocked) { alert; _changed(); return; }`）位置在
`_placeMany()` / `_finishPlacementPass()` / `_startReconcileTimer()` **之前**，
于是「熔断记录没清就重启」会一次性留下三具尸体：

1. 对账定时器不启动 → `exchangeOpenOrdersVerifiedAt` 冻在秒级，`ageMs` 单调涨；
2. 风控心跳不启动（`_startReconcileTimer()` 顺带启动它）→ 风控只在成交事件里跑；
3. `_beginPlacementProgress('start', seeds)` 已经写过，`_finishPlacementPass()` 永不执行
   → `placementProgress.status` 永久 `placing`，把回收前置检查（bot.js 1709，
   要求 `status === 'complete'`）永久堵死。

10:20 起代码已修：闸门早退会清掉这批 progress 并 `_startReconcileTimer()`；
`beginNewRiskEpoch()` 也会补一次 `_startReconcileTimer()`（幂等），避免「解了熔断但心跳没亮」。

**验收三条（现在可以直接读，不用猜）**：

1. `state.reconcile.timerActive === true`；
2. `state.reconcile.skipReason === null` 且 `ageMs < 40s`（两次读数之间应 reset）；
3. `state.placementProgress === null` 或 `status === 'complete'`。

`skipReason` 的取值就是那六个早退出口：`not-running` / `halted` / `adapter-unsupported` /
`no-grid` / `fetch-failed: …` / `bad-snapshot`。看到 `halted` 且熔断其实已解除，
说明 `guardState` 与熔断记录不同步；看到 `fetch-failed` 才轮到查限流/网络。

### 11.4 架构级规则：监护先于意图（2026-11-09 11:40 评审定稿）

> **资源获取（定时器、心跳、事件监听）必须发生在任何「决定要不要交易」的闸门之前。
> 闸门只决定「铺不铺单」，永不决定「进程是否在监护」。**

在闸门里补一次 `_startReconcileTimer()` 是**分支级**修复：它在已知的那条闸门上正确，
在下一条还没人写的闸门上无效。所以这一条现在由**代码顺序**保证，而不是由注释保证：

```js
this.running = true;
this._startReconcileTimer();   // 监护先起
this._startDynTimer();
this._runRiskCycle('start');
const blocked = this._startBlockedReason();   // 意图后判
```

两道守卫（`test/start-gate-structure.test.js`）：

1. **枚举**：`_startBlockedReason()` 的 8 种理由逐条跑一遍 `start()`，断言每种早退都
   `_reconTimer && _riskTimer`、`active.size === 0`、`placementProgress === null`；
2. **结构**：读源码断言 `_start()` 里 `_startReconcileTimer()` 的下标必须小于
   `_startBlockedReason()` 的下标——新加闸门时这条会先红。

**停止侧同样不许借道**：`_stopReconcileTimer()` 只停对账；风控心跳只在
`_pauseTradingRuntime()`（停机/暂停，此时确实没有数据源）与进程退出时停。
任何「只想暂停对账」的路径都不该静默掐掉监护。

### 11.4.1 仪表报警：判活看**导数**，不看**年龄**

`reconcile = {timerActive, lastOkAt, ageMs, skipReason, runs, fails}` 里，
`ageMs` 是**年龄**（正常运行下也会周期性涨到 30s），HALTED 期间它**必然**单调涨
（`reconcileOpenOrders()` 设计上就在熔断期早退）。所以：

- ❌ `ageMs > 90s → BLOCKING`：每次熔断都误报，包括我们自己制造的那些。
- ✅ **`skipReason !== 'halted'` 且 `Δruns(5min) < 8` → BLOCKING**（30s 一轮 ≈ 10 轮，留 20% 余量）。

`runs` 是计数，计数不动就是死了，没有阈值可以糊弄。巡检每轮必须打印
`reconcile={runs,ageMs,skipReason,timerActive}` **和** `placementProgress={status,pending,ageMs}`——
一具僵尸摆在库里不显示，就等于没有这件事。

### 11.4.2 幂等成功必须带现场量

`POST /api/ar/start` 在「已在运行」时回 200，但返回体必须同时带
`openOrders` 与 `startBlockedReason`：否则「已经好好的」和「在跑但一张单都没有」
长得一模一样——**「空转被报成成功」是「成功被报成失败」的镜像病**。

同理，`_startBlocked`（上一轮为什么没铺单）已进 state 快照，重启后仍可见。
总纲：**该活的字段别持久化成化石（`placementProgress` 停在 `placing`、
`exchangeOpenOrders` 冻 14 小时）；该记的事实别只活在内存里（`_startBlocked` 重启即失）。
存错的会骗人，不存的会失忆。**

### 11.4.3 `placementProgress` 僵尸的处置触发线

`placementProgress.status !== 'complete'` 会挡住 `_canEnterRecovery()`（bot.js 1709）。
纯记账僵尸不影响交易（`gaps=0`、local == exchange），但会在需要走回收时咬人。触发线：

> **AR 价格跌破 73,500 而 `placementProgress` 仍非 `complete` → 回收路径被僵尸挡住，当场处置。**

处置顺序：① 部署新版本后重启（重启会按 `active` 重建、自动清掉）；② 实在不能重启则
`stop{closePosition:false}` + 停进程 + 重启。**绝不要手改 state 文件**——那是从可恢复
走向不可恢复的路。

### 11.3.1 历史教训（保留）：`/reconnect` 是唯一「不撤单不平仓」的抢修口

2026-11-09 09:19 维护窗实测：`ALLOW_STATE=1` 重启后进程正常（行情/W S/死手全绿、
8 张种子单真的挂上了、成交也在处理），但**对账循环静默失效**——
`exchangeOpenOrdersVerifiedAt` 与 `placementProgress.updatedAt` 双双冻在启动那一秒，
`exchangeOpenOrders` 恒为 0、`placementProgress.status` 永远 `placing`。
抢修手段仍然是 `POST /api/ar/reconnect`：它调用一次 `reconcileOpenOrders()` 并重建客户端，
实测把 `exchangeOpenOrdersAgeMs` 从 375,000ms 拉回 1ms、`local 7 == exchange 7`。
注意它**只修一次**——如果定时器没起（见 11.3），一分钟后 age 会继续涨。
所以「reconnect 有效」不等于「修好了」，必须回到 `reconcile.timerActive` 判断。

---

## 12. 已知的观测债（下一维护窗处理）

**2026-11-09 11:40 评审排定的下一窗顺序**（都是小改动，不用停、不用改参数）：

| 序 | 项 | 为什么排这个位置 |
|---|---|---|
| 1 | `runs` 导数告警规则 + `skipReason !== 'halted'` 例外 | 仪表装了但报警规则会误报，等于没装（§11.4.1 已写规则，巡检脚本待接） |
| 2 | `start` 200 补 `openOrders` / `startBlockedReason` | 两行，堵「空转被报成成功」（代码已改，随窗口部署） |
| 3 | `_stopReconcileTimer` 停止侧解耦 | 对称性，防将来（代码已改+用例） |
| 4 | `_startBlocked` 进 state 快照 | 该记的事实（代码已改+用例） |
| 5 | 部署 `6300697`（顺带清僵尸） | 已推未部署 |
| 6 | `grid_idle_since` / `exchangeHealth` / `opening` 错标 / 补腿冲突 30·33 | 观测与遗留 |


日志已经被 `logrotate copytruncate` 写坏过：多个历史进程的 fd 各自在旧 offset 上继续写，
文件里**时间不单调**（第 5999 行是 18:29，第 9699 行反而是 14:02 的 banner）。
后果是任何「扫全文件 + 按 HH:MM:SS 比时间」的统计都会把历史行当成刚刚——
2026-11-07 巡检因此误报过一次「最近 10 分钟有 429」，把 C/D 段打空。

**两条根治方向（都记在账上，按窗口做）：**

1. **别再从日志里数**：在 `state.exchangeHealth` 暴露结构化计数器
   `rateLimitedCount` / `lastRateLimitAt` / `fillPollFailures` / `placeFailsSinceBoot`。
   巡检只读这些字段，**日志仅用于事后取证，永不用于计数**。
2. **一次启动一个文件**（改 supervisor，不改应用代码）：

   ```bash
   BOOT=$(date +%Y%m%d-%H%M%S); LOG=~/logs/gridbot-$BOOT.log
   ln -sfn "$LOG" ~/logs/gridbot-latest.log
   exec node src/server.js >> "$LOG" 2>&1
   ```

   这样「本次重启后的日志段」= **整个文件**，不用再跟时间戳搏斗；logrotate 只需按天删旧文件。

**在那之前**，巡检的限流判定只在 `banner` 之后的那段日志里找（已改），
且 `429` 的正则必须包含真实措辞 `rate limited`（原正则 `429 (Too Many|rate limit)`
匹配不到它，`429=0` 曾经一直是「测不到」而不是「没有」）。
