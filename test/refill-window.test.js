// test/refill-window.test.js —— 补格必须受活跃窗口约束，且窗口缺失时必须拒绝
//
// 背景（2026-11-07 巡检 review）：review 指出 refillGrid() 调 seedOrders 时没传
// windowGrids，一次 refill 会把窗口外的空位全部铺出来（约 64 张单），projected
// 当场撞穿 34 格熔断线。
//
// 实测结论：**这个问题在 v1.6.49（ea65980，2026-10-30）已经修过了**，四个
// seedOrders 调用点（start / adjustRange / refill / 窗口滚动）全部传了 windowGrids。
// 所以这里不重复修，而是：
//   ① 用行为测试把「refill 只能铺窗口内的档」钉住——以后谁删掉 windowGrids，这条会红；
//   ② 补一个 review 没提、但同源的洞：**窗口本身可以是 null**（activeWindowGrids
//      未配置），seedOrders 的 win 会退化成 Infinity，66 档一次全铺。现在直接拒绝。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';

const L0 = 70632.1;
const SP = 151.2469697;
const LEVELS = Array.from({ length: 66 }, (_, i) => L0 + i * SP);

function mkBot({ windowGrids, occupied = [], haltGrids } = {}) {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.recovery = false;
  bot.outOfRange = false;
  bot._refillPausedUntil = 0;
  bot.lastPrice = L0 + 34.89 * SP;      // 34.89 档，与 11-07 主网实测一致
  bot.config = {
    marketId: 1, mode: 'neutral', sizeBase: 0.0002, leverage: 10,
    activeWindowGrids: windowGrids, inventoryHaltGrids: haltGrids,
  };
  bot.grid = { levels: LEVELS, spacing: SP };
  bot.active = new Map();
  for (const idx of occupied) bot.active.set(`o${idx}`, { levelIndex: idx, price: LEVELS[idx], side: 'buy' });
  bot.ex = { equity: 150 };
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(m);
  bot._changed = () => {};
  bot.reconcileOpenOrders = async () => {};
  bot._refreshExchangeOpenOrderCount = async () => bot.active.size;
  bot._beginPlacementProgress = () => 'p1';
  bot._finishPlacementPass = () => {};
  bot._placementProgressView = () => ({ status: 'complete' });
  bot.getState = () => ({ ok: true });
  bot.placed = null;
  bot._placeMany = async (seeds) => {
    bot.placed = seeds;
    for (const s of seeds) bot.active.set(`n${s.levelIndex}`, { levelIndex: s.levelIndex });
    return seeds.length;
  };
  return bot;
}

test('refill 只铺窗口内的档（windowGrids=4 → 7 单，而不是 66 档）', async () => {
  const bot = mkBot({ windowGrids: 4 });
  await bot.refillGrid();
  assert.ok(bot.placed, '应当调用 _placeMany');
  const n = bot.placed.length;
  assert.equal(n, 7, `窗口 4 应铺 7 档（买 31~34 + 卖 36~38），实际 ${n} 档`);
  assert.ok(n <= 9, `绝不该接近整条阶梯：${n}/66`);
  // 窗口内外的分界：31~34 买、36~38 卖，35 落在 skipBand 里不挂
  const idxs = bot.placed.map((s) => s.levelIndex);
  assert.deepEqual(idxs, [31, 32, 33, 34, 36, 37, 38]);
});

test('refill 会跳过已有挂单的档位', async () => {
  const bot = mkBot({ windowGrids: 4, occupied: [31, 32, 33, 34] });
  await bot.refillGrid();
  const idxs = bot.placed.map((s) => s.levelIndex);
  assert.deepEqual(idxs, [36, 37, 38], '买腿已占满，只该补卖腿');
});

test('窗口未配置 + 阶梯超过库存熔断线时，refill 必须拒绝而不是一次铺满', async () => {
  // 真实风险形态：activeWindowGrids 丢了（env 没配/配置漂移），66 档会一次全铺，
  // projected 当场顶穿 halt 线。判据用「结果 vs halt 线」，比检查传参可靠。
  for (const bad of [undefined, null, 0, NaN]) {
    const bot = mkBot({ windowGrids: bad, haltGrids: 34 });
    await assert.rejects(() => bot.refillGrid(), /超过库存熔断线/, `windowGrids=${bad} 必须拒绝`);
    assert.equal(bot.placed, null, `windowGrids=${bad} 时一张单都不该下`);
  }
});

test('窗口未配置但阶梯很小（未超过 halt 线）时保持旧行为，不误伤其它场地', async () => {
  // 兼容性：RISEx/HL 这类小阶梯本来就不配窗口，refill 必须照旧可用。
  const bot = mkBot({ windowGrids: undefined, haltGrids: 34 });
  bot.grid = { levels: Array.from({ length: 10 }, (_, i) => 70_000 + i * 10), spacing: 10 };
  bot.lastPrice = 70_045;
  bot.active = new Map();
  await bot.refillGrid();
  assert.ok(bot.placed && bot.placed.length > 0, '小阶梯无窗口时应当照旧铺单');
});

test('窗口配置正常时不会误触拒绝分支', async () => {
  const bot = mkBot({ windowGrids: 1 });
  await bot.refillGrid();
  assert.ok(bot.placed.length >= 1 && bot.placed.length <= 3, `窗口 1 应是 1~3 档，实际 ${bot.placed.length}`);
});