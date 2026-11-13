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
// —— 复位线：连续 3 次同样本一致 + 历时 ≥90s → 自动解除（review 要求 1） ——
function mkHealBot() {
  const bot = mkBot();
  bot.config = { marketId: 1 };
  bot.posLedger = { value: 0.0056 };
  bot.ex = { getPosition: () => ({ sizeBase: 0.0056 }) };
  bot._ledgerBlockAt = Date.now() - 60_000;
  return bot;
}

test('自愈：3 次一致且历时 ≥90s → 解除并留痕', () => {
  const bot = mkHealBot();
  const ok = { ok: true, status: 'ok', issues: [] };
  bot._maybeAutoClearLedgerBlock(ok);           // 第 1 次，建立 since
  bot._ledgerBlockOkSince = Date.now() - 91_000; // 让「历时」满足
  bot._maybeAutoClearLedgerBlock(ok);           // 第 2 次
  assert.equal(bot._ledgerBlockReason !== null, true, '两次还不够');
  const cleared = bot._maybeAutoClearLedgerBlock(ok); // 第 3 次
  assert.equal(cleared, true);
  assert.equal(bot._ledgerBlockReason, null);
  assert.equal(bot._ledgerBlockAutoCleared.n, 3);
  assert.equal(bot._ledgerBlockAutoCleared.delta, 0);
  assert.ok(bot._alerts.some((m) => m.includes('账本闸已自愈解除')));
});

test('自愈：中间有一次不一致 → 连击清零，不解除', () => {
  const bot = mkHealBot();
  const ok = { ok: true, status: 'ok', issues: [] };
  const bad = { ok: false, status: 'mismatch', issues: ['仓位不一致'] };
  bot._maybeAutoClearLedgerBlock(ok);
  bot._ledgerBlockOkSince = Date.now() - 91_000;
  bot._maybeAutoClearLedgerBlock(ok);
  bot._maybeAutoClearLedgerBlock(bad);
  assert.equal(bot._ledgerBlockOkStreak, 0);
  const cleared = bot._maybeAutoClearLedgerBlock(ok);
  assert.equal(cleared, false, '一次不一致之后必须重新数三次');
  assert.equal(bot._ledgerBlockReason !== null, true);
});

test('自愈：历时不足 90s 不解除（三次一致但太快）', () => {
  const bot = mkHealBot();
  const ok = { ok: true, status: 'ok', issues: [] };
  for (let i = 0; i < 5; i += 1) bot._maybeAutoClearLedgerBlock(ok);
  assert.equal(bot._ledgerBlockReason !== null, true, '90s 是规格的一部分，不是装饰');
});

test('过期：6h 未解 → 升级告警只报一次（不是只写日志）', () => {
  const bot = mkHealBot();
  bot._ledgerBlockAt = Date.now() - 6.5 * 3600_000;
  bot._ledgerBlockReason = '账本重锚被拒绝（仓位不一致）';
  bot._maybeAutoClearLedgerBlock({ ok: false, status: 'mismatch', issues: ['x'] });
  const hits = bot._alerts.filter((m) => /未解/.test(m));
  assert.equal(hits.length, 1);
  assert.equal(bot._ledgerBlockEscalated, true);
  bot._maybeAutoClearLedgerBlock({ ok: false, status: 'mismatch', issues: ['x'] });
  assert.equal(bot._alerts.filter((m) => /未解/.test(m)).length, 1, '不许每轮刷屏');
});
