// test/apply-fill-error.test.js —— 「账本写失败」必须比「成交没认领」更响
//
// 2026-11-13 review 补丁：applyFill 原来在函数最开头裸调，抛异常就整条成交消失、
// 不计数、不留痕 —— 巡检看到的是一本「干净的账」，实际上少了一笔。
// 现在：applyFillErrors++ + 进 _untrackedFills（带 applyError）+ 告警。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';

const FILL = {
  marketId: 1, orderId: 'deadbeef01', side: 'sell',
  sizeBase: 0.0002, price: 68_400, rawTs: 1_763_000_000_000,
};

function mkBot() {
  const bot = Object.create(GridBot.prototype);
  bot.running = false;
  bot.config = { marketId: 1, sizeBase: 0.0002, displayName: 'BTC-USD', mode: 'neutral' };
  bot.active = new Map();
  bot._recentOrderMeta = new Map();
  bot._untrackedFills = [];
  bot._applyFillErrors = 0;
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(String(m));
  bot._changed = () => {};
  bot._duplicateFills = 0;
  bot.posLedger = { applyFill() { throw new Error('EIO: 磁盘写入失败'); }, value: 0 };
  return bot;
}

test('停机路径：applyFill 抛异常 → 计数 + 未识别留痕 + 告警（不再静默）', () => {
  const bot = mkBot();
  bot._applyFillWhileStopped(FILL);
  assert.equal(bot._applyFillErrors, 1);
  assert.equal(bot._untrackedFills.length, 1, '写失败必须留一条记录，否则巡检看到的是干净的账');
  assert.match(bot._untrackedFills[0].applyError, /磁盘写入失败/);
  assert.equal(bot._untrackedFills[0].whileStopped, true);
  assert.ok(bot._alerts.some((m) => m.includes('账本写入失败')), '必须告警');
  assert.match(bot.lastStopFill.applyError, /磁盘写入失败/);
  assert.equal(bot._duplicateFills, 0, '写失败不是重复成交，不许混进 duplicateFills');
});

test('写失败不吞掉后续成交：第二次成功仍能入账', () => {
  const bot = mkBot();
  let calls = 0;
  bot.posLedger = {
    value: 0,
    applyFill() { calls += 1; if (calls === 1) throw new Error('transient'); return { duplicate: false }; },
  };
  bot._applyFillWhileStopped(FILL);
  bot._applyFillWhileStopped({ ...FILL, orderId: 'deadbeef02' });
  assert.equal(bot._applyFillErrors, 1);
  assert.equal(calls, 2);
  assert.ok(bot.lastStopFill.ledgerAfter !== undefined);
});