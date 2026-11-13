// test/stop-reason.test.js —— 「为什么停」必须是可读的现值，不是化石
//
// 2026-11-13 10:14 破界平仓停机后，state 里能读到的唯一「原因」是
// `startBlockedReason="已有熔断记录：账本不一致：存在 1 笔未识别成交"`。
// 那是一天前另一世代的化石；真正的原因（breakout）**一个字都没有**，
// 因为 `_noteAutoStop()` 整段被 `if (!dynamic.enabled) return` 挡住。
// 同一族的第二处：库存 warn 档文案说「进入防守」，而它 blockOpening=false，
// 读起来像已经限买 —— 抄送行必须写成「未限制买入；30 格禁买 / 34 格熔断」。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { evaluateRisk } from '../src/guard.js';

function mkBot({ dynamicEnabled = false } = {}) {
  const bot = Object.create(GridBot.prototype);
  bot.config = {
    marketId: 1, lower: 70_632.1, upper: 80_614.4, sizeBase: 0.0002,
    maxInventoryGrids: 34, inventoryWarnGrids: 20, inventoryBlockGrids: 30, inventoryHaltGrids: 34,
    dynamic: { enabled: dynamicEnabled },
  };
  bot._lastStop = null;
  bot._autoStopped = null;
  return bot;
}

test('_noteAutoStop 在未启用动态网格时也要记下停机原因（破界平仓的默认形态）', () => {
  const bot = mkBot({ dynamicEnabled: false });
  bot._noteAutoStop('breakout');
  assert.equal(bot._lastStop?.reason, 'breakout');
  assert.ok(Number(bot._lastStop?.at) > 0);
  assert.equal(bot._autoStopped, null, '动态网格未启用时不该伪造冷静门状态');
});

test('_inventoryLimits 必须把「格」一并交出去，否则告警文案只能说「进入防守」', () => {
  const bot = mkBot();
  const L = bot._inventoryLimits();
  assert.equal(L.inventoryWarnGrids, 20);
  assert.equal(L.inventoryBlockGrids, 30);
  assert.equal(L.inventoryHaltGrids, 34);
  assert.ok(Math.abs(L.inventoryBlockFrac - 30 / 34) < 1e-9);
});

test('库存 warn 档文案：必须写明「未限制买入」并给出禁买/熔断格数', () => {
  const r = evaluateRisk(
    { price: 71_000, lower: 70_632.1, upper: 80_614.4, positionBase: 0.0056, inventoryBase: 0.0056, maxInventoryBase: 0.0068, mode: 'neutral' },
    { inventoryWarnFrac: 20 / 34, inventoryBlockFrac: 30 / 34, inventoryHaltFrac: 1, inventoryBlockGrids: 30, inventoryHaltGrids: 34 },
  );
  const text = r.reasons.join('；');
  assert.match(text, /库存预警 \d+%（未限制买入；30 格禁买 \/ 34 格熔断）/, '实际：' + text);
  assert.equal(r.blockOpening, false, 'warn 档只变色，不拦开仓');
  assert.equal(r.blockSide, null);
});

test('库存 warn 档不传格数时退回短文案，不许崩', () => {
  const r = evaluateRisk(
    { price: 71_000, lower: 70_632.1, upper: 80_614.4, positionBase: 0.0056, inventoryBase: 0.0056, maxInventoryBase: 0.0068 },
    { inventoryWarnFrac: 0.5, inventoryBlockFrac: 0.9, inventoryHaltFrac: 1 },
  );
  assert.match(r.reasons.join('；'), /库存预警 \d+%（未限制买入）/);
  assert.doesNotMatch(r.reasons.join('；'), /进入防守/);
});
test('_clearDeferredOpenings：启动即清，返回清掉的条数（重启不许带旧价腿）', () => {
  const bot = mkBot();
  bot._deferredOpenings = [
    { levelIndex: 21, price: 70_632.1, _deferredAt: Date.now() - 60_000 },
    { levelIndex: 22, price: 70_480.9, _deferredAt: Date.now() - 30_000 },
  ];
  assert.equal(bot._clearDeferredOpenings('start'), 2);
  assert.deepEqual(bot._deferredOpenings, []);
  assert.equal(bot._clearDeferredOpenings('start'), 0, '幂等：没东西可清时返回 0');
});

test('重锚后 guardState 不许自相矛盾：state=RUNNING 时 blockOpening 必须 false、reasons 清空', async () => {
  const bot = mkBot();
  bot.guardState = { state: 'DEFENSIVE', reasons: ['库存 82%…', '价格在区间外'], blockOpening: true, blockSide: null };
  bot.active = new Map();
  bot._retryQueue = [];
  bot._placementProgress = null;
  bot._untrackedFills = [];
  bot._deferredOpenings = [];
  bot.posLedger = { value: 0.0056, reset(v) { this.value = v; return this; } };
  bot.guard = { clearHalt() { return { reason: '账本不一致' }; } };
  bot.ex = {
    fetchOpenOrders: async () => [],
    getPositionFresh: async () => ({ sizeBase: 0 }),
  };
  bot._startReconcileTimer = () => {};
  bot._alert = () => {};
  bot._changed = () => {};
  const r = await bot.beginNewRiskEpoch({ by: 'test', reason: '单测' });
  assert.equal(r.ok, true);
  assert.equal(bot.guardState.state, 'RUNNING');
  assert.equal(bot.guardState.blockOpening, false, 'state=RUNNING 时 blockOpening 必须 false');
  assert.deepEqual(bot.guardState.reasons, [], '上一代 reasons 不许冒充现值');
  assert.equal(bot.posLedger.value, 0, '账本重锚到交易所真值');
});

test('_newEpochIssues：任何一个脏字段都要被点名（重锚不许自称干净）', () => {
  const bot = mkBot();
  bot.active = new Map();
  bot._retryQueue = [];
  bot._untrackedFills = [];
  bot._deferredOpenings = [];
  bot.posLedger = { value: 0 };
  bot.guardState = bot._newGuardEpoch();
  assert.deepEqual(bot._newEpochIssues(), [], '干净起点不该报问题');

  bot.guardState.blockOpening = true;
  bot._untrackedFills.push({ orderId: 'x' });
  bot._retryQueue.push({});
  bot._deferredOpenings.push({});
  const issues = bot._newEpochIssues();
  for (const k of ['blockOpening', 'untrackedFills', 'retryQueue', 'deferredOpenings']) {
    assert.ok(issues.some((s) => s.includes(k)), `必须点名 ${k}，实际：${issues.join('|')}`);
  }
});

test('_newGuardEpoch：整体替换而不是在旧对象上删字段', () => {
  const bot = mkBot();
  const old = { state: 'DEFENSIVE', reasons: ['a'], blockOpening: true, blockSide: 'buy', haltReason: 'x', metrics: { m: 1 }, 未来字段: '会漏' };
  bot.guardState = old;
  const fresh = bot._newGuardEpoch();
  assert.equal(fresh.state, 'RUNNING');
  assert.deepEqual(fresh.reasons, []);
  assert.equal(fresh.blockOpening, false);
  assert.equal(fresh.haltReason, null);
  assert.equal('未来字段' in fresh, false, '替换后上一个世代的多余字段不该跟着进来');
});

test('_clearDeferredOpenings 必须计数（静默丢弃是第 5 类反复出事的家族）', () => {
  const bot = mkBot();
  bot._deferredOpenings = [{ levelIndex: 21 }, { levelIndex: 22 }];
  assert.equal(bot._clearDeferredOpenings('start'), 2);
  assert.equal(bot._deferredDropped, 2);
  assert.equal(bot._deferredDroppedReason, 'start');
});
