// 多周期特征构建（阶段1）：4H 大方向 / 1H 确认 / 5M 入场。
// 硬约束：只消费"已收盘"K线（dropUnclosed），杜绝未来函数。
import { adx, atr, ema, normalizedSlope } from '../indicators.js';

/** 丢弃未收盘 K 线（candle 的收盘时间 > now 的最后一根）。candles: [{time, open, high, low, close, volume}] */
export function dropUnclosed(candles, intervalSec, nowMs = Date.now()) {
  if (!Array.isArray(candles)) return [];
  return candles.filter((c) => Number(c.time) + Number(intervalSec) * 1000 <= nowMs);
}

/** 滚动结构高低点：最近 n 根的高/低。 */
export function structureRange(candles, bars = 24) {
  const slice = (candles || []).slice(-bars);
  if (!slice.length) return { low: null, high: null };
  let low = Infinity, high = -Infinity;
  for (const c of slice) {
    if (Number.isFinite(c.low) && c.low < low) low = c.low;
    if (Number.isFinite(c.high) && c.high > high) high = c.high;
  }
  return { low: Number.isFinite(low) ? low : null, high: Number.isFinite(high) ? high : null };
}

/**
 * 构建多周期特征。入参 candles 必须已按周期升序且**已丢弃未收盘**（调用方用 dropUnclosed）。
 * @returns {Object|null} 特征对象；数据不足返回 null
 */
export function buildFeatures({ candles5m, candles1h, candles4h }, opts = {}) {
  const fast = opts.fast ?? 20, slow = opts.slow ?? 50;
  const adxPeriod = opts.adxPeriod ?? 14;
  const slopeBars = opts.slopeBars ?? 20;
  const structureBars = opts.structureBars ?? 24;
  if (!Array.isArray(candles5m) || !Array.isArray(candles1h) || !Array.isArray(candles4h)) return null;

  const closes5m = candles5m.map((c) => c.close);
  const closes1h = candles1h.map((c) => c.close);
  const closes4h = candles4h.map((c) => c.close);
  if (closes5m.length < Math.max(fast, slow) + 1) return null;

  const ema20_5m = ema(closes5m, fast), ema50_5m = ema(closes5m, slow);
  const ema20_1h = ema(closes1h, fast), ema50_1h = ema(closes1h, slow);
  const ema20_4h = ema(closes4h, fast), ema50_4h = ema(closes4h, slow);
  const adx1h = adx(candles1h, adxPeriod);
  const atr5m = atr(candles5m, adxPeriod), atr1h = atr(candles1h, adxPeriod), atr4h = atr(candles4h, adxPeriod);
  const price = closes5m[closes5m.length - 1];
  const structure = structureRange(candles1h, structureBars);

  return {
    price,
    // 方向对齐（true/false/null=数据不足）
    htfUp: ema20_4h != null && ema50_4h != null ? ema20_4h > ema50_4h : null,   // 4H 大方向
    mtfUp: ema20_1h != null && ema50_1h != null ? ema20_1h > ema50_1h : null,   // 1H 确认
    entryUp: ema20_5m != null && ema50_5m != null ? ema20_5m > ema50_5m : null, // 5M 入场
    priceVsEma20_5m: ema20_5m != null ? Math.sign(price - ema20_5m) : 0,
    // 强度
    adx1h: adx1h ? adx1h.adx : null,
    plusDI: adx1h ? adx1h.plusDI : null,
    minusDI: adx1h ? adx1h.minusDI : null,
    slope4h: normalizedSlope(closes4h, slopeBars),
    slope1h: normalizedSlope(closes1h, slopeBars),
    slope5m: normalizedSlope(closes5m, slopeBars),
    // 波动
    atr5m, atr1h, atr4h,
    atrPct: atr1h != null && price > 0 ? (atr1h / price) * 100 : null, // 1H ATR 占价格百分比
    // 结构
    structureLow: structure.low,
    structureHigh: structure.high,
    bars: { m5: closes5m.length, h1: closes1h.length, h4: closes4h.length },
  };
}
