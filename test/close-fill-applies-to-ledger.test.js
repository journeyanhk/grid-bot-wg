// test/close-fill-applies-to-ledger.test.js —— 断言账本，不只看分类
//
// 2026-11-13 review P0-1 的原话：
//   「成交被归类了」和「账本被更新了」是两件事，测试必须测后者。
//
// 破界平仓的真实现场是「先 stop()、后成交」：
//   10:14:32 stop() 把 running 置 false 并落盘快照（expected=0.0056）
//   10:14:33 交易所成交事件才到 → 旧代码 `if (!this.running) return` 直接丢掉
// 于是账本冻结在 0.0056，重启一致性检查读成「账本不一致」，恢复只剩 new-epoch 一条路。
// 这里锁三件事：① 停机期间成交照常入账；② 平仓确认归零后账本按真值对齐；
// ③ 认领平仓腿不污染完成格 / 格利。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { PositionLedger } from '../src/position-ledger.js';

function mkBot({ running = true, ledgerBase = 0.0056 } = {}) {
  const bot = Object.create(GridBot.prototype);
  bot.running = running;
  bot.outOfRange = false;
  bot.recovery = false;
  bot.lastPrice = 70_458.7;
  bot.config = {
    marketId: 1, sizeBase: 0.0002, minOrderSize: 0.0001, mode: 'neutral',
    displayName: 'BTC-USD', spacing: 151.247,
  };
  bot.grid = { levels: [70_481.4, 70_632.1], spacing: 151.247 };
  bot.active = new Map();
  bot._recentOrderMeta = new Map();
  bot._untrackedFills = [];
  bot._untrackedResolved = [];
  bot._closingCtx = null;
  bot._closeSeq = 0;
  bot._retryQueue = [];
  bot.stats = { buys: 0, sells: 0, volume: 0, completedRungs: 0, gridProfit: 0 };
  bot._gridProfitRaw = 0;
  bot.fills = [];
  bot.posLedger = new PositionLedger({ startBase: ledgerBase, expected: ledgerBase });
  bot._runRiskCycle = () => {};
  bot._checkTrendFills = () => {};
  bot._queueReplacement = () => { bot._replacementQueued = true; };
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(String(m));
  bot._touch = () => {};
  bot._changed = () => {};
  return bot;
}

const CLOSE_FILL = {
  marketId: 1, orderId: '83d69dffd9f94e82', side: 'sell', sizeBase: 0.0056, price: 70_458.7,
};

test('停机期间到达的平仓成交必须入账（running=false 不是丢成交的理由）', () => {
  const bot = mkBot({ running: false });
  bot._handleFill({ ...CLOSE_FILL });
  assert.equal(bot.posLedger.value, 0, 'expected 必须从 0.0056 推进到 0');
  assert.equal(bot.stats.completedRungs, 0, '停机入账不许记完成格');
  assert.equal(bot.stats.gridProfit, 0, '停机入账不许记格利');
  assert.equal(bot.lastStopFill?.orderId, '83d69dffd9f94e82', '停机成交要留痕');
});

test('停机期间的成交：台账已知时不进未跟踪列表', () => {
  const bot = mkBot({ running: false });
  bot._recentOrderMeta.set('83d69dffd9f94e82', { levelIndex: -1, opening: false, closing: true, manual: true });
  bot._handleFill({ ...CLOSE_FILL });
  assert.equal(bot.posLedger.value, 0);
  assert.equal(bot._untrackedFills.length, 0, '台账认识的 orderId 不该被当成未识别');
  assert.equal(bot.lastStopFill.known, true);
});

test('停机期间的未知成交：入账但标记未跟踪（传感器不许被蒙住）', () => {
  const bot = mkBot({ running: false });
  bot._handleFill({ ...CLOSE_FILL, orderId: 'unknown-x' });
  assert.equal(bot.posLedger.value, 0, '仍要入账');
  assert.equal(bot._untrackedFills.length, 1);
  assert.equal(bot._untrackedFills[0].whileStopped, true, '要标出「停机期间到达」这个事实');
});

test('运行中的平仓腿认领：账本推进、完成格与格利不动、不补对腿', () => {
  const bot = mkBot();
  bot._closingCtx = { attemptId: 7, marketId: 1, side: 'sell', at: Date.now(), claimed: 0, claims: 0, maxClaimLagMs: 0 };
  bot._handleFill({ ...CLOSE_FILL });
  assert.equal(bot.posLedger.value, 0, '账本必须推进');
  assert.equal(bot._untrackedFills.length, 0);
  assert.equal(bot.stats.completedRungs, 0);
  assert.equal(bot.stats.gridProfit, 0);
  assert.equal(bot._replacementQueued, undefined);
  assert.equal(bot._closingCtx.claims, 1);
});

test('仓位确认归零后账本按真值对齐：不把「重启前先 new-epoch」写进操作规程', async () => {
  const bot = mkBot();
  let pos = { sizeBase: 0.0056, entryPrice: 71_249.6 };
  bot.ex = {
    getPosition: () => pos,
    closePosition: async () => {
      pos = null;                     // 交易所已平，但成交事件没到（模拟丢事件）
      return { orderId: 'c1', side: 'sell', price: 70_458.7, sizeBase: 0.0056 };
    },
  };
  const ok = await bot._closeWithConfirm(1);
  assert.equal(ok, true);
  assert.equal(bot.posLedger.value, 0, '账本必须对齐到交易所真值 0');
  assert.equal(bot.posLedger.lastReconcile?.why, 'close-confirmed#1');
  assert.ok(bot._alerts.some((m) => /账本按交易所真值对齐/.test(m)));
  assert.equal(bot._lastCloseClaim?.attemptId, 1, '平仓尝试序号要可见');
});

test('平仓期间未认领的成交：仓位已归零 + 账本对齐 → 移入 resolved，不拦下次启动', async () => {
  const bot = mkBot();
  let pos = { sizeBase: 0.0056, entryPrice: 71_249.6 };
  bot.ex = {
    getPosition: () => pos,
    closePosition: async () => {
      // 方向不符（另一个方向），窗口认领不到 → untracked +1
      bot._handleFill({ marketId: 1, orderId: 'other', side: 'buy', sizeBase: 0.0002, price: 70_500 });
      pos = null;
      return { orderId: 'c2', side: 'sell', price: 70_458.7, sizeBase: 0.0056 };
    },
  };
  await bot._closeWithConfirm(1);
  assert.equal(bot._untrackedFills.length, 0, '已对账的未识别成交不该继续拦启动');
  assert.equal(bot._untrackedResolved.length, 1, '证据保留在 resolved');
  assert.equal(bot._untrackedResolved[0].reason, 'close-confirmed');
});