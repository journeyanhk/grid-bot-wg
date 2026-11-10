// test/partial-fill-continuation.test.js —— 「同单续成交」不能再被算成未识别成交
//
// 2026-11-10 18:42 主网真事故：一张 0.0002 买单被交易所拆成两块推送
// （0.00013971 + 0.00006029，同一个 orderId c98515c21c824d45）。
// 第一块命中 this.active，随后 `_handleFill` 就 this.active.delete(id)；
// 5 秒后第二块带着同一个 orderId 到达，此时 act 为空 → 被记成「未识别成交」。
// 那个计数只增不减、强制重拉只会拿回同一笔历史成交 → 90 秒收敛窗口必然失败 →
// 账本一分不差（0.0030 vs 0.0030）也熔断，15 格裸腿在熔断里放了 11 小时。
//
// 修法：成交后把订单身份留在短 TTL 台账里，后续碎片按「同单续成交」认领。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';

const LEVELS = [74_110.8, 74_262.0, 74_413.3, 74_564.5, 74_715.8, 74_867.0, 75_018.3];

function mkBot() {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.outOfRange = false;
  bot.recovery = false;
  bot.config = {
    marketId: 1, sizeBase: 0.0002, minOrderSize: 0.0001, mode: 'neutral', displayName: 'BTC-USD',
  };
  bot.grid = { levels: LEVELS, spacing: 151.247 };
  bot.active = new Map();
  bot._recentOrderMeta = new Map();
  bot._untrackedFills = [];
  bot.stats = { buys: 0, sells: 0, volume: 0 };
  bot.fills = [];
  bot.posLedger = { value: 0, applyFill() {} };
  bot._runRiskCycle = () => {};
  bot._checkTrendFills = () => {};
  bot._queueReplacement = () => {};
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(m);
  bot._touch = () => {};
  bot._changed = () => {};
  return bot;
}

test('同一 orderId 的第二块成交：认领为续成交，不进未识别计数', () => {
  const bot = mkBot();
  const orderId = 'c98515c21c824d45';
  bot.active.set(orderId, { levelIndex: 3, price: 74_110.8, side: 'buy', opening: true });

  // 第一块：命中 active
  bot._handleFill({ orderId, marketId: 1, side: 'buy', sizeBase: 0.00013971, price: 74_110.8 });
  assert.equal(bot._untrackedFills.length, 0, '第一块是正常成交');
  assert.equal(bot.active.size, 0, '命中后即从 active 移除（既有行为不变）');
  assert.ok(bot._recentOrderMeta.has(orderId), '成交后必须留台账');

  // 第二块：同一个 orderId，active 已经没有它了
  bot._handleFill({ orderId, marketId: 1, side: 'buy', sizeBase: 0.00006029, price: 74_110.8 });
  assert.equal(bot._untrackedFills.length, 0, '续成交不能被算成未识别（这正是主网熔断的成因）');
  assert.equal(bot.fills[0].level, 3, '档位必须从台账恢复，不能退化成 null');
});

test('真的不认识 orderId：照样记账，仍进未识别计数（传感器不许被修坏）', () => {
  const bot = mkBot();
  bot._handleFill({ orderId: 'deadbeefdeadbeef', marketId: 1, side: 'buy', sizeBase: 0.0002, price: 74_110.8 });
  assert.equal(bot._untrackedFills.length, 1, '外部/丢失订单仍要暴露出来');
  assert.equal(bot._untrackedFills[0].orderId, 'deadbeefdeadbeef');
});

test('台账有上限：超 500 条会裁掉最旧的，不会无界增长', () => {
  const bot = mkBot();
  for (let i = 0; i < 620; i += 1) {
    bot._rememberOrderMeta(`oid${i}`, { levelIndex: i % 7, price: 74_000, opening: true });
  }
  assert.ok(bot._recentOrderMeta.size <= 500, `台账必须收敛，实际 ${bot._recentOrderMeta.size}`);
});

test('重锚（new-epoch）清空未识别计数：上一代的碎片不许跟着进新一代', async () => {
  const bot = mkBot();
  bot._untrackedFills = [{ orderId: 'x', side: 'buy', sizeBase: 1e-5, price: 74_000 }];
  bot._retryQueue = [];
  bot._placementProgress = { status: 'complete', updatedAt: Date.now(), pending: 0 };
  bot._haltSatisfied = false;
  bot._haltEnforceLastAt = 0;
  bot._deferredOpenings = [];
  bot._consistencyUnknownStreak = 1;
  bot._consistencyStaleStreak = 0;
  bot._startReconcileTimer = () => {};
  bot.posLedger = { value: 0.0028, reset(v) { this.value = v; } };
  bot.guard = {
    isHalted: true,
    haltReason: '账本不一致：存在 1 笔未识别成交',
    clearHalt() { this.isHalted = false; this.haltReason = null; return '账本不一致：存在 1 笔未识别成交'; },
  };
  bot.guardState = { state: 'HALTED' };
  bot._alert = () => {};
  bot._changed = () => {};
  // openOrders 两次快照一致且为空；持仓两次一致
  bot.ex = {
    fetchOpenOrders: async () => [],
    getPositionFresh: async () => ({ sizeBase: 0.003 }),
  };

  const res = await bot.beginNewRiskEpoch({ by: 'test', reason: '续成交假熔断' });
  assert.equal(res.ok, true);
  assert.equal(bot._untrackedFills.length, 0, '重锚后新一代不能再背着旧碎片');
  assert.equal(bot.posLedger.value, 0.003, '重锚以交易所真值为准');
});