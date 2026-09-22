// 影子运行器（阶段1）：拉取 HL 公共行情 → 特征 → regime → 影子记录 → 落盘/日报/状态。
// 零交易权限：只访问公共行情端点（candleSnapshot/l2Book/metaAndAssetCtxs），无任何下单路径。
import { buildFeatures, dropUnclosed } from './features.js';
import { evaluateRegime } from './regime.js';
import { createShadowRecorder, SHADOW_DEFAULTS } from './shadow-recorder.js';
import { slippageFromBook } from './shadow-cost-model.js';
import { composeDailyReport, evaluateGate, loadShadowData, saveShadowData } from './shadow-persistence.js';

export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const RUNNER_DEFAULTS = Object.freeze({
  symbol: 'BTC',
  checkMs: 30_000,        // 检查节拍（真正动作只在新的已收盘 5M 出现时）
  reportHour: 8,          // 日报小时（本地时区）
  bars: { m5: 300, h1: 220, h4: 220 },
  bookSampleNotional: 1000, // 盘口滑点采样的参考名义
  binance: false,         // 旁路对照（fapi klines）
});

export function createShadowRunner(opts = {}) {
  const cfg = { ...RUNNER_DEFAULTS, ...(opts.config || {}) };
  const logger = opts.logger || console;
  const notifier = opts.notifier || null;
  const file = opts.file;
  const now = opts.now || (() => Date.now());
  const fetchImpl = opts.fetchImpl || fetch;
  const equity = Number(opts.equity || SHADOW_DEFAULTS.equity);

  const recorder = createShadowRecorder({ shadowCfg: { ...SHADOW_DEFAULTS, equity } });
  let timer = null;
  let runner = { startedAt: null, lastBarKey: null, lastHourKey: null, lastReportDay: null, binance: { samples: 0, lastDevBps: null, error: null, checkedAt: null } };
  let lastError = null;
  let lastEvaluatedAt = null;

  // ── 数据获取（公共端点，零鉴权） ──
  async function postInfo(payload) {
    const res = await fetchImpl(HL_INFO_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HL info HTTP ${res.status}`);
    return res.json();
  }

  async function fetchCandles(interval, bars) {
    const intervalSec = { '5m': 300, '1h': 3600, '4h': 14400 }[interval];
    const end = now();
    const start = end - (bars + 5) * intervalSec * 1000;
    const rows = await postInfo({ type: 'candleSnapshot', req: { coin: cfg.symbol, interval, startTime: start, endTime: end } });
    const candles = (Array.isArray(rows) ? rows : []).map((r) => ({ time: Number(r.t), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v || 0) }));
    return { candles, intervalSec };
  }

  async function fetchFunding() {
    const data = await postInfo({ type: 'metaAndAssetCtxs' });
    const meta = data?.[0], ctxs = data?.[1];
    const i = meta?.universe?.findIndex((u) => u.name === cfg.symbol) ?? -1;
    const funding = i >= 0 ? Number(ctxs?.[i]?.funding) : NaN;
    return Number.isFinite(funding) ? funding : 0;
  }

  async function fetchBookSample(direction, price) {
    try {
      const book = await postInfo({ type: 'l2Book', coin: cfg.symbol });
      const sizeBase = cfg.bookSampleNotional / Math.max(1, price);
      const s = slippageFromBook(book, direction === 'short' ? 'sell' : 'buy', sizeBase);
      return s ? { entryBps: s.bps } : null;
    } catch { return null; }
  }

  async function fetchBinanceCheck(hlClose) {
    if (!cfg.binance) return;
    try {
      const res = await fetchImpl(`https://fapi.binance.com/fapi/v1/klines?symbol=${cfg.symbol}USDT&interval=5m&limit=3`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      const closed = rows.filter((r) => Number(r[0]) + 300_000 <= now());
      const bnClose = Number(closed.at(-1)?.[4]);
      if (bnClose > 0 && hlClose > 0) {
        runner.binance = { samples: (runner.binance.samples || 0) + 1, lastDevBps: Number((Math.abs(hlClose / bnClose - 1) * 10_000).toFixed(2)), error: null, checkedAt: now() };
      }
    } catch (e) {
      runner.binance = { ...runner.binance, error: String(e?.message || e), checkedAt: now() };
    }
  }

  // ── 单轮：仅当出现新的已收盘 5M 时执行 ──
  async function tick() {
    try {
      const m5 = await fetchCandles('5m', cfg.bars.m5);
      const closed5m = dropUnclosed(m5.candles, m5.intervalSec, now());
      if (!closed5m.length) return;
      const bar = closed5m[closed5m.length - 1];
      if (bar.time === runner.lastBarKey) return; // 已处理过

      const [h1, h4] = await Promise.all([fetchCandles('1h', cfg.bars.h1), fetchCandles('4h', cfg.bars.h4)]);
      const closed1h = dropUnclosed(h1.candles, h1.intervalSec, now());
      const closed4h = dropUnclosed(h4.candles, h4.intervalSec, now());
      const features = buildFeatures({ candles5m: closed5m, candles1h: closed1h, candles4h: closed4h });
      const signal = evaluateRegime(features);
      const fundingHourly = await fetchFunding().catch(() => 0);
      // 首轮 lastHourKey 为空时先建立基线，不得当作"1H 刚收盘"（否则绕过双确认立即入场）
      const hourKey = closed1h.at(-1)?.time ?? null;
      const isNewHourlyBar = hourKey != null && runner.lastHourKey != null && hourKey !== runner.lastHourKey;
      const bookSample = signal.direction ? await fetchBookSample(signal.direction, bar.close) : null;

      const events = recorder.onBar({ candle5m: bar, signal, barKey: bar.time, isNewHourlyBar, features, fundingHourly, bookSample });
      runner.lastBarKey = bar.time;
      if (hourKey != null) runner.lastHourKey = hourKey;
      lastEvaluatedAt = now();
      lastError = null;
      if (events.length) logger.info?.('strategy', `[影子] ${cfg.symbol} ${signal.regime} score=${signal.score} 事件: ${events.map((e) => `${e.configId}:${e.event}`).join(', ')}`);
      else logger.info?.('strategy', `[影子] ${cfg.symbol} ${signal.regime} score=${signal.score} 无动作`);

      if (signal.direction) await fetchBinanceCheck(bar.close);
      persist();
      maybeDailyReport();
    } catch (e) {
      lastError = String(e?.message || e);
      logger.warn?.('strategy', `[影子] 评估失败：${lastError}`);
    }
  }

  function persist() {
    saveShadowData({ version: 2, startedAt: runner.startedAt, runner, recorder: recorder.exportData() }, file);
  }

  function maybeDailyReport() {
    const day = new Date(now()).toISOString().slice(0, 10);
    const hour = new Date(now()).getHours();
    if (hour < cfg.reportHour || runner.lastReportDay === day) return;
    runner.lastReportDay = day;
    const data = recorder.exportData();
    const gate = evaluateGate(data, { equity, startedAt: runner.startedAt });
    const text = composeDailyReport({ recorderData: data, gate, runner: { equity, binance: runner.binance } });
    logger.info?.('strategy', `[影子] 日报:\n${text}`);
    try { notifier?.send?.({ source: 'strategy', level: 'warn', key: 'strategy-shadow:daily', cooldownMs: 20 * 3600_000, message: text }); } catch { /* 推送失败不影响 */ }
  }

  function start() {
    if (timer) return;
    const saved = loadShadowData(file);
    if (saved?.recorder) {
      recorder.loadData(saved.recorder);
      runner = { ...runner, ...(saved.runner || {}) };
      logger.info?.('strategy', `[影子] 已恢复历史数据（交易 ${recorder.getState().perConfig?.r2fast?.stats?.closed || 0} 笔）`);
    }
    if (!runner.startedAt) runner.startedAt = now();
    timer = setInterval(() => { tick().catch(() => {}); }, cfg.checkMs);
    timer.unref?.();
    tick().catch(() => {});
    logger.info?.('strategy', `[影子] 运行器已启动（${cfg.symbol}，检查节拍 ${cfg.checkMs / 1000}s，日报 ${cfg.reportHour} 点）`);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function getState() {
    const data = recorder.exportData();
    const gate = evaluateGate(data, { equity, startedAt: runner.startedAt });
    return {
      enabled: !!timer, symbol: cfg.symbol, startedAt: runner.startedAt,
      lastBarKey: runner.lastBarKey, lastEvaluatedAt, lastError,
      binance: runner.binance,
      gate,
      recorder: recorder.getState(),
    };
  }

  return { start, stop, tick, getState, _recorder: recorder };
}
