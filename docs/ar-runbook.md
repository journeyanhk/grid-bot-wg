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
（约 270–290s）。别把锯齿相位读成「爬升/回落」（2026-11-07 04:00–07:00 我连错三轮）。

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
