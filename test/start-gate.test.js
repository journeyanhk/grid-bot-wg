// test/start-gate.test.js —— P0 启动闸门 / P1 fail-closed / P1 全量撤单
//
// 这组测试回答一个具体问题：启动那一刻价格已经在区间外，会不会先铺出开仓单？
// 必须证明「一张都不许铺」，而不是「铺完再被价格事件拦住」。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { STATES } from '../src/guard.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.failPosition = false;
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
  getPosition() {
    if (this.failPosition) throw new Error('positions endpoint timeout');
    return this.positions.get(1);
  }
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

async function boot(opts = {}, cfg = CFG) {
  const ex = new MockEx(opts);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  let ret = null;
  let err = null;
  try { ret = await bot.start(cfg); } catch (e) { err = e; }
  return { ex, bot, ret, err };
}

test('启动价格低于下界：一张单都不许铺', async () => {
  const { ex, bot, ret, err } = await boot({ price: 90 });
  assert.equal(err, null, `start 不应抛错，实际：${err?.message}`);
  assert.equal(ex.placed.length, 0, '区间外启动绝不允许提交开仓单');
  assert.equal(ex.orders.size, 0);
  assert.equal(bot.active.size, 0);
  assert.equal(bot.guardState.state, STATES.DEFENSIVE);
  assert.equal(bot.guardState.blockOpening, true);
  assert.ok(ret?.running === true, '实例保持运行态但等待，不进入正常网格');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('启动价格高于上界：同样一张不铺', async () => {
  const { ex, bot, err } = await boot({ price: 250 });
  assert.equal(err, null);
  assert.equal(ex.placed.length, 0, '上界外启动也不许铺单');
  assert.equal(bot.guardState.state, STATES.DEFENSIVE);
  assert.equal(bot.guardState.blockOpening, true);
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('首笔行情未到达（无有效价）：拒绝启动，不铺单', async () => {
  const { ex, bot, err } = await boot({ price: 0 });
  assert.ok(err, '没有有效价必须直接失败，而不是猜一个价格去铺单');
  assert.equal(ex.placed.length, 0);
  assert.equal(ex.orders.size, 0);
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('启动价格在区间内：正常铺单且状态 RUNNING', async () => {
  const { ex, bot, err } = await boot({ price: 150 });
  assert.equal(err, null);
  assert.ok(ex.placed.length > 0, '区间内应正常铺单');
  assert.equal(bot.guardState.state, STATES.RUNNING);
  assert.equal(bot.guardState.blockOpening, false);
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('一致性读不出来 = fail-closed：单次 DEFENSIVE，连续两次 HALTED', async () => {
  const { ex, bot } = await boot({ price: 150 });
  assert.equal(bot.guardState.state, STATES.RUNNING);

  ex.failPosition = true;
  await sleep(300);   // 先跨过 200ms 事件聚合窗（emit 是同步的）
  ex.emit('price', { marketId: 1, price: 150 });
  await sleep(50);
  assert.equal(bot.guardState.state, STATES.DEFENSIVE, '仓位读失败必须降级，不能默认放行');
  assert.equal(bot.guardState.blockOpening, true);

  // 第二次仍失败 → HALTED
  await sleep(300);
  ex.emit('price', { marketId: 1, price: 150 });
  await sleep(50);
  assert.equal(bot.guardState.state, STATES.HALTED, '连续失败必须熔断');

  // 接口恢复后，一致性回到 ok（HALTED 仍需人工清除）
  ex.failPosition = false;
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('HALTED 撤单以交易所真实订单为准：本地台账缺单也要撤掉', async () => {
  const { ex, bot } = await boot({ price: 150 });

  // 模拟"本地台账丢了一部分、交易所仍有单"
  const orphan = 'orphan-1';
  ex.orders.set(orphan, {
    marketId: 1, side: 'buy', price: 120, sizeBase: 1, reduceOnly: false, orderId: orphan,
  });
  // 再放一张真正的减仓单，HALT 时不许撤
  const keep = 'ro-keep';
  ex.orders.set(keep, {
    marketId: 1, side: 'sell', price: 190, sizeBase: 1, reduceOnly: true, orderId: keep,
  });
  bot.active.set(keep, {
    levelIndex: 20, side: 'sell', price: 190, sizeBase: 1,
    opening: false, reduceOnly: true, placedAt: Date.now(),
  });
  // 故意把这张孤儿单从本地台账里摘掉
  bot.active.delete(orphan);

  ex.balance = 4900;   // 跌破熔断线
  bot._runRiskCycle('timer');
  assert.equal(bot.guardState.state, STATES.HALTED);
  await sleep(1200);

  const left = [...ex.orders.keys()];
  assert.ok(!left.includes(orphan), '本地台账没有、交易所存在的普通单也必须被撤');
  assert.ok(left.includes(keep), 'reduce-only 单不得误撤');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('区间外启动后，价格回到区间内也不会自动铺单（需人工重启）', async () => {
  const { ex, bot } = await boot({ price: 90 });
  assert.equal(ex.placed.length, 0);
  await sleep(300);
  ex.price = 150;
  ex.emit('price', { marketId: 1, price: 150 });
  await sleep(300);
  assert.equal(ex.placed.length, 0, '闸门拦截后不存在自动补铺路径，必须人工确认后再启动');
  await bot.stop({ closePosition: false }).catch(() => {});
});