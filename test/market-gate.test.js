// 市场三绿指标单测：门边界（振幅/斜率/极值）、防抖两拍、数据源兜底、未收盘过滤。
// 运行: node test/market-gate.test.js（npm test 串联）
import assert from 'node:assert/strict';
import { computeGates, createMarketGate, describeGaps, MARKET_GATE_DEFAULTS } from '../src/market-gate.js';

let passed = 0, failed = 0;
const T = [];
const test = (name, fn) => T.push([name, fn]);
const H = 3_600_000;

const flatCandles = (n = 96, price = 100) =>
  Array.from({ length: n }, (_, i) => ({ time: i * H, open: price, high: price, low: price, close: price, volume: 1 }));

// ── computeGates 门边界 ──
test('门1 振幅：≤2.5% 绿 / >2.5% 红（含边界口径一致性）', () => {
  const green = flatCandles();
  green[72].low = 100 / 1.0249; // 24h 振幅 2.49%
  const g1 = computeGates(green);
  assert.equal(g1.greens.amplitude, true, `2.49% 应绿（实际 ${g1.amplitudePct}）`);

  const red = flatCandles();
  red[72].low = 100 / 1.0251; // 2.51%
  const g2 = computeGates(red);
  assert.equal(g2.greens.amplitude, false, `2.51% 应红（实际 ${g2.amplitudePct}）`);

  const exact = flatCandles();
  exact[72].low = 100 / 1.025; // 名义 2.5%
  const g3 = computeGates(exact);
  assert.equal(g3.greens.amplitude, g3.amplitudePct <= 2.5, '边界口径必须为 ≤（阈值即绿）');
});

test('门3 极值：极值出现在最近 <24h 内红 / ≥24h 绿', () => {
  const safe = flatCandles();
  safe[71].high = 101; // age = 95-71 = 24h
  assert.equal(computeGates(safe).greens.noNewExtreme, true, 'age=24h 应绿');
  const recent = flatCandles();
  recent[72].high = 101; // age = 23h
  assert.equal(computeGates(recent).greens.noNewExtreme, false, 'age=23h 应红（创新高）');
});

test('门2 斜率：走平绿 / 强趋势红 / 阈值 ±0.05 精确边界翻转', () => {
  const flat = computeGates(flatCandles());
  assert.equal(flat.greens.slope, true, '走平应绿');
  assert.ok(Math.abs(flat.slopePctPerH) < 1e-6);

  const ramp = (rate) => Array.from({ length: 96 }, (_, i) => {
    const px = 100 * (1 + rate) ** i;
    return { time: i * H, open: px, high: px, low: px, close: px, volume: 1 };
  });
  const steep = computeGates(ramp(0.002));
  assert.equal(steep.greens.slope, false, '0.2%/h 应红');
  assert.ok(Math.abs(steep.slopePctPerH) > 0.05);

  // 二分找到 |slope| = 0.05 的临界 ramp 率，验证两侧翻转
  let loR = 0, hiR = 0.002;
  for (let i = 0; i < 50; i++) {
    const mid = (loR + hiR) / 2;
    if (Math.abs(computeGates(ramp(mid)).slopePctPerH) < 0.05) loR = mid; else hiR = mid;
  }
  assert.equal(computeGates(ramp(loR * 0.99)).greens.slope, true, '临界下侧应绿');
  assert.equal(computeGates(ramp(hiR * 1.01)).greens.slope, false, '临界上侧应红');
});

test('describeGaps：红灯项给出"还差多少"', () => {
  const c = flatCandles();
  c[72].low = 100 / 1.04; // 4% 振幅
  c[80].high = 101;       // 且 15h 内创新高
  const g = computeGates(c);
  const gaps = describeGaps(g);
  assert.ok(gaps.some((x) => x.includes('振幅 4.0') || x.includes('振幅')), `含振幅差距（${gaps.join('；')}）`);
  assert.ok(gaps.some((x) => x.includes('极值')), '含极值差距');
});

test('数据不足 -> ok=false 且不判绿', () => {
  const g = computeGates(flatCandles(10));
  assert.equal(g.ok, false);
  assert.equal(g.allGreen, false);
});

// ── 轮询器：防抖 / 兜底 / 未收盘过滤 ──
function binanceRows(closedCount = 96, { unclosed = null } = {}) {
  const nowMs = Date.now();
  const lastOpen = Math.floor(nowMs / H) * H - H; // 最近一根已收盘
  const rows = [];
  for (let i = 0; i < closedCount; i++) {
    const t = lastOpen - (closedCount - 1 - i) * H;
    rows.push([t, '100', '100', '100', '100', '1']);
  }
  if (unclosed) rows.push([lastOpen + H, '100', String(unclosed.high), String(unclosed.low ?? '100'), '100', '1']);
  return rows;
}

function makeGate({ rows, fallback = null, notifierSends = [] } = {}) {
  const notifier = { send: (o) => { notifierSends.push(o); return true; } };
  const gate = createMarketGate({
    config: { symbol: 'BTC' },
    fetchImpl: async () => ({ ok: true, json: async () => rows }),
    fetchFallback: fallback,
    notifier,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { gate, notifierSends };
}

test('防抖：连续 2 次全绿才转绿推送；单次不推', async () => {
  const { gate, notifierSends } = makeGate({ rows: binanceRows() });
  await gate.tick();
  assert.equal(gate.snapshot().allGreen, true);
  assert.equal(notifierSends.length, 0, '第 1 次不推送');
  assert.equal(gate.mode, null, '未确认');
  await gate.tick();
  assert.equal(notifierSends.length, 1, '第 2 次转绿推送');
  assert.ok(notifierSends[0].message.includes('🟢'), '绿灯消息');
  assert.equal(notifierSends[0].key, 'market-gate');
  assert.equal(notifierSends[0].cooldownMs, MARKET_GATE_DEFAULTS.notifyCooldownMs, '冷却 6h');
  assert.equal(gate.mode, 'green');
  await gate.tick();
  assert.equal(notifierSends.length, 1, '持续绿不重复推送');
});

test('防抖：转红同样两拍确认；绿->红边界抖动不刷屏', async () => {
  const rowsGreen = binanceRows();
  const rowsRed = binanceRows();
  rowsRed[72][3] = String(100 / 1.04); // 某根 low 拉低 -> 24h 振幅 4%
  const holder = { rows: rowsGreen };
  const sends = [];
  const gate = createMarketGate({
    fetchImpl: async () => ({ ok: true, json: async () => holder.rows }),
    notifier: { send: (o) => { sends.push(o); return true; } },
    logger: { info() {}, warn() {}, error() {} },
  });
  await gate.tick(); await gate.tick(); // 绿两拍
  assert.equal(gate.mode, 'green');
  assert.equal(sends.length, 1);

  holder.rows = rowsRed;
  await gate.tick();
  assert.equal(sends.length, 1, '红一拍不推（防抖）');
  assert.equal(gate.mode, 'green', '未确认转红前保持绿态');
  await gate.tick();
  assert.equal(sends.length, 2, '红两拍推送');
  assert.ok(sends.at(-1).message.includes('🔴'), '红灯消息');
  assert.equal(gate.mode, 'red');
});

test('主源失败 2 次后切换兜底源并标注 source', async () => {
  const fbCandles = flatCandles().map((c, i) => ({ ...c, time: Date.now() - (96 - i) * H }));
  let gate;
  const fallback = async () => ({ candles: fbCandles, source: 'Extended' });
  gate = createMarketGate({
    fetchImpl: async () => { throw new Error('binance blocked'); },
    fetchFallback: fallback,
    notifier: { send: () => true },
    logger: { info() {}, warn() {}, error() {} },
  });
  await gate.tick();
  assert.equal(gate.snapshot().ok, false, '第 1 次失败：不用兜底（等第 2 次）');
  assert.ok(gate.snapshot().error.includes('binance blocked'));
  await gate.tick();
  const snap = gate.snapshot();
  assert.equal(snap.ok, true, '第 2 次失败后启用兜底并计算成功');
  assert.equal(snap.source, 'fallback:Extended', 'source 标注兜底');
  await gate.tick();
  assert.equal(gate.snapshot().source, 'fallback:Extended', '切换后保持兜底');
});

test('未收盘 K 线被丢弃（含诈值不影响判断）', async () => {
  // 未收盘根 high=999：若被计入会瞬间判振幅红
  const rows = binanceRows(96, { unclosed: { high: 999 } });
  const { gate } = makeGate({ rows });
  await gate.tick();
  const snap = gate.snapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.values.amplitudePct, 0, '振幅仅按已收盘计算');
  assert.equal(snap.allGreen, true, '未收盘诈值被过滤');
});

(async () => {
  for (const [name, fn] of T) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
