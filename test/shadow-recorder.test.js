// 阶段1 影子记录器测试：全生命周期（入场/加仓/分批止盈/移动止损/止损/信号退出/持仓熔断）、
// 三组参数隔离、同根去重、成本四档、盘口滑点、决断门统计。
import assert from 'node:assert/strict';
import { createShadowRecorder, SHADOW_DEFAULTS } from '../src/strategy/shadow-recorder.js';
import { allScenarioCosts, fundingCost, legCost, slippageFromBook } from '../src/strategy/shadow-cost-model.js';
import { computeStats, evaluateGate } from '../src/strategy/shadow-persistence.js';

let passed = 0, failed = 0;
const T = [];
const test = (name, fn) => T.push([name, fn]);

// 策略 ATR 基准 = 1H（Review：与回测一致）；测试中 atr1h=atr5m=10 便于断言
const FEATURES = { atr5m: 10, atr1h: 10, structureLow: 95, structureHigh: 105 };
const SIG_LONG = { score: 65, direction: 'long', ts: 0 };
const candle = (o, h, l, c, t = 0) => ({ time: t, open: o, high: h, low: l, close: c, volume: 1 });
const r2 = (rec) => rec.configs.get('r2fast');
const bal = (rec) => rec.configs.get('balanced');

/** 让 r2fast/balanced 完成双确认入场（strict 阈值 70 不触发）。 */
function enterLong(rec) {
  rec.onBar({ candle5m: candle(100, 100, 100, 100, 1), signal: SIG_LONG, barKey: 1, features: FEATURES });
  rec.onBar({ candle5m: candle(100, 100, 100, 100, 2), signal: SIG_LONG, barKey: 2, features: FEATURES });
}

// ── 生命周期：分批止盈到全平 ──
test('多头全生命周期：入场 → TP1 → TP2 全平（tp_full）+ 三组隔离', () => {
  const rec = createShadowRecorder({ now: () => 1_000_000_000 });
  enterLong(rec);
  assert.ok(r2(rec).position, 'r2fast 应已入场');
  assert.ok(bal(rec).position, 'balanced 应已入场（阈值 60）');
  assert.equal(rec.configs.get('strict').position, null, 'strict 阈值 70 不触发');

  const pos = r2(rec).position;
  assert.equal(pos.entryPrice, 100);
  assert.equal(pos.initialStop, 90, '止损 = 入场 - 1.0×ATR（与结构位取更宽：min(90, 95-2)=90）');
  assert.equal(pos.R, 10);
  assert.equal(pos.atrSource, '1h', 'ATR 基准必须是 1H（与回测一致）');

  // K线A：high 109 触及 TP1(108)，移动止损升至 109-12=97
  rec.onBar({ candle5m: candle(100, 109, 101, 108, 3), signal: { score: 65, direction: 'long' }, barKey: 3, features: FEATURES });
  assert.ok(r2(rec).position.tpLevels[0].filled, 'TP1 应成交');
  assert.equal(r2(rec).position.stopPrice, 97, '移动止损只向上移动');

  // K线B：high 116 触及 TP2(115)，剩余仓位全平
  rec.onBar({ candle5m: candle(108, 116, 105, 115, 4), signal: { score: 65, direction: 'long' }, barKey: 4, features: FEATURES });
  assert.equal(r2(rec).position, null, 'r2fast 应已全平');
  assert.equal(bal(rec).position != null, true, 'balanced 止损更宽未平（隔离）');

  const trade = r2(rec).trades[0];
  assert.equal(trade.exitReason, 'tp_full');
  assert.deepEqual(trade.tpFills, [0.8, 1.5]);
  assert.equal(trade.exitPrice, 115);
  assert.ok(trade.grossPnl > 0, '毛利应为正');
  assert.ok(trade.netPnl.baseline < trade.grossPnl, '净利应扣除成本');
  assert.equal(Object.keys(trade.costs).length, 4, '四档成本齐备');
  assert.ok(trade.costs.allTaker.totalUsd >= trade.costs.optimistic.totalUsd, '全Taker 成本 ≥ 乐观');
  assert.equal(r2(rec).stats.closed, 1);
});

// ── 止损路径 ──
test('止损：触发初始止损 -> reason=stop，净亏大于毛亏', () => {
  const rec = createShadowRecorder({ now: () => 1_000_000_000 });
  enterLong(rec);
  const pos = r2(rec).position;
  const size = pos.filledSize;
  rec.onBar({ candle5m: candle(95, 96, 89, 90, 3), signal: { score: 65, direction: 'long' }, barKey: 3, features: FEATURES });
  const trade = r2(rec).trades[0];
  assert.equal(trade.exitReason, 'stop');
  assert.equal(trade.grossPnl, Number(((90 - 100) * size).toFixed(4)));
  assert.ok(trade.netPnl.baseline < trade.grossPnl);
  assert.ok(trade.mae >= 10, 'MAE 应记录最大不利偏移');
});

// ── 加仓路径 ──
test('分层加仓：低点触及 Add1 -> 成交并更新均价，超时熔断收尾', () => {
  let fakeNow = 1_000_000_000;
  const rec = createShadowRecorder({ now: () => fakeNow, shadowCfg: { ...SHADOW_DEFAULTS, maxHoldingHours: 0.001 } });
  enterLong(rec);
  const pos = r2(rec).position;
  const layer0 = pos.filledSize;
  rec.onBar({ candle5m: candle(95, 96, 94, 95, 3), signal: { score: 65, direction: 'long' }, barKey: 3, features: FEATURES });
  assert.ok(r2(rec).position.filledSize > layer0, 'Add1 应成交');
  assert.ok(r2(rec).position.avgEntry < 100, '均价应下移');
  // 时间推进超过 maxHoldingHours -> 熔断平仓
  fakeNow += 5_000;
  rec.onBar({ candle5m: candle(95, 96, 94, 95, 4), signal: { score: 65, direction: 'long' }, barKey: 4, features: FEATURES });
  const trade = r2(rec).trades[0];
  assert.equal(trade.exitReason, 'max_holding');
  assert.equal(trade.adds, 1, '记录一次加仓');
});

// ── 信号退出 ──
test('信号退出：score 跌破退出阈值 -> reason=signal_exit', () => {
  const rec = createShadowRecorder({ now: () => 1_000_000_000 });
  enterLong(rec);
  rec.onBar({ candle5m: candle(100, 101, 99, 100, 3), signal: { score: 10, direction: null }, barKey: 3, features: FEATURES });
  const trade = r2(rec).trades[0];
  assert.equal(trade.exitReason, 'signal_exit');
  assert.equal(trade.exitPrice, 100);
});

// ── 同根去重 ──
test('同 barKey 重复驱动被忽略（入场/管理都不重复）', () => {
  const rec = createShadowRecorder({ now: () => 1_000_000_000 });
  rec.onBar({ candle5m: candle(100, 100, 100, 100, 1), signal: SIG_LONG, barKey: 1, features: FEATURES });
  rec.onBar({ candle5m: candle(100, 100, 100, 100, 1), signal: SIG_LONG, barKey: 1, features: FEATURES });
  const evals1 = rec.getState().evaluations;
  rec.onBar({ candle5m: candle(100, 100, 100, 100, 1), signal: SIG_LONG, barKey: 1, features: FEATURES });
  assert.equal(rec.getState().evaluations, evals1, '同根不重复计入评估');
  rec.onBar({ candle5m: candle(100, 100, 100, 100, 2), signal: SIG_LONG, barKey: 2, features: FEATURES });
  assert.ok(r2(rec).position, '换根后正常双确认入场');
});

// ── 成本模型 ──
test('盘口滑点：吃单 VWAP 相对最优价的 bps', () => {
  const book = { levels: [
    [{ px: '100.0', sz: '1' }, { px: '99.9', sz: '2' }],
    [{ px: '100.1', sz: '1' }, { px: '100.2', sz: '2' }],
  ] };
  const buy = slippageFromBook(book, 'buy', 1.5);
  assert.equal(buy.filled, 1.5);
  assert.ok(Math.abs(buy.bps - 3.333) < 0.05, `买入滑点 ~3.33bps（实际 ${buy.bps}）`);
  const sell = slippageFromBook(book, 'sell', 1);
  assert.ok(Math.abs(sell.bps) < 1e-9, '卖 1 在最优价成交零滑点');
  assert.equal(slippageFromBook(book, 'buy', 0), null);
  assert.equal(slippageFromBook(null, 'buy', 1), null);
});

test('成本情景：市价腿含滑点、限价腿按 makerFillRate 期望，四档单调', () => {
  const legs = [{ notional: 1000, isMarket: false }, { notional: 1000, isMarket: true }];
  const costs = allScenarioCosts(legs);
  const order = ['optimistic', 'baseline', 'conservative', 'allTaker'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(costs[order[i]].totalUsd >= costs[order[i - 1]].totalUsd, `${order[i]} ≥ 前档`);
  }
  const opt = legCost({ notional: 1000, isMarket: false }, { makerFillRate: 1, takerSlippageBps: 0 });
  assert.ok(Math.abs(opt.feeUsd - 1000 * 0.00015) < 1e-9, '全 maker 限价腿费率为 maker 档');
});

test('资金费率：多头正费率付成本，空头反收', () => {
  const long = fundingCost({ notional: 10_000, hourlyRate: 0.00001, holdingMs: 3_600_000, side: 'long' });
  assert.ok(Math.abs(long - 0.1) < 1e-9, '1h×1e-5×10000 = 0.1U 成本');
  const short = fundingCost({ notional: 10_000, hourlyRate: 0.00001, holdingMs: 3_600_000, side: 'short' });
  assert.ok(short < 0, '空头正费率下为收入（负成本）');
});

// ── 决断门统计 ──
test('computeStats：PF/回撤/单日亏损', () => {
  const mk = (p, closedAt) => ({ closedAt, grossPnl: p, netPnl: { baseline: p, conservative: p * 0.9, allTaker: p * 0.8, optimistic: p * 1.05 } });
  const trades = [mk(10, 1), mk(-5, 2), mk(20, 3), mk(-10, 4)];
  const s = computeStats(trades, 10_000);
  assert.equal(s.trades, 4);
  assert.equal(s.wins, 2);
  assert.ok(Math.abs(s.pf - 2) < 1e-9, 'PF = 30/15 = 2');
  assert.ok(Math.abs(s.net - 15) < 1e-9);
  assert.ok(s.maxDrawdownPct >= 0);
});

test('evaluateGate：样本不足时不通过且给出逐项原因', () => {
  const rec = createShadowRecorder({ now: () => 1_000_000_000 });
  const gate = evaluateGate(rec.exportData(), { equity: 10_000, startedAt: Date.now() - 86_400_000 });
  assert.equal(gate.pass, false);
  assert.ok(gate.checks.some((c) => !c.ok), '应有未达标项');
  assert.ok(gate.checks.find((c) => c.name.includes('完整交易')).ok === false);
});

(async () => {
  for (const [name, fn] of T) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
