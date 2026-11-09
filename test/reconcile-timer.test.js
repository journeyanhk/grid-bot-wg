// test/reconcile-timer.test.js —— 对账心跳必须「可观测 + 一定会启动」
//
// 2026-11-09 09:19 实测事故：`_start()` 因为「已有熔断记录」早退，连带跳过了
// `_startReconcileTimer()`。结果对账/风控心跳 40 分钟没跑，而外部完全看不出来：
// `exchangeOpenOrders` 只是冻着（它本来就可能是缓存），六个静默 return 一个日志都不留。
// 这组用例钉死三件事：
//   ① 对账定时器在被闸门拦下的启动路径上也要启动；
//   ② 每一次早退都要留下 skipReason，最后一次成功要留 lastOkAt；
//   ③ 跨重启的 placementProgress 僵尸不能永久挡住回收前置检查。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { STATES } from '../src/guard.js';

class MockEx extends EventEmitter {
  constructor(o = {}) {
    super();
    this.mode = 'paper';
    this.dataSource = 'real';
    this.feeRate = 0;
    this.displayFeeRate = 0;
    this.balance = o.balance ?? 5000;
    this.orders = new Map();
    this.positions = new Map();
    this.placed = [];
    this.price = o.price ?? 150;
    this._seq = 1;
    this.marketDefs = [{
      marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC',
      stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001, lastPrice: this.price,
    }];
  }
  get equity() { return this.balance; }
  async init() { return true; }
  start() {}
  stop() {}
  async getMarkets() { return this.marketDefs; }
  async getPrice() { return this.price; }
  getPosition() { return this.positions.get(1); }
  async setLeverage() { return true; }
  async placeLimitOrder(o) {
    const id = String(this._seq++);
    this.orders.set(id, {
      marketId: 1, side: o.side, price: Number(o.price), sizeBase: Number(o.sizeBase),
      reduceOnly: !!o.reduceOnly, levelIndex: o.levelIndex, orderId: id,
    });
    this.placed.push({ ...o, orderId: id });
    return { orderId: id };
  }
  async cancelOrder(m, id) { this.orders.delete(String(id)); return true; }
  async cancelAll() { this.orders.clear(); return true; }
  async fetchOpenOrders() { return [...this.orders.values()]; }
  async closePosition() { this.positions.clear(); return true; }
}

const CFG = {
  marketId: 1, mode: 'neutral', lower: 100, upper: 200,
  gridCount: 10, sizeBase: 1, leverage: 3,
  outOfRangeAction: 'close', outDwellMs: 0,
};

function makeBot(o = {}) {
  const ex = new MockEx(o);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  return { ex, bot };
}

test('正常启动：对账心跳活着，且仪表显示最后一次成功', async () => {
  const { bot } = makeBot({ price: 150 });
  await bot.start(CFG);
  await bot.reconcileOpenOrders();
  const s = bot.getState();
  assert.equal(s.reconcile.timerActive, true, '启动后对账定时器必须在跑');
  assert.equal(s.reconcile.skipReason, null, '成功一轮后不应残留 skipReason');
  assert.ok(s.reconcile.ageMs != null && s.reconcile.ageMs < 5000, `ageMs 应为新鲜值，实际 ${s.reconcile.ageMs}`);
  assert.ok(s.reconcile.runs >= 1);
  assert.equal(s.startBlockedReason, null);
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('启动被风控拦下：一张不铺，但对账心跳必须启动、progress 不许停在 placing', async () => {
  const { ex, bot } = makeBot({ price: 150 });
  bot._startBlockedReason = () => '已有熔断记录：仓位缓存连续 12 轮落后于成交';
  const ret = await bot.start(CFG);
  assert.equal(ex.placed.length, 0, '闸门拦下时绝不允许铺单');
  assert.equal(bot.active.size, 0);
  assert.equal(bot._placementProgress, null, '闸门早退必须清掉这批 progress，否则永久挡回收');
  assert.ok(bot._reconTimer, '闸门早退也必须启动对账定时器（09:19 事故）');
  const s = bot.getState();
  assert.equal(s.reconcile.timerActive, true);
  assert.match(s.startBlockedReason, /已有熔断记录/);
  assert.ok(ret?.running === true);
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('HALTED 期间对账早退必须留原因，不能静默', async () => {
  const { bot } = makeBot({ price: 150 });
  await bot.start(CFG);
  bot.guardState = { state: STATES.HALTED, reasons: [], blockOpening: true, blockSide: 'both', haltReason: 'test', metrics: {} };
  await bot.reconcileOpenOrders();
  assert.equal(bot.getState().reconcile.skipReason, 'halted');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('跨重启僵尸：待补档位其实都在簿上时，progress 必须被清掉', async () => {
  const { bot } = makeBot({ price: 150 });
  bot.config = { ...CFG };
  bot.running = true;
  bot.active.set('a1', { levelIndex: 1, side: 'buy', price: 100, sizeBase: 1, opening: true });
  bot.active.set('a2', { levelIndex: 2, side: 'buy', price: 99, sizeBase: 1, opening: true });
  bot._placementProgress = {
    id: 'stale-1', action: 'start', target: 2,
    orders: [{ levelIndex: 1, side: 'buy', price: 100 }, { levelIndex: 2, side: 'buy', price: 99 }],
    confirmedLevels: [], pendingLevels: [1, 2], failedLevels: [],
    status: 'placing', initialPassDone: false, completionAlerted: false,
    updatedAt: Date.now() - 3600_000,
  };
  bot._restorePendingPlacementRetries();
  assert.equal(bot._placementProgress, null, '没有待补档位的 placing 是僵尸，必须清掉');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('跨重启且确有待补档位：适配器支持安全重试时保留并推进到 retrying', async () => {
  const { ex, bot } = makeBot({ price: 150 });
  ex.supportsSafeOpeningRetry = true;   // Arcus 是 false，这里验证「支持」的那条分支
  bot.config = { ...CFG };
  bot.running = true;
  bot.active.set('a1', { levelIndex: 1, side: 'buy', price: 100, sizeBase: 1, opening: true });
  bot._placementProgress = {
    id: 'stale-2', action: 'start', target: 2,
    orders: [{ levelIndex: 1, side: 'buy', price: 100 }, { levelIndex: 2, side: 'buy', price: 99 }],
    confirmedLevels: [], pendingLevels: [1, 2], failedLevels: [],
    status: 'placing', initialPassDone: false, completionAlerted: false,
    updatedAt: Date.now() - 3600_000,
  };
  bot._restorePendingPlacementRetries();
  assert.ok(bot._placementProgress, '真有待补档位时不能清');
  assert.deepEqual(bot._placementProgress.pendingLevels, [2], '已在簿的档位必须从待补里剔除');
  assert.equal(bot._placementProgress.status, 'retrying', '重启后不许再停在 placing');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('跨重启且适配器不支持安全重试：没有可执行动作的批次必须清掉', async () => {
  const { bot } = makeBot({ price: 150 });   // MockEx 默认没有 supportsSafeOpeningRetry
  bot.config = { ...CFG };
  bot.running = true;
  bot.active.set('a1', { levelIndex: 1, side: 'buy', price: 100, sizeBase: 1, opening: true });
  bot._placementProgress = {
    id: 'stale-3', action: 'start', target: 2,
    orders: [{ levelIndex: 1, side: 'buy', price: 100 }, { levelIndex: 2, side: 'buy', price: 99 }],
    confirmedLevels: [], pendingLevels: [1, 2], failedLevels: [],
    status: 'placing', initialPassDone: false, completionAlerted: false,
    updatedAt: Date.now() - 3600_000,
  };
  bot._restorePendingPlacementRetries();
  assert.equal(bot._placementProgress, null, '补不了的批次必须清掉，否则永久挡回收');
  await bot.stop({ closePosition: false }).catch(() => {});
});
