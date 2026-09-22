// 阶段1 策略测试：ADX/特征（无未来函数）/四态 regime/双确认防抖。
// 运行: node test/regime.test.js（npm test 串联）
import assert from 'node:assert/strict';
import { adx } from '../src/indicators.js';
import { buildFeatures, dropUnclosed, structureRange } from '../src/strategy/features.js';
import { createRegimeTracker, evaluateRegime } from '../src/strategy/regime.js';
import { Regime } from '../src/strategy/types.js';

let passed = 0, failed = 0;
const T = [];
const test = (name, fn) => T.push([name, fn]);

const mkCandles = (closes, { range = 2, intervalSec = 300 } = {}) =>
  closes.map((c, i) => ({ time: i * intervalSec * 1000, open: c, high: c + range / 2, low: c - range / 2, close: c, volume: 1 }));

// ── ADX ──
test('ADX：单边趋势应高（+DI 主导），震荡应低', () => {
  const up = adx(mkCandles(Array.from({ length: 80 }, (_, i) => 100 + i)), 14);
  assert.ok(up, '趋势序列应有 ADX');
  assert.ok(up.adx > 60, `趋势 ADX 应 >60（实际 ${up.adx}）`);
  assert.ok(up.plusDI > up.minusDI, '+DI 应主导');

  const chop = adx(mkCandles(Array.from({ length: 80 }, (_, i) => (i % 2 ? 101 : 100)), { range: 1 }), 14);
  assert.ok(chop, '震荡序列应有 ADX');
  assert.ok(chop.adx < 20, `震荡 ADX 应 <20（实际 ${chop.adx}）`);

  assert.equal(adx(mkCandles([100, 101, 102]), 14), null, '数据不足应返回 null');
});

// ── 特征 ──
test('dropUnclosed：丢弃未收盘 K 线', () => {
  const c = mkCandles([100, 101, 102]); // time: 0, 300s, 600s（收盘 900s）
  const now = 600_000 + 100_000; // 600s 那根尚未收盘（收盘 900s > 700s）
  const closed = dropUnclosed(c, 300, now);
  assert.equal(closed.length, 2);
  assert.equal(closed.at(-1).close, 101);
  assert.equal(dropUnclosed(c, 300, 900_000).length, 3, '收盘时刻应包含');
});

test('structureRange：滚动结构高低点', () => {
  const c = mkCandles([100, 105, 95, 102]);
  const r = structureRange(c, 4);
  assert.equal(r.low, 95 - 1);
  assert.equal(r.high, 105 + 1);
});

test('buildFeatures：多周期对齐布尔与波动率（确定性，无未来函数）', () => {
  const up5 = mkCandles(Array.from({ length: 120 }, (_, i) => 100 + i * 0.2));
  const up1h = mkCandles(Array.from({ length: 120 }, (_, i) => 100 + i * 0.5), { intervalSec: 3600 });
  const up4h = mkCandles(Array.from({ length: 120 }, (_, i) => 100 + i * 1.0), { intervalSec: 14400 });
  const f1 = buildFeatures({ candles5m: up5, candles1h: up1h, candles4h: up4h });
  const f2 = buildFeatures({ candles5m: up5, candles1h: up1h, candles4h: up4h });
  assert.deepEqual(f1, f2, '相同输入必须确定性输出');
  assert.equal(f1.htfUp, true);
  assert.equal(f1.mtfUp, true);
  assert.equal(f1.entryUp, true);
  assert.ok(f1.adx1h > 0);
  assert.ok(f1.atrPct > 0);
  assert.ok(f1.structureLow > 0 && f1.structureHigh > f1.structureLow);
  assert.equal(buildFeatures({ candles5m: [], candles1h: [], candles4h: [] }), null, '数据不足返回 null');
});

// ── regime 四态 ──
const featureUp = (over = {}) => ({
  price: 100, htfUp: true, mtfUp: true, entryUp: true, priceVsEma20_5m: 1,
  adx1h: 30, plusDI: 30, minusDI: 10, slope4h: 0.002, slope1h: 0.002, slope5m: 0.001,
  atr5m: 1, atr1h: 1, atr4h: 1, atrPct: 1.0, structureLow: 98, structureHigh: 102, ...over,
});

test('evaluateRegime：全对齐向上 -> TREND_UP/多头，评分>0', () => {
  const s = evaluateRegime(featureUp());
  assert.equal(s.regime, Regime.TREND_UP);
  assert.equal(s.direction, 'long');
  assert.ok(s.score > 50, `score 应 >50（实际 ${s.score}）`);
  assert.ok(s.confidence > 0);
});

test('evaluateRegime：全对齐向下 -> TREND_DOWN/空头，评分<0', () => {
  const s = evaluateRegime(featureUp({ htfUp: false, mtfUp: false, entryUp: false, priceVsEma20_5m: -1, slope4h: -0.002, slope1h: -0.002, plusDI: 10, minusDI: 30 }));
  assert.equal(s.regime, Regime.TREND_DOWN);
  assert.equal(s.direction, 'short');
  assert.ok(s.score < -50);
});

test('evaluateRegime：4H 与 1H 不同向 -> RANGE（空仓，不回退中性网格）', () => {
  const s = evaluateRegime(featureUp({ mtfUp: false, slope1h: -0.001 }));
  assert.equal(s.regime, Regime.RANGE);
  assert.equal(s.direction, null);
});

test('evaluateRegime：ADX 不足 -> RANGE', () => {
  const s = evaluateRegime(featureUp({ adx1h: 10 }));
  assert.equal(s.regime, Regime.RANGE);
});

test('evaluateRegime：波动超限 -> VOLATILE（优先级最高）', () => {
  const s = evaluateRegime(featureUp({ atrPct: 3.5 }));
  assert.equal(s.regime, Regime.VOLATILE);
  assert.equal(s.direction, null);
});

// ── 双确认防抖 ──
test('tracker：连续两次 5M 达标才入场（单次不动作）', () => {
  const tr = createRegimeTracker({ entryThreshold: 50, exitThreshold: 15, adxMin: 18 });
  const sig = { score: 60, direction: 'long' };
  const r1 = tr.onEvaluation(sig, { barKey: 1 });
  assert.equal(r1.entryDirection, null, '第一次不确认');
  const r2 = tr.onEvaluation(sig, { barKey: 2 });
  assert.equal(r2.entryDirection, 'long', '连续两次确认');
});

test('tracker：中间跌破阈值重置连击', () => {
  const tr = createRegimeTracker({ entryThreshold: 50 });
  tr.onEvaluation({ score: 60, direction: 'long' }, { barKey: 1 });
  tr.onEvaluation({ score: 10, direction: null }, { barKey: 2 }); // 重置
  const r3 = tr.onEvaluation({ score: 60, direction: 'long' }, { barKey: 3 });
  assert.equal(r3.entryDirection, null, '重置后需重新累计两次');
});

test('tracker：1H 收盘确认一次即可入场', () => {
  const tr = createRegimeTracker({ entryThreshold: 50 });
  const r = tr.onEvaluation({ score: -55, direction: 'short' }, { barKey: 1, isNewHourlyBar: true });
  assert.equal(r.entryDirection, 'short');
});

test('tracker：RANGE/VOLATILE 方向为空时不入场（趋势不明确空仓）', () => {
  const tr = createRegimeTracker({ entryThreshold: 50 });
  tr.onEvaluation({ score: 60, direction: null }, { barKey: 1 });
  const r = tr.onEvaluation({ score: 60, direction: null }, { barKey: 2 });
  assert.equal(r.entryDirection, null);
});

test('tracker：退出阈值（多头 score<15 / 空头 score>-15）', () => {
  const tr = createRegimeTracker({ exitThreshold: 15 });
  assert.equal(tr.shouldExit('long', 14), true);
  assert.equal(tr.shouldExit('long', 15), false);
  assert.equal(tr.shouldExit('short', -14), true);
  assert.equal(tr.shouldExit('short', -15), false);
});

test('tracker：同 barKey 重复评估被跳过（去重）', () => {
  const tr = createRegimeTracker({ entryThreshold: 50 });
  tr.onEvaluation({ score: 60, direction: 'long' }, { barKey: 7 });
  const dup = tr.onEvaluation({ score: 60, direction: 'long' }, { barKey: 7 });
  assert.equal(dup.skipped, true);
  const next = tr.onEvaluation({ score: 60, direction: 'long' }, { barKey: 8 });
  assert.equal(next.entryDirection, 'long');
});

(async () => {
  for (const [name, fn] of T) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
