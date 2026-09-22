// Technical indicators used for trend detection. Pure functions, no deps.

/** Simple moving average of the last `period` values. */
export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Exponential moving average over the whole series; returns the final value. */
export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/**
 * Average True Range over OHLC candles. Returns ATR in price units.
 * candles: [{high, low, close}]
 */
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return sma(trs, period);
}

/**
 * Linear-regression slope of the last `period` closes, normalised to the mean
 * price and expressed as fractional change per candle (e.g. 0.002 = +0.2%/bar).
 */
export function normalizedSlope(values, period) {
  if (values.length < period) return 0;
  const y = values.slice(-period);
  const n = y.length;
  const xMean = (n - 1) / 2;
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (y[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den; // price units per bar
  return yMean === 0 ? 0 : slope / yMean;   // fraction per bar
}

/**
 * Wilder ADX with +DI/-DI (directional movement system). Pure function.
 * candles: [{high, low, close}] chronological. Requires >= 2*period candles.
 * Returns { adx, plusDI, minusDI } or null when insufficient data.
 * 实现为 Wilder 平滑（RMA）：首值取前 period 项之和，其后 smoothed - smoothed/period + current。
 */
export function adx(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period * 2) return null;
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high, down = p.low - c.low;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (trs.length < period * 2 - 1) return null;

  // Wilder 平滑首值 = 前 period 项之和；之后 smoothed = smoothed - smoothed/period + current
  let smTr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smPlus = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dxs = [];
  const pushDx = () => {
    const plusDI = smTr === 0 ? 0 : (100 * smPlus) / smTr;
    const minusDI = smTr === 0 ? 0 : (100 * smMinus) / smTr;
    const sum = plusDI + minusDI;
    dxs.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  };
  pushDx();
  for (let i = period; i < trs.length; i++) {
    smTr = smTr - smTr / period + trs[i];
    smPlus = smPlus - smPlus / period + plusDMs[i];
    smMinus = smMinus - smMinus / period + minusDMs[i];
    pushDx();
  }
  if (dxs.length < period) return null;
  let adxValue = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) adxValue = (adxValue * (period - 1) + dxs[i]) / period;
  const lastTr = smTr;
  return {
    adx: adxValue,
    plusDI: lastTr === 0 ? 0 : (100 * smPlus) / lastTr,
    minusDI: lastTr === 0 ? 0 : (100 * smMinus) / lastTr,
  };
}
