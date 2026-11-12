// test/reduce-position.test.js —— 人工减仓接口的八条硬约束
//
// 2026-11-12 用户裁决：写 /api/ar/reduce，但它不是自动交易器，
// **首要价值是消灭「在交易所界面手动挂 reduce-only 单 → 落进 _untrackedFills」
// 那条危险路径**（2026-11-10 就是这么停摆 19 小时的）。
//
// 每条约束一个用例；再加两条「成交之后账本与统计不许被污染」。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';

const LEVELS = [73_808.3, 73_959.5, 74_110.8, 74_262.0, 74_413.3, 74_564.5];

function mkBot({ sizeBase = 0.0002, held = 0.005, guardState = 'RUNNING', outOfRange = false, retry = 0, lastPrice = 74_000 } = {}) {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.outOfRange = outOfRange;
  bot.recovery = false;
  bot.lastPrice = lastPrice;
  bot.config = {
    marketId: 1, sizeBase, minOrderSize: 0.0001, mode: 'neutral', displayName: 'BTC-USD',
    maxReduceGrids: 10,
  };
  bot.grid = { levels: LEVELS, spacing: 151.247 };
  bot.active = new Map();
  bot._recentOrderMeta = new Map();
  bot._untrackedFills = [];
  bot._retryQueue = Array.from({ length: retry }, (_, i) => ({ levelIndex: i }));
  bot._reduceInFlight = null;
  bot._coidSeq = 0;
  bot.stats = { buys: 0, sells: 0, volume: 0, completedRungs: 0, gridProfit: 0 };
  bot._gridProfitRaw = 0;
  bot.fills = [];
  bot.posLedger = { value: held, applyFill() { bot._ledgerApplied = (bot._ledgerApplied || 0) + 1; } };
  bot.guard = { isHalted: guardState === 'HALTED' };
  bot.guardState = { state: guardState, reasons: [], blockOpening: false, blockSide: null };
  bot._runRiskCycle = () => {};
  bot._checkTrendFills = () => {};
  bot._queueReplacement = () => { bot._replacementQueued = true; };
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(m);
  bot._touch = () => {};
  bot._changed = () => {};
  bot.heldNow = held;
  bot.placed = [];
  bot.ex = {
    getPosition: () => ({ sizeBase: bot.heldNow, entryPrice: 74_000 }),
    getPositionFresh: async () => ({ sizeBase: bot.heldNow, entryPrice: 74_000 }),
    getPrice: async () => bot.lastPrice,
    placeLimitOrder: async (o) => {
      bot.placed.push(o);
      // 立即成交：多头减仓=卖出→变小；空头减仓=买入→向 0 靠拢
      const q = Number(o.sizeBase);
      bot.heldNow = Number((bot.heldNow > 0 ? bot.heldNow - q : bot.heldNow + q).toFixed(10));
      return { orderId: 'r1', clientOrderId: o.clientOrderId };
    },
  };
  return bot;
}

const ARGS = { sizeBase: 0.001, by: 'agent', reason: '完成格停转 12h+ 且 projected≥30 格', waitMs: 0 };

test('1. sizeBase 必须是 sizeBase 的整数倍（碎量不许进账本）', async () => {
  const bot = mkBot();
  await assert.rejects(() => bot.reducePosition({ ...ARGS, sizeBase: 0.00013 }), /整数倍/);
  assert.equal(bot.placed.length, 0);
});

test('2. 单次上限 10 格，超过必须走全平', async () => {
  const bot = mkBot({ held: 0.005 });
  await assert.rejects(() => bot.reducePosition({ ...ARGS, sizeBase: 0.003 }), /单次减仓上限/);
  assert.equal(bot.placed.length, 0);
});

test('3. 熔断状态拒绝动仓', async () => {
  const bot = mkBot({ guardState: 'HALTED' });
  await assert.rejects(() => bot.reducePosition(ARGS), /熔断状态不许动仓/);
});

test('4. 价格在区间外拒绝（走破界处置路径）', async () => {
  const bot = mkBot({ outOfRange: true });
  await assert.rejects(() => bot.reducePosition(ARGS), /区间外/);
});

test('5. retryQueue 非空拒绝（台账不干净时不动仓）', async () => {
  const bot = mkBot({ retry: 2 });
  await assert.rejects(() => bot.reducePosition(ARGS), /重试队列非空/);
});

test('6. 在途减仓拒绝（幂等，防连点）', async () => {
  const bot = mkBot();
  bot._reduceInFlight = { at: Date.now(), sizeBase: 0.001 };
  await assert.rejects(() => bot.reducePosition(ARGS), /仍在途/);
});

test('7. 无持仓 / 超过持仓 都拒绝', async () => {
  const flat = mkBot({ held: 0 });
  await assert.rejects(() => flat.reducePosition(ARGS), /没有持仓/);
  const small = mkBot({ held: 0.0004 });
  await assert.rejects(() => small.reducePosition(ARGS), /超过当前持仓/);
});

test('8. 正常路径：reduceOnly + IOC + 卖方向，返回体带齐现场量', async () => {
  const bot = mkBot({ held: 0.005 });
  const r = await bot.reducePosition(ARGS);
  assert.equal(bot.placed.length, 1);
  const o = bot.placed[0];
  assert.equal(o.reduceOnly, true, 'must be reduce-only');
  assert.equal(o.postOnly, false, 'IOC：风险动作要成交，不挂 ALO 等回调');
  assert.equal(o.side, 'sell', '多头减仓 = 卖出');
  assert.ok(o.price < 74_000, '卖价必须穿过盘口才有成交把握');
  assert.equal(r.ok, true);
  assert.deepEqual(
    [r.beforeSize, r.filledSize, r.afterSize, r.unfilled],
    [0.005, 0.001, 0.004, 0],
  );
  assert.ok(Number.isFinite(r.afterLedger), '返回体必须带账本现值（不可见的动作等于没发生）');
});

test('9. 持仓为负（空头）时减仓方向是买入', async () => {
  const bot = mkBot({ held: -0.004 });
  const r = await bot.reducePosition({ ...ARGS, sizeBase: 0.0006, waitMs: 0 });
  assert.equal(bot.placed[0].side, 'buy');
  assert.equal(r.filledSize, 0.0006);
});

test('10. 减仓成交不许污染网格统计：completedRungs / gridProfit / 补腿 全不动', () => {
  const bot = mkBot();
  // 模拟减仓单的身份登记（reducePosition 内部做的事）
  bot._rememberOrderMeta('r1', { levelIndex: -1, price: 73_970, opening: false, recovery: false, manual: true });
  const before = { rungs: bot.stats.completedRungs, profit: bot.stats.gridProfit };
  bot._handleFill({ orderId: 'r1', marketId: 1, side: 'sell', sizeBase: 0.001, price: 73_970 });
  assert.equal(bot.stats.completedRungs, before.rungs, '人工减仓不是完成一格网格');
  assert.equal(bot.stats.gridProfit, before.profit, '人工减仓不许记格利');
  assert.equal(bot._replacementQueued, undefined, '人工减仓不许被对腿补回来');
  assert.equal(bot._untrackedFills.length, 0, '它必须被认出来（这正是本接口存在的理由）');
  assert.equal(bot._ledgerApplied, 1, '成交必须推进 posLedger');
});

test('11. 减仓后核对不平 → 立刻告警 reduce-mismatch', async () => {
  const bot = mkBot({ held: 0.004 });
  bot.posLedger.value = 0.005; // 账本比交易所多一格 → 不平
  const v = await bot._verifyReduce('r1');
  assert.ok(Math.abs(v.delta) > 0, 'delta 不该是 0');
  assert.ok(bot._alerts.some((m) => /账本不平/.test(m)), '必须告警');
});

test('12. 减仓后核对一致 → 通过且带现场量', async () => {
  const bot = mkBot({ held: 0.004 });
  bot.posLedger.value = 0.004;
  const v = await bot._verifyReduce('r1');
  assert.equal(v.delta, 0);
  assert.ok(bot._alerts.some((m) => /核对通过/.test(m)));
});