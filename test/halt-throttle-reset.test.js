// test/halt-throttle-reset.test.js —— 熔断节流的复位、单飞、写路径不重试
//
// 背景（2026-11-07 代码 review）：
//   P2-1 安全回归：_haltSatisfied 的复位写在 _enforceHalt 的 `!= HALTED` 分支里，
//        而 _enforceHalt 的唯一调用点已判过 `r.state === HALTED` —— 死代码。
//        后果：解除熔断后 5 分钟内再次熔断 → gap 仍按「已确认清空」算 →
//        一次撤单都不发，交易所上的非减仓单继续挂着跑。
//   P2-2 pollFillsNow() 直接调 _pollFills()，绕过 _startLoop 的 _loops 防重入锁
//        → 并发拉取，权重 ×2（去重靠 _fillsSeen 所以不会重复记账）。
//   P3-1 mismatch 复跑被 _guardInFlight 丢掉时静默。
//   写路径：placeLimitOrder / cancelOrder 本来就不走 _retry，长退避不该影响它们——
//        这里用一条会立刻抛的行为测试把这件事钉住，防止以后有人给它套上 _retry。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { ArcusExchange } from '../src/exchange/ar/arcus.js';
import { STATES } from '../src/guard.js';
import { logger } from '../src/log.js';

const OK = { ok: true, status: 'ok', issues: [] };
const BAD = { ok: false, status: 'mismatch', issues: ['仓位不一致：交易所 0.0004 vs 本地 0.0006'] };

function mkBot(seq) {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.config = { marketId: 1, sizeBase: 0.0002, displayName: 'BTC-USD', mode: 'neutral' };
  bot.grid = { levels: [70_000, 90_000], spacing: 151.247 };
  bot.active = new Map();
  bot.ex = { pollFillsNow: async () => {}, getPositionFresh: async () => null };
  bot.guard = {
    isHalted: false,
    haltReason: null,
    halt(reason) { this.isHalted = true; this.haltReason = reason; },
  };
  bot.guardState = null;
  bot._guardLastState = null;
  bot._consistencyUnknownStreak = 0;
  bot._consistencyStaleStreak = 0;
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(m);
  bot._changed = () => {};
  bot._mismatchRefetched = false;
  bot._haltSatisfied = true;      // 模拟「上一轮熔断已确认清空」
  bot._haltEnforceLastAt = Date.now();  // 且刚执行过（这正是 bug 的触发前提）
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

test('P2-1：进入熔断那一刻复位节流标记（否则下一次熔断不撤单）', () => {
  // 状态：RUNNING（节流标记是上一次熔断留下的 true + 刚执行过的时间戳）
  const bot = mkBot([BAD]);
  bot.guardState = { state: STATES.RUNNING, reasons: [], metrics: {} };
  bot._guardLastState = STATES.RUNNING;
  bot._forceMismatchRefetch = async () => {};
  // 2026-11-10：第一次 mismatch 不再「只拉一次然后什么都不说」，而是开一个
  // 90 秒收敛窗口（DEFENSIVE）。判定仍不一致要等窗口耗尽，所以这里把 since 回拨。
  bot._applyGuard('test');
  assert.equal(bot._mismatchWindow?.attempts, 1, '第一次 mismatch 应开窗并强制拉取');

  bot._mismatchWindow.since -= 91_000;
  bot._mismatchWindow.inFlight = false;
  bot._applyGuard('test');
  assert.equal(bot.guardState.state, STATES.HALTED, '窗口耗尽仍不一致必须熔断');
  assert.equal(bot._haltSatisfied, false, '进入熔断必须把「已确认清空」复位');
  assert.equal(bot._haltEnforceLastAt, 0, '进入熔断必须把节流时间戳清零');
});

test('P2-1 反面：熔断期间重复评估不会把标记又翻回去', () => {
  const bot = mkBot([BAD]);
  bot.guardState = { state: STATES.HALTED, reasons: [], metrics: {} };
  bot._guardLastState = STATES.HALTED;
  bot._haltSatisfied = false;
  bot._haltEnforceLastAt = 12345;      // 已经在这个熔断周期里执行过一次
  bot._mismatchRefetched = true;
  bot.guard.isHalted = true;
  bot._applyGuard('test');
  assert.equal(bot._haltEnforceLastAt, 12345, '同一熔断周期内不该被反复清零（否则退化成每 5 秒撤一次）');
});

test('P3-1：复跑撞上并发锁时明确告警，不静默丢弃', () => {
  const bot = mkBot([OK]);
  bot._guardInFlight = true;
  const warns = [];
  const orig = logger.warn;
  logger.warn = (scope, msg) => warns.push(`${scope}:${msg}`);
  try {
    bot._runRiskCycle('mismatch-refetch');
  } finally {
    logger.warn = orig;
  }
  assert.equal(warns.length, 1, '应打一行 warn');
  assert.match(warns[0], /mismatch|复跑|丢弃/);
});

test('P3-1 反面：普通 timer 被并发锁丢弃时不刷告警', () => {
  const bot = mkBot([OK]);
  bot._guardInFlight = true;
  const warns = [];
  const orig = logger.warn;
  logger.warn = (scope, msg) => warns.push(`${scope}:${msg}`);
  try {
    bot._runRiskCycle('timer');
  } finally {
    logger.warn = orig;
  }
  assert.equal(warns.length, 0, '高频 timer 撞锁是正常现象，不该告警');
});

// ── P2-2 单飞 ────────────────────────────────────────────────────────────────
function mkAdapter() {
  const a = Object.create(ArcusExchange.prototype);
  a._fillsFromMs = Date.now() - 60_000;
  a._fillsSeen = new Set();
  a._fillsPrimed = true;
  a._startedAt = Date.now();
  a._tracked = new Map();
  a._lastFillPollAt = 0;
  a._pollFillsPromise = null;
  a.fetches = 0;
  a.handled = [];
  // 让一次拉取有真实耗时，才能观察到并发
  a._fetchFillRows = async () => {
    a.fetches += 1;
    await new Promise((r) => setTimeout(r, 30));
    return [];
  };
  a._onFill = (f) => a.handled.push(f);
  return a;
}

test('P2-2：pollFillsNow 与定时轮询并发时只真正拉一次', async () => {
  const a = mkAdapter();
  await Promise.all([a._pollFills(), a.pollFillsNow(), a._pollFills()]);
  assert.equal(a.fetches, 1, `并发三次应只发一次请求，实际 ${a.fetches} 次`);
});

test('P2-2 反面：串行调用仍是两次（单飞不能把后续请求也吃掉）', async () => {
  const a = mkAdapter();
  await a._pollFills();
  await a._pollFills();
  assert.equal(a.fetches, 2);
});

test('P2-2：单飞句柄在失败后必须释放，否则拉取永久停摆', async () => {
  const a = mkAdapter();
  let boom = true;
  a._fetchFillRows = async () => {
    a.fetches += 1;
    if (boom) throw new Error('boom');
    return [];
  };
  await assert.rejects(() => a._pollFills(), /boom/);
  boom = false;
  await a._pollFills();
  assert.equal(a._pollFillsPromise, null, '句柄必须已释放');
  assert.equal(a.fetches, 2, '失败后下一次必须能真的重试');
});

// ── 写路径不吃长退避 ─────────────────────────────────────────────────────────
test('写路径：placeLimitOrder 遇 429 立刻抛，不进 _retry 长退避', async () => {
  const a = Object.create(ArcusExchange.prototype);
  a._market = () => ({
    tradable: true, symbol: 'BTC-USD', stepPrice: 0.1, stepSize: 0.00000001,
    minOrderNotional: 5, minOrderSize: 0.0001,
  });
  a.address = '0xabc';
  a.accountIndex = 0;
  a._nowNs = () => 1_700_000_000_000_000_000n;
  a._payload1 = () => ({});
  a._headers = () => ({});
  a._tracked = new Map();
  a._watch = new Set();
  a._http = async () => {
    throw Object.assign(new Error('Arcus 限流（ip）：rate limited'), { rateLimited: true, status: 429 });
  };
  const t0 = Date.now();
  await assert.rejects(
    () => a.placeLimitOrder({ marketId: 1, price: 75_000, sizeBase: 0.0002, side: 'buy', levelIndex: 3 }),
    /rate limited/,
  );
  const dt = Date.now() - t0;
  assert.ok(dt < 500, `写路径必须立刻失败（交给 bot 层 _queueRetry），实际耗时 ${dt}ms`);
});