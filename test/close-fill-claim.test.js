// test/close-fill-claim.test.js —— 平仓单必须能被 `_handleFill` 认领
//
// 2026-11-13 10:14 主网破界平仓（outOfRangeAction=close）实测：
//   `未跟踪订单的成交（可能来自网页手动下单）：83d69dffd9f94e82 sell 0.0056 @ 70458.7`
// 每一次 close 都会 100% 制造一笔未识别成交 —— 因为平仓单由适配器直接下发、
// 不进 `this.active`，成交回来「查无此单」。这与 2026-11-10 那笔被拆块推送的
// 买单是同一个机制的两种形态：**下单没有登记，成交就找不到人**。
//
// 两条防线，各一组用例：
//   ① 平仓在途窗口（_closingCtx）：兜住「成交比 HTTP 响应先到」的竞态；
//   ② 订单台账（_recentOrderMeta）：适配器返回 orderId 后，后续碎片按单号认领。
// 另加一条反向断言：窗口没覆盖住时必须留下告警 —— 修复不许把传感器蒙住。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';

const LEVELS = [70_481.4, 70_632.1, 70_783.3, 70_934.5];

function mkBot({ running = true } = {}) {
  const bot = Object.create(GridBot.prototype);
  bot.running = running;
  bot.outOfRange = true;
  bot.recovery = false;
  bot.lastPrice = 70_481.45;
  bot.config = {
    marketId: 1, sizeBase: 0.0002, minOrderSize: 0.0001, mode: 'neutral',
    displayName: 'BTC-USD', spacing: 151.247,
  };
  bot.grid = { levels: LEVELS, spacing: 151.247 };
  bot.active = new Map();
  bot._recentOrderMeta = new Map();
  bot._untrackedFills = [];
  bot._closingCtx = null;
  bot._retryQueue = [];
  bot.stats = { buys: 0, sells: 0, volume: 0, completedRungs: 0, gridProfit: 0 };
  bot._gridProfitRaw = 0;
  bot.fills = [];
  bot.posLedger = { value: 0.0056, applyFill() { bot._ledgerApplied = (bot._ledgerApplied || 0) + 1; } };
  bot._runRiskCycle = () => {};
  bot._checkTrendFills = () => {};
  bot._queueReplacement = () => { bot._replacementQueued = true; };
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(String(m));
  bot._touch = () => {};
  bot._changed = () => {};
  return bot;
}

const FILL = { marketId: 1, orderId: '83d69dffd9f94e82', side: 'sell', sizeBase: 0.0056, price: 70_458.7 };

test('平仓在途：未知 orderId 的成交被认领，不记未跟踪成交', () => {
  const bot = mkBot();
  bot._closingCtx = { marketId: 1, side: 'sell', at: Date.now(), claimed: 0 };
  bot._handleFill({ ...FILL });
  assert.equal(bot._untrackedFills.length, 0, '平仓成交不得进未跟踪列表');
  assert.equal(bot._ledgerApplied, 1, '账本必须照记（applyFill 无条件执行）');
  assert.equal(bot._closingCtx.claimed, 0.0056, '认领量要累加，供事后核对');
});

test('平仓成交不污染统计：完成格与格利都不动，也不补对腿', () => {
  const bot = mkBot();
  bot._closingCtx = { marketId: 1, side: 'sell', at: Date.now(), claimed: 0 };
  bot._handleFill({ ...FILL });
  assert.equal(bot.stats.completedRungs, 0, '平仓不是一格网格');
  assert.equal(bot.stats.gridProfit, 0, '平仓不许记假格利');
  assert.equal(bot._replacementQueued, undefined, '平仓腿不得触发补腿');
});

test('平仓结束后：未知 orderId 仍记为未跟踪成交（传感器没被蒙住）', () => {
  const bot = mkBot();
  bot._closingCtx = { marketId: 1, side: 'sell', at: Date.now() - 200_000, claimed: 0 }; // 窗口已过期
  bot._handleFill({ ...FILL });
  assert.equal(bot._untrackedFills.length, 1, '过期窗口之外的成交必须照旧报警');
});

test('方向不符不认领：平仓是 sell 时，一笔 buy 成交不能借窗口洗白', () => {
  const bot = mkBot();
  bot._closingCtx = { marketId: 1, side: 'sell', at: Date.now(), claimed: 0 };
  bot._handleFill({ ...FILL, side: 'buy' });
  assert.equal(bot._untrackedFills.length, 1);
});

test('_closeWithConfirm：适配器返回 orderId → 登记台账，窗口清空后碎片仍被认领', async () => {
  const bot = mkBot();
  let pos = { sizeBase: 0.0056, entryPrice: 71_249.6 };
  const calls = [];
  bot.ex = {
    getPosition: () => pos,
    closePosition: async (mId) => {
      calls.push(mId);
      pos = null;                     // 平仓成功，下一拍仓位为空
      return { orderId: 'c9f1', side: 'sell', price: 70_458.7, sizeBase: 0.0056 };
    },
  };
  const ok = await bot._closeWithConfirm(1);
  assert.equal(ok, true);
  assert.equal(bot._closingCtx, null, '平仓结束必须清窗口');
  assert.ok(bot._recentOrderMeta.has('c9f1'), '适配器返回的 orderId 必须进台账');

  // 模拟「先成交、后返回」的碎片：窗口已清，只靠订单号认领
  bot._handleFill({ marketId: 1, orderId: 'c9f1', side: 'sell', sizeBase: 0.0002, price: 70_458.7 });
  assert.equal(bot._untrackedFills.length, 0, '同一 orderId 的后续碎片必须被台账认领');
});

test('_closeWithConfirm：窗口未覆盖住时必须告警（修复不许蒙住传感器）', async () => {
  const bot = mkBot();
  let pos = { sizeBase: 0.0056, entryPrice: 71_249.6 };
  bot.ex = {
    getPosition: () => pos,
    closePosition: async () => {
      // 一笔方向不符的成交（例如别的客户端同时在交易）落在窗口内
      bot._handleFill({ marketId: 1, orderId: 'other', side: 'buy', sizeBase: 0.0002, price: 70_500 });
      pos = null;
      return { orderId: 'c10', side: 'sell', price: 70_458.7, sizeBase: 0.0056 };
    },
  };
  const ok = await bot._closeWithConfirm(1);
  assert.equal(ok, true);
  assert.ok(
    bot._alerts.some((m) => /平仓期间仍产生 1 笔未跟踪成交/.test(m)),
    '未覆盖的成交必须留下告警原文，实际告警：' + JSON.stringify(bot._alerts),
  );
});