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
    this.feeRate = 0;
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

const CFG = { marketId: 1, mode: 'neutral', lower: 100, upper: 200, gridCount: 10, sizeBase: 1, leverage: 3, outOfRangeAction: 'close' };

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

test('出区间风控(close)：价格突破上边界 -> 撤单 + 平仓 + 停止', async () => {
  const { ex, bot } = await makeBot();
  ex.setPrice(1, 205);
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
  ex.setPrice(1, 250);
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
  const { bot } = await makeBot({}, { ...CFG, gridCount: 100, upper: 110 });
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

// ── 顺序执行全部用例 ──────────────────────────────────────────────────────────
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
