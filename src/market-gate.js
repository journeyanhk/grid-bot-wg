// 市场三绿指标（重开窗口看门）：把"是否适合重开网格"变成三盏灯。
//
// 门1 振幅：近 24h 高低振幅 ≤ ampMaxPct（默认 2.5%）
// 门2 斜率：EMA20 现值 vs 6h 前，折算 %/小时，|斜率| ≤ slopeMaxPctPerH（默认 0.05）
// 门3 极值：96h 极值不落在最近 extremeRecent 小时内（默认 24h）——即"不再创新高/新低"
// 三绿 + 连续 debounceChecks 次（默认 2 次检查/10 分钟）确认 -> 转绿事件（Telegram 推送，冷却 6h）
//
// 数据源：Binance 公共 K 线（免密钥）为主；连续 2 次失败后自动切换适配器 getCandles 兜底，
// 并在 state 标注当前源。纯逻辑与轮询器分离，computeGates 可单测、无 I/O。
import { logger as defaultLogger } from './log.js';

export const MARKET_GATE_DEFAULTS = Object.freeze({
  symbol: 'BTC',
  ampMaxPct: 2.5,          // 门1：24h 振幅上限（%）
  slopeMaxPctPerH: 0.05,   // 门2：EMA20 斜率上限（%/小时，绝对值）
  extremeLookback: 96,     // 门3：极值回看窗口（小时）
  extremeRecent: 24,       // 门3：极值出现在最近 N 小时内 = 红
  pollMs: 5 * 60_000,      // 检查节拍（1h 级指标无需更快）
  debounceChecks: 2,       // 连续 N 次同向才算"转绿/转红事件"（防边界抖动）
  notifyCooldownMs: 6 * 3600_000, // 通知冷却（同一 key）
  binanceBase: 'https://api.binance.com',
  binanceLimit: 96,
  primaryFailLimit: 2,     // 主源连续失败 N 次后切换兜底源
});

/**
 * 计算三绿指标（纯函数，无 I/O）。
 * candles: 1h K 线升序 [{time, open, high, low, close, volume}]（建议仅传已收盘；含未收盘亦可，
 * 但调用方应在轮询器中丢弃未收盘根以消除 EMA 噪音——computeGates 本身不做时间判断）。
 * 阈值经过回测口径校准，斜率公式按设计稿实现（EMA 以首值播种）。
 */
export function computeGates(candles, opts = {}) {
  const { ampMaxPct, slopeMaxPctPerH, extremeLookback, extremeRecent } = { ...MARKET_GATE_DEFAULTS, ...opts };
  const list = Array.isArray(candles) ? candles.filter((c) => Number.isFinite(c?.close)) : [];
  if (list.length < 25) {
    return {
      ok: false, reason: '数据不足（<25 根 1h）', price: null, ts: Date.now(),
      allGreen: false, greens: { amplitude: false, slope: false, noNewExtreme: false },
      amplitudePct: null, slopePctPerH: null, extremeAgeH: null, newExtreme24h: true,
    };
  }
  const lookback = Math.min(extremeLookback, list.length);
  const window = list.slice(-lookback);
  const h24 = window.slice(-24);
  const hi24 = Math.max(...h24.map((c) => Number(c.high)));
  const lo24 = Math.min(...h24.map((c) => Number(c.low)));
  const amplitudePct = lo24 > 0 ? ((hi24 - lo24) / lo24) * 100 : Infinity;

  // EMA（首值播种；与设计稿公式一致，阈值按此口径校准）
  const ema = (xs, n) => xs.slice(1).reduce((a, x) => a + (x - a) * (2 / (n + 1)), xs[0]);
  const closes = list.map((c) => Number(c.close));
  const slopePctPerH = closes.length >= 27
    ? ((ema(closes, 20) / ema(closes.slice(0, -6), 20) - 1) * 100) / 6
    : 0;

  const iHi = window.reduce((m, c, i) => (Number(c.high) > Number(window[m].high) ? i : m), 0);
  const iLo = window.reduce((m, c, i) => (Number(c.low) < Number(window[m].low) ? i : m), 0);
  const ageHi = window.length - 1 - iHi, ageLo = window.length - 1 - iLo;
  const extremeAgeH = Math.min(ageHi, ageLo);
  const newExtreme24h = extremeAgeH < extremeRecent;

  const greens = {
    amplitude: amplitudePct <= ampMaxPct,
    slope: Math.abs(slopePctPerH) <= slopeMaxPctPerH,
    noNewExtreme: !newExtreme24h,
  };
  return {
    ok: true,
    price: closes.at(-1),
    ts: Date.now(),
    amplitudePct: Number(amplitudePct.toFixed(3)),
    slopePctPerH: Number(slopePctPerH.toFixed(4)),
    extremeAgeH,
    newExtreme24h,
    greens,
    allGreen: greens.amplitude && greens.slope && greens.noNewExtreme,
    thresholds: { ampMaxPct, slopeMaxPctPerH, extremeRecent, extremeLookback },
  };
}

/** 红灯项的"还差多少"文案（前端小卡与推送共用）。 */
export function describeGaps(gate) {
  if (!gate?.ok) return ['数据不足'];
  const gaps = [];
  const t = gate.thresholds;
  if (!gate.greens.amplitude) gaps.push(`振幅 ${gate.amplitudePct}% → 需 ≤${t.ampMaxPct}%`);
  if (!gate.greens.slope) gaps.push(`斜率 ${gate.slopePctPerH}%/h → 需 |·|≤${t.slopeMaxPctPerH}`);
  if (!gate.greens.noNewExtreme) gaps.push(`距上次极值 ${gate.extremeAgeH}h → 需 ≥${t.extremeRecent}h`);
  return gaps;
}

/**
 * 轮询器（有状态）：每 pollMs 检查一次；转绿/转红事件推送（连续 debounceChecks 次确认）。
 * @param {Object} o
 * @param {Function} [o.fetchImpl]       fetch 实现（测试注入）
 * @param {Function} [o.fetchFallback]   async () => { candles, source } | null（适配器兜底，server 注入）
 * @param {Object}   [o.notifier]        通知总线
 * @param {Object}   [o.logger]
 * @param {Object}   [o.config]          MARKET_GATE_DEFAULTS 覆盖
 * @param {Function} [o.now]
 */
export function createMarketGate({ fetchImpl = fetch, fetchFallback = null, notifier = null, logger = defaultLogger, config = {}, now = () => Date.now() } = {}) {
  const cfg = { ...MARKET_GATE_DEFAULTS, ...config };
  let timer = null;
  let consecutiveGreen = 0, consecutiveRed = 0;
  let mode = null; // 'green' | 'red' | null（最近一次确认态）
  let primaryFails = 0;
  let state = {
    symbol: cfg.symbol,
    ok: false, allGreen: false, greens: { amplitude: false, slope: false, noNewExtreme: false },
    values: null, thresholds: { ampMaxPct: cfg.ampMaxPct, slopeMaxPctPerH: cfg.slopeMaxPctPerH, extremeRecent: cfg.extremeRecent, extremeLookback: cfg.extremeLookback },
    source: null, ts: null, error: null,
    lastGreenAt: null, lastRedAt: null,
    checks: 0, primaryFails: 0,
    consecutiveGreen: 0, consecutiveRed: 0,
  };

  /** 主源：Binance 公共 K 线（免密钥）。 */
  async function fetchBinance() {
    const url = `${cfg.binanceBase}/api/v3/klines?symbol=${cfg.symbol}USDT&interval=1h&limit=${cfg.binanceLimit}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const rows = await res.json();
    const candles = (Array.isArray(rows) ? rows : []).map((r) => ({
      time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
    }));
    if (candles.length < 25) throw new Error('Binance 返回 K 线不足');
    return { candles, source: 'binance' };
  }

  /** 取一次数据：主源失败累计到阈值后切兜底源（切换后保持，state.source 标注）。 */
  async function fetchWithFallback() {
    if (state.source === 'fallback' && fetchFallback) {
      const fb = await fetchFallback();
      if (fb?.candles?.length) return { candles: fb.candles, source: `fallback:${fb.source || 'adapter'}` };
      throw new Error('兜底源不可用');
    }
    try {
      const out = await fetchBinance();
      primaryFails = 0;
      return out;
    } catch (e) {
      primaryFails++;
      state.primaryFails = primaryFails;
      if (primaryFails >= cfg.primaryFailLimit && fetchFallback) {
        state.source = 'fallback';
        const fb = await fetchFallback();
        if (fb?.candles?.length) return { candles: fb.candles, source: `fallback:${fb.source || 'adapter'}` };
      }
      throw e;
    }
  }

  /** 单次检查（测试可直接调用）。 */
  async function tick() {
    try {
      const { candles, source } = await fetchWithFallback();
      // 丢弃未收盘根（消除 EMA 噪音；振幅/极值不受影响）
      const closed = candles.filter((c) => Number(c.time) + 3_600_000 <= now());
      const g = computeGates(closed.length >= 25 ? closed : candles, cfg);
      state = { ...state, ...g, source, error: null, ts: now() };
      if (g.ok) {
        if (g.allGreen) { consecutiveGreen++; consecutiveRed = 0; } else { consecutiveRed++; consecutiveGreen = 0; }
        state.consecutiveGreen = consecutiveGreen;
        state.consecutiveRed = consecutiveRed;
        if (consecutiveGreen >= cfg.debounceChecks && mode !== 'green') {
          mode = 'green';
          state.lastGreenAt = now();
          const gaps = describeGaps(g);
          notify(`🟢 ${cfg.symbol} 三绿达成：价 ${g.price} ｜ 振幅 ${g.amplitudePct}% ｜ 斜率 ${g.slopePctPerH}%/h ｜ 距上次极值 ${g.extremeAgeH}h——重开窗口开启`);
          logger.info?.('market-gate', `[三绿] ${cfg.symbol} 转绿（振幅 ${g.amplitudePct}% / 斜率 ${g.slopePctPerH}% / 极值 ${g.extremeAgeH}h）`);
        } else if (consecutiveRed >= cfg.debounceChecks && mode !== 'red') {
          mode = 'red';
          state.lastRedAt = now();
          const gaps = describeGaps(g);
          notify(`🔴 ${cfg.symbol} 三绿破坏：${gaps.join(' ｜ ')}`);
          logger.info?.('market-gate', `[三绿] ${cfg.symbol} 转红（${gaps.join('；')}）`);
        }
      } else {
        logger.warn?.('market-gate', `[三绿] ${cfg.symbol} 数据不足，本轮跳过`);
      }
      state.checks++;
    } catch (e) {
      state.error = String(e?.message || e);
      state.ok = false;
      logger.warn?.('market-gate', `[三绿] ${cfg.symbol} 检查失败：${state.error}`);
    }
  }

  function notify(message) {
    try {
      notifier?.send?.({ source: 'market-gate', level: 'warn', key: 'market-gate', cooldownMs: cfg.notifyCooldownMs, message });
    } catch { /* 推送失败不影响 */ }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, cfg.pollMs);
    timer.unref?.();
    tick().catch(() => {});
    logger.info?.('market-gate', `[三绿] 看门已启动（${cfg.symbol}，节拍 ${Math.round(cfg.pollMs / 60_000)} 分钟，防抖 ${cfg.debounceChecks} 次）`);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  /** 精简快照（总览载荷/前端小卡用）。 */
  function snapshot() {
    return {
      symbol: state.symbol, ok: state.ok, allGreen: state.allGreen,
      greens: state.greens, values: state.values || {
        amplitudePct: state.amplitudePct ?? null, slopePctPerH: state.slopePctPerH ?? null,
        extremeAgeH: state.extremeAgeH ?? null, price: state.price ?? null,
      },
      thresholds: state.thresholds, source: state.source, ts: state.ts, error: state.error,
      lastGreenAt: state.lastGreenAt, lastRedAt: state.lastRedAt,
      gaps: describeGaps(state),
    };
  }

  return { start, stop, tick, snapshot, getState: () => ({ ...state }), get mode() { return mode; } };
}
