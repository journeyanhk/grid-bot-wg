// GridBot v1.2 新增安全机制测试：一键补格（refillGrid）、挂单进度跟踪
// （placementProgress）、开仓单安全重试（supportsSafeOpeningRetry 两次权威快照去重）。
// 运行: node test/safety-progress.test.js（npm test 会串联执行）
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GridBot } from '../src/bot.js';

let passed = 0, failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MockExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.dataSource = 'real';
    this.feeRate = 0;
    this.balance = opts.balance ?? 100000;
    this.orders = new Map();
    this.positions = new Map();
    this.prices = new Map();
    this._seq = 1;
    this.supportsSafeOpeningRetry = true;
    this.marketDefs = opts.markets ?? [{
      marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC',
      stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001, lastPrice: 150,
    }];
    for (const m of this.marketDefs) this.prices.set(m.marketId, m.lastPrice ?? 100);
  }

  get equity() { return this.balance; }
  async init() { return true; }
  start() {}
  stop() {}

  async getMarkets() { return this.marketDefs; }
  async getPrice(marketId) { return this.prices.get(Number(marketId)) ?? null; }
  async setLeverage() { return true; }

  async placeLimitOrder(o) {
    const id = String(this._seq++);
    this.orders.set(id, {
      marketId: Number(o.marketId), side: o.side, price: Number(o.price),
      sizeBase: Number(o.sizeBase), reduceOnly: !!o.reduceOnly,
      levelIndex: o.levelIndex, orderId: id,
    });
    return { orderId: id };
  }

  async cancelOrder(marketId, orderId) { this.orders.delete(String(orderId)); return true; }

  async cancelAll(marketId) {
    for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) this.orders.delete(id);
    return true;
  }

  async fetchOpenOrders(marketId) {
    return [...this.orders.values()]
      .filter((o) => o.marketId === Number(marketId))
      .map((o) => ({ orderId: o.orderId, price: o.price, side: o.side }));
  }

  adoptOrder() {}
  forgetOrder(orderId) { this.orders.delete(String(orderId)); }
  forgetOrders(marketId) {
    for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) this.orders.delete(id);
  }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    return p && p.sizeBase !== 0 ? p : null;
  }

  async closePosition(marketId) { this.positions.delete(Number(marketId)); return true; }

  seedOrder(marketId, { price, side, sizeBase = 1, levelIndex = -1 }) {
    const id = String(this._seq++);
    this.orders.set(id, { marketId: Number(marketId), side, price: Number(price), sizeBase, levelIndex, orderId: id });
    return id;
  }

  fill(orderId) {
    const o = this.orders.get(String(orderId));
    if (!o) return false;
    this.orders.delete(String(orderId));
    const p = this.positions.get(o.marketId) || { sizeBase: 0, entryPrice: 0, unrealizedPnl: 0, leverage: 3 };
    if (o.side === 'buy') p.sizeBase += o.sizeBase; else p.sizeBase -= o.sizeBase;
    if (p.sizeBase === 0) this.positions.delete(o.marketId); else this.positions.set(o.marketId, p);
    this.emit('fill', { orderId: String(orderId), marketId: o.marketId, side: o.side, price: o.price, sizeBase: o.sizeBase, levelIndex: o.levelIndex });
    return true;
  }
}

const CFG = { marketId: 1, mode: 'neutral', lower: 100, upper: 200, gridCount: 10, sizeBase: 1, leverage: 3, outOfRangeAction: 'close' };

async function makeBot(exOpts = {}, cfg = CFG) {
  const ex = new MockExchange(exOpts);
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await bot.start(cfg);
  return { ex, bot };
}

const T = [];
const test = (name, fn) => T.push([name, fn]);

test('一键补格：空格位补齐并计入进度，无空格时提示', async () => {
  const { ex, bot } = await makeBot();
  // 手动撤掉 3 个挂单模拟"缺格"
  const victims = [...bot.active].slice(0, 3);
  for (const [id] of victims) { ex.orders.delete(id); bot.active.get(id).placedAt = Date.now() - 60000; }
  await bot.reconcileOpenOrders(); // 第一轮标记
  await bot.reconcileOpenOrders(); // 第二轮清理（prune）
  const before = bot.active.size;
  assert.equal(before, 7);
  const r = await bot.refillGrid();
  assert.ok(r.openOrders > before, '补格后挂单数增加');
  assert.equal(r.openOrders, 10, '补齐到 10 单');
  // 再次补格 -> 无需补
  await bot.refillGrid();
  assert.equal(bot.active.size, 10);
});

test('一键补格：保证金不足拒绝补格', async () => {
  const { ex, bot } = await makeBot({}, { ...CFG, sizeBase: 10 }); // 名义 10格x10x150=15000
  // 删除 8 个挂单（保留 2 个，避免触发 massVanish 保护）
  const victims = [...bot.active].slice(0, 8);
  for (const [id] of victims) { ex.orders.delete(id); bot.active.get(id).placedAt = Date.now() - 60000; }
  await bot.reconcileOpenOrders();
  await bot.reconcileOpenOrders();
  assert.equal(bot.active.size, 2, '8 个空档位已清理');
  ex.balance = 20; // 补格前余额骤降 -> 补格预检应拒绝（8格x10x150/3=4000 > 20）
  await assert.rejects(() => bot.refillGrid(), /保证金不足/);
});

test('启动挂单进度跟踪：placementProgress 从 placing 到 complete', async () => {
  const { bot } = await makeBot();
  const p = bot.getState().placementProgress;
  assert.ok(p, '启动后应有进度');
  assert.equal(p.status, 'complete', '全部下单成功应为 complete');
  assert.equal(p.target, 10);
  assert.equal(p.confirmed, 10);
  assert.equal(p.pending, 0);
});

test('开仓单安全重试：下单失败进重试队列，交易所出现该档挂单后被接管不重复下单', async () => {
  const ex = new MockExchange();
  // 让 level 3 的下单失败一次：拦截 placeLimitOrder
  const orig = ex.placeLimitOrder.bind(ex);
  let failNext = true;
  ex.placeLimitOrder = async (o) => {
    if (failNext && o.levelIndex === 3) { failNext = false; throw new Error('模拟限流 429'); }
    return orig(o);
  };
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10 });
  await bot.start(CFG);
  // level 3 失败 -> 进入重试队列（开仓单安全重试）
  assert.ok(bot._retryQueue.some((o) => o.levelIndex === 3 && o._placementId === bot._placementProgress?.id), '失败档位进入重试队列');
  assert.ok(bot.active.size < 10, '缺一单');
  // 模拟：外部/重试前该档位被交易所真实占用（订单已在交易所但未跟踪）
  const liveId = ex.seedOrder(1, { price: 130, side: 'buy', levelIndex: 3 });
  // 手动触发重试排水（等 _nextAt 到期）
  for (const q of bot._retryQueue) q._nextAt = 0;
  await bot._drainRetryQueue();
  await sleep(30);
  // 两次快照看到该档位已有真实挂单 -> 接管而不是重复下单
  assert.ok(bot.active.has(liveId), '接管交易所真实挂单');
  const dup = [...bot.active.values()].filter((a) => a.levelIndex === 3);
  assert.equal(dup.length, 1, '该档位只有一单（未重复下单）');
  assert.equal(bot.getState().placementProgress?.confirmed, 10, '进度最终全部确认');
});

test('停止流程：撤单确认失败时中止并保留跟踪', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 2 });
  await bot.start(CFG);
  // 让 cancelAll 后交易所仍返回挂单（模拟撤单没生效）
  ex.cancelAll = async () => { return true; }; // 不实际删除
  await assert.rejects(() => bot.stop({ closePosition: false }), /仍检测到/);
  assert.equal(bot.running, true, '撤单未确认 -> 停止中止，网格保持运行');
  assert.equal(bot.active.size, 10, '跟踪保留');
});

(async () => {
  for (const [name, fn] of T) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

test('破界硬止损：recover 模式未实现亏损达到 recoverMaxLossUsd 触发停止', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await bot.start({ ...CFG, outOfRangeAction: 'recover', recoverMaxLossUsd: 30 });
  bot.recovery = true; // 进入回收模式
  bot.outOfRange = true;
  ex.positions.set(1, { sizeBase: 1, entryPrice: 200, unrealizedPnl: -40, leverage: 3 });
  const origStop = bot.stop.bind(bot);
  let stopped = false;
  bot.stop = async (o) => { stopped = true; return origStop(o); };
  bot._checkMaxLoss();
  await sleep(60);
  assert.equal(stopped, true, '亏损达到上限应触发硬止损 stop');
});

test('破界硬止损：独立回收模式（outOfRange=false）亏损达上限也应触发', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  // 模拟 startRecovery 后的状态：recovery=true、outOfRange=false、config 含 recoverMaxLossUsd
  bot.running = true;
  bot.recovery = true;
  bot.outOfRange = false;
  bot.config = { marketId: 1, displayName: 'X', mode: 'recovery', outOfRangeAction: 'recover', recoverMaxLossUsd: 20, sizeBase: 1 };
  ex.positions.set(1, { sizeBase: -1, entryPrice: 200, unrealizedPnl: -30, leverage: 3 });
  const origStop = bot.stop.bind(bot);
  let stopped = false;
  bot.stop = async (o) => { stopped = true; return origStop(o); };
  bot._checkMaxLoss();
  await sleep(60);
  assert.equal(stopped, true, '独立回收模式亏损达上限应触发硬止损');
});

test('尘埃仓守卫：部分成交低于最小下单量时跳过补挂对腿', async () => {
  const ex = new MockExchange();
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 6 });
  await bot.start({ ...CFG, sizeBase: 0.0002, minOrderSize: 0.0002 });
  // 手动补齐 minOrderSize 到 config
  bot.config.minOrderSize = 0.0002;
  const buy140 = [...bot.active.values()].find((a) => a.side === 'buy' && a.levelIndex === 4);
  // 模拟 level 4 以低于最小量成交（0.0001 < 0.0002）
  const fakeFill = { orderId: [...bot.active].find(([id, a]) => a === buy140)[0], marketId: 1, side: 'buy', price: 140, sizeBase: 0.0001, levelIndex: 4 };
  const before = bot.active.size;
  bot._handleFill(fakeFill);
  await sleep(10);
  assert.equal(bot.active.size + 1, before, '不补挂对腿（5 补前数量 - 1 删除 = 4）');
  assert.ok(bot.alerts.some((a) => a.message.includes('低于最小下单量')), '应有尘埃仓提示');
});

test('库存漂移审计：实际持仓与成交流水偏差超阈值时告警', async () => {
  const { ex, bot } = await makeBot({}, { ...CFG, sizeBase: 0.5 });
  // 模拟成交 4 笔买单（推导库存 4×0.5=2），但实际持仓 3（差异 1 格 < 容忍 2）
  bot.stats.buys = 4; bot.stats.sells = 0;
  ex.positions.set(1, { sizeBase: 3, entryPrice: 150, unrealizedPnl: 0, leverage: 3 });
  await bot.reconcileOpenOrders();
  assert.ok(!bot.alerts.some((a) => a.message.includes('库存与成交流水不符')), '1 格偏差在容忍内不告警');
  // 实际持仓 9（推导 2，偏差 7 币，容差 = gridCount(10)×0.5 = 5 => 超阈值告警）
  ex.positions.set(1, { sizeBase: 9, entryPrice: 150, unrealizedPnl: 0, leverage: 3 });
  bot._lastDriftAlertAt = 0;
  await bot.reconcileOpenOrders();
  assert.ok(bot.alerts.some((a) => a.message.includes('库存与成交流水不符')), '超阈值应告警');
});

test('库存漂移审计：带基线重启不误报（已知遗留库存不算漂移）', async () => {
  const { ex, bot } = await makeBot({}, { ...CFG, sizeBase: 0.5 });
  // 模拟"保留持仓重启"：已有 10 币遗留库存记为基线
  bot._invBase = 10;
  ex.positions.set(1, { sizeBase: 10, entryPrice: 150, unrealizedPnl: 0, leverage: 3 });
  bot.stats.buys = 0; bot.stats.sells = 0;
  await bot.reconcileOpenOrders();
  assert.ok(!bot.alerts.some((a) => a.message.includes('库存与成交流水不符')), '遗留库存=基线，不应误报');
  // 基线之上又成交 2 笔（推导 +1 币=2格），实际 12（net=1 格 ≤ 容忍2）
  bot._invBase = 10;
  bot.stats.buys = 2;
  ex.positions.set(1, { sizeBase: 12, entryPrice: 150, unrealizedPnl: 0, leverage: 3 });
  await bot.reconcileOpenOrders();
  assert.ok(!bot.alerts.some((a) => a.message.includes('库存与成交流水不符')), '基线之上 2 格在容忍内');
  // 但基线之上漂移超阈（+0 推导，实际 13 => net 3 格 > 容忍2）
  bot.stats.buys = 0;
  ex.positions.set(1, { sizeBase: 13, entryPrice: 150, unrealizedPnl: 0, leverage: 3 });
  bot._lastDriftAlertAt = 0;
  await bot.reconcileOpenOrders();
  assert.ok(bot.alerts.some((a) => a.message.includes('库存与成交流水不符')), '基线之上超阈仍应告警');
});

test('审计锚点：跨重启带历史 stats 不误报（Restore 后锚定当前计数）', async () => {
  const { ex, bot } = await makeBot({}, { ...CFG, sizeBase: 0.5 });
  // 模拟"历史 stats 残留"：重启前 stats.buys=10（已在基线 0.0046 里），新快照不含锚点
  bot.stats.buys = 10; bot.stats.sells = 0;
  bot.restore({ config: bot.config, stats: { ...bot.stats }, invBase: 10, grid: bot.grid });
  // 锚点应等于恢复时刻 stats（10, 0）——推导从 0 起算
  assert.ok(Number.isFinite(bot._auditBuysBase) && bot._auditBuysBase === 10, '恢复后锚点=当前 stats');
  // 基线 10 库存 + 恢复后无新成交 => net=0，不应误报
  ex.positions.set(1, { sizeBase: 10, entryPrice: 150, unrealizedPnl: 0, leverage: 3 });
  await bot.reconcileOpenOrders();
  assert.ok(!bot.alerts.some((a) => a.message.includes('库存与成交流水不符')), '锚点校正后不误报');
});

test('恢复后首轮重校准：基线锚点同刻校正，不把合法积累库存当漂移', async () => {
  const { ex, bot } = await makeBot({}, { ...CFG, sizeBase: 0.5 });
  // 模拟旧快照（无 auditBuysBase）+ 遗留库存 11 币（基线 0.0046 旧值），
  // 但无 auditBuysBase -> 恢复路径应打 _auditNeedsRebase 标记
  bot.restore({ config: bot.config, stats: { ...bot.stats, buys: 10 }, invBase: 0.0046, grid: bot.grid });
  assert.equal(bot._auditNeedsRebase, true, '旧快照缺锚点应触发重校准标记');
  ex.positions.set(1, { sizeBase: 11, entryPrice: 150, unrealizedPnl: 0, leverage: 3 });
  await bot.reconcileOpenOrders(); // 首轮: 重校准将基线设为 11、锚点设为 11（stats.buys），本轮不审计
  assert.ok(!bot.alerts.some((a) => a.message.includes('库存与成交流水不符')), '重校准轮不误报');
  assert.equal(bot._auditNeedsRebase, false, '重校准后清除标记');
  assert.ok(Math.abs(bot._invBase - 11) < 1e-9, '基线被校正到当前持仓');
  // 重校准后：基线 11，成交推导 = (11-11)=0，实际 11 => net 0，不再误报
  await bot.reconcileOpenOrders();
  assert.ok(!bot.alerts.some((a) => a.message.includes('库存与成交流水不符')), '重校准后干净');
});
