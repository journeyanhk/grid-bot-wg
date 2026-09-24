// Review 质量修复专项测试（dev006/v1.7.1）：
// 资金费率逐时段累计/缺失、断档 K 线补处理、未平仓 MTM 入口径、覆盖率与资金完整度闸门、
// ATR 来源一致性、盘口滑点仅诊断、重启恢复、有符号基差统计。
import assert from 'node:assert/strict';
import { accrueFunding, createShadowRecorder, SHADOW_DEFAULTS } from '../src/strategy/shadow-recorder.js';
import { computePendingBars } from '../src/strategy/shadow-runner.js';
import { evaluateRegime } from '../src/strategy/regime.js';
import { composeDailyReport, computeStats, evaluateGate, fundingCompleteness, summarizeBasis } from '../src/strategy/shadow-persistence.js';

let passed = 0, failed = 0;
const T = [];
const test = (name, fn) => T.push([name, fn]);
const FEAT = { atr5m: 10, atr1h: 10, structureLow: 95, structureHigh: 105 };
const SIG = { score: 65, direction: 'long' };
const cdl = (t) => ({ time: t, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 });
const mkPos = () => ({ side: 'long', avgEntry: 100, filledSize: 1, funding: { accruedThrough: 0, totalUsd: 0, samples: 0, missingMs: 0, lastRate: null } });

// ── 资金费率（P0-1） ──
test('accrueFunding：跨整点费率变化 -> 逐时段累计（不用最终费率覆盖全程）', () => {
  const pos = mkPos();
  accrueFunding(pos, 2 * 3_600_000, [{ time: 3_600_000, rate: 0.0001 }, { time: 7_200_000, rate: 0.0002 }]);
  assert.ok(Math.abs(pos.funding.totalUsd - 0.03) < 1e-9, '0.01+0.02 分段累计');
  assert.equal(pos.funding.samples, 2);
  assert.equal(pos.funding.missingMs, 0);
});

test('accrueFunding：费率点缺失 -> 计 missingMs，绝不静默当 0', () => {
  const pos = mkPos();
  accrueFunding(pos, 2 * 3_600_000, [{ time: 3_600_000, rate: 0.0001 }]);
  assert.equal(pos.funding.missingMs, 3_600_000, '缺失时段的时长被记录');
  assert.ok(Math.abs(pos.funding.totalUsd - 0.01) < 1e-9, '只累计有数据的时段');
});

test('accrueFunding：完全无数据（null）-> missing 全额、成本为 0 而非估算', () => {
  const pos = mkPos();
  accrueFunding(pos, 2 * 3_600_000, null);
  assert.equal(pos.funding.totalUsd, 0);
  assert.equal(pos.funding.missingMs, 7_200_000);
});

test('accrueFunding：finalize 尾段按最后已知费率估算，无已知费率则记缺失', () => {
  const p1 = mkPos();
  accrueFunding(p1, 3_600_000, [{ time: 3_600_000, rate: 0.0001 }]);
  p1.funding.accruedThrough = 3_600_000;
  accrueFunding(p1, 3_600_000 + 1_800_000, [{ time: 3_600_000, rate: 0.0001 }], { finalize: true });
  assert.ok(Math.abs(p1.funding.totalUsd - (0.01 + 0.005)) < 1e-9, '尾段 0.5h 用最后已知费率');
  const p2 = mkPos();
  accrueFunding(p2, 1_800_000, null);
  accrueFunding(p2, 3_600_000, null, { finalize: true });
  assert.equal(p2.funding.totalUsd, 0);
  assert.equal(p2.funding.missingMs, 3_600_000);
});

test('recorder 集成：持仓横跨两个整点、费率中途变化 -> trade.fundingUsd 为分段和', () => {
  let fake = 0;
  const rec = createShadowRecorder({ now: () => fake });
  rec.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: FEAT });
  rec.onBar({ candle5m: cdl(300_000), signal: SIG, barKey: 300_000, features: FEAT });
  const pos = rec.configs.get('r2fast').position;
  assert.ok(pos, '入场');
  const notional = 100 * pos.filledSize;
  const points = [{ time: 3_600_000, rate: 0.0001 }, { time: 7_200_000, rate: 0.0002 }];
  fake = 3_300_000;
  rec.onBar({ candle5m: cdl(3_300_000), signal: SIG, barKey: 3_300_000, features: FEAT, fundingPoints: points });
  fake = 6_900_000;
  rec.onBar({ candle5m: cdl(6_900_000), signal: SIG, barKey: 6_900_000, features: FEAT, fundingPoints: points });
  fake = 7_200_000;
  rec.onBar({ candle5m: cdl(7_200_000), signal: { score: 5, direction: null }, barKey: 7_200_000, features: FEAT, fundingPoints: points });
  const trade = rec.configs.get('r2fast').trades[0];
  assert.equal(trade.exitReason, 'signal_exit');
  const expect = notional * (0.0001 + 0.0002);
  assert.ok(Math.abs(trade.fundingUsd - expect) < 1e-6, `分段累计 ${expect}（实际 ${trade.fundingUsd}，若用最终费率覆盖为 ${notional * 0.0002 * 2}）`);
  assert.equal(trade.fundingMissingMs, 0);
});

test('recorder 集成：资金费率数据不可用 -> fundingUsd=0 且 missingMs>0（不当 0 计）', () => {
  let fake = 0;
  const rec = createShadowRecorder({ now: () => fake });
  rec.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: FEAT });
  rec.onBar({ candle5m: cdl(300_000), signal: SIG, barKey: 300_000, features: FEAT });
  fake = 3_600_000;
  rec.onBar({ candle5m: cdl(3_300_000), signal: SIG, barKey: 3_300_000, features: FEAT, fundingPoints: null });
  fake = 3_600_000;
  rec.onBar({ candle5m: cdl(3_600_000), signal: { score: 5, direction: null }, barKey: 3_600_000, features: FEAT, fundingPoints: null });
  const trade = rec.configs.get('r2fast').trades[0];
  assert.equal(trade.fundingUsd, 0);
  assert.ok(trade.fundingMissingMs >= 3_600_000, `缺失时长被记录（实际 ${trade.fundingMissingMs}）`);
  const fc = fundingCompleteness([trade], null);
  assert.ok(fc.pct < 100, '完整度下降');
});

// ── 断档补处理（P0-2） ──
test('computePendingBars：连续无缺口 -> 全部待处理、零缺失', () => {
  const bars = [300_000, 600_000, 900_000].map((t) => ({ time: t }));
  const r = computePendingBars(bars, 0);
  assert.equal(r.pending.length, 3);
  assert.equal(r.missedBars, 0);
  assert.equal(r.gapMs, 0);
});

test('computePendingBars：20 分钟断档但窗口内可取 -> 顺序补 4 根、零缺失', () => {
  const bars = [300_000, 600_000, 900_000, 1_200_000].map((t) => ({ time: t }));
  const r = computePendingBars(bars, 0);
  assert.equal(r.pending.length, 4, '补处理 4 根 5M');
  assert.equal(r.pending[0].time, 300_000);
  assert.equal(r.pending.at(-1).time, 1_200_000);
  assert.equal(r.missedBars, 0);
  assert.equal(r.gapMs, 0, '窗口内可取不算缺口');
});

test('computePendingBars：缺口超出可取窗口 -> 计入缺失、不伪造', () => {
  const bars = [{ time: 1_200_000 }]; // 只取到 20 分钟后的那根
  const r = computePendingBars(bars, 0);
  assert.equal(r.pending.length, 1);
  assert.equal(r.missedBars, 3, '10:05/10:10/10:15 三根永久缺失');
  assert.equal(r.gapMs, 1_200_000, '缺口峰值 20 分钟');
});

test('computePendingBars：超回放上限 -> 截断并计入缺失', () => {
  const bars = Array.from({ length: 300 }, (_, i) => ({ time: (i + 1) * 300_000 }));
  const r = computePendingBars(bars, 0, 288);
  assert.equal(r.pending.length, 288);
  assert.equal(r.missedBars, 12);
});

// ── 未平仓 MTM（P0-3） ──
test('computeStats：未平仓浮亏计入净值/回撤/当日亏损（Gate 不能虚高）', () => {
  const trades = [{ closedAt: Date.now() - 86_400_000, netPnl: { baseline: 10, conservative: 10 }, grossPnl: 10, side: 'long', holdingMs: 1000, fundingMissingMs: 0 }];
  const without = computeStats(trades, 10_000, 'baseline');
  assert.ok(Math.abs(without.net - 10) < 1e-9);
  const withMtm = computeStats(trades, 10_000, 'baseline', { mtm: { mtmUsd: -30 } });
  assert.ok(Math.abs(withMtm.net - (-20)) < 1e-9, '净收益含 MTM');
  assert.ok(Math.abs(withMtm.maxDrawdown - 30) < 1e-9, '回撤含浮动亏损');
  assert.equal(withMtm.openMtmPnl, -30);
  assert.ok(withMtm.maxDailyLoss <= -29, '当日亏损含 MTM');
});

// ── 覆盖率与资金完整度闸门（P0-4 / P0-1） ──
const mkTrade = (o = {}) => ({ closedAt: 1, netPnl: { baseline: 5, conservative: 4 }, grossPnl: 5, side: 'long', holdingMs: 3_600_000, fundingMissingMs: 0, ...o });

test('evaluateGate：覆盖率/缺口不达标 -> 对应项失败（有效天数取代墙上时间）', () => {
  const data = { perConfig: { r2fast: { trades: Array.from({ length: 40 }, () => mkTrade()), position: null } } };
  const bad = evaluateGate(data, { equity: 10_000, coverage: { effectiveDays: 7.1, coveragePct: 95, maxGapMs: 20 * 60_000 } });
  assert.equal(bad.checks.find((c) => c.name.includes('覆盖率')).ok, false);
  assert.equal(bad.checks.find((c) => c.name.includes('缺口')).ok, false);
  const good = evaluateGate(data, { equity: 10_000, coverage: { effectiveDays: 7.1, coveragePct: 99.5, maxGapMs: 10 * 60_000 } });
  assert.equal(good.checks.find((c) => c.name.includes('覆盖率')).ok, true);
  assert.equal(good.checks.find((c) => c.name.includes('缺口')).ok, true);
  assert.equal(good.checks.find((c) => c.name.includes('有效数据天数')).ok, true);
});

test('evaluateGate：资金费率完整度 <99% -> 闸门失败；无持仓时按 100%', () => {
  const data = { perConfig: { r2fast: { trades: [mkTrade({ fundingMissingMs: 360_000 }), mkTrade({ fundingMissingMs: 0 })], position: null } } };
  const gate = evaluateGate(data, { equity: 10_000, coverage: { effectiveDays: 8, coveragePct: 100, maxGapMs: 300_000 } });
  const chk = gate.checks.find((c) => c.name.includes('资金费率数据完整度'));
  assert.equal(chk.ok, false, '缺失 5% -> 不达标');
  assert.equal(gate.funding.pct, 95);
});

test('evaluateGate：未平仓 MTM 纳入后净收益与回撤使用浮动口径', () => {
  const data = { perConfig: { r2fast: { trades: [mkTrade()], position: { tradeId: 'x', side: 'long', stopPrice: 90, funding: { totalUsd: 0.1, missingMs: 0 }, openedAt: 0 } } } };
  const gate = evaluateGate(data, { equity: 10_000, coverage: { effectiveDays: 1, coveragePct: 100, maxGapMs: 300_000 }, mtm: { mtmUsd: -500, holdingMs: 1000, fundingMissingMs: 0 } });
  assert.ok(Math.abs(gate.baseline.net - (5 - 500)) < 1e-9, 'Gate 使用含 MTM 的净值');
});

// ── ATR 来源 / 盘口采样口径（P1-1 / P1-2） ──
test('ATR 来源：atr1h 缺失时不入场（不得退回 5M ATR）', () => {
  const rec = createShadowRecorder({ now: () => 0 });
  const noAtr1h = { atr5m: 10, atr1h: null, structureLow: 95, structureHigh: 105 };
  rec.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: noAtr1h });
  rec.onBar({ candle5m: cdl(300_000), signal: SIG, barKey: 300_000, features: noAtr1h });
  assert.equal(rec.configs.get('r2fast').position, null, '1H ATR 不可用 -> 空仓');
});

test('盘口采样：仅记录 bookObservedSlippage，不改变净 PnL（Review Option A）', () => {
  const drive = (withBook) => {
    const rec = createShadowRecorder({ now: () => 0 });
    rec.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: FEAT });
    rec.onBar({ candle5m: cdl(300_000), signal: SIG, barKey: 300_000, features: FEAT, bookSample: withBook ? { entryBps: 8.5 } : null });
    rec.onBar({ candle5m: cdl(600_000), signal: { score: 5, direction: null }, barKey: 600_000, features: FEAT });
    return rec.configs.get('r2fast').trades[0];
  };
  const a = drive(false), b = drive(true);
  assert.equal(b.bookObservedSlippage.entryBps, 8.5);
  assert.equal(a.bookObservedSlippage, null);
  assert.equal(a.netPnl.baseline, b.netPnl.baseline, '采样不进入净 PnL');
});

// ── 重启恢复 / 基差统计（P2-2 / 恢复） ──
test('重启恢复：export/loadData 保留 funding 累计、bookSamples 与持仓', () => {
  const rec = createShadowRecorder({ now: () => 0 });
  rec.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: FEAT });
  rec.onBar({ candle5m: cdl(300_000), signal: SIG, barKey: 300_000, features: FEAT, bookSample: { entryBps: 3.2 } });
  rec.configs.get('r2fast').position.funding.totalUsd = 0.123;
  const data = rec.exportData();
  const rec2 = createShadowRecorder({ now: () => 0 });
  rec2.loadData(data);
  assert.equal(rec2.configs.get('r2fast').position.funding.totalUsd, 0.123, 'funding 累计恢复');
  assert.equal(rec2.configs.get('r2fast').position.side, 'long', '持仓恢复');
  assert.equal(rec2.getState().bookObserved.samples, 1, 'bookSamples 恢复');
});

test('summarizeBasis：有符号均值 / |P95| / 溢价占比', () => {
  const s = summarizeBasis([{ signedBps: 5 }, { signedBps: -3 }, { signedBps: 1 }]);
  assert.equal(s.samples, 3);
  assert.equal(s.meanSignedBps, 1);
  assert.equal(s.meanAbsBps, 3);
  assert.equal(s.maxAbsBps, 5);
  assert.equal(s.hlPremiumRatio, 0.67);
  assert.equal(summarizeBasis([]).samples, 0);
});

// ── Review2 首夜优化（v1.7.2） ──
test('短命交易（<1h 未跨整点）：尾段用最近费率点回退 -> 完整度 100%', () => {
  let fake = 0;
  const rec = createShadowRecorder({ now: () => fake });
  rec.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: FEAT });
  rec.onBar({ candle5m: cdl(300_000), signal: SIG, barKey: 300_000, features: FEAT });
  // 持仓 30 分钟后信号退出（10:05 -> 10:35 类比，未跨整点）
  fake = 1_800_000;
  rec.onBar({ candle5m: cdl(1_500_000), signal: { score: 5, direction: null }, barKey: 1_500_000, features: FEAT, fundingPoints: [{ time: 0, rate: 0.0001 }] });
  const trade = rec.configs.get('r2fast').trades[0];
  assert.equal(trade.exitReason, 'signal_exit');
  assert.ok(trade.fundingMissingMs < 3_600_000, `尾段不应全额记缺失（实际 ${trade.fundingMissingMs}）`);
  const fc = fundingCompleteness([trade], null);
  assert.ok(fc.pct > 90, `完整度应显著提升（实际 ${fc.pct}%）`);
});

test('onBar 返回平仓事件（含完整 trade）供明细日志', () => {
  const rec = createShadowRecorder({ now: () => 0 });
  rec.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: FEAT });
  rec.onBar({ candle5m: cdl(300_000), signal: SIG, barKey: 300_000, features: FEAT });
  const events = rec.onBar({ candle5m: cdl(600_000), signal: { score: 5, direction: null }, barKey: 600_000, features: FEAT });
  const closed = events.find((e) => e.event === 'closed');
  assert.ok(closed, '应返回 closed 事件');
  assert.equal(closed.configId, 'r2fast');
  assert.ok(closed.trade.tradeId && closed.trade.exitReason && closed.trade.netPnl, 'trade 含编号/原因/净利');
});

test('统计分布：byExit / bySide 计数', () => {
  const rec = createShadowRecorder({ now: () => 0 });
  rec.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: FEAT });
  rec.onBar({ candle5m: cdl(300_000), signal: SIG, barKey: 300_000, features: FEAT });
  rec.onBar({ candle5m: cdl(600_000), signal: { score: 5, direction: null }, barKey: 600_000, features: FEAT });
  const st = rec.configs.get('r2fast').stats;
  assert.equal(st.byExit.signal_exit, 1);
  assert.equal(st.bySide.long, 1);
});

test('盘口观测分布：4 位精度 + P50/P95/Max', () => {
  const rec = createShadowRecorder({ now: () => 0 });
  const samples = [0.0012, 0.0031, 0.0008, 0.0095];
  rec.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: FEAT });
  let i = 0;
  // 每次入场一次采样（用不同 barKey 触发多次入场，但入场需冷却——直接驱动 samples 注入
  for (const bps of samples) {
    rec.configs.get('r2fast').bookObserved = { entryBps: bps };
  }
  // 通过 onBar 路径注入一次真实采样并校验摘要精度
  const rec2 = createShadowRecorder({ now: () => 0 });
  rec2.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: FEAT });
  rec2.onBar({ candle5m: cdl(300_000), signal: SIG, barKey: 300_000, features: FEAT, bookSample: { entryBps: 0.001234 } });
  const sum = rec2.getState().bookObserved;
  assert.equal(sum.samples, 1);
  assert.equal(sum.meanBps, 0.0012, '4 位精度（原 3 位会显示 0）');
  assert.ok(sum.p50Bps != null && sum.maxBps != null);
});

test('composeDailyReport：首日模式不刷决断门；时间戳含 UTC 标注；明细含退出分布', () => {
  const rec = createShadowRecorder({ now: () => 0 });
  const emptyData = rec.exportData();
  const firstDay = composeDailyReport({
    recorderData: emptyData,
    gate: { days: 0, checks: [{ name: 'x', ok: false, value: 0 }], baseline: { trades: 0 }, funding: { pct: 100 } },
    runner: { equity: 500, coverage: { coveragePct: 100, processedBars: 12, missedBars: 0, maxGapMs: 0 } },
  });
  assert.ok(firstDay.includes('未达最小统计周期'), '首日模式');
  assert.ok(firstDay.includes('UTC'), '统计日 UTC 标注');
  assert.ok(!firstDay.includes('决断门进度'), '首日不刷决断门');

  rec.onBar({ candle5m: cdl(0), signal: SIG, barKey: 0, features: FEAT });
  rec.onBar({ candle5m: cdl(300_000), signal: SIG, barKey: 300_000, features: FEAT });
  rec.onBar({ candle5m: cdl(600_000), signal: { score: 5, direction: null }, barKey: 600_000, features: FEAT });
  const full = composeDailyReport({
    recorderData: rec.exportData(),
    gate: { days: 8, checks: [{ name: 'x', ok: true, value: 1 }], baseline: { trades: 3 }, funding: { pct: 100 } },
    runner: { equity: 500, coverage: { coveragePct: 99.5, processedBars: 2300, missedBars: 1, maxGapMs: 300_000 } },
  });
  assert.ok(full.includes('信号退出 1'), '退出原因分布');
  assert.ok(full.includes('r2faster'), '日报含第四对照组');
  assert.ok(full.includes('资金完整度'), '资金完整度行');
});

// ── Review13：r2faster 第四变体（A/B） ──
const regimeFeatures = (adx = 30) => ({
  price: 100, atr5m: 10, atr1h: 10, structureLow: 95, structureHigh: 105,
  htfUp: true, mtfUp: true, entryUp: true, priceVsEma20_5m: 1,
  adx1h: adx, plusDI: 30, minusDI: 10, slope4h: 0.002, slope1h: 0.002, slope5m: 0.001,
  atrPct: 1.0,
});

test('r2faster：单次 5M 确认 + 阈值 40（r2fast 双确认对照）', () => {
  const rec = createShadowRecorder({ now: () => 0 });
  const feat = regimeFeatures(30);
  const sig = evaluateRegime(feat);
  rec.onBar({ candle5m: cdl(0), signal: sig, barKey: 0, features: feat });
  assert.ok(rec.configs.get('r2faster').position, 'r2faster 单次确认即入场');
  assert.equal(rec.configs.get('r2fast').position, null, 'r2fast 需两次确认（对照）');
  rec.onBar({ candle5m: cdl(300_000), signal: sig, barKey: 300_000, features: feat });
  assert.ok(rec.configs.get('r2fast').position, 'r2fast 第二次确认后入场');
  assert.equal(rec.configs.get('r2faster').def.version, 'shadow-v1.7.3');
});

test('r2faster 变体级 ADX 15：基准判 RANGE 的 ADX16 行情下可入场', () => {
  const rec = createShadowRecorder({ now: () => 0 });
  const feat = regimeFeatures(16);
  const base = evaluateRegime(feat);
  assert.equal(base.regime, 'range', '基准 adxMin=18 判 RANGE（ADX16）');
  rec.onBar({ candle5m: cdl(0), signal: base, barKey: 0, features: feat });
  assert.ok(rec.configs.get('r2faster').position, 'r2faster（regimeAdxMin 15）看到 trend_up 并入场');
  assert.equal(rec.configs.get('r2fast').position, null, 'r2fast 沿用基准信号 -> 空仓');
});

(async () => {
  for (const [name, fn] of T) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
