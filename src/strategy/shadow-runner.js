// 影子运行器（阶段1）：拉取 HL 公共行情 → 特征 → regime → 影子记录 → 落盘/日报/状态。
// 零交易权限：只访问公共行情端点（candleSnapshot/l2Book/metaAndAssetCtxs/fundingHistory），无任何下单路径。
//
// Review 修复要点：
//   P0-2 断档补处理：lastBarKey 之后的所有已收盘 5M 按时间升序逐根回放（computePendingBars），
//        超出回放窗口的缺口计入覆盖率（不伪造交易）；每根 K 线按 as-of 切片特征（无未来函数）。
//   P0-4 有效覆盖率：以 processedBars/expectedBars 计算 coveragePct 与有效天数，取代墙上时间。
//   P0-1 资金费率：改用 fundingHistory 逐时段点位（缺失时分段记 missing，绝不当 0）。
//   P2-2 基差：有符号 + 分布统计；P2-3 请求计数与单次重试。
import { buildFeatures, dropUnclosed } from './features.js';
import { evaluateRegime } from './regime.js';
import { createShadowRecorder, SHADOW_DEFAULTS } from './shadow-recorder.js';
import { slippageFromBook } from './shadow-cost-model.js';
import { composeDailyReport, evaluateGate, loadShadowData, saveShadowData, summarizeBasis } from './shadow-persistence.js';

export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const RUNNER_DEFAULTS = Object.freeze({
  symbol: 'BTC',
  checkMs: 30_000,        // 检查节拍（真正动作只在新的已收盘 5M 出现时）
  reportHour: 8,          // 日报小时（本地时区）
  bars: { m5: 300, h1: 220, h4: 220 },
  maxReplayBars: 288,     // 单次回放上限（24h）；更长缺口计入缺失
  bookSampleNotional: 1000, // 盘口滑点采样的参考名义
  binance: false,         // 旁路对照（fapi klines）
});

/**
 * 计算待补处理的 K 线（纯函数，便于测试）。
 * @returns { pending, missedBars, gapMs } gapMs = 上次已处理 → 本次首个待处理之间的时间跨度
 */
export function computePendingBars(closedBars, lastBarKey, maxReplay = RUNNER_DEFAULTS.maxReplayBars) {
  const list = (closedBars || [])
    .filter((b) => lastBarKey == null || b.time > lastBarKey)
    .sort((a, b) => a.time - b.time);
  let missedBars = 0, gapMs = 0;
  if (lastBarKey != null && list.length) {
    const gap = list[0].time - lastBarKey;
    if (gap > 300_000) { missedBars = Math.round(gap / 300_000) - 1; gapMs = gap; }
  }
  let pending = list;
  if (list.length > maxReplay) {
    const dropped = list.length - maxReplay;
    pending = list.slice(-maxReplay);
    missedBars += dropped;
    gapMs = Math.max(gapMs, pending[0].time - list[0].time);
  }
  return { pending, missedBars, gapMs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createShadowRunner(opts = {}) {
  const cfg = { ...RUNNER_DEFAULTS, ...(opts.config || {}) };
  const logger = opts.logger || console;
  const notifier = opts.notifier || null;
  const file = opts.file;
  const now = opts.now || (() => Date.now());
  const fetchImpl = opts.fetchImpl || fetch;
  const equity = Number(opts.equity || SHADOW_DEFAULTS.equity);

  // 模拟时钟：recorder 内部时间线跟随正在处理的 K 线（回放历史时 openedAt/closedAt/资金费才正确）
  let simNow = Date.now();
  const recorder = createShadowRecorder({ now: () => simNow, shadowCfg: { ...SHADOW_DEFAULTS, equity } });
  let timer = null;
  let lastError = null;
  let lastEvaluatedAt = null;
  let lastBarClose = null;
  let runner = newRunnerState();

  function newRunnerState() {
    return {
      startedAt: null, lastBarKey: null, lastHourKey: null, lastReportDay: null,
      coverage: { firstBarKey: null, lastBarKey: null, processedBars: 0, missedBars: 0, maxGapMs: 0, outageCount: 0 },
      requests: { candle: { ok: 0, fail: 0 }, funding: { ok: 0, fail: 0 }, book: { ok: 0, fail: 0 }, binance: { ok: 0, fail: 0 } },
      binanceSamples: [],
      binance: { samples: 0 },
    };
  }

  function bump(kind, ok) {
    const r = runner.requests[kind];
    if (r) r[ok ? 'ok' : 'fail']++;
  }

  // ── 数据获取（公共端点，零鉴权；单次重试） ──
  async function postInfo(payload) {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(HL_INFO_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`HL info HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        last = e;
        if (attempt === 0) await sleep(500);
      }
    }
    throw last;
  }

  async function fetchCandles(interval, bars) {
    const intervalSec = { '5m': 300, '1h': 3600, '4h': 14400 }[interval];
    const end = now();
    const start = end - (bars + 5) * intervalSec * 1000;
    const rows = await postInfo({ type: 'candleSnapshot', req: { coin: cfg.symbol, interval, startTime: start, endTime: end } });
    bump('candle', true);
    const candles = (Array.isArray(rows) ? rows : []).map((r) => ({ time: Number(r.t), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v || 0) }));
    return { candles, intervalSec };
  }

  /** 资金费率历史（逐时段点位；失败返回 null —— 缺失绝不当 0）。 */
  async function fetchFundingHistory() {
    try {
      const end = now();
      const rows = await postInfo({ type: 'fundingHistory', coin: cfg.symbol, startTime: end - 48 * 3_600_000, endTime: end });
      bump('funding', true);
      return (Array.isArray(rows) ? rows : [])
        .map((r) => ({ time: Number(r.time), rate: Number(r.fundingRate) }))
        .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.rate));
    } catch (e) {
      bump('funding', false);
      throw e;
    }
  }

  async function fetchBookSample(direction, price) {
    try {
      const book = await postInfo({ type: 'l2Book', coin: cfg.symbol });
      bump('book', true);
      const sizeBase = cfg.bookSampleNotional / Math.max(1, price);
      const s = slippageFromBook(book, direction === 'short' ? 'sell' : 'buy', sizeBase);
      return s ? { entryBps: s.bps } : null;
    } catch {
      bump('book', false);
      return null;
    }
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
        const signedBps = Number(((hlClose / bnClose - 1) * 10_000).toFixed(3));
        runner.binanceSamples.push({ t: now(), signedBps });
        if (runner.binanceSamples.length > 200) runner.binanceSamples.shift();
        runner.binance = { ...summarizeBasis(runner.binanceSamples), error: null, checkedAt: now() };
      }
      bump('binance', true);
    } catch (e) {
      runner.binance = { ...runner.binance, error: String(e?.message || e), checkedAt: now() };
      bump('binance', false);
    }
  }

  /** 覆盖率视图（Review P0-4：有效数据天数 = processedBars × 5 分钟）。 */
  function coverageView() {
    const c = runner.coverage;
    const expected = c.firstBarKey != null && c.lastBarKey != null ? Math.round((c.lastBarKey - c.firstBarKey) / 300_000) + 1 : 0;
    return {
      firstBarKey: c.firstBarKey, lastBarKey: c.lastBarKey,
      expectedBars: expected, processedBars: c.processedBars, missedBars: c.missedBars,
      coveragePct: expected > 0 ? Number(Math.min(100, (c.processedBars / expected) * 100).toFixed(2)) : 0,
      effectiveDays: Number(((c.processedBars * 300_000) / 86_400_000).toFixed(2)),
      maxGapMs: c.maxGapMs, outageCount: c.outageCount,
    };
  }

  /** 处理单根已收盘 5M（按收盘时刻 as-of 切片特征，杜绝未来函数）。 */
  async function processBar(bar, { closed5m, closed1hAll, closed4hAll, fundingPoints, isLast }) {
    const asOf = bar.time + 300_000;
    simNow = asOf; // 模拟时钟推进到该 K 线收盘时刻
    const c5 = closed5m.filter((c) => c.time + 300_000 <= asOf);
    const c1 = closed1hAll.filter((c) => c.time + 3_600_000 <= asOf);
    const c4 = closed4hAll.filter((c) => c.time + 14_400_000 <= asOf);
    const features = buildFeatures({ candles5m: c5, candles1h: c1, candles4h: c4 });
    const signal = evaluateRegime(features);
    const hourKey = c1.at(-1)?.time ?? null;
    const isNewHourlyBar = hourKey != null && runner.lastHourKey != null && hourKey !== runner.lastHourKey;
    if (hourKey != null) runner.lastHourKey = hourKey;
    const bookSample = isLast && signal.direction ? await fetchBookSample(signal.direction, bar.close) : null;

    const events = recorder.onBar({ candle5m: bar, signal, barKey: bar.time, isNewHourlyBar, features, fundingPoints, bookSample });

    runner.lastBarKey = bar.time;
    runner.coverage.firstBarKey ??= bar.time;
    runner.coverage.lastBarKey = bar.time;
    runner.coverage.processedBars++;
    lastEvaluatedAt = now();
    lastBarClose = Number(bar.close) || lastBarClose;
    lastError = null;
    if (events.length) logger.info?.('strategy', `[影子] ${cfg.symbol} ${signal.regime} score=${signal.score} 事件: ${events.map((e) => `${e.configId}:${e.event}`).join(', ')}`);
    persist(); // 每根落盘：崩溃/重启后 cursor 一致，不重复驱动
    if (isLast && signal.direction) await fetchBinanceCheck(bar.close);
  }

  // ── 单轮：对 lastBarKey 之后的所有已收盘 5M 顺序回放 ──
  async function tick() {
    try {
      const m5 = await fetchCandles('5m', cfg.bars.m5);
      const closed5m = dropUnclosed(m5.candles, m5.intervalSec, now());
      if (!closed5m.length) return;
      // 首次启动（无 cursor）：初始化到最新已收盘 5M，不回溯历史——决断门是前向验证
      if (runner.lastBarKey == null) {
        const bar = closed5m[closed5m.length - 1];
        runner.lastBarKey = bar.time;
        runner.coverage.firstBarKey = bar.time;
        runner.coverage.lastBarKey = bar.time;
        runner.coverage.processedBars = 1; // 基线计入覆盖率分母，保证 (processed/expected) 口径自洽
        persist();
        logger.info?.('strategy', `[影子] 首次启动：cursor 初始化为最新已收盘 5M（前向验证，不回溯历史）`);
        return;
      }
      const { pending, missedBars, gapMs } = computePendingBars(closed5m, runner.lastBarKey, cfg.maxReplayBars);
      if (!pending.length) return;
      if (missedBars > 0) { runner.coverage.missedBars += missedBars; runner.coverage.outageCount++; }
      if (gapMs > 0) runner.coverage.maxGapMs = Math.max(runner.coverage.maxGapMs, gapMs);

      const [h1, h4] = await Promise.all([fetchCandles('1h', cfg.bars.h1), fetchCandles('4h', cfg.bars.h4)]);
      const closed1hAll = dropUnclosed(h1.candles, h1.intervalSec, now());
      const closed4hAll = dropUnclosed(h4.candles, h4.intervalSec, now());
      const fundingPoints = await fetchFundingHistory().catch(() => null); // null = 数据不可用（记缺失，不当 0）

      for (let i = 0; i < pending.length; i++) {
        await processBar(pending[i], { closed5m, closed1hAll, closed4hAll, fundingPoints, isLast: i === pending.length - 1 });
      }
      if (pending.length > 1) logger.info?.('strategy', `[影子] 补处理 ${pending.length} 根 5M（缺口 ${missedBars} 根）`);
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
    const mtm = lastBarClose != null ? recorder.getMarkToMarket(lastBarClose) : null;
    const gate = evaluateGate(data, { equity, coverage: coverageView(), mtm: mtm?.r2fast || null });
    const text = composeDailyReport({ recorderData: data, gate, runner: { equity, binance: runner.binance, bookObserved: recorder.getState().bookObserved, mtm } });
    logger.info?.('strategy', `[影子] 日报:\n${text}`);
    try { notifier?.send?.({ source: 'strategy', level: 'warn', key: 'strategy-shadow:daily', cooldownMs: 20 * 3600_000, message: text }); } catch { /* 推送失败不影响 */ }
  }

  function start() {
    if (timer) return;
    const saved = loadShadowData(file);
    if (saved?.recorder) {
      recorder.loadData(saved.recorder);
      if (saved.runner) {
        runner = { ...runner, ...saved.runner };
        if (!Array.isArray(runner.binanceSamples)) runner.binanceSamples = [];
        if (!runner.coverage) runner.coverage = newRunnerState().coverage;
        if (!runner.requests) runner.requests = newRunnerState().requests;
        runner.binance = { ...summarizeBasis(runner.binanceSamples), error: null, checkedAt: null };
      }
      logger.info?.('strategy', `[影子] 已恢复历史数据（交易 ${recorder.getState().perConfig?.r2fast?.stats?.closed || 0} 笔，cursor ${runner.lastBarKey || '无'}）`);
    }
    if (!runner.startedAt) runner.startedAt = now();
    timer = setInterval(() => { tick().catch(() => {}); }, cfg.checkMs);
    timer.unref?.();
    tick().catch(() => {});
    logger.info?.('strategy', `[影子] 运行器已启动（${cfg.symbol}，检查节拍 ${cfg.checkMs / 1000}s，日报 ${cfg.reportHour} 点）`);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function getState() {
    const coverage = coverageView();
    const mtm = lastBarClose != null ? recorder.getMarkToMarket(lastBarClose) : null;
    const rec = recorder.getState(lastBarClose);
    const data = recorder.exportData();
    const gate = evaluateGate(data, { equity, coverage, mtm: mtm?.r2fast || null });
    return {
      enabled: !!timer, symbol: cfg.symbol, startedAt: runner.startedAt,
      lastBarKey: runner.lastBarKey, lastEvaluatedAt, lastError, lastBarClose,
      coverage, requests: runner.requests,
      binance: runner.binance,
      bookObserved: rec.bookObserved,
      gate,
      recorder: rec,
    };
  }

  return { start, stop, tick, getState, _recorder: recorder };
}
