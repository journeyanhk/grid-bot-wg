// test/start-gate-structure.test.js —— 「监护先于意图」的结构级守卫
//
// 2026-11-09 11:40 评审要求：分支级修复（在 `if (blocked)` 里补 `_startReconcileTimer()`）
// 只在「已知的那条闸门」上正确，下一个新闸门会重犯。所以这里钉四件事：
//   ① 枚举 `_startBlockedReason()` 的每一种理由，每条早退路径都必须有心跳；
//   ② 源码顺序：`_start()` 里定时器必须出现在闸门取值之前（结构级，不是分支级）；
//   ③ 停止侧对称：`_stopReconcileTimer()` 不许顺手掐掉风控心跳；
//   ④ 「上一轮为什么没铺单」必须进快照，重启后还能看见。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { GridBot } from '../src/bot.js';

class MockEx extends EventEmitter {
  constructor(o = {}) {
    super();
    this.mode = 'paper'; this.dataSource = 'real'; this.feeRate = 0; this.displayFeeRate = 0;
    this.balance = 5000; this.orders = new Map(); this.positions = new Map();
    this.placed = []; this.price = o.price ?? 150; this._seq = 1;
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

function makeBot() {
  const ex = new MockEx({ price: 150 });
  return { ex, bot: new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 }) };
}

// 枚举：`_startBlockedReason()` 目前能返回的全部理由（写分支的人加一条，这里就要加一条；
// 这条清单不完整时，下面的结构顺序测试仍然兜底）。
const BLOCKED_REASONS = [
  '缺少网格配置',
  '尚未取得有效的最新价',
  '最新价 100 在区间 [200, 300] 之外',
  '价格处于破界状态（99）',
  '已有熔断记录：仓位缓存连续 12 轮落后于成交',
  '风控状态未建立（guardState 为空）',
  '风控状态为 DEFENSIVE',
  '启动前投影库存 9.0 已超上限 8.0（持仓 0 + 近价同向挂单 9）',
];

for (const reason of BLOCKED_REASONS) {
  test(`早退分支「${reason.slice(0, 14)}…」：一张不铺，但心跳必须活着`, async () => {
    const { ex, bot } = makeBot();
    bot._startBlockedReason = () => reason;
    await bot.start(CFG);
    assert.equal(ex.placed.length, 0, '闸门拦下时绝不允许铺单');
    assert.equal(bot.active.size, 0);
    assert.ok(bot._reconTimer, '对账定时器必须已启动');
    assert.ok(bot._riskTimer, '风控心跳必须已启动');
    assert.equal(bot._placementProgress, null, '没铺单就不许留 progress');
    const s = bot.getState();
    assert.equal(s.reconcile.timerActive, true);
    assert.equal(s.startBlockedReason, reason);
    await bot.stop({ closePosition: false }).catch(() => {});
  });
}

test('结构级：_start() 里定时器必须出现在闸门取值之前', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/bot.js'), 'utf8');
  const startAt = src.indexOf('async _start(');
  const endAt = src.indexOf('async stop(', startAt);
  assert.ok(startAt > 0 && endAt > startAt, '定位不到 _start() 函数体');
  const body = src.slice(startAt, endAt);
  const timerAt = body.indexOf('this._startReconcileTimer()');
  const gateAt = body.indexOf('this._startBlockedReason()');
  assert.ok(timerAt > 0, '_start() 里必须启动对账定时器');
  assert.ok(gateAt > 0, '_start() 里必须调用闸门');
  assert.ok(timerAt < gateAt,
    '监护资源的获取必须在任何「决定要不要交易」的闸门之前：'
    + `timerAt=${timerAt} gateAt=${gateAt}。在闸门里补调用是分支级修复，下一个新闸门会重犯。`);
});

test('停止侧对称：_stopReconcileTimer() 不许顺手掐掉风控心跳', async () => {
  const { bot } = makeBot();
  await bot.start(CFG);
  assert.ok(bot._reconTimer && bot._riskTimer, '启动后两个定时器都该在');
  bot._stopReconcileTimer();
  assert.equal(bot._reconTimer, null);
  assert.ok(bot._riskTimer, '风控心跳的生命周期不属于对账（2026-11-09 评审第 2 条）');
  bot._startReconcileTimer();
  assert.ok(bot._reconTimer, '_startReconcileTimer 必须可重入');
  await bot.stop({ closePosition: false });
  assert.equal(bot._riskTimer, null, 'stop() 必须收掉风控心跳');
  assert.equal(bot._reconTimer, null);
});

test('「上一轮为什么没铺单」进快照，重启后仍然可见', async () => {
  const { bot } = makeBot();
  bot._startBlockedReason = () => '已有熔断记录：仓位缓存连续 12 轮落后于成交';
  await bot.start(CFG);
  const snap = bot.snapshot();
  assert.match(String(snap.startBlocked), /已有熔断记录/, '事实必须落盘');
  await bot.stop({ closePosition: false }).catch(() => {});

  const { bot: bot2 } = makeBot();
  await bot2.resume(snap);
  // 2026-11-12 语义收紧：重启后要能看见上一轮为什么没铺单，但**不许让它冒充现值**。
  // 上一版这里断言的是 startBlockedReason 仍等于那句旧话，而实测中它连报 20 小时
  // 「已有熔断记录：存在 1 笔未识别成交」，同时 guard=DEFENSIVE 正常在跑。
  // 历史留 startBlockedLast；startBlockedReason 只描述「此刻为什么起不了」。
  assert.match(String(bot2.getState().startBlockedLast), /已有熔断记录/, '重启后巡检还要能看见上一轮为什么没铺单');
  const now = bot2.getState().startBlockedReason;
  assert.ok(now === null || !/已有熔断记录/.test(String(now)),
    `旧世代的熔断原话不许作为现值出现，实际=${now}`);
  await bot2.stop({ closePosition: false }).catch(() => {});
});
