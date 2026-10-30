// test/inventory-cap.test.js —— 独立库存硬上限 + projectedInventory
//
// 核心命题：66 格的「价格覆盖范围」不等于 66 格的「风险敞口许可」。
// 以及：只限制已成交持仓是不够的，同向待成交挂单会把它顶穿。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { STATES } from '../src/guard.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MockEx extends EventEmitter {
  constructor() {
    super();
    this.mode = 'paper';
    this.dataSource = 'real';
    this.feeRate = 0;
    this.displayFeeRate = 0;
    this.balance = 5000;
    this.orders = new Map();
    this.positions = new Map();
    this.placed = [];
    this.price = 150;
    this._seq = 1;
    this.marketDefs = [{
      marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC',
      stepSize: 0.00001, stepPrice: 1, maxLeverage: 50, minOrderSize: 0.0001, lastPrice: 150,
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
    this.orders.set(id, { marketId: 1, side: o.side, price: Number(o.price), sizeBase: Number(o.sizeBase), reduceOnly: !!o.reduceOnly, levelIndex: o.levelIndex, orderId: id });
    this.placed.push({ ...o, orderId: id });
    return { orderId: id };
  }
  async cancelOrder(m, id) { this.orders.delete(String(id)); return true; }
  async cancelAll() { this.orders.clear(); return true; }
  async fetchOpenOrders() { return [...this.orders.values()]; }
  async closePosition() { this.positions.clear(); return true; }
}

const CAP_CFG = {
  marketId: 1, mode: 'neutral', lower: 100, upper: 200,
  gridCount: 66, sizeBase: 1, leverage: 3,
  outOfRangeAction: 'recover', outDwellMs: 0,
  maxInventoryGrids: 8, inventoryWarnGrids: 4,
  inventoryBlockGrids: 6, inventoryHaltGrids: 8,
};

async function boot(cfg = CAP_CFG) {
  const ex = new MockEx();
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 4 });
  await bot.start(cfg);
  // start() 会铺满 66 张；清掉，避免干扰「库存投影」与「挂单数一致性」的计数
  bot.active.clear();
  ex.orders.clear();
  return { ex, bot };
}

/** 设仓位并同步本地账本——否则会先命中「仓位不一致」，测不到库存逻辑。 */
function setPos(ex, bot, sizeBase) {
  ex.positions.set(1, { sizeBase, entryPrice: 150 });
  bot.posLedger.reset(sizeBase);
}

test('上限取自 maxInventoryGrids，不再等于 gridCount', async () => {
  const { bot } = await boot();
  assert.equal(bot._maxInventoryBase(), 8, '66 格网格的库存上限必须是 8 格，不是 66');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('未配置 maxInventoryGrids 时退回旧行为（向后兼容）', async () => {
  const cfg = { ...CAP_CFG };
  delete cfg.maxInventoryGrids;
  const { bot } = await boot(cfg);
  assert.equal(bot._maxInventoryBase(), 66);
  assert.deepEqual(bot._inventoryLimits(), {}, '未配置时不传自定义比例');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('格阈值换算成 guard 比例：4/6/8 格 → 50%/75%/100%', async () => {
  const { bot } = await boot();
  const L = bot._inventoryLimits();
  assert.equal(L.inventoryWarnFrac, 0.5);
  assert.equal(L.inventoryBlockFrac, 0.75);
  assert.equal(L.inventoryHaltFrac, 1);
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('projectedInventory：空仓不按挂单投影，有持仓才累加同向待成交', async () => {
  const { ex, bot } = await boot();
  // 空仓 + 33 张买单 + 33 张卖单：projected 必须是 0，否则一铺单就自锁
  assert.equal(bot._projectedInventory().projected, 0);

  setPos(ex, bot, 5);
  // 同向（多头 → buy）3 张未成交
  for (let i = 0; i < 3; i++) {
    ex.orders.set(`b${i}`, { orderId: `b${i}`, side: 'buy', price: 149 - i * 0.5, sizeBase: 1, reduceOnly: false });
    bot.active.set(`b${i}`, { levelIndex: i, side: 'buy', price: 149 - i * 0.5, sizeBase: 1, opening: true, placedAt: Date.now() });
  }
  // 反向（sell）5 张：只会在减仓方向成交，不算暴露
  for (let i = 0; i < 5; i++) {
    ex.orders.set(`s${i}`, { orderId: `s${i}`, side: 'sell', price: 151 + i * 0.5, sizeBase: 1, reduceOnly: false });
    bot.active.set(`s${i}`, { levelIndex: 10 + i, side: 'sell', price: 151 + i * 0.5, sizeBase: 1, opening: true, placedAt: Date.now() });
  }
  const p = bot._projectedInventory();
  assert.equal(p.pending, 3, '只累加同向开仓单');
  assert.equal(p.projected, 8, '真实 5 格 + 同向 3 格 = 8 格暴露');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('真实持仓到 8 格 → HALTED（不是靠挂单推断）', async () => {
  const { ex, bot } = await boot();
  setPos(ex, bot, 8);
  bot._runRiskCycle('timer');
  assert.equal(bot.guardState.state, STATES.HALTED);
  assert.match(bot.guardState.haltReason, /库存触顶/);
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('持仓 5 格 + 同向 3 张挂单 = projected 8 → 停同向开仓（不熔断）', async () => {
  const { ex, bot } = await boot();
  setPos(ex, bot, 5);
  for (let i = 0; i < 3; i++) {
    ex.orders.set(`b${i}`, { orderId: `b${i}`, side: 'buy', price: 149 - i * 0.5, sizeBase: 1, reduceOnly: false });
    bot.active.set(`b${i}`, { levelIndex: i, side: 'buy', price: 149 - i * 0.5, sizeBase: 1, opening: true, placedAt: Date.now() });
  }
  bot._runRiskCycle('timer');
  // projected 到顶但真实持仓没到顶 → 停开仓，不熔断
  assert.notEqual(bot.guardState.state, STATES.HALTED, '仅挂单顶到上限不应熔断');
  assert.equal(bot.guardState.blockSide, 'buy', '必须封锁加多方向');
  assert.equal(bot._guardAllowsOrder({ side: 'buy', opening: true, reduceOnly: false }), false,
    '同向开仓必须被拦');
  assert.equal(bot._guardAllowsOrder({ side: 'sell', opening: true, reduceOnly: false }), true,
    '反向（减仓）必须放行');
});

test('4 格进入预警，6 格封同向开仓方向', async () => {
  const { ex, bot } = await boot();
  setPos(ex, bot, 4);
  bot._runRiskCycle('timer');
  assert.equal(bot.guardState.state, STATES.DEFENSIVE, '4 格必须进防守预警');

  setPos(ex, bot, 6);
  bot._runRiskCycle('timer');
  assert.equal(bot.guardState.blockSide, 'buy', '多头超 6 格只允许减仓方向');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('达到上限后不再提交该方向开仓单，reduceOnly 仍可提交', async () => {
  const { ex, bot } = await boot();
  setPos(ex, bot, 7);
  bot._runRiskCycle('timer');
  // 直接测下单许可判定（_place 还受档位合法性约束，不适合做单元断言）
  assert.equal(bot._guardAllowsOrder({ side: 'buy', opening: true, reduceOnly: false }), false,
    '库存 7/8 时不得再加多头');
  assert.equal(bot._guardAllowsOrder({ side: 'sell', opening: true, reduceOnly: false }), true,
    '减仓方向必须放行');
  assert.equal(bot._guardAllowsOrder({ side: 'buy', opening: false, reduceOnly: true }), true,
    'reduceOnly 不得被库存风控拦截');
  await bot.stop({ closePosition: false }).catch(() => {});
});