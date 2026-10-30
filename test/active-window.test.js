// test/active-window.test.js —— 66 格价格覆盖 + 近价窗口激活
//
// 核心命题（附件的判断）：
//   「全部同向挂单都计入 projected inventory」与「完整铺 66 格」不能同时成立。
// 持仓 0 时同向 33 张挂单就是 33 格 projected，第一笔成交前就该熔断。
//
// 解法不是「按距离截断挂单」（那会低估暴露），而是「交易所上本来就只有近价单」：
// 66 格仍是策略的价格覆盖范围，但远端档位只作候选、不提交。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { GridBot } from '../src/bot.js';

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
  async getPositionFresh() { return this.positions.get(1) || { sizeBase: 0 }; }
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
  gridCount: 66, sizeBase: 1, leverage: 3,
  outOfRangeAction: 'recover', outDwellMs: 0,
  maxInventoryGrids: 8, inventoryWarnGrids: 4,
  inventoryBlockGrids: 6, inventoryHaltGrids: 8,
  activeWindowGrids: 4,
};

async function boot(cfg = CFG) {
  const ex = new MockEx();
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 10, cancelVerifyAttempts: 4 });
  await bot.start(cfg);
  return { ex, bot };
}

const openCount = (bot) => bot.active.size;

test('活跃窗口：66 格覆盖只提交现价附近 4 格内的开仓单', async () => {
  const { ex, bot } = await boot();
  // 66 格、现价 150、格距 100/66≈1.515 → ±4 格 ≈ ±6.06 → 约 9 张，绝不是 66 张
  assert.ok(openCount(bot) <= 9, `窗口内单数应 ≤9，实际 ${openCount(bot)}`);
  assert.ok(openCount(bot) >= 5, `窗口内单数过少（${openCount(bot)}），策略无法工作`);

  const sp = bot.grid.spacing;
  for (const o of bot.active.values()) {
    assert.ok(Math.abs(Number(o.price) - 150) <= sp * 4 + 1e-9,
      `挂单 ${o.price} 落在窗口外（现价 150，格距 ${sp}）`);
  }
  assert.equal(ex.orders.size, openCount(bot), '交易所挂单数应与本地台账一致');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('窗口铺单后 projected 不会因为「远端 33 张」直接顶到上限', async () => {
  const { ex, bot } = await boot();
  // 空仓：projected 必须为 0，而不是 33
  const p0 = bot._projectedInventory();
  assert.equal(p0.projected, 0, `空仓 projected 应为 0，实际 ${p0.projected}`);

  // 有 2 格持仓：projected = 2 格 + 窗口内同向单（≤4 格），必须仍在上限 8 格以内
  ex.positions.set(1, { sizeBase: 2, entryPrice: 150 });
  bot.posLedger.reset(2);
  const p2 = bot._projectedInventory();
  assert.ok(p2.projected <= 8, `2 格持仓时 projected 不应超上限，实际 ${p2.projected}`);
  assert.ok(p2.projected >= 2, 'projected 必须包含真实持仓');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('窗口滚动：价格移出后撤掉远端开仓单、在新价位补单', async () => {
  const { ex, bot } = await boot();
  const before = new Set([...bot.active.values()].map((o) => Number(o.price)));

  // 价格上移 5 格（150 → 157.6），旧窗口下沿的单已远离现价
  bot._windowDrifted();                     // 首次调用只是把锚点对齐到启动价
  ex.price = 150 + bot.grid.spacing * 5;
  bot.lastPrice = ex.price;
  assert.equal(bot._windowDrifted(), true, '价格移动 5 格应判定窗口漂移');

  await bot._rollActiveWindow();

  const after = [...bot.active.values()].map((o) => Number(o.price));
  assert.ok(after.length > 0, '滚动后窗口内必须有单');
  const sp = bot.grid.spacing;
  for (const p of after) {
    assert.ok(Math.abs(p - bot.lastPrice) <= sp * 4 + 1e-9, `滚动后 ${p} 仍在窗口外`);
  }
  // 新窗口应包含旧窗口里没有的价位（价格上方的档位被激活）
  assert.ok(after.some((p) => p > Math.max(...before)), '新价位档位未被激活');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('窗口滚动绝不触碰 reduceOnly / recovery 腿', async () => {
  const { bot } = await boot();
  const far = bot.lastPrice + bot.grid.spacing * 20;
  // 手工塞一张远端的减仓单（模拟破界后的回收梯）
  bot.active.set('ro-1', {
    orderId: 'ro-1', levelIndex: 999, side: 'sell', price: far,
    sizeBase: 1, reduceOnly: true, recovery: true, opening: false,
  });
  await bot._rollActiveWindow();
  assert.ok(bot.active.has('ro-1'), '减仓腿被窗口滚动误撤了——这会让回收梯消失');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('阶梯哨兵只把窗口内的空档算缺口，不判塌陷', async () => {
  const { bot } = await boot();
  // 窗口模式：66 格里只有现价附近 8 张单是正常的。
  // 旧哨兵按 66 格算 → 58 个「缺口」→ 判塌陷 → 每 1.5 分钟自动重铺 → 429 → 熔断。
  await bot.reconcileOpenOrders();
  const gaps = bot._ladderGaps || [];
  const sp = bot.grid.spacing;
  const outside = gaps.filter((i) => Math.abs(bot.grid.levels[i] - bot.lastPrice) > sp * 4 + 1e-9);
  assert.equal(outside.length, 0, `窗口外档位被当成缺口了：${outside.slice(0, 5)}`);
  assert.ok(gaps.length <= 3, `窗口内缺口应为个位数，实际 ${gaps.length}（疑似仍按 66 格算）`);
  assert.equal(bot._collapseStreak || 0, 0, '窗口模式下不应累计塌陷计数');
  await bot.stop({ closePosition: false }).catch(() => {});
});

test('未配置 activeWindowGrids 时退回旧行为（全档铺满）', async () => {
  const cfg = { ...CFG };
  delete cfg.activeWindowGrids;
  const { bot } = await boot(cfg);
  assert.ok(openCount(bot) > 40, `无窗口配置时应接近全档铺满，实际 ${openCount(bot)}`);
  await bot.stop({ closePosition: false }).catch(() => {});
});