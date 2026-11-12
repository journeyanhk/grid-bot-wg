// test/instrument-lifecycle.test.js —— 「没有清空路径的字段，迟早会被当成现值读」
//
// 2026-11-12 巡检里三处同族接线不完整（用户裁决书写成通则）：
//  ① startBlockedReason 只在 _start() 成功分支清 → new-epoch 救活的路径永远留着旧话
//  ② guard=DEFENSIVE reason= 空 20 小时 —— reasons 从不进 guardReason 字段
//  ③ haltResolved=False 而 haltReason=null（这一条在巡检脚本侧修，见 ~/arcus_inspect.py）
// 这里锁住 ① 与 ②。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';

function mkBot() {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.recovery = false;
  bot.outOfRange = false;
  bot.config = {
    marketId: 1, sizeBase: 0.0002, mode: 'neutral', displayName: 'BTC-USD',
    lower: 70_000, upper: 80_000, gridCount: 2,
  };
  bot.grid = { levels: [74_000, 74_151], spacing: 151.247, count: 2 };
  bot.active = new Map();
  bot.stats = { buys: 0, sells: 0, volume: 0, completedRungs: 0, gridProfit: 0 };
  bot.fills = [];
  bot.alerts = [];
  bot._retryQueue = [];
  bot._untrackedFills = [];
  bot._deferredOpenings = [];
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(m);
  bot._changed = () => {};
  bot._touch = () => {};
  bot._startBlocked = '已有熔断记录：账本不一致：存在 1 笔未识别成交';
  bot.guard = {
    isHalted: false,
    clearHalt: () => '旧原因',
    toJSON: () => null,
  };
  bot.guardState = {
    state: 'DEFENSIVE',
    reasons: ['账本不一致收敛中（12s/90s，重拉 1 次）'],
    blockOpening: true, blockSide: null, haltReason: null,
  };
  bot._projectedInventory = () => ({ projected: 0.005, pending: 0.0006, side: 'long' });
  bot.ex = {
    getPosition: () => ({ sizeBase: 0.0044, entryPrice: 74_034.5, unrealizedPnl: -1.2 }),
    balance: 100, equity: 145, realizedPnl: -2, feeRate: 0.0001, dataSource: 'test',
    getPrice: async () => 73_763,
  };
  return bot;
}

test('② guardReason 在 DEFENSIVE 时必须带上 reasons（空原因告警等于没告警）', () => {
  const s = mkBot().getState();
  assert.ok(s.guardReason && s.guardReason.length > 0, 'guardReason 不能为空');
  assert.match(s.guardReason, /收敛中/, '必须把收敛窗口进度写进去');
});

test('④ guardState 一律是对象，字符串走 guardStateName（一个名字只允许一种语义）', () => {
  const s = mkBot().getState();
  assert.equal(typeof s.guardState, 'object');
  assert.equal(s.guardState.state, 'DEFENSIVE');
  assert.equal(s.guardStateName, 'DEFENSIVE');
  assert.equal(typeof s.guardState.reasons, 'object');
});

test('① clearHalt 必须清掉 startBlocked（熔断解除后旧话不再成立）', () => {
  const bot = mkBot();
  const r = bot.clearHalt('tester');
  assert.equal(r.ok, true);
  assert.equal(bot._startBlocked, null, '解除熔断后 startBlocked 必须为 null');
});

test('① 铺单批次铺完（complete）也必须清掉 startBlocked', () => {
  const bot = mkBot();
  bot._placementProgress = {
    action: 'start', target: 2, confirmedLevels: [0, 1], pendingLevels: [], failedLevels: [],
    status: 'complete', updatedAt: Date.now(), initialPassDone: false,
  };
  bot._refreshPlacementProgress = () => {};   // 只为隔离被测行为
  bot._finishPlacementPass();
  assert.equal(bot._startBlocked, null, '铺单成功即证明「被风控拦住」已不成立');
});