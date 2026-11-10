// test/mismatch-converge.test.js —— 账本不一致的「限时收敛」（2026-11-10 定稿）
//
// 背景：11-06 21:29 / 22:36、11-09 17:05 / 21:34 四次 mismatch 熔断，
// 全部在数秒内自行对齐，零次真错账 —— 假阳性率 100%。
// 根因是数据源时序：position 快照比 fills 事件早约 4–5 秒可见。
// 11-07 的「先强制拉取再判」不够：强制拉取那一拍，fills 端点里那笔成交还没出现。
//
// 新判据：不一致 → DEFENSIVE（禁新增开仓，不撤单）→ 0/30/60s 三次强制重拉
//         → 90s 内对齐则回 RUNNING → 90s 仍不一致才 HALTED（fail-closed 保留）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { STATES } from '../src/guard.js';

const MISMATCH = {
  ok: false,
  status: 'mismatch',
  issues: ['仓位不一致：交易所 0.0016 vs 本地 0.0018（Δ-0.0002）'],
};
const OK = { ok: true, status: 'ok', issues: [] };

function mkBot(seq, { canRefetch = true } = {}) {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.config = { marketId: 1, sizeBase: 0.0002, displayName: 'BTC-USD', mode: 'neutral' };
  bot.grid = { levels: [70_000, 90_000], spacing: 151.247 };
  bot.active = new Map();
  bot._untrackedFills = [];
  bot.ex = canRefetch ? { pollFillsNow: async () => {}, getPositionFresh: async () => null } : {};
  bot.guard = {
    isHalted: false,
    haltReason: null,
    haltedAt: null,
    halt(reason) { this.isHalted = true; this.haltReason = reason; this.haltedAt = Date.now(); },
    clearHalt() { this.isHalted = false; this.haltReason = null; return 'test'; },
  };
  bot.guardState = null;
  bot._guardLastState = null;
  bot._consistencyUnknownStreak = 0;
  bot._consistencyStaleStreak = 0;
  bot._mismatchWindow = null;
  bot._placementProgress = null;
  bot._retryQueue = [];
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(m);
  bot._changed = () => {};
  bot._guardCtx = () => ({
    price: 80_000, lower: 70_000, upper: 90_000,
    positionBase: 0, maxInventoryBase: 0.0068,
    equity: 150, startBalance: 150, now: Date.now(),
    outOfRange: false, mode: 'neutral',
  });
  bot._inventoryLimits = () => ({});
  let i = 0;
  bot._guardConsistency = () => seq[Math.min(i++, seq.length - 1)];
  bot.refetchCalls = 0;
  bot._forceMismatchRefetch = async () => { bot.refetchCalls += 1; };
  return bot;
}

test('窗口内是 DEFENSIVE：禁新增开仓，但不熔断、不撤单', () => {
  const bot = mkBot([MISMATCH]);
  const r = bot._applyGuard('t');
  assert.equal(r.state, STATES.DEFENSIVE);
  assert.equal(r.blockOpening, true);
  assert.equal(r.haltReason, null);
  assert.equal(bot.guard.isHalted, false);
});

test('三次强制重拉按 0/30/60s 节拍，不在同一拍连打', () => {
  const bot = mkBot([MISMATCH]);
  bot._applyGuard('t');
  assert.equal(bot.refetchCalls, 1, '首拍立刻重拉一次');
  bot._applyGuard('t');
  assert.equal(bot.refetchCalls, 1, '同一秒内不许再拉（防风暴）');
  bot._mismatchWindow.since -= 31_000;
  bot._mismatchWindow.inFlight = false;
  bot._applyGuard('t');
  assert.equal(bot.refetchCalls, 2, '约 30s 后第二次');
  bot._mismatchWindow.since -= 31_000;
  bot._mismatchWindow.inFlight = false;
  bot._applyGuard('t');
  assert.equal(bot.refetchCalls, 3, '约 60s 后第三次');
  bot._mismatchWindow.since -= 31_000;
  bot._mismatchWindow.inFlight = false;
  bot._applyGuard('t');
  assert.equal(bot.refetchCalls, 3, '第四次不再重拉——窗口耗尽，交判据');
  assert.equal(bot.guard.isHalted, true, '90s 后仍不一致：熔断');
});

test('窗口内对齐：回 RUNNING，并留一条「自愈」告警', () => {
  const bot = mkBot([MISMATCH, OK]);
  bot._applyGuard('t1');
  bot._applyGuard('t2');
  assert.equal(bot.guard.isHalted, false);
  assert.equal(bot._mismatchWindow, null, '窗口必须清掉');
  assert.match(bot._alerts.join('\n'), /已在 \d+s 内自行对齐/);
});

test('已在熔断时遇到 mismatch：不许把 HALTED 降级成 DEFENSIVE', () => {
  const bot = mkBot([MISMATCH]);
  bot.guard.isHalted = true;
  bot.guard.haltReason = '旧原因';
  const r = bot._applyGuard('t');
  assert.equal(bot.guard.isHalted, true, '粘滞熔断只能人工解除');
  assert.notEqual(r?.state, STATES.DEFENSIVE, '不许降级');
});

test('适配器无法强制重拉：不进窗口，当场按原判据熔断', () => {
  const bot = mkBot([MISMATCH], { canRefetch: false });
  bot._applyGuard('t');
  assert.equal(bot.guard.isHalted, true);
  assert.equal(bot._mismatchWindow, null, '没有收敛能力就不该开窗口');
});

// ── 死传感器接线：_untrackedFills ────────────────────────────────────────────
test('成交无法归属到本地订单时，必须落进 _untrackedFills（而不是永远 undefined）', () => {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.config = { marketId: 1, sizeBase: 0.0002, displayName: 'BTC-USD', mode: 'neutral', minOrderSize: 0.0001 };
  bot.grid = { levels: [70_000, 80_000], spacing: 151.247 };
  bot.active = new Map();          // 本地根本没有这张单
  bot.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
  bot.fills = [];
  bot._untrackedFills = [];
  bot._gridProfitRaw = 0;
  bot.outOfRange = false;
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(m);
  bot._changed = () => {};
  bot._runRiskCycle = () => {};
  bot._checkTrendFills = () => {};
  bot._queueReplacement = () => {};
  bot.posLedger = { applyFill: () => ({ applied: true }) };

  bot._handleFill({ orderId: 'unknown-1', side: 'sell', sizeBase: 0.0002, price: 75_000, marketId: 1 });
  assert.equal(bot._untrackedFills.length, 1, '这是全项目唯一的写点，必须有内容');
  assert.equal(bot._untrackedFills[0].orderId, 'unknown-1');
});

// ── 僵尸 progress 不许拦重锚 ─────────────────────────────────────────────────
// ── 窗口期被拦下的开仓腿必须补，不许留裸腿 ───────────────────────────────────
test('收敛窗口拦下的开仓腿：按档去重入队，恢复后补铺；熔断期间不补', () => {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.recovery = false;
  bot.config = { marketId: 1, sizeBase: 0.0002, mode: 'neutral' };
  bot._deferredOpenings = [];
  const placed = [];
  bot._place = async (o) => { placed.push(o); };

  bot._deferOpening({ levelIndex: 27, side: 'sell', price: 75_018.3 });
  bot._deferOpening({ levelIndex: 27, side: 'sell', price: 75_018.3 });  // 重复
  bot._deferOpening({ levelIndex: 28, side: 'sell', price: 75_169.5 });
  assert.equal(bot._deferredOpenings.length, 2, '同档只留一张');

  bot.guardState = { state: STATES.DEFENSIVE, blockOpening: true };
  bot._drainDeferredOpenings('still-defensive');
  assert.equal(bot._deferredOpenings.length, 2, '风控未恢复时不许补');

  bot.guardState = { state: STATES.HALTED };
  bot._drainDeferredOpenings('halted');
  assert.equal(bot._deferredOpenings.length, 2, '熔断期间不许补（已撤清，等重锚后 refill）');

  bot.guardState = { state: STATES.RUNNING, blockOpening: false };
  bot._drainDeferredOpenings('converged');
  assert.equal(bot._deferredOpenings.length, 0);
  assert.equal(placed.length, 2, '恢复后必须真的补出去');
  assert.equal(placed[0]._deferredAt, undefined, '内部字段不许传给下单');
});

test('过期（>5 分钟）的被拦开仓腿：丢弃并告警，不用旧价格补出去', () => {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.recovery = false;
  bot.guardState = { state: STATES.RUNNING, blockOpening: false };
  bot._deferredOpenings = [];
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(m);
  const placed = [];
  bot._place = async (o) => { placed.push(o); };

  bot._deferOpening({ levelIndex: 30, side: 'sell', price: 75_320.8 });
  bot._deferredOpenings[0]._deferredAt = Date.now() - 6 * 60_000;  // 模拟卡了 6 分钟
  bot._drainDeferredOpenings('late');
  assert.equal(placed.length, 0, '旧价格不能补出去（卖腿可能瞬间亏损成交）');
  assert.equal(bot._deferredOpenings.length, 0);
  assert.match(bot._alerts.join('\n'), /按过期丢弃/);
});

test('待铺队列超 32 条：挤掉的必须计数（否则又是一次静默丢弃）', () => {
  const bot = Object.create(GridBot.prototype);
  bot._deferredOpenings = [];
  bot._deferredDropped = 0;
  for (let i = 0; i < 40; i += 1) bot._deferOpening({ levelIndex: i, side: 'buy', price: 70_000 + i });
  assert.equal(bot._deferredOpenings.length, 32, '上限仍是 32');
  assert.equal(bot._deferredDropped, 8, '被挤掉的 8 条必须计数，不能静默 shift');
});

test('_placementInFlight：新鲜的非 complete = 在铺；僵尸记录 = 不在铺', () => {
  const bot = Object.create(GridBot.prototype);
  bot._placementProgress = { status: 'retrying', pending: 2, updatedAt: Date.now() };
  assert.equal(bot._placementInFlight(), true);
  bot._placementProgress = { status: 'retrying', pending: 2, updatedAt: Date.now() - 34_700_000 };
  assert.equal(bot._placementInFlight(), false, '34,700s 前的 retrying 是僵尸，不许拦恢复');
  bot._placementProgress = { status: 'complete', pending: 0, updatedAt: Date.now() };
  assert.equal(bot._placementInFlight(), false);
  bot._placementProgress = null;
  assert.equal(bot._placementInFlight(), false);
});
