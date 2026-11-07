// test/mismatch-refetch.test.js —— 「用某一瞬间的差代替差是否真的存在」
//
// 背景（2026-11-06 两次熔断同形：21:29 / 22:36）：
//   WS 先推来**新鲜的**仓位快照，成交推送晚到几秒。于是 stale 判据
//   （positionsFetchedAt < lastFillAtMs）失效——快照确实比上一笔成交新——
//   读出差一格 → 立即熔断；成交到达后账本自己对齐，熔断却粘滞 14 小时。
//
// 判据必须从「此刻差一格」改成「强制拉取之后仍然差」。三条约束：
//   ① 每次 mismatch 只强制拉一次（防风暴）
//   ② 拉取后仍不一致 → 照样熔断（fail-closed 不放松）
//   ③ 强制拉取失败不许当成「没有新成交」
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { STATES } from '../src/guard.js';

const MISMATCH = {
  ok: false,
  status: 'mismatch',
  issues: ['仓位不一致：交易所 0.0004 vs 本地 0.0006（Δ-0.0002）'],
};
const OK = { ok: true, status: 'ok', issues: [] };

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

test('瞬时不一致：先强制拉取，本轮不熔断', () => {
  const bot = mkBot([MISMATCH, OK]);
  bot._applyGuard('test');
  assert.equal(bot.refetchCalls, 1, '必须强制拉取一次');
  assert.equal(bot.guardState, null, '数据是旧的，此刻不许下任何结论');
  assert.equal(bot.guard.isHalted, false, '抢跑不许熔断');
});

test('每次 mismatch 只强制拉一次（防风暴）', () => {
  const bot = mkBot([MISMATCH]);
  bot._applyGuard('test');
  bot._applyGuard('test');
  bot._applyGuard('test');
  assert.equal(bot.refetchCalls, 1, '同一个 mismatch 只许触发一次强制拉取');
});

test('强制拉取后仍不一致：必须熔断（fail-closed 不放松）', () => {
  const bot = mkBot([MISMATCH]);
  bot._applyGuard('test');            // 第 1 轮：强制拉取，不判
  assert.equal(bot.guard.isHalted, false);
  bot._applyGuard('test');            // 第 2 轮：数据已重拉，仍差 → 真不一致
  assert.equal(bot.guard.isHalted, true, '拉取后仍不一致就是真错账，必须熔断');
  assert.equal(bot.guardState.state, STATES.HALTED);
  assert.match(bot.guard.haltReason, /仓位不一致/);
});

test('一致性恢复后标志重置：下次 mismatch 还能再拉一次', () => {
  const bot = mkBot([MISMATCH, OK, MISMATCH, OK]);
  bot._applyGuard('t1');              // mismatch → 拉 1 次
  bot._applyGuard('t2');              // ok → 重置
  bot._applyGuard('t3');              // mismatch → 再拉 1 次
  assert.equal(bot.refetchCalls, 2);
  assert.equal(bot.guard.isHalted, false);
});

test('适配器没有强制拉取能力时：不许跳过判据，必须照旧熔断', () => {
  const bot = mkBot([MISMATCH]);
  bot.ex = {};                        // 既无 pollFillsNow 也无 getPositionFresh
  bot._forceMismatchRefetch = async () => { throw new Error('不该被调用'); };
  bot._applyGuard('test');
  assert.equal(bot.guard.isHalted, true, '拿不到新数据就必须按原判据熔断');
});

// ── 熔断执行节流 ────────────────────────────────────────────────────────
function mkHaltBot({ satisfied, lastAt }) {
  const bot = Object.create(GridBot.prototype);
  bot.config = { marketId: 1 };
  bot.active = new Map();
  bot.guardState = { state: STATES.HALTED };
  bot._haltEnforceInFlight = false;
  bot._haltSatisfied = satisfied;
  bot._haltEnforceLastAt = lastAt;
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(m);
  bot.fetches = 0;
  bot.ex = {
    fetchOpenOrders: async () => { bot.fetches += 1; return []; },
    cancelOrder: async () => {},
  };
  return bot;
}

test('已确认清空后 5 分钟内不再拉 openOrders（堵住限流自噬）', async () => {
  const bot = mkHaltBot({ satisfied: true, lastAt: Date.now() - 60_000 });
  await bot._enforceHalt('test');
  assert.equal(bot.fetches, 0, '答案已经确定，这一分钟不该再花 weight 20');
});

test('已确认清空但超过 5 分钟：复查一次', async () => {
  const bot = mkHaltBot({ satisfied: true, lastAt: Date.now() - 6 * 60_000 });
  await bot._enforceHalt('test');
  assert.equal(bot.fetches, 1, '复查就是单发一次快照，确认无可撤单即降频');
});

test('尚未确认清空：15 秒内不重复拉，超过就重试', async () => {
  const fresh = mkHaltBot({ satisfied: false, lastAt: Date.now() - 5_000 });
  await fresh._enforceHalt('test');
  assert.equal(fresh.fetches, 0, '5 秒前刚拉过，不该每轮都拉');

  const stale = mkHaltBot({ satisfied: false, lastAt: Date.now() - 20_000 });
  await stale._enforceHalt('test');
  assert.ok(stale.fetches > 0, '15 秒以上必须重试撤单');
});

test('离开熔断后重置节流标记', async () => {
  const bot = mkHaltBot({ satisfied: true, lastAt: Date.now() });
  bot.guardState = { state: STATES.RUNNING };
  await bot._enforceHalt('test');
  assert.equal(bot._haltSatisfied, false);
  assert.equal(bot._haltEnforceLastAt, 0);
  assert.equal(bot.fetches, 0);
});