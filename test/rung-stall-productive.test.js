// test/rung-stall-productive.test.js —— 「运行」是一个状态，不是一个布尔值
//
// 2026-11-13 review（第二次，🔴 必改 2 残留）：
// 上一版 `_rungStallTick` 只排除了 `running=false`，于是「开着但不干活」的时间
// （HALTED 熔断、库存闸 blockOpening）也被算进「完成格零增长」。
//
// 后果不是数字难看，是一次**自动动作**：
//   库存 32 格（blockOpening=true）→ 再来一次 12h 熔断（这周 6 次，最长 17h）
//   → 恢复那一刻 _stallRunningMs ≥ 12h，projected ≥ 28 也成立
//   → 预授权减仓**在恢复的瞬间自动执行**。
//
// 约束：
//   ① 只有 RUNNING 且 !blockOpening 才累加零增长；
//   ② HALTED 记 _haltedMs、blockOpening 记 _blockedMs，分列报告，绝不混入判据；
//   ③ running=false 三者都不动（停机不是停转）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { STATES } from '../src/guard.js';

const H12 = 12 * 3600_000;

function mkBot({ running = true, state = STATES.RUNNING, blockOpening = false } = {}) {
  const bot = Object.create(GridBot.prototype);
  bot.running = running;
  bot.guardState = { state, blockOpening, blockSide: null, reasons: [] };
  bot._stallRunningMs = 0;
  bot._haltedMs = 0;
  bot._blockedMs = 0;
  bot._stallTickAt = 1_000_000;
  return bot;
}

test('RUNNING：12h 全计入零增长', () => {
  const bot = mkBot({});
  bot._rungStallTickAt(1_000_000 + H12);
  assert.equal(bot._stallRunningMs, H12);
  assert.equal(bot._haltedMs, 0);
  assert.equal(bot._blockedMs, 0);
});

test('running=true + HALTED：12h 一格都不进零增长，全进 haltedMs', () => {
  const bot = mkBot({ state: STATES.HALTED });
  bot._rungStallTickAt(1_000_000 + H12);
  assert.equal(bot._stallRunningMs, 0, '熔断期不许计入零增长（否则恢复瞬间触发减仓）');
  assert.equal(bot._haltedMs, H12);
  assert.equal(bot._blockedMs, 0);
});

test('running=true + DEFENSIVE + blockOpening（库存闸）：只进 blockedMs', () => {
  const bot = mkBot({ state: STATES.DEFENSIVE, blockOpening: true });
  bot._rungStallTickAt(1_000_000 + H12);
  assert.equal(bot._stallRunningMs, 0, '买腿被拦时引擎不产出，不许计入零增长');
  assert.equal(bot._blockedMs, H12);
  assert.equal(bot._haltedMs, 0);
});

test('running=false：三个计时都不动（停机不是停转）', () => {
  const bot = mkBot({ running: false, state: STATES.RUNNING });
  bot._rungStallTickAt(1_000_000 + H12);
  assert.equal(bot._stallRunningMs, 0);
  assert.equal(bot._haltedMs, 0);
  assert.equal(bot._blockedMs, 0);
});

test('跨状态分段累计：4h 跑 + 6h 熔断 + 2h 拦买 → 零增长只有 4h', () => {
  const bot = mkBot({});
  bot._rungStallTickAt(1_000_000 + 4 * 3600_000);
  bot.guardState = { state: STATES.HALTED, blockOpening: false, reasons: [] };
  bot._rungStallTickAt(1_000_000 + 10 * 3600_000);
  bot.guardState = { state: STATES.DEFENSIVE, blockOpening: true, reasons: [] };
  bot._rungStallTickAt(1_000_000 + 12 * 3600_000);
  assert.equal(bot._stallRunningMs, 4 * 3600_000);
  assert.equal(bot._haltedMs, 6 * 3600_000);
  assert.equal(bot._blockedMs, 2 * 3600_000);
});

test('完成一格：零增长清零（熔断/拦买计时不清——它们是历史，不是判据）', () => {
  const bot = mkBot({ state: STATES.HALTED });
  bot._rungStallTickAt(1_000_000 + H12);
  bot._noteRungCompleted();
  assert.equal(bot._stallRunningMs, 0);
  assert.equal(bot._haltedMs, H12);
});