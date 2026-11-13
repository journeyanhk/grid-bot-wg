// test/stopped-fill-dedupe.test.js —— 回放不许记账两次
//
// 2026-11-13 review 必改 3：修好「停机期间成交入账」之后，新写入口带来新风险 ——
// 轮询游标重启后重新对齐，可能把已处理过的成交再推一遍（现场实测过「游标落后 1247ms」）。
// 若那条平仓成交被回放，expected 会从 0 变成 −0.0056，账本与交易所立刻不一致 → 假熔断。
// 也就是说：**这次熔断的成因，恰恰是「修了入账」。**
//
// 约束：
//   ① `_handleFill` 与 `_applyFillWhileStopped` 共用同一套去重（都走 PositionLedger.applyFill 的 fillKey）；
//   ② 重复不入账，只 `duplicateFills++`（不报警、不熔断，但必须可见）；
//   ③ 已应用成交集合跨重启持久化（seenOrder）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { PositionLedger } from '../src/position-ledger.js';

const FILL = {
  marketId: 1,
  orderId: '83d69dffd9f94e82',
  side: 'sell',
  sizeBase: 0.0056,
  price: 70_458.7,
  rawTs: 1_762_990_468_000,
};

function mkBot({ running = false, ledger = {} } = {}) {
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
  bot.posLedger = new PositionLedger({ startBase: 0.0056, expected: 0.0056, ...ledger });
  bot._runRiskCycle = () => {};
  bot._checkTrendFills = () => {};
  bot._queueReplacement = () => {};
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(String(m));
  bot._touch = () => {};
  bot._changed = () => {};
  bot._duplicateFills = 0;
  return bot;
}

test('停机窗口：同一笔成交连喂两次，账本只动一次，duplicateFills=1', () => {
  const bot = mkBot({ running: false });
  bot._recentOrderMeta.set(FILL.orderId, { levelIndex: 0, side: 'sell', price: FILL.price });
  bot._handleFill({ ...FILL });
  assert.equal(bot.posLedger.value, 0, '第一次必须入账到 0');
  bot._handleFill({ ...FILL });
  assert.equal(bot.posLedger.value, 0, '回放不许把 expected 推成 −0.0056');
  assert.equal(bot._duplicateFills, 1);
  assert.equal(bot._untrackedFills.length, 0, '重复不是「未识别」，不许进未知列表');
});

test('运行态：同一笔成交连喂两次，账本只动一次，duplicateFills=1', () => {
  const bot = mkBot({ running: true });
  bot.active.set(FILL.orderId, { levelIndex: 0, side: 'sell', price: FILL.price, opening: true });
  bot._handleFill({ ...FILL });
  const afterFirst = bot.posLedger.value;
  bot._handleFill({ ...FILL });
  assert.equal(bot.posLedger.value, afterFirst);
  assert.equal(bot._duplicateFills, 1);
});

test('跨重启：已应用成交集合随快照恢复，重启后回放仍不记账', () => {
  const bot = mkBot({ running: false });
  bot._handleFill({ ...FILL });
  assert.equal(bot.posLedger.value, 0);

  const snap = bot.posLedger.toJSON();
  const revived = mkBot({ running: false, ledger: snap });
  revived._handleFill({ ...FILL });
  assert.equal(revived.posLedger.value, 0, '重启后回放不许再记账');
  assert.equal(revived._duplicateFills, 1);
});