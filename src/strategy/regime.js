// 市场状态过滤（阶段1）：四态 + 可解释评分 + 双确认防抖。
// 原则（文档共识）：趋势不明确 → 空仓（不回退中性网格）；评分仅用于确认/退出阈值。
import { Regime } from './types.js';

export const REGIME_DEFAULTS = Object.freeze({
  entryThreshold: 50,   // 入场确认阈值（|score|）
  exitThreshold: 15,    // 趋势退出阈值（多头 score < +15 / 空头 score > -15）
  adxMin: 18,           // 1H ADX 下限
  volMaxAtrPct: 2.0,    // 1H ATR% 超过该值视为 VOLATILE（降仓/暂停）
  slopeThreshold: 0.0005, // 1H 归一化斜率（每根）达到该值算"有斜率"
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * 评估市场状态与评分。纯函数（无状态）。
 * @param {Object} f buildFeatures 输出
 * @param {Object} cfg REGIME_DEFAULTS 覆盖
 * @returns {Object} signal
 */
export function evaluateRegime(f, cfg = {}) {
  const c = { ...REGIME_DEFAULTS, ...cfg };
  if (!f || !Number.isFinite(f.price)) {
    return { regime: Regime.RANGE, score: 0, confidence: 0, direction: null, adx: null, atrPct: null, htfAvailable: false, mtfAvailable: false, htfMtfAligned: false, entryConfirmed: false, reason: ['数据不足'] };
  }
  const dirHtf = f.htfUp === true ? 1 : f.htfUp === false ? -1 : 0;
  const dirMtf = f.mtfUp === true ? 1 : f.mtfUp === false ? -1 : 0;
  const dirEntry = f.entryUp === true ? 1 : f.entryUp === false ? -1 : 0;
  const adxValue = Number.isFinite(f.adx1h) ? f.adx1h : 0;
  const slope1h = Number.isFinite(f.slope1h) ? f.slope1h : 0;
  const slope4h = Number.isFinite(f.slope4h) ? f.slope4h : 0;
  const priceLoc = Number.isFinite(f.priceVsEma20_5m) ? f.priceVsEma20_5m : 0;

  // ── 评分（±100，可解释）──
  const adxScore = clamp((adxValue - c.adxMin) / Math.max(1, c.adxMin), 0, 1);
  const score =
    dirHtf * 25 +
    dirMtf * 25 +
    dirMtf * 15 * adxScore +
    clamp(slope1h / c.slopeThreshold, -1, 1) * 15 +
    dirEntry * 10 +
    priceLoc * 10;

  // ── 四态 ──
  const volatile = Number.isFinite(f.atrPct) && f.atrPct > c.volMaxAtrPct;
  const slopeOkUp = slope4h > 0 || slope1h > 0;
  const slopeOkDown = slope4h < 0 || slope1h < 0;
  const upConditions = f.htfUp === true && f.mtfUp === true && f.entryUp === true && adxValue >= c.adxMin && slopeOkUp && priceLoc >= 0;
  const downConditions = f.htfUp === false && f.mtfUp === false && f.entryUp === false && adxValue >= c.adxMin && slopeOkDown && priceLoc <= 0;

  let regime = Regime.RANGE;
  if (volatile) regime = Regime.VOLATILE;
  else if (upConditions) regime = Regime.TREND_UP;
  else if (downConditions) regime = Regime.TREND_DOWN;

  const direction = regime === Regime.TREND_UP ? 'long' : regime === Regime.TREND_DOWN ? 'short' : null;
  const reason = [];
  reason.push(`4H ${f.htfUp === true ? 'EMA20>EMA50' : f.htfUp === false ? 'EMA20<EMA50' : '数据不足'}`);
  reason.push(`1H ${f.mtfUp === true ? 'EMA20>EMA50' : f.mtfUp === false ? 'EMA20<EMA50' : '数据不足'}`);
  reason.push(`ADX ${adxValue ? adxValue.toFixed(1) : '—'}${adxValue >= c.adxMin ? '≥' : '<'}${c.adxMin}`);
  if (volatile) reason.push(`波动超限 ATR% ${Number(f.atrPct).toFixed(2)} > ${c.volMaxAtrPct}`);
  if (regime === Regime.RANGE) reason.push('趋势条件未同时满足（空仓）');

  return {
    ts: Date.now(),
    regime,
    score: Number(score.toFixed(1)),
    confidence: Number(clamp(Math.abs(score) / 100, 0, 1).toFixed(2)),
    direction,
    adx: Number.isFinite(f.adx1h) ? Number(f.adx1h.toFixed(1)) : null,
    atrPct: Number.isFinite(f.atrPct) ? Number(f.atrPct.toFixed(3)) : null,
    // 字段语义（Review P2-1）：Available=数据存在；Aligned=4H/1H 同向
    htfAvailable: f.htfUp === true || f.htfUp === false,
    mtfAvailable: f.mtfUp === true || f.mtfUp === false,
    htfMtfAligned: f.htfUp != null && f.mtfUp != null && f.htfUp === f.mtfUp,
    entryConfirmed: f.entryUp === true || f.entryUp === false,
    reason,
  };
}

/**
 * 双确认防抖跟踪器（有状态，每个参数组一个实例）。
 * 入场：score 达阈值连续两次 5M 检查（两根已收盘 5M）或 1H 收盘确认一次；
 * 且必须与 regime 方向一致（趋势不明确 → 空仓）。
 * 退出：多头 score < exitThreshold / 空头 score > -exitThreshold。
 */
export function createRegimeTracker(config = {}) {
  const c = { ...REGIME_DEFAULTS, ...config };
  let upStreak = 0, downStreak = 0, lastBarKey = null;

  function onEvaluation(signal, ctx = {}) {
    const { barKey = null, isNewHourlyBar = false, force = false } = ctx;
    if (barKey != null && barKey === lastBarKey && !force) {
      return { entryDirection: null, skipped: true, upStreak, downStreak };
    }
    if (barKey != null) lastBarKey = barKey;

    if (signal.score >= c.entryThreshold) { upStreak++; downStreak = 0; }
    else if (signal.score <= -c.entryThreshold) { downStreak++; upStreak = 0; }
    else { upStreak = 0; downStreak = 0; }

    // 入场必须与 regime 方向一致（RANGE/VOLATILE 一律空仓）
    let entryDirection = null;
    if (signal.direction === 'long' && (upStreak >= 2 || (isNewHourlyBar && signal.score >= c.entryThreshold))) entryDirection = 'long';
    else if (signal.direction === 'short' && (downStreak >= 2 || (isNewHourlyBar && signal.score <= -c.entryThreshold))) entryDirection = 'short';

    return { entryDirection, skipped: false, upStreak, downStreak };
  }

  function shouldExit(side, score) {
    return side === 'long' ? score < c.exitThreshold : score > -c.exitThreshold;
  }

  return {
    onEvaluation,
    shouldExit,
    get state() { return { upStreak, downStreak, lastBarKey }; },
  };
}
