// test/ledger-block-sticky.test.js —— 重锚被拒：账本不可信时，网格不许继续挂单
//
// 2026-11-13 review 补丁（必改 4 残留）：
// 拒绝重锚时只写 `_startBlocked` 只能拦住「下次启动」，
// 而运行态下（成交在跑单中到达、差额解释不了）网格还在挂单 —— 账本已经不可信，
// 敞口却继续扩大。所以 `_ledgerBlockReason` 必须是粘滞闸：
// 任何风控结果（哪怕算出来 RUNNING）都要被压成 DEFENSIVE + blockOpening=true，
// 直到 new-epoch（账本按交易所真值重建）才解除。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { STATES } from '../src/guard.js';

function mkBot() {
  const bot = Object.create(GridBot.prototype);
  bot._guardLastState = STATES.RUNNING;
  bot._ledgerBlockReason = '账本重锚被拒绝（delta-mismatch）';
  bot._alerts = [];
  bot._alert = (m) => bot._alerts.push(String(m));
  bot._changed = () => {};
  bot.guard = null;
  return bot;
}

const RUNNING = {
  state: STATES.RUNNING, reasons: [], blockOpening: false, blockSide: null,
  haltReason: null, metrics: {},
};

test('运行态重锚被拒：风控算成 RUNNING 也必须被压成 DEFENSIVE + blockOpening', () => {
  const bot = mkBot();
  const r = bot._applyGuardResult({ ...RUNNING });
  assert.equal(r.state, STATES.DEFENSIVE, '账本不可信时不许报 RUNNING');
  assert.equal(r.blockOpening, true, '必须禁开仓，而不是只拦下次启动');
  assert.match(r.reasons[0], /重锚被拒绝/);
});

test('熔断优先级更高：已 HALTED 时不被降级成 DEFENSIVE', () => {
  const bot = mkBot();
  const r = bot._applyGuardResult({ ...RUNNING, state: STATES.HALTED, haltReason: 'x' });
  assert.equal(r.state, STATES.HALTED, '熔断是粘滞的，任何自动逻辑都不许降级');
  assert.equal(r.blockOpening, true);
});

test('没有拒绝理由时原样透传（不许把正常 RUNNING 也压成 DEFENSIVE）', () => {
  const bot = mkBot();
  bot._ledgerBlockReason = null;
  const r = bot._applyGuardResult({ ...RUNNING });
  assert.equal(r.state, STATES.RUNNING);
  assert.equal(r.blockOpening, false);
});