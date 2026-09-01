// 动态网格单元测试：漂移重定、库存门、冷静门、冷却、影子模式、自动停机/重启。
// 运行: node test/dynamic.test.js（npm test 会串联执行）
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GridBot } from '../src/bot.js';

let passed = 0, failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MockExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper'; this.dataSource = 'real'; this.feeRate = 0;
    this.balance = opts.balance ?? 100000;
    this.orders = new Map(); this.positions = new Map(); this.prices = new Map(); this._seq = 1;
    this.supportsSafeOpeningRetry = true;
    this.candles = [];
    this.marketDefs = opts.markets ?? [{
      marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC',
      stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001, lastPrice: 150,
    }];
    for (const m of this.marketDefs) this.prices.set(m.marketId, m.lastPrice ?? 100);
    this.lastOkAt = Date.now();
  }
  get equity() { return this.balance; }
  async init() { return true; }
  start() {} stop() {}
  async getMarkets() { return this.marketDefs; }
  async getPrice(marketId) { return this.prices.get(Number(marketId)) ?? null; }
  async getCandles() { return this.candles; }
  async setLeverage() { return true; }
  async placeLimitOrder(o) {
    const id = String(this._seq++);
    this.orders.set(id, { marketId: Number(o.marketId), side: o.side, price: Number(o.price), sizeBase: Number(o.sizeBase), reduceOnly: !!o.reduceOnly, levelIndex: o.levelIndex, orderId: id });
    return { orderId: id };
  }
  async cancelOrder(m, id) { this.orders.delete(String(id)); return true; }
  async cancelAll(m) { for (const [id, o] of this.orders) if (o.marketId === Number(m)) this.orders.delete(id); return true; }
  async fetchOpenOrders(m) { return [...this.orders.values()].filter((o) => o.marketId === Number(m)).map((o) => ({ orderId: o.orderId, price: o.price, side: o.side })); }
  adoptOrder() {} forgetOrder(id) { this.orders.delete(String(id)); } forgetOrders(m) {}
  getPosition(m) { const p = this.positions.get(Number(m)); return p && p.sizeBase !== 0 ? p : null; }
  async closePosition(m) { this.positions.delete(Number(m)); return true; }
}

const CFG = { marketId: 1, mode: 'neutral', lower: 100, upper: 200, gridCount: 10, sizeBase: 1, leverage: 3, outOfRangeAction: 'recover' };

const T = [];
const test = (name, fn) => T.push([name, fn]);

function calmCandles(ex, movePct) {
  const start = 150;
  ex.candles = Array.from({ length: 121 }, (_, i) => ({ time: i * 3600e3, open: start, high: start, low: start, close: start * (i === 120 ? (1 + movePct / 100) : 1) }));
}

test('漂移重定：偏心+库存平+冷静门+cooled -> 调用 adjustRange（非影子）', async () => {
  const ex = new MockExchange();
  calmCandles(ex, 0.5);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await bot.start({ ...CFG, dynamic: { enabled: true, shadow: false, driftFrac: 0.33, calmMaxMovePct: 3, invGateGrids: 2, recenterCooldownMin: 0, restartEnabled: false } });
  bot.lastPrice = 175; // 明显偏心上（mid=150, 宽100, 阈值33 -> |175-150|=25 > 33? 否）
  // 用更极端偏心：upper=300 宽 200，mid=200，price=275 -> |75| > 66 ✓
  await bot.stop({ closePosition: false });
  bot.running = true;
  bot.lastPrice = 275;
  bot.grid = { count: 10, levels: [100,120,140,160,180,200,220,240,260,280,300], spacing: 20 };
  let adjusted = null;
  bot.adjustRange = async (o) => { adjusted = o; return bot.getState(); };
  bot.stats.recenters = 0;
  await bot._dynCheck();
  assert.ok(adjusted, '漂移应触发 adjustRange（影子关闭）');
  assert.ok(adjusted.upper > adjusted.lower);
  assert.equal(bot.stats.recenters, 1, '重定计数 +1');
});

test('库存门：净库存超限 -> 不重定', async () => {
  const ex = new MockExchange();
  calmCandles(ex, 0.5);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10 });
  await bot.start({ ...CFG, dynamic: { enabled: true, shadow: false, driftFrac: 0.33, invGateGrids: 1, recenterCooldownMin: 0, restartEnabled: false } });
  bot.stop({ closePosition: false });
  bot.running = true; bot.lastPrice = 275;
  bot.grid = { count: 10, levels: [100,120,140,160,180,200,220,240,260,280,300], spacing: 20 };
  bot.config = { ...bot.config, lower: 100, upper: 300 };
  ex.positions.set(1, { sizeBase: 5, entryPrice: 150, unrealizedPnl: 0, leverage: 3 }); // 5 格 > 1 格
  let adjusted = false;
  bot.adjustRange = async () => { adjusted = true; };
  await bot._dynCheck();
  assert.equal(adjusted, false, '库存超限应拦下重定');
});

test('冷静门：动量超限 -> 不重定 / 不重启', async () => {
  const ex = new MockExchange();
  calmCandles(ex, 8); // 动量 8% > 3%
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10 });
  await bot.start({ ...CFG, dynamic: { enabled: true, shadow: false, driftFrac: 0.33, calmMaxMovePct: 3, invGateGrids: 2, recenterCooldownMin: 0, restartEnabled: true, restartCooldownMin: 0 } });
  bot.stop({ closePosition: false });
  bot.running = true; bot.lastPrice = 275;
  bot.grid = { count: 10, levels: [100,120,140,160,180,200,220,240,260,280,300], spacing: 20 };
  bot.config = { ...bot.config, lower: 100, upper: 300 };
  bot._autoStopped = { at: Date.now() - 10_000, reason: 'breakout', config: bot.config };
  let adjusted = false, started = false;
  bot.adjustRange = async () => { adjusted = true; };
  bot.start = async () => { started = true; };
  await bot._dynCheck();
  assert.equal(adjusted, false, '冷静门拦重定');
  assert.equal(started, false, '冷静门拦重启');
});

test('影子模式：动作只告警不执行', async () => {
  const ex = new MockExchange();
  calmCandles(ex, 0.5);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10 });
  await bot.start({ ...CFG, dynamic: { enabled: true, shadow: true, driftFrac: 0.33, invGateGrids: 2, recenterCooldownMin: 0, restartEnabled: true, restartCooldownMin: 0 } });
  bot.stop({ closePosition: false });
  bot.running = true; bot.lastPrice = 275;
  bot.grid = { count: 10, levels: [100,120,140,160,180,200,220,240,260,280,300], spacing: 20 };
  bot.config = { ...bot.config, lower: 100, upper: 300 };
  let adjusted = false; bot.adjustRange = async () => { adjusted = true; };
  await bot._dynCheck();
  assert.equal(adjusted, false, '影子不执行');
  assert.ok(bot.alerts.some((a) => a.message.includes('[动态·影子]')), '影子应有提醒告警');
});

test('自动停机记录：破界 stop 前 _noteAutoStop(reason=breakout)', async () => {
  const ex = new MockExchange();
  calmCandles(ex, 0.5);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10 });
  await bot.start({ ...CFG, outOfRangeAction: 'close', dynamic: { enabled: true, shadow: false } });
  bot.lastPrice = 150;
  bot._handlePrice({ marketId: 1, price: 205 }); // 突破上边界
  await sleep(120);
  assert.equal(bot.running, false, '破界 close 停止');
  assert.ok(bot._autoStopped, '应记录自动停机');
  assert.equal(bot._autoStopped.reason, 'breakout');
  bot._stopDynTimer();
});

test('冷静门自动重启：非影子 走 start 且新区间居中', async () => {
  const ex = new MockExchange();
  calmCandles(ex, 1);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await bot.start({ ...CFG, dynamic: { enabled: true, shadow: false, restartEnabled: true, restartCooldownMin: 0 } });
  await bot.stop({ closePosition: false });
  const stoppedCfg = { ...bot.config, lower: 100, upper: 200, gridCount: 10, sizeBase: 1, stepPrice: 1 };
  bot._autoStopped = { at: Date.now() - 5_000, reason: 'breakout', config: stoppedCfg };
  bot.lastPrice = 160;
  bot.running = false;
  let startedArgs = null;
  const origStart = bot.start.bind(bot);
  bot.start = async (cfg) => { startedArgs = cfg; return { running: true }; };
  bot.stats.autoRestarts = 0;
  await bot._dynCheck();
  assert.ok(startedArgs, '应自动重启');
  const width = 100;
  assert.ok(Math.abs(startedArgs.lower - (160 - width / 2)) < 20, '区间应居中于现价');
  assert.ok(Math.abs(startedArgs.upper - (160 + width / 2)) < 20);
  assert.equal(bot.stats.autoRestarts, 1, '重启计数 +1');
  assert.equal(bot._autoStopped, null, '重启后清除自动停机态');
});

test('手动 stop 不记录自动停机（清空）', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10 });
  await bot.start({ ...CFG, dynamic: { enabled: true, shadow: false } });
  bot.cancelAutoRestart();   // 手动接管（对应 server 路由调用）
  bot.stop({ closePosition: false });
  await sleep(60);
  assert.equal(bot._autoStopped, null, '手动停止不应设置自动停机');
  bot._stopDynTimer();
});

(async () => {
  for (const [name, fn] of T) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
test('P1-a: restore 带 autoStopped 快照后监督器仍工作（影子告警触发）', async () => {
  const ex = new MockExchange();
  calmCandles(ex, 1);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  // 模拟进程重启前的快照：动态启用 + 自动停机态（restore 不置 running）
  const snap = {
    config: { marketId: 1, displayName: 'X', mode: 'neutral', lower: 100, upper: 300, gridCount: 10, sizeBase: 1, leverage: 3,
              outOfRangeAction: 'recover', stepPrice: 1,
              dynamic: { enabled: true, shadow: true, restartEnabled: true, restartCooldownMin: 0, calmWindowH: 120, calmMaxMovePct: 3 } },
    stats: { recenters: 0, autoRestarts: 0 },
    autoStopped: { at: Date.now() - 10_000, reason: 'breakout', config: { upper: 300, lower: 100, stepPrice: 1 } },
  };
  bot.restore(snap); // P1-a 修复点：restore 应启动动态监督器
  assert.ok(bot._dynTimer, 'restore 应启动动态监督器定时器');
  bot.lastPrice = 160;
  bot.running = false;
  let started = false;
  bot.start = async () => { started = true; };
  bot.grid = { count: 10, levels: [100,120,140,160,180,200,220,240,260,280,300], spacing: 20 };
  await bot._dynCheck();
  // 影子模式：不真正重启，只出影子告警
  assert.equal(started, false, '影子模式不执行重启');
  assert.ok(bot.alerts.some((a) => a.message.includes('[动态·影子]')), 'restore 后监督器应产生影子告警');
  bot._stopDynTimer();
});
