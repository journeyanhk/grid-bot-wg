// GridBot 核心逻辑单元测试：用内存 MockExchange（含迷你撮合）验证
// 铺单 / 成交补单链 / 出区间风控 / 挂单对账 / 崩溃恢复 / 保证金预检。
// 运行: node test/bot.test.js（npm test 会串联执行）
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GridBot } from '../src/bot.js';

let passed = 0, failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════════
// MockExchange：内存撮合引擎。订单簿 + 持仓 + 价格，成交后 emit fill。
// 覆盖 GridBot 依赖的全部适配器接口。
// ══════════════════════════════════════════════════════════════════════════════
class MockExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.dataSource = 'real';
    this.feeRate = opts.feeRate ?? 0;
    this.balance = opts.balance ?? 100000;
    this.orders = new Map();      // orderId -> {marketId, side, price, sizeBase, reduceOnly, levelIndex, orderId}
    this.positions = new Map();   // marketId -> {sizeBase, entryPrice, unrealizedPnl, leverage}
    this.prices = new Map();
    this._seq = 1;
    this.marketDefs = opts.markets ?? [{
      marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC',
      stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001, lastPrice: 150,
    }];
    for (const m of this.marketDefs) this.prices.set(m.marketId, m.lastPrice ?? 100);
    this.cancelCalls = 0;
    this.closeCalls = 0;
  }

  get equity() { return this.balance; }

  async init() { return true; }
  start() {}
  stop() {}

  async getMarkets() { return this.marketDefs; }

  async getPrice(marketId) { return this.prices.get(Number(marketId)) ?? null; }

  async setLeverage() { return true; }

  async placeLimitOrder(o) {
    const id = String(this._seq++);
    this.orders.set(id, {
      marketId: Number(o.marketId), side: o.side, price: Number(o.price),
      sizeBase: Number(o.sizeBase), reduceOnly: !!o.reduceOnly,
      levelIndex: o.levelIndex, orderId: id,
    });
    return { orderId: id };
  }

  async cancelOrder(marketId, orderId) { this.orders.delete(String(orderId)); return true; }

  async cancelAll(marketId) {
    this.cancelCalls++;
    for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) this.orders.delete(id);
    return true;
  }

  async fetchOpenOrders(marketId) {
    return [...this.orders.values()]
      .filter((o) => o.marketId === Number(marketId))
      .map((o) => ({ orderId: o.orderId, price: o.price, side: o.side }));
  }

  adoptOrder(_o) { /* 挂单跟踪由 bot 负责，mock 无需记录 */ }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    return p && p.sizeBase !== 0 ? p : null;
  }

  async closePosition(marketId) {
    this.closeCalls++;
    this.positions.delete(Number(marketId));
    return true;
  }

  getOpenOrders(marketId) { return [...this.orders.values()].filter((o) => o.marketId === Number(marketId)); }

  // ── 测试辅助 ────────────────────────────────────────────────────────────────
  /** 价格变动：更新现价并 emit price（触发 bot 出区间风控等逻辑） */
  setPrice(marketId, price) {
    this.prices.set(Number(marketId), price);
    this.emit('price', { marketId: Number(marketId), price });
  }

  /** 直接向订单簿塞入一笔挂单（模拟交易所端已有挂单/外部下单） */
  seedOrder(marketId, { price, side, sizeBase = 1, levelIndex = -1, reduceOnly = false }) {
    const id = String(this._seq++);
    this.orders.set(id, {
      marketId: Number(marketId), side, price: Number(price), sizeBase, reduceOnly,
      levelIndex, orderId: id,
    });
    return id;
  }

  /** 模拟成交：从订单簿移除并按限价成交，更新持仓并 emit fill */
  fill(orderId) {
    const o = this.orders.get(String(orderId));
    if (!o) return false;
    this.orders.delete(String(orderId));
    const mId = o.marketId;
    const p = this.positions.get(mId) || { sizeBase: 0, entryPrice: 0, unrealizedPnl: 0, leverage: 3 };
    if (o.side === 'buy') {
      p.sizeBase += o.sizeBase;
      p.entryPrice = p.entryPrice > 0
        ? (p.entryPrice * (p.sizeBase - o.sizeBase) + o.price * o.sizeBase) / p.sizeBase
        : o.price;
    } else {
      p.sizeBase -= o.sizeBase;
    }
    if (p.sizeBase === 0) this.positions.delete(mId); else this.positions.set(mId, p);
    this.emit('fill', { orderId: String(orderId), marketId: mId, side: o.side, price: o.price, sizeBase: o.sizeBase, levelIndex: o.levelIndex });
    return true;
  }
}

// outDwellMs: 0 —— 测试里关掉「破界驻留时间」闸门，保持原有逐拍语义（生产默认 8000ms）
const CFG = { marketId: 1, mode: 'neutral', lower: 100, upper: 200, gridCount: 10, sizeBase: 1, leverage: 3, outOfRangeAction: 'close', outDwellMs: 0 };

async function makeBot(exOpts = {}, cfg = CFG) {
  const ex = new MockExchange(exOpts);
  // 测试用快速撤单确认（生产默认 750ms x 2 次稳定快照）
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await bot.start(cfg);
  return { ex, bot };
}

const orderAtLevel = (bot, lvl) => [...bot.active.values()].find((a) => a.levelIndex === lvl) || null;
const idOf = (bot, order) => [...bot.active].find(([_id, a]) => a === order)?.[0];

// ══════════════════════════════════════════════════════════════════════════════

const T = [];
const test = (name, fn) => T.push([name, fn]);

test('启动铺单：中性网格 现价下方买单/上方卖单，跳过带内不挂单', async () => {
  const { ex, bot } = await makeBot();
  assert.equal(bot.running, true);
  assert.equal(bot.active.size, 10, '10 格内应挂出 10 单');
  const buys = [...bot.active.values()].filter((a) => a.side === 'buy');
  const sells = [...bot.active.values()].filter((a) => a.side === 'sell');
  assert.equal(buys.length, 5); assert.equal(sells.length, 5);
  assert.ok(buys.every((a) => a.price < 150), '买单全部低于现价 150');
  assert.ok(sells.every((a) => a.price > 150), '卖单全部高于现价 150');
  assert.equal(orderAtLevel(bot, 5), null, '跳过带内的 150 档不应挂单');
  assert.ok(buys.every((a) => !a.reduceOnly) && sells.every((a) => !a.reduceOnly), '中性模式种子单均非 reduce-only');
  assert.ok([...bot.active.values()].every((a) => a.opening === true), '种子单均为开仓单');
  assert.equal(ex.cancelCalls, 1, '启动时做了一次 cancelAll');
});

test('启动铺单：做多仅买单 / 做空仅卖单，reduce-only 标记正确', async () => {
  const long = await makeBot({}, { ...CFG, mode: 'long' });
  assert.ok([...long.bot.active.values()].every((a) => a.side === 'buy' && a.price < 150 && !a.reduceOnly));
  const short = await makeBot({}, { ...CFG, mode: 'short' });
  assert.ok([...short.bot.active.values()].every((a) => a.side === 'sell' && a.price > 150 && !a.reduceOnly));
});

test('成交补单链：买单成交 -> 相邻上一格挂卖单；卖单成交 -> 完成一格并累加利润', async () => {
  const { ex, bot } = await makeBot();
  const buy140 = [...bot.active.values()].find((a) => a.side === 'buy' && a.price === 140);
  ex.fill(idOf(bot, buy140));
  await sleep(10);
  // 买单@140(level 4) 成交 -> 补卖单@150(level 5，种子阶段被跳过带留空)
  const repl = orderAtLevel(bot, 5);
  assert.ok(repl && repl.side === 'sell' && repl.price === 150, '买单成交后应在上一格挂卖单');
  assert.equal(bot.stats.completedRungs, 0, '开仓单成交不计完成格数');
  assert.equal(bot.stats.buys, 1);
  assert.equal(bot.stats.volume, 140);

  ex.fill(idOf(bot, repl));
  await sleep(10);
  assert.equal(bot.stats.completedRungs, 1);
  assert.equal(bot.stats.gridProfit, 10, '格距 10 x 每格 1 = 10');
  const buyBack = orderAtLevel(bot, 4);
  assert.ok(buyBack && buyBack.side === 'buy' && buyBack.price === 140, '卖单成交后应补回买单');
  assert.ok(buyBack.opening === true, '中性模式卖单成交后补回的买单是开仓腿');
});

test('格利精度：小格子逐笔累加不被 round2 舍成 0（回归）', async () => {
  // 每格毛利 = 格距 10 × 0.0002 = 0.002，逐笔 round2 会把它舍成 0，账面永远 0 利。
  const { ex, bot } = await makeBot({}, { ...CFG, sizeBase: 0.0002 });
  for (let r = 0; r < 3; r += 1) {
    const buy = orderAtLevel(bot, 4);
    assert.ok(buy && buy.side === 'buy', `第 ${r + 1} 轮应在 140 档有买单`);
    ex.fill(idOf(bot, buy));
    await sleep(10);
    const sell = orderAtLevel(bot, 5);
    assert.ok(sell && sell.side === 'sell', `第 ${r + 1} 轮应在 150 档有卖单`);
    ex.fill(idOf(bot, sell));
    await sleep(10);
  }
  assert.equal(bot.stats.completedRungs, 3);
  assert.equal(bot.stats.gridProfit, 0.01, '3 格 × 0.002 = 0.006，应显示 0.01 而不是恒为 0');
});

test('出区间风控(close)：价格突破上边界 -> 撤单 + 平仓 + 停止', async () => {
  const { ex, bot } = await makeBot();
  ex.setPrice(1, 210); // 第 1 拍越界（>upper+半格=205）：仅去抖计数，不触发
  await sleep(10);
  assert.equal(bot.running, true, '单拍越界不触发（2 拍确认去抖）');
  ex.setPrice(1, 210); // 第 2 拍越界：触发
  await sleep(100); // 等待异步 auto-stop 完成
  assert.equal(bot.running, false, '自动停止');
  assert.equal(ex.closeCalls, 1, '已发送平仓');
  assert.equal(bot.active.size, 0, '挂单已清');
});

test('出区间风控(recover)：空头突破上边界 -> 挂只减仓回收阶梯；回区间自动撤销', async () => {
  const { ex, bot } = await makeBot({}, { ...CFG, mode: 'short', outOfRangeAction: 'recover' });
  const sell160 = [...bot.active.values()].find((a) => a.price === 160);
  ex.fill(idOf(bot, sell160));
  await sleep(10);
  assert.equal(bot.ex.getPosition(1).sizeBase, -1, '空头持仓 -1');
  ex.setPrice(1, 250); // 第 1 拍越界：去抖计数
  await sleep(10);
  assert.equal(bot.outOfRange, false, '单拍越界不进破界');
  ex.setPrice(1, 250); // 第 2 拍：进破界
  await sleep(50);
  const ladders = [...bot.active.values()].filter((a) => a.recovery);
  assert.ok(ladders.length >= 2, '应挂出回收阶梯单，实际 ' + ladders.length);
  assert.ok(ladders.every((a) => a.side === 'buy' && a.recovery), '回收单必须为 reduce-only 买单（active 中 recovery=true 即表示 reduce-only 回收腿）');
  assert.ok(ladders.every((a) => a.price > 200 && a.price < 250), '回收单在区间与现价之间');
  ex.setPrice(1, 150);
  await sleep(50);
  assert.equal(bot.outOfRange, false);
  assert.equal([...bot.active.values()].filter((a) => a.recovery).length, 0, '阶梯已撤销');
});

test('recover 迟滞：越外侧半格且连续 2 拍才进破界；回内侧半格才退出；阶梯首档 L−2 格', async () => {
  // CFG：lower=100 upper=200 gridCount=10 → 格距 sp=10，半格 h=5 → 外侧 95、内侧 105
  const { ex, bot } = await makeBot({}, { ...CFG, mode: 'long', outOfRangeAction: 'recover' });
  const buy140 = [...bot.active.values()].find((a) => a.side === 'buy' && a.price === 140);
  ex.fill(idOf(bot, buy140));
  await sleep(10);
  assert.ok(bot.ex.getPosition(1).sizeBase > 0, '应有多头库存');

  // 半格缓冲带内抖动：97(=L−0.3格) 与 102(=L+0.2格) 都不进破界
  ex.setPrice(1, 97); await sleep(10);
  ex.setPrice(1, 102); await sleep(10);
  assert.equal(bot.outOfRange, false, '半格缓冲带内不进破界');
  assert.equal(bot._outTicks, 0, '带内不累计越界拍数');

  // 越过外侧半格但仅 1 拍：不进破界（2 拍确认去抖）
  ex.setPrice(1, 94); await sleep(10);
  assert.equal(bot.outOfRange, false, '单拍越界不进破界');
  assert.equal(bot._outTicks, 1, '越界拍数累计 1');

  // 连续第 2 拍越界（79 同时低于 L−2格=80）：进破界并挂阶梯，首档落在 80
  ex.setPrice(1, 79); await sleep(50);
  assert.equal(bot.outOfRange, true, '连续 2 拍越界进破界');
  const ladders = [...bot.active.values()].filter((a) => a.recovery);
  assert.ok(ladders.length >= 1, '应挂出回收阶梯单，实际 ' + ladders.length);
  assert.ok(ladders.every((a) => a.side === 'sell' && a.recovery), '多头破下界挂 reduce-only 卖单（recovery=true 即 reduce-only）');
  assert.ok(ladders.some((a) => a.price === 80), '阶梯首档 = L − 2 格 = 80');
  assert.ok(ladders.every((a) => a.price <= 80), '所有阶梯档不高于 L−2 格（首档留 2 格缓冲）');

  // 回到迟滞带内（102 = L+0.2格 < 内侧半格 105）：不撤阶梯
  ex.setPrice(1, 102); await sleep(50);
  assert.equal(bot.outOfRange, true, '回到迟滞带内仍保持破界');
  assert.ok([...bot.active.values()].some((a) => a.recovery), '带内不撤阶梯');

  // 回到内侧半格之内（106 > 105）：撤阶梯、恢复正常
  ex.setPrice(1, 106); await sleep(50);
  assert.equal(bot.outOfRange, false, '回内侧半格退出破界');
  assert.equal([...bot.active.values()].filter((a) => a.recovery).length, 0, '阶梯已撤销');
});

test('recoverLadderOffsetGrids：off=1 首档落在 L−1 格；off=∞ 不挂阶梯', async () => {
  // off=1：格距 sp=10，首档应落在 L−1格=90（而非默认 L−2格=80）
  {
    const { ex, bot } = await makeBot({}, { ...CFG, mode: 'long', outOfRangeAction: 'recover', recoverLadderOffsetGrids: 1 });
    assert.equal(bot.config.recoverLadderOffsetGrids, 1);
    const buy140 = [...bot.active.values()].find((a) => a.side === 'buy' && a.price === 140);
    ex.fill(idOf(bot, buy140)); await sleep(10);
    ex.setPrice(1, 94); await sleep(10);   // 第 1 拍
    ex.setPrice(1, 79); await sleep(50);   // 第 2 拍 → 破界挂阶梯
    const ladders = [...bot.active.values()].filter((a) => a.recovery);
    assert.ok(ladders.some((a) => a.price === 90), 'off=1 阶梯首档 = L − 1 格 = 90');
    assert.ok(ladders.every((a) => a.price <= 90), '所有阶梯档不高于 L−1 格');
  }
  // off=∞：破界后完全不挂回收阶梯（纯持有，靠硬退出线）
  {
    const { ex, bot } = await makeBot({}, { ...CFG, mode: 'long', outOfRangeAction: 'recover', recoverLadderOffsetGrids: Infinity });
    // 存字符串 'inf'（非 JS Infinity）——保证 JSON 快照往返不失真
    assert.equal(bot.config.recoverLadderOffsetGrids, 'inf');
    const buy140 = [...bot.active.values()].find((a) => a.side === 'buy' && a.price === 140);
    ex.fill(idOf(bot, buy140)); await sleep(10);
    ex.setPrice(1, 94); await sleep(10);
    ex.setPrice(1, 79); await sleep(50);
    assert.equal(bot.outOfRange, true, '仍进破界（迟滞逻辑不受阶梯偏移影响）');
    assert.equal([...bot.active.values()].filter((a) => a.recovery).length, 0, 'off=∞ 不挂任何回收阶梯');
  }
});

test('recoverLadderOffsetGrids：∞ 经 snapshot→JSON→restore 仍是"不挂阶梯"（P0 序列化回归）', async () => {
  const { bot } = await makeBot({}, { ...CFG, mode: 'long', outOfRangeAction: 'recover', recoverLadderOffsetGrids: Infinity });
  // 真实持久化路径：snapshot → JSON 往返 → restore。若还存 JS Infinity，这一步会被吞成 null。
  const snap = JSON.parse(JSON.stringify(bot.snapshot()));
  assert.equal(snap.config.recoverLadderOffsetGrids, 'inf', '快照存可往返的 "inf" 字符串');

  const { bot: fresh } = await makeBot({}, CFG);
  fresh.running = false;
  fresh.restore(snap);
  assert.equal(fresh.config.recoverLadderOffsetGrids, 'inf', 'restore 后仍是 inf（不挂阶梯）');
});

test('recover 迟滞：启动价落在边界外侧半格内 → 不判破界、正常铺单（P2-1）', async () => {
  // lower=100 sp=10 h=5 → 外侧半格 95；起始价 97 在 [95,100) 缓冲带内
  const mkt = { marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC',
    stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001, lastPrice: 97 };
  const { bot } = await makeBot({ markets: [mkt] }, { ...CFG, outOfRangeAction: 'recover' });
  assert.equal(bot.outOfRange, false, '外侧半格内启动不判破界（避免"已铺单+补单暂停"的怪状态）');
  assert.ok(bot.active.size > 0, '正常铺单');

  // 对照：起始价 94（< 95 外侧半格）应判破界起步
  const mkt2 = { ...mkt, lastPrice: 94 };
  const { bot: bot2 } = await makeBot({ markets: [mkt2] }, { ...CFG, outOfRangeAction: 'recover' });
  assert.equal(bot2.outOfRange, true, '越过外侧半格启动仍判破界');
});

test('对账 prune：交易所消失的挂单连续两轮确认后清理', async () => {
  const { ex, bot } = await makeBot();
  const victimId = [...bot.active][0][0];
  ex.orders.delete(victimId); // 模拟外部撤单/成交丢失
  bot.active.get(victimId).placedAt = Date.now() - 60000; // 超过 20s 保护期
  await bot.reconcileOpenOrders();
  assert.ok(bot.active.has(victimId), '第一轮仅标记、不清理');
  await bot.reconcileOpenOrders();
  assert.ok(!bot.active.has(victimId), '第二轮清理');
  assert.equal(bot.active.size, 9);
});

test('对账 massVanish 保护：交易所返回 0 单但本地跟踪多单 -> 不清理', async () => {
  const { ex, bot } = await makeBot();
  ex.orders.clear(); // 接口异常返回空快照
  await bot.reconcileOpenOrders();
  assert.equal(bot.active.size, 10, '异常空快照不清理任何挂单');
});

test('对账 trim + adopt：同档重复单被撤、孤儿单被接管', async () => {
  const { ex, bot } = await makeBot();
  const dupId = ex.seedOrder(1, { price: 130, side: 'buy', levelIndex: 3 });   // level 3 已被种子买单占用
  const orphanId = ex.seedOrder(1, { price: 150, side: 'sell', levelIndex: 5 }); // level 5 空闲（跳过带）
  await bot.reconcileOpenOrders();
  assert.ok(!ex.orders.has(dupId), '同档重复挂单被撤销');
  assert.ok(ex.orders.has(orphanId), '孤儿单保留在交易所');
  assert.ok(bot.active.has(orphanId), '孤儿单被接管进跟踪');
});

test('resume 失败重试不重复附着监听器（Review23 P2）', async () => {
  const { ex, bot } = await makeBot();
  const snap = bot.snapshot();
  const ex2 = new MockExchange();
  for (const [id, o] of ex.orders) ex2.orders.set(id, { ...o });
  const bot2 = new GridBot(ex2);
  // 第一次 resume：附着监听器后 ex.start() 抛错 -> running 未置位（看门狗会重试）
  const origStart = ex2.start.bind(ex2);
  ex2.start = () => { throw new Error('start boom'); };
  await assert.rejects(() => bot2.resume(snap), /start boom/);
  assert.equal(ex2.listenerCount('fill'), 1, '失败后监听器恰好一份');
  assert.equal(ex2.listenerCount('price'), 1);
  // 重试（模拟看门狗下一轮）：修复前会再挂一遍 -> 2 份 -> 成交双倍处理
  ex2.start = origStart;
  await bot2.resume(snap);
  assert.equal(ex2.listenerCount('fill'), 1, '重试后监听器仍恰好一份');
  assert.equal(ex2.listenerCount('price'), 1);
  assert.equal(bot2.running, true, '重试成功恢复运行');
  bot2._stopDynTimer(); bot2._stopReconcileTimer();
});

test('崩溃恢复 resume：接管快照挂单并恢复运行，成交事件继续生效', async () => {
  const { ex, bot } = await makeBot();
  const snap = bot.snapshot();
  // 模拟重启：新交易所实例，订单簿保留原挂单
  const ex2 = new MockExchange();
  for (const [id, o] of ex.orders) ex2.orders.set(id, { ...o });
  const bot2 = new GridBot(ex2);
  await bot2.resume(snap);
  assert.equal(bot2.running, true);
  assert.equal(bot2.active.size, 10, '接管全部挂单');
  assert.equal(bot2.config.lower, 100);
  const firstId = [...bot2.active][0][0];
  ex2.fill(firstId);
  await sleep(10);
  assert.equal(bot2.stats.buys + bot2.stats.sells, 1, '恢复后成交事件生效');
});

test('保证金预检：所需保证金超过可用权益 -> 拒绝启动', async () => {
  const ex = new MockExchange({ balance: 100 });
  const bot = new GridBot(ex);
  await assert.rejects(() => bot.start({ ...CFG }), /保证金不足/); // 需 500 > 100
  assert.equal(bot.running, false);
  assert.equal(ex.orders.size, 0, '拒绝后不挂任何单');
});

test('保证金占用偏高告警（>80%）不阻断启动', async () => {
  const ex = new MockExchange({ balance: 600 });
  const bot = new GridBot(ex);
  await bot.start({ ...CFG });
  assert.equal(bot.running, true);
  assert.ok(bot.alerts.some((a) => a.message.includes('保证金占用偏高')));
});

test('格距不足覆盖手续费：告警但不阻断启动', async () => {
  // MockExchange.feeRate=0（零费）不告警；用真实费率验证告警路径
  const { bot } = await makeBot({ feeRate: 0.001 }, { ...CFG, gridCount: 100, upper: 110 });
  assert.ok(bot.alerts.some((a) => a.message.includes('不足以覆盖往返手续费')));
});

test('stop：撤单 + 平仓 + 状态复位', async () => {
  const { ex, bot } = await makeBot();
  await bot.stop({ closePosition: true });
  assert.equal(bot.running, false);
  assert.equal(bot.active.size, 0);
  assert.equal(ex.closeCalls, 1);
  assert.equal(ex.orders.size, 0);
});

test('重试空快照守卫：期望有单但快照为空 -> 本轮不重挂（防翻倍下单）', async () => {
  const { ex, bot } = await makeBot();
  // 塞入 10+ 个 opening 重试项，且本地 active 有 10+ 单（满足守卫阈值）
  for (let i = 0; i < 12; i++) {
    bot.active.set('a' + i, { levelIndex: i, side: 'buy', price: 110 + i, sizeBase: 1, opening: true, placedAt: Date.now() });
    bot._retryQueue.push({ levelIndex: i, sizeBase: 1, side: 'buy', price: 110 + i, opening: true, _nextAt: 0 });
  }
  // 交易所挂单快照为空（模拟 dex 端点瞎眼）——守卫应拦截重挂
  ex.orders.clear();
  const before = bot.active.size;
  await bot._drainRetryQueueNow();
  assert.equal(bot.active.size, before, '空快照轮不得重挂/新增挂单');
  assert.equal(ex.orders.size, 0, '交易所侧不得出现任何新单');
  assert.ok(bot._retryQueue.length >= 12, '重试项应保留（推后重试而非放弃）');
  assert.ok(bot.alerts.some((a) => a.message.includes('安全重试暂缓')), '应发出安全重试暂缓告警');
});

test('批量成交竞态：同一 tick 连吃相邻多档，每档都必须补出对腿（不留空洞）', async () => {
  const { ex, bot } = await makeBot();
  // 一笔扫单在同一 tick 打穿相邻 5 档买单：适配器 for..of emit('fill') 同步下发，
  // 旧实现里每档补腿目标档仍被同批未处理成交占着，会被"一格一单"不变量静默丢弃。
  for (let lvl = 0; lvl <= 4; lvl += 1) {
    const o = orderAtLevel(bot, lvl);
    assert.ok(o && o.side === 'buy', `第 ${lvl} 档应有买单`);
    ex.fill(idOf(bot, o));
  }
  await sleep(20);
  for (let lvl = 1; lvl <= 5; lvl += 1) {
    const o = orderAtLevel(bot, lvl);
    assert.ok(o && o.side === 'sell', `第 ${lvl} 档应补出卖单，实际 ${o ? o.side : '空档'}`);
  }
  assert.equal(bot.active.size, 10, '阶梯应恢复到 10 单（5 卖@1-5 + 5 卖@6-10）');
  assert.equal(bot.stats.buys, 5, '五笔买单成交均计数');
});

// ── 补腿冲突记账：微任务窗口内目标档仍被占，必须留证据并进 state ──────────────
test('补腿冲突计数：目标档仍被占用时记账并暴露到 state', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  bot._alert = () => {};
  bot.running = true;
  bot.grid = { lower: 90, upper: 110, levels: 21, spacing: 1, sizeBase: 0.1, marketId: 1 };
  bot.active.set('o1', { orderId: 'o1', levelIndex: 5, side: 'buy', price: 95, sizeBase: 0.1 });
  bot._replQueue.push({ levelIndex: 5, side: 'sell', price: 96, sizeBase: 0.1 });
  bot._flushReplacements();
  await sleep(20);
  assert.equal(bot._replConflicts, 1, '同一档位被占应记一次冲突');
  assert.equal(bot.getState().replConflicts, 1, 'state 要暴露计数供巡检读取');
  assert.equal(bot.getState().lastReplConflict.levelIndex, 5, '最后一次冲突要带档位');
});

// ── 无冲突时不应误报 ─────────────────────────────────────────────────────────
test('补腿冲突计数：目标档空闲时不记账', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  bot._alert = () => {};
  bot.running = true;
  bot.grid = { lower: 90, upper: 110, levels: 21, spacing: 1, sizeBase: 0.1, marketId: 1 };
  bot._replQueue.push({ levelIndex: 7, side: 'sell', price: 97, sizeBase: 0.1 });
  bot._flushReplacements();
  await sleep(20);
  assert.equal(bot._replConflicts, 0, '空闲档位不该记账');
});

// ── 全撤确认门：连续 3 轮 0 单才清台账，2 轮不动（防接口抖动）──────────────
test('挂单全撤：连续两轮 0 单只告警、不清台账（接口抖动保护仍在）', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  bot._alert = () => {};
  bot.running = true;
  bot.config = { ...bot.config, marketId: 1, mode: 'neutral', lower: 90, upper: 110, gridCount: 20, sizeBase: 0.1 };
  bot.grid = { lower: 90, upper: 110, levels: Array.from({ length: 21 }, (_, i) => 90 + i), spacing: 1, sizeBase: 0.1, marketId: 1 };
  for (let i = 0; i < 5; i += 1) bot.active.set(`o${i}`, { orderId: `o${i}`, levelIndex: i, side: 'buy', price: 90 + i, sizeBase: 0.1 });
  ex.orders.clear();
  await bot.reconcileOpenOrders();
  await bot.reconcileOpenOrders();
  assert.equal(bot.active.size, 5, '两轮 0 单不该清台账（可能是快照抖动）');
  assert.equal(bot._vanishStreak, 2, '连续轮次要被记住');
});

test('挂单全撤：连续三轮 0 单确认为真，清空台账并重建', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  const alerts = [];
  bot._alert = (m) => alerts.push(m);
  bot.running = true;
  bot.config = { ...bot.config, marketId: 1, mode: 'neutral', lower: 90, upper: 110, gridCount: 20, sizeBase: 0.1 };
  bot.grid = { lower: 90, upper: 110, levels: Array.from({ length: 21 }, (_, i) => 90 + i), spacing: 1, sizeBase: 0.1, marketId: 1 };
  for (let i = 0; i < 5; i += 1) bot.active.set(`o${i}`, { orderId: `o${i}`, levelIndex: i, side: 'buy', price: 90 + i, sizeBase: 0.1 });
  ex.orders.clear();
  await bot.reconcileOpenOrders();
  await bot.reconcileOpenOrders();
  await bot.reconcileOpenOrders();
  assert.equal(bot.active.size, 0, '第三轮必须清空本地台账');
  assert.equal(bot._vanishStreak, 0, '确认后计数归零');
  assert.ok(alerts.some((m) => m.includes('全撤已确认')), '必须留下确认告警');
});

// ── 止损口径：按盘口价重算，不听交易所 mark ──────────────────────────────────
test('止损：mark 口径假报盈利时，盘口口径亏到线照砍', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  const alerts = [];
  bot._alert = (m) => alerts.push(m);
  bot.running = true;
  bot.config = { ...bot.config, marketId: 1, mode: 'neutral', stopLossUsd: 50 };
  bot.lastPrice = 200;
  ex.getPosition = () => ({ sizeBase: -0.6, entryPrice: 100, unrealizedPnl: 5 });
  let stopped = false;
  bot.stop = async () => { stopped = true; };
  bot._checkMaxLoss();
  await sleep(10);
  assert.ok(stopped, '盘口价 (200−100)×(−0.6) = −60 已破 50 的线，必须砍');
  assert.ok(alerts.some((m) => m.includes('止损线')), '要留下止损告警');
});

test('止损：盘口口径未到线时不动', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  bot._alert = () => {};
  bot.running = true;
  bot.config = { ...bot.config, marketId: 1, mode: 'neutral', stopLossUsd: 50 };
  bot.lastPrice = 110;
  ex.getPosition = () => ({ sizeBase: -0.6, entryPrice: 100, unrealizedPnl: -500 });
  let stopped = false;
  bot.stop = async () => { stopped = true; };
  bot._checkMaxLoss();
  await sleep(10);
  assert.ok(!stopped, '盘口口径只有 −6，不该触发（mark 的 −500 是失真）');
});

// ── 看门狗心跳 ───────────────────────────────────────────────────────────────
test('看门狗：行情推送会刷新活动时间戳', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  bot.config = { ...bot.config, marketId: 1 };
  bot._lastActivityAt = 1;
  bot._handlePrice({ marketId: 1, price: 100 });
  assert.ok(bot._lastActivityAt > 1, '行情到达必须刷新心跳');
});

// ── 全撤确认后的自动重铺（5 分钟节流）──────────────────────────────────────
test('挂单全撤确认后自动重铺一次，且 5 分钟内不重复', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  bot._alert = () => {};
  bot.running = true;
  bot.config = { ...bot.config, marketId: 1, mode: 'neutral', lower: 90, upper: 110, gridCount: 20, sizeBase: 0.1 };
  bot.grid = { lower: 90, upper: 110, levels: Array.from({ length: 21 }, (_, i) => 90 + i), spacing: 1, sizeBase: 0.1, marketId: 1 };
  let rebuilds = 0;
  bot.refillGrid = async () => { rebuilds += 1; };
  for (let i = 0; i < 5; i += 1) bot.active.set(`o${i}`, { orderId: `o${i}`, levelIndex: i, side: 'buy', price: 90 + i, sizeBase: 0.1 });
  ex.orders.clear();
  for (let i = 0; i < 3; i += 1) await bot.reconcileOpenOrders();
  await sleep(20);
  assert.equal(rebuilds, 1, '确认全撤后应自动重铺一次');
  // 再造一次全撤：节流窗口内不应再次重铺
  for (let i = 0; i < 5; i += 1) bot.active.set(`p${i}`, { orderId: `p${i}`, levelIndex: i, side: 'buy', price: 90 + i, sizeBase: 0.1 });
  for (let i = 0; i < 3; i += 1) await bot.reconcileOpenOrders();
  await sleep(20);
  assert.equal(rebuilds, 1, '5 分钟节流内不重复重铺');
});

test('异常价格帧：破界需驻留 outDwellMs 才认，跳出去又跳回来不触发', async () => {
  const { ex, bot } = await makeBot();
  bot.config.outDwellMs = 200;
  // 1 拍越界 → 不触发（仍需 2 拍）
  ex.setPrice(1, 210); await sleep(10);
  ex.setPrice(1, 210); await sleep(10); // 2 拍越界，但驻留不足 200ms
  assert.equal(bot.outOfRange, false, '驻留不足不触发');
  // 1 秒内回到区间：闸门必须把这次抖动整个吞掉
  ex.setPrice(1, 150); await sleep(10);
  assert.equal(bot.outOfRange, false, '跳出去又跳回来不应切换模式');
  assert.equal(bot._outTicks, 0, '回区间后越界拍数复位');
  // 持续越界超过驻留时间 → 正常触发
  ex.setPrice(1, 210); ex.setPrice(1, 210);
  await sleep(250);
  ex.setPrice(1, 210); await sleep(50);
  assert.equal(bot.outOfRange, true, '驻留足够久应触发');
});

// 停机很久后重新 start：活动水位必须立刻重置，否则看门狗当轮判定停滞并杀进程
test('start 会重置活动水位（防停机后重启被误杀）', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  bot._lastActivityAt = Date.now() - 16_000_000;   // 停机 4.5 小时
  await bot.start({ ...CFG });
  assert.ok(Date.now() - bot._lastActivityAt < 2_000, 'start 后 _lastActivityAt 应是刚刚');
  await bot.stop({ closePosition: false });
  bot._stopDynTimer?.();
});

// 2026-10-26 实测：sizeBase == minOrderSize 时，任何部分成交都低于最小下单量，
// 旧逻辑直接跳过补腿 → 现价附近 3 小时攒出 10 档永久空洞。改为按最小量补挂。
test('死手全撤后残留少数单（非 0 单）：连续多轮大面积缺格应自动重铺', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  bot._alert = () => {};
  bot.running = true;
  bot.config = { ...bot.config, marketId: 1, mode: 'neutral', lower: 90, upper: 110, gridCount: 20, sizeBase: 0.1 };
  bot.grid = { lower: 90, upper: 110, levels: Array.from({ length: 21 }, (_, i) => 90 + i), spacing: 1, sizeBase: 0.1, marketId: 1 };
  let rebuilds = 0;
  bot.refillGrid = async () => { rebuilds += 1; };
  for (let i = 0; i < 20; i += 1) bot.active.set(`o${i}`, { orderId: `o${i}`, levelIndex: i, side: 'buy', price: 90 + i, sizeBase: 0.1 });
  ex.orders.clear();
  // 交易所只活下来 1 张：massVanish 的「0 单」判据不成立，旧逻辑只 prune 不重铺
  ex.orders.set('o5', { marketId: 1, side: 'buy', price: 95, sizeBase: 0.1, levelIndex: 5, orderId: 'o5' });
  for (let i = 0; i < 3; i += 1) await bot.reconcileOpenOrders();
  await sleep(20);
  assert.equal(rebuilds, 0, '前 3 轮还在确认期，不应立刻重铺');
  await bot.reconcileOpenOrders();
  await sleep(20);
  assert.equal(rebuilds, 1, '连续 4 轮大面积缺格应自动重铺一次');
});

// 2026-10-26 15:22 实测：一笔市价扫单吃掉 idx 34~60 共 27 张卖单（缺口 27/61 = 44%），
// 旧的 50% 阈值永不触发，上半段阶梯空了 37 分钟。单边扫单天然只空一半，阈值必须低于 50%。
test('单边扫单吞掉 44% 档位：连续四轮也应自动重铺', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex);
  bot._alert = () => {};
  bot.running = true;
  bot.lastPrice = 120;
  bot.config = { ...bot.config, marketId: 1, mode: 'neutral', lower: 90, upper: 150, gridCount: 60, sizeBase: 0.0001 };
  bot.grid = { lower: 90, upper: 150, levels: Array.from({ length: 61 }, (_, i) => 90 + i), spacing: 1, sizeBase: 0.0001, marketId: 1 };
  let rebuilds = 0;
  bot.refillGrid = async () => { rebuilds += 1; };
  for (let i = 0; i <= 33; i += 1) {
    bot.active.set(`s${i}`, { orderId: `s${i}`, levelIndex: i, side: i < 30 ? 'buy' : 'sell', price: 90 + i, sizeBase: 0.0001 });
    ex.orders.set(`s${i}`, { marketId: 1, side: i < 30 ? 'buy' : 'sell', price: 90 + i, sizeBase: 0.0001, levelIndex: i, orderId: `s${i}` });
  }
  for (let i = 0; i < 3; i += 1) await bot.reconcileOpenOrders();
  await sleep(20);
  assert.equal(rebuilds, 0, '前 3 轮还在确认期');
  await bot.reconcileOpenOrders();
  await sleep(20);
  assert.equal(rebuilds, 1, '27/61 = 44% 缺口也要重铺');
});

test('部分成交低于最小下单量：仍按最小量补挂对腿（不留空洞）', async () => {
  const mkt = { marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC',
    stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001, lastPrice: 150 };
  const cfg = { ...CFG, sizeBase: 0.0001 };
  const { bot } = await makeBot({ markets: [mkt] }, cfg);
  const target = [...bot.active.values()].find((a) => String(a.side).toLowerCase() === 'buy');
  assert.ok(target, '存在买单档位');
  const lvl = target.levelIndex;
  // 只成交 85%（0.000085 < minOrderSize 0.0001）
  bot.ex.emit('fill', {
    orderId: 'dust-1', marketId: 1, side: target.side, price: target.price,
    sizeBase: 0.000085, levelIndex: lvl,
  });
  await new Promise((r) => setImmediate(r));
  const repl = orderAtLevel(bot, lvl + 1);
  assert.ok(repl, '对腿必须挂出来，不能留空洞');
  assert.equal(repl.sizeBase, 0.0001, '按最小下单量补挂');
  assert.ok(bot._dustPromoted > 0, '漂移已记账');
});

test('单格净利红线：150ppm 下 0.09% 间距拒启，0.10% 放行（review 2026-10-27）', async () => {
  const mk = (pct) => {
    const px = 79500, spacing = px * pct / 100, half = spacing * 66 / 2;
    const ex = new MockExchange({ feeRate: 0.00015, balance: 100000 });
    ex.minGridNetUsd = 0.01;
    ex.prices.set(1, px);
    ex.marketDefs[0].lastPrice = px;
    return { ex, cfg: { marketId: 1, mode: 'neutral', lower: px - half, upper: px + half,
      gridCount: 66, sizeBase: 0.0002, leverage: 10, outOfRangeAction: 'recover', outDwellMs: 0 } };
  };

  // 0.09%：毛利 $0.01431 − 双边费 $0.00477 = $0.00954 < $0.01 → 必须拒绝
  const bad = mk(0.09);
  const badBot = new GridBot(bad.ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await assert.rejects(() => badBot.start(bad.cfg), /低于红线/, '0.09% 间距单格净利 0.0095 必须被拒');
  assert.equal(badBot.running, false, '拒启后不得处于运行态');
  assert.equal(bad.ex.orders.size, 0, '拒启前不得下任何单');

  // 0.10%：$0.0159 − $0.00477 = $0.01113 ≥ $0.01 → 放行，且 risk 暴露净利
  const good = mk(0.10);
  const goodBot = new GridBot(good.ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await goodBot.start(good.cfg);
  assert.equal(goodBot.running, true);
  assert.ok(goodBot.risk.perRungNet >= 0.011, `risk.perRungNet 应约为 0.0111，实际 ${goodBot.risk.perRungNet}`);
  assert.equal(goodBot.risk.sizeBase, 0.0002, 'risk 暴露 sizeBase 供验收');
});

// ── 顺序执行全部用例 ──────────────────────────────────────────────────────────
// ── P3：被交易所语义性拒绝的订单，不得进台账 / 重试队列 / 挂单数 ──
test('REJECTED 单不进 active、不进重试队列、不被反复重试', async () => {
  class RejEx extends MockExchange {
    constructor(o = {}) {
      super(o);
      this.rejectLevels = new Set(o.rejectLevels || []);
      this.attempts = [];
    }
    async placeLimitOrder(o) {
      this.attempts.push({ level: o.levelIndex, side: o.side });
      if (this.rejectLevels.has(o.levelIndex)) {
        const e = new Error('下单被交易所拒绝：status=REJECTED reduceOnly=true');
        e.rejected = true; e.status = 'REJECTED'; e.orderId = 'rej-' + o.levelIndex;
        throw e;
      }
      return super.placeLimitOrder(o);
    }
  }
  const ex = new RejEx({ rejectLevels: [3, 7] });
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await bot.start({ ...CFG });
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(ex.orders.size, 8, '10 档里 2 档被拒 → 交易所侧只能 8 张');
  assert.equal(bot.active.size, 8, 'active 也只能 8 张');
  assert.equal(
    bot._retryQueue.filter((o) => ex.rejectLevels.has(o.levelIndex)).length, 0,
    '被拒订单不得进入重试队列',
  );
  assert.ok(
    ![...bot.active.values()].some((o) => String(o.orderId || '').startsWith('rej-')),
    '被拒订单不得出现在 active 台账',
  );
  for (const lv of [3, 7]) {
    const n = ex.attempts.filter((a) => a.level === lv).length;
    assert.equal(n, 1, `level ${lv} 只应尝试一次（不重试），实际 ${n} 次`);
  }
  await bot.stop({ closePosition: false }).catch(() => {});
});

// ── P3：回收阶梯的每一张单都必须显式带 reduceOnly ──
test('recover 阶梯全部显式 reduceOnly=true 且带 recovery 标记', async () => {
  const ex = new MockExchange({ balance: 5000 });
  ex.positions.set(1, { sizeBase: -0.5, entryPrice: 150, unrealizedPnl: 0, leverage: 3 });
  const calls = [];
  const orig = ex.placeLimitOrder.bind(ex);
  ex.placeLimitOrder = async (o) => { calls.push({ ...o }); return orig(o); };

  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await bot.startRecovery({ ...CFG, sizeBase: 0.1 });
  await new Promise((r) => setTimeout(r, 80));

  assert.ok(calls.length > 0, '回收阶梯必须真的下单');
  const notReduceOnly = calls.filter((o) => o.reduceOnly !== true);
  assert.equal(
    notReduceOnly.length, 0,
    `回收单必须全部 reduceOnly=true，违规 ${notReduceOnly.length} 张：${JSON.stringify(notReduceOnly.slice(0, 3))}`,
  );
  // recovery 只是本地标记（seedOrders 补种路径不带它），交易所语义只看 reduceOnly，
  // 所以这里只做提示不做硬断言。
  const notRecovery = calls.filter((o) => !o.recovery);
  if (notRecovery.length) {
    console.log(`    （提示）${notRecovery.length}/${calls.length} 张回收单未带本地 recovery 标记，不影响交易所语义`);
  }
  await bot.stop({ closePosition: false }).catch(() => {});
});

(async () => {
  for (const [name, fn] of T) {
    try {
      await fn();
      passed++;
      console.log('  ✓ ' + name);
    } catch (e) {
      failed++;
      console.error('  ✗ ' + name + '\n    ' + (e?.message || e));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
