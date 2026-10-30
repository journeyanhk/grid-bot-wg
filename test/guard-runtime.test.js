// test/guard-runtime.test.js —— P0-1 运行时集成测试
//
// 目的：证明风控不是"只在 start 时跑一次的函数"，而是运行中真的接管了机器人。
// 刻意不调用 start / adjustRange / _recomputeRisk，只走正常运行事件（价格 tick、
// 定时巡检），验证状态能自己从 RUNNING 进 DEFENSIVE / HALTED 并拦住后续开仓。
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
    this.canceled = [];
    this._seq = 1;
    this.marketDefs = [{
      marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC',
      stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001, lastPrice: 150,
    }];
  }
  get equity() { return this.balance; }
  async init() { return true; }
  start() {}
  stop() {}
  async getMarkets() { return this.marketDefs; }
  getPrice() { return this.marketDefs[0].lastPrice; }
  getPosition(id) { return this.positions.get(Number(id)); }
  async setLeverage() { return true; }
  async placeLimitOrder(o) {
    const id = String(this._seq++);
    this.orders.set(id, {
      marketId: Number(o.marketId), side: o.side, price: Number(o.price),
      sizeBase: Number(o.sizeBase), reduceOnly: !!o.reduceOnly,
      levelIndex: o.levelIndex, orderId: id,
    });
    this.placed.push({ ...o, orderId: id });
    return { orderId: id };
  }
  async cancelOrder(marketId, id) {
    this.canceled.push(String(id));
    this.orders.delete(String(id));
    return true;
  }
  async cancelAll() { for (const id of [...this.orders.keys()]) this.orders.delete(id); return true; }
  async fetchOpenOrders() { return [...this.orders.values()]; }
  async closePosition() { this.positions.clear(); return true; }
}

const CFG = {
  marketId: 1, mode: 'neutral', lower: 100, upper: 200,
  gridCount: 10, sizeBase: 1, leverage: 3,
  outOfRangeAction: 'close', outDwellMs: 0,
};

async function makeBot(opts = {}) {
  const ex = new MockEx(opts);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await bot.start(CFG);
  return { ex, bot };
}

test('启动后是 RUNNING，且定时器已挂上', async () => {
  const { bot } = await makeBot();
  assert.equal(bot.guardState?.state, STATES.RUNNING);
  assert.ok(bot._riskTimer, '风控心跳定时器必须存在');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('运行中价格跌破下界 → 不调 start 也自动进 DEFENSIVE，并拦住开仓', async () => {
  const { ex, bot } = await makeBot();
  assert.equal(bot.guardState.state, STATES.RUNNING);

  const before = ex.placed.length;
  // 只走正常行情事件，绝不调用 start / adjustRange / _recomputeRisk
  await sleep(300);   // 先跨过 200ms 的事件聚合窗（emit 是同步的）
  ex.emit('price', { marketId: 1, price: 90 });
  await sleep(30);

  assert.equal(bot.guardState.state, STATES.DEFENSIVE, '价格破界后必须自动降级');
  assert.equal(bot.guardState.blockOpening, true);

  await bot._place({ levelIndex: 99, side: 'buy', price: 95, sizeBase: 1 });
  assert.equal(ex.placed.length, before, '破界后新开仓必须被拦截');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('运行中权益跌破熔断线 → 自动 HALTED，撤掉普通挂单但保留 reduce-only', async () => {
  const { ex, bot } = await makeBot();
  assert.equal(bot.guardState.state, STATES.RUNNING);
  const normalCount = ex.orders.size;
  assert.ok(normalCount > 0, '启动后应有普通挂单');

  // 手工放一张 reduce-only 单（模拟减仓腿），熔断时不许被误撤
  const roId = 'ro-keep-1';
  ex.orders.set(roId, {
    marketId: 1, side: 'sell', price: 190, sizeBase: 1,
    reduceOnly: true, levelIndex: 20, orderId: roId,
  });
  bot.active.set(roId, {
    levelIndex: 20, side: 'sell', price: 190, sizeBase: 1,
    opening: false, reduceOnly: true, placedAt: Date.now(),
  });

  // 亏损 100 > 熔断线 80
  ex.balance = 4900;
  bot._runRiskCycle('timer');
  assert.equal(bot.guardState.state, STATES.HALTED, '权益跌破熔断线必须 HALTED');
  assert.ok(bot.guard?.isHalted, '熔断必须写进持久化账本');

  await sleep(1200);   // 等 _enforceHalt 的两轮快照确认

  const left = [...ex.orders.keys()];
  assert.ok(!left.includes(roId) === false, 'reduce-only 单必须保留');
  assert.equal(left.length, 1, `普通挂单应被撤净，实际还剩 ${left.length} 张`);
  assert.equal(left[0], roId, '剩余的唯一一张必须是 reduce-only 单');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('熔断后重启（新实例读快照）仍是 HALTED，不会自动恢复', async () => {
  const { ex, bot } = await makeBot();
  ex.balance = 4900;
  bot._runRiskCycle('timer');
  assert.equal(bot.guardState.state, STATES.HALTED);
  const snap = bot.snapshot();
  assert.equal(snap.guard.haltReason !== null, true, '快照里必须带熔断原因');
  assert.equal(snap.guard.startBalance, 5000, '策略起点余额必须被锁定');
  await bot.stop({ closePosition: false }).catch(() => {});

  const ex2 = new MockEx({ balance: 4900 });
  const bot2 = new GridBot(ex2);
  bot2.restore(snap);
  assert.equal(bot2.guard.isHalted, true, '重启后仍是熔断态');
  await bot2.start(snap.config);          // 即便重新 start，也不许把 HALTED 洗掉
  assert.equal(bot2.guardState?.state, STATES.HALTED, 'start 不能清除既存熔断');
  await bot2.stop({ closePosition: false }).catch(() => {});
});

test('恢复清单要求真实挂单快照（本地 active 为 0 也不能空口放行）', async () => {
  const { ex, bot } = await makeBot();
  // 本地台账清空，但交易所仍有单
  bot.active.clear();
  const r = await bot.recoveryChecklist();
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => /交易所仍有/.test(m)), `应指出交易所有残留单：${r.missing.join('|')}`);

  // 真的全清了才可能通过（价格仍在区间内）
  ex.orders.clear();
  const r2 = await bot.recoveryChecklist();
  assert.ok(!r2.missing.some((m) => /交易所仍有|本地台账|重试队列/.test(m)),
    `清干净后不应再有挂单类阻塞：${r2.missing.join('|')}`);
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('仓位账本：只认成交，不认挂单；挂单多但空仓不得误报', async () => {
  const { ex, bot } = await makeBot();
  // 10 张挂单、0 持仓、账本 0 → 一致
  assert.equal(bot.posLedger.value, 0);
  assert.equal(bot.guardState.state, STATES.RUNNING, '挂单不是持仓，不能触发熔断');

  // 成交一笔 buy 0.5 → 账本 +0.5
  bot.posLedger.applyFill({ orderId: 'f1', side: 'buy', sizeBase: 0.5, price: 150, rawTs: '100' });
  assert.equal(bot.posLedger.value, 0.5);
  // 重复投递同一条 → 不重复记账
  const dup = bot.posLedger.applyFill({ orderId: 'f1', side: 'buy', sizeBase: 0.5, price: 150, rawTs: '100' });
  assert.equal(dup.duplicate, true);
  assert.equal(bot.posLedger.value, 0.5, '重复事件不得重复增加仓位');

  // 交易所仓位与账本不符 → 一致性巡检判不一致
  ex.positions.set(1, { sizeBase: 0.2, entryPrice: 150, unrealizedPnl: 0, leverage: 3 });
  const c = bot._guardConsistency();
  assert.equal(c.ok, false, '仓位差必须被发现');
  await bot.stop({ closePosition: false }).catch(() => {});
});