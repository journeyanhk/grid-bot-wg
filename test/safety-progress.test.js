// GridBot v1.2 新增安全机制测试：一键补格（refillGrid）、挂单进度跟踪
// （placementProgress）、开仓单安全重试（supportsSafeOpeningRetry 两次权威快照去重）。
// 运行: node test/safety-progress.test.js（npm test 会串联执行）
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GridBot } from '../src/bot.js';

let passed = 0, failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MockExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.dataSource = 'real';
    this.feeRate = 0;
    this.balance = opts.balance ?? 100000;
    this.orders = new Map();
    this.positions = new Map();
    this.prices = new Map();
    this._seq = 1;
    this.supportsSafeOpeningRetry = true;
    this.marketDefs = opts.markets ?? [{
      marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC',
      stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001, lastPrice: 150,
    }];
    for (const m of this.marketDefs) this.prices.set(m.marketId, m.lastPrice ?? 100);
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
    for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) this.orders.delete(id);
    return true;
  }

  async fetchOpenOrders(marketId) {
    return [...this.orders.values()]
      .filter((o) => o.marketId === Number(marketId))
      .map((o) => ({ orderId: o.orderId, price: o.price, side: o.side }));
  }

  adoptOrder() {}
  forgetOrder(orderId) { this.orders.delete(String(orderId)); }
  forgetOrders(marketId) {
    for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) this.orders.delete(id);
  }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    return p && p.sizeBase !== 0 ? p : null;
  }

  async closePosition(marketId) { this.positions.delete(Number(marketId)); return true; }

  seedOrder(marketId, { price, side, sizeBase = 1, levelIndex = -1 }) {
    const id = String(this._seq++);
    this.orders.set(id, { marketId: Number(marketId), side, price: Number(price), sizeBase, levelIndex, orderId: id });
    return id;
  }

  fill(orderId) {
    const o = this.orders.get(String(orderId));
    if (!o) return false;
    this.orders.delete(String(orderId));
    const p = this.positions.get(o.marketId) || { sizeBase: 0, entryPrice: 0, unrealizedPnl: 0, leverage: 3 };
    if (o.side === 'buy') p.sizeBase += o.sizeBase; else p.sizeBase -= o.sizeBase;
    if (p.sizeBase === 0) this.positions.delete(o.marketId); else this.positions.set(o.marketId, p);
    this.emit('fill', { orderId: String(orderId), marketId: o.marketId, side: o.side, price: o.price, sizeBase: o.sizeBase, levelIndex: o.levelIndex });
    return true;
  }
}

const CFG = { marketId: 1, mode: 'neutral', lower: 100, upper: 200, gridCount: 10, sizeBase: 1, leverage: 3, outOfRangeAction: 'close' };

async function makeBot(exOpts = {}, cfg = CFG) {
  const ex = new MockExchange(exOpts);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await bot.start(cfg);
  return { ex, bot };
}

const T = [];
const test = (name, fn) => T.push([name, fn]);

test('一键补格：空格位补齐并计入进度，无空格时提示', async () => {
  const { ex, bot } = await makeBot();
  // 手动撤掉 3 个挂单模拟"缺格"
  const victims = [...bot.active].slice(0, 3);
  for (const [id] of victims) { ex.orders.delete(id); bot.active.get(id).placedAt = Date.now() - 60000; }
  await bot.reconcileOpenOrders(); // 第一轮标记
  await bot.reconcileOpenOrders(); // 第二轮清理（prune）
  const before = bot.active.size;
  assert.equal(before, 7);
  const r = await bot.refillGrid();
  assert.ok(r.openOrders > before, '补格后挂单数增加');
  assert.equal(r.openOrders, 10, '补齐到 10 单');
  // 再次补格 -> 无需补
  await bot.refillGrid();
  assert.equal(bot.active.size, 10);
});

test('一键补格：保证金不足拒绝补格', async () => {
  const { ex, bot } = await makeBot({}, { ...CFG, sizeBase: 10 }); // 名义 10格x10x150=15000
  // 删除 8 个挂单（保留 2 个，避免触发 massVanish 保护）
  const victims = [...bot.active].slice(0, 8);
  for (const [id] of victims) { ex.orders.delete(id); bot.active.get(id).placedAt = Date.now() - 60000; }
  await bot.reconcileOpenOrders();
  await bot.reconcileOpenOrders();
  assert.equal(bot.active.size, 2, '8 个空档位已清理');
  ex.balance = 20; // 补格前余额骤降 -> 补格预检应拒绝（8格x10x150/3=4000 > 20）
  await assert.rejects(() => bot.refillGrid(), /保证金不足/);
});

test('启动挂单进度跟踪：placementProgress 从 placing 到 complete', async () => {
  const { bot } = await makeBot();
  const p = bot.getState().placementProgress;
  assert.ok(p, '启动后应有进度');
  assert.equal(p.status, 'complete', '全部下单成功应为 complete');
  assert.equal(p.target, 10);
  assert.equal(p.confirmed, 10);
  assert.equal(p.pending, 0);
});

test('开仓单安全重试：下单失败进重试队列，交易所出现该档挂单后被接管不重复下单', async () => {
  const ex = new MockExchange();
  // 让 level 3 的下单失败一次：拦截 placeLimitOrder
  const orig = ex.placeLimitOrder.bind(ex);
  let failNext = true;
  ex.placeLimitOrder = async (o) => {
    if (failNext && o.levelIndex === 3) { failNext = false; throw new Error('模拟限流 429'); }
    return orig(o);
  };
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10 });
  await bot.start(CFG);
  // level 3 失败 -> 进入重试队列（开仓单安全重试）
  assert.ok(bot._retryQueue.some((o) => o.levelIndex === 3 && o._placementId === bot._placementProgress?.id), '失败档位进入重试队列');
  assert.ok(bot.active.size < 10, '缺一单');
  // 模拟：外部/重试前该档位被交易所真实占用（订单已在交易所但未跟踪）
  const liveId = ex.seedOrder(1, { price: 130, side: 'buy', levelIndex: 3 });
  // 手动触发重试排水（等 _nextAt 到期）
  for (const q of bot._retryQueue) q._nextAt = 0;
  await bot._drainRetryQueue();
  await sleep(30);
  // 两次快照看到该档位已有真实挂单 -> 接管而不是重复下单
  assert.ok(bot.active.has(liveId), '接管交易所真实挂单');
  const dup = [...bot.active.values()].filter((a) => a.levelIndex === 3);
  assert.equal(dup.length, 1, '该档位只有一单（未重复下单）');
  assert.equal(bot.getState().placementProgress?.confirmed, 10, '进度最终全部确认');
});

test('停止流程：撤单确认失败时中止并保留跟踪', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 2 });
  await bot.start(CFG);
  // 让 cancelAll 后交易所仍返回挂单（模拟撤单没生效）
  ex.cancelAll = async () => { return true; }; // 不实际删除
  await assert.rejects(() => bot.stop({ closePosition: false }), /仍检测到/);
  assert.equal(bot.running, true, '撤单未确认 -> 停止中止，网格保持运行');
  assert.equal(bot.active.size, 10, '跟踪保留');
});

(async () => {
  for (const [name, fn] of T) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
