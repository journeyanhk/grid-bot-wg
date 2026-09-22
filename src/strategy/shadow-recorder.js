// 影子记录器（阶段1）：三组参数并行记录假设交易全生命周期。
// 生命周期：SIGNAL → VIRTUAL_ENTRY → VIRTUAL_ADD_1/2 → VIRTUAL_TP(0.8R/1.5R/2.2R) → TRAILING/STOP → CLOSED
// 处理约定（确定性、可审计）：
//   - 每个已收盘 5M K线驱动一次：先用该 K 线 high/low 管理持仓（止损优先于止盈），再用信号评估入场；
//   - 入场价 = 当根收盘价；加仓/止盈/止损按触发价成交；市价腿（止损/信号退出）滑点进成本模型；
//   - 止损只允许向有利方向移动（移动止损 = 最高价 - trailAtr×ATR，多头镜像）。
import { createRegimeTracker } from './regime.js';
import { allScenarioCosts, COST_SCENARIOS, FEE_DEFAULTS, fundingCost } from './shadow-cost-model.js';
import { ExitReason } from './types.js';

/** 三组参数：R2 Fast 为决断对象；Balanced/Strict 为对照（文档1 参数 + 低频对照假设）。 */
export const PARAM_SETS = Object.freeze([
  { id: 'r2fast', label: 'R2 Fast（决断）', entryThreshold: 50, exitThreshold: 15, adxMin: 18, volMaxAtrPct: 2.0, spacingAtr: 0.5, stopAtr: 1.0, trailAtr: 1.2, maxLevels: 3, tpR: [0.8, 1.5, 2.2], tpFrac: [0.25, 0.35, 0.25] },
  { id: 'balanced', label: 'Balanced（对照）', entryThreshold: 60, exitThreshold: 20, adxMin: 20, volMaxAtrPct: 2.0, spacingAtr: 0.8, stopAtr: 1.5, trailAtr: 1.5, maxLevels: 3, tpR: [0.8, 1.5, 2.2], tpFrac: [0.25, 0.35, 0.25] },
  { id: 'strict', label: 'Strict（低频对照）', entryThreshold: 70, exitThreshold: 25, adxMin: 25, volMaxAtrPct: 2.0, spacingAtr: 1.0, stopAtr: 2.0, trailAtr: 2.0, maxLevels: 3, tpR: [0.8, 1.5, 2.2], tpFrac: [0.25, 0.35, 0.25] },
]);

export const SHADOW_DEFAULTS = Object.freeze({
  equity: 10_000,          // 虚拟权益（仓位计算基准）
  initialRiskPct: 0.0015,  // 初始层风险 0.15%
  layerRiskPct: 0.00135,   // 加仓层风险 0.135%/层（合计 maxStrategyRisk 0.42%）
  maxLeverage: 3,
  maxHoldingHours: 48,
  cooldownBars5m: 6,       // 平仓后冷却 6 根 5M（30 分钟）再入场——状态机 COOLDOWN 的影子实现
  maxTradesPerConfig: 200,
});

let tradeSeq = 0;

export function createShadowRecorder(opts = {}) {
  const paramSets = opts.paramSets || PARAM_SETS;
  const shadow = { ...SHADOW_DEFAULTS, ...(opts.shadowCfg || {}) };
  const fees = { ...FEE_DEFAULTS, ...(opts.fees || {}) };
  const scenarios = opts.scenarios || COST_SCENARIOS;
  const now = opts.now || (() => Date.now());

  const configs = new Map();
  for (const def of paramSets) {
    configs.set(def.id, {
      def,
      tracker: createRegimeTracker({ entryThreshold: def.entryThreshold, exitThreshold: def.exitThreshold, adxMin: def.adxMin, volMaxAtrPct: def.volMaxAtrPct }),
      position: null,
      trades: [],
      stats: { entries: 0, closed: 0, wins: 0, grossPnl: 0, netPnlBaseline: 0 },
    });
  }
  const signals = []; // 诊断用信号环（全局）
  let evaluations = 0, lastSignal = null, lastProcessedBarKey = null;

  function pushSignal(signal, barKey) {
    lastSignal = signal;
    signals.unshift({ t: signal.ts || now(), barKey, regime: signal.regime, score: signal.score, direction: signal.direction, adx: signal.adx, atrPct: signal.atrPct });
    if (signals.length > 200) signals.pop();
  }

  /** 开仓（虚拟）：按止损距离反推仓位，分 3 层。 */
  function openPosition(cfg, signal, candle, atrValue, structureRef) {
    const side = signal.direction;
    if (side !== 'long' && side !== 'short') return;
    const entry = Number(candle.close);
    const atr = Number(atrValue) || 0;
    if (!(entry > 0) || !(atr > 0)) return;
    const def = cfg.def;
    // 止损：入场 ∓ stopAtr×ATR 与结构位取更宽（多头取更低者）
    const atrStop = side === 'long' ? entry - def.stopAtr * atr : entry + def.stopAtr * atr;
    const structStop = side === 'long'
      ? (Number.isFinite(structureRef?.low) ? structureRef.low - 0.2 * atr : atrStop)
      : (Number.isFinite(structureRef?.high) ? structureRef.high + 0.2 * atr : atrStop);
    const stopPrice = side === 'long' ? Math.min(atrStop, structStop) : Math.max(atrStop, structStop);
    const stopDistance = Math.abs(entry - stopPrice);
    if (!(stopDistance > 0)) return;

    // 三层风险反推仓位（合计 ≈ maxStrategyRisk）
    const risks = [shadow.initialRiskPct, shadow.layerRiskPct, shadow.layerRiskPct];
    const sizes = risks.map((r) => (shadow.equity * r) / stopDistance);
    const leverageCap = (shadow.equity * shadow.maxLeverage) / entry;
    const totalRaw = sizes.reduce((a, b) => a + b, 0);
    const scale = totalRaw > leverageCap ? leverageCap / totalRaw : 1;
    const layerSizes = sizes.map((s) => s * scale);

    const layers = [{ level: 0, price: entry, size: layerSizes[0], filled: true, at: now() }];
    for (let i = 1; i < def.maxLevels; i++) {
      const px = side === 'long' ? entry - def.spacingAtr * atr * i : entry + def.spacingAtr * atr * i;
      layers.push({ level: i, price: px, size: layerSizes[i], filled: false, at: null });
    }
    const R = stopDistance;
    const tpLevels = def.tpR.map((r, i) => ({
      r,
      price: side === 'long' ? entry + r * R : entry - r * R,
      size: totalRaw * def.tpFrac[i],
      filled: false, at: null,
    }));

    cfg.position = {
      tradeId: `sh-${++tradeSeq}`,
      configId: def.id, side,
      openedAt: now(), entryPrice: entry, avgEntry: entry,
      initialStop: stopPrice, stopPrice,
      atr, R, layers, tpLevels,
      filledSize: layerSizes[0], closedSize: 0,
      legs: [{ notional: entry * layerSizes[0], isMarket: false, kind: 'entry' }],
      highSinceEntry: entry, lowSinceEntry: entry,
      mfe: 0, mae: 0, grossPnl: 0,
      bookEntryBps: null,
    };
    cfg.stats.entries++;
    return cfg.position;
  }

  /** 平掉剩余仓位（市价腿）。 */
  function closeRemaining(cfg, pos, price, reason) {
    const remaining = pos.filledSize - pos.closedSize;
    if (!(remaining > 0)) return;
    const pnl = pos.side === 'long' ? (price - pos.avgEntry) * remaining : (pos.avgEntry - price) * remaining;
    pos.grossPnl += pnl;
    pos.closedSize += remaining;
    pos.legs.push({ notional: price * remaining, isMarket: true, kind: reason });
    pos.exitReason = reason;
    pos.exitPrice = price;
  }

  /** 用一根已收盘 5M K 线管理持仓（止损优先于止盈，保守）。 */
  function managePosition(cfg, candle, signal) {
    const pos = cfg.position;
    if (!pos) return;
    const high = Number(candle.high), low = Number(candle.low), close = Number(candle.close);
    const long = pos.side === 'long';

    // 0) 极值/MFE/MAE 先行（止损 K 线的波动同样要记录）
    pos.highSinceEntry = Math.max(pos.highSinceEntry, high);
    pos.lowSinceEntry = Math.min(pos.lowSinceEntry, low);
    pos.mfe = Math.max(pos.mfe, long ? (pos.highSinceEntry - pos.avgEntry) : (pos.avgEntry - pos.lowSinceEntry));
    pos.mae = Math.max(pos.mae, long ? (pos.avgEntry - pos.lowSinceEntry) : (pos.highSinceEntry - pos.avgEntry));

    // 1) 止损（含移动止损后的价位）
    const stopHit = long ? low <= pos.stopPrice : high >= pos.stopPrice;
    if (stopHit) {
      const reason = pos.stopPrice === pos.initialStop ? ExitReason.STOP : ExitReason.TRAILING_STOP;
      closeRemaining(cfg, pos, pos.stopPrice, reason);
      finalize(cfg, pos, candle);
      return;
    }

    // 2) 分批止盈
    for (const tp of pos.tpLevels) {
      if (tp.filled) continue;
      const hit = long ? high >= tp.price : low <= tp.price;
      if (!hit) continue;
      const size = Math.min(tp.size, pos.filledSize - pos.closedSize);
      if (!(size > 0)) continue;
      const pnl = long ? (tp.price - pos.avgEntry) * size : (pos.avgEntry - tp.price) * size;
      pos.grossPnl += pnl;
      pos.closedSize += size;
      tp.filled = true; tp.at = now();
      pos.legs.push({ notional: tp.price * size, isMarket: false, kind: 'tp' });
      if (pos.closedSize >= pos.filledSize - 1e-12) { // 全部止盈完成
        pos.exitReason = ExitReason.TP_FULL; pos.exitPrice = tp.price;
        finalize(cfg, pos, candle);
        return;
      }
    }

    // 3) 分层加仓（趋势未失效时才加：由调用方保证 signal 方向一致）
    for (const layer of pos.layers) {
      if (layer.filled) continue;
      const hit = long ? low <= layer.price : high >= layer.price;
      if (!hit) continue;
      if (signal && signal.direction !== pos.side) break; // 趋势失效：不再加仓
      const size = layer.size;
      pos.avgEntry = (pos.avgEntry * pos.filledSize + layer.price * size) / (pos.filledSize + size);
      pos.filledSize += size;
      layer.filled = true; layer.at = now();
      pos.legs.push({ notional: layer.price * size, isMarket: false, kind: 'add' });
    }

    // 4) 移动止损（只向有利方向移动）
    const trail = long ? pos.highSinceEntry - cfg.def.trailAtr * pos.atr : pos.lowSinceEntry + cfg.def.trailAtr * pos.atr;
    pos.stopPrice = long ? Math.max(pos.stopPrice, trail) : Math.min(pos.stopPrice, trail);

    // 5) 最长持仓熔断（maxHoldingHours，市价腿）
    if (now() - pos.openedAt >= shadow.maxHoldingHours * 3_600_000) {
      closeRemaining(cfg, pos, close, ExitReason.MAX_HOLDING);
      finalize(cfg, pos, candle);
      return;
    }

    // 6) 趋势失效退出（信号退出，市价腿）
    if (signal && cfg.tracker.shouldExit(pos.side, signal.score)) {
      closeRemaining(cfg, pos, close, ExitReason.SIGNAL_EXIT);
      finalize(cfg, pos, candle);
    }
  }

  /** 收尾：成本四档 + 资金费 + 记录交易。 */
  function finalize(cfg, pos, candle) {
    const closedAt = now();
    const holdingMs = Math.max(0, closedAt - pos.openedAt);
    const costs = allScenarioCosts(pos.legs, scenarios, fees);
    const avgNotional = pos.avgEntry * Math.max(pos.filledSize, 1e-12);
    const fundingUsd = fundingCost({ notional: avgNotional, hourlyRate: pos.fundingHourly || 0, holdingMs, side: pos.side });
    const netPnl = {};
    for (const sc of scenarios) netPnl[sc.id] = Number((pos.grossPnl - costs[sc.id].totalUsd - fundingUsd).toFixed(4));
    const trade = {
      tradeId: pos.tradeId, configId: cfg.def.id, side: pos.side,
      openedAt: pos.openedAt, closedAt, holdingMs,
      entryPrice: Number(pos.avgEntry.toFixed(2)), initialStop: Number(pos.initialStop.toFixed(2)), finalStop: Number(pos.stopPrice.toFixed(2)),
      filledSize: Number(pos.filledSize.toFixed(6)), R: Number(pos.R.toFixed(2)),
      adds: pos.layers.filter((l) => l.level > 0 && l.filled).length,
      tpFills: pos.tpLevels.filter((t) => t.filled).map((t) => t.r),
      exitReason: pos.exitReason, exitPrice: pos.exitPrice != null ? Number(pos.exitPrice.toFixed(2)) : null,
      grossPnl: Number(pos.grossPnl.toFixed(4)),
      fundingUsd: Number(fundingUsd.toFixed(4)),
      costs, netPnl,
      mfe: Number(pos.mfe.toFixed(2)), mae: Number(pos.mae.toFixed(2)),
      bookEntryBps: pos.bookEntryBps,
    };
    cfg.trades.unshift(trade);
    if (cfg.trades.length > shadow.maxTradesPerConfig) cfg.trades.pop();
    cfg.stats.closed++;
    if (trade.grossPnl > 0) cfg.stats.wins++;
    cfg.stats.grossPnl = Number((cfg.stats.grossPnl + trade.grossPnl).toFixed(4));
    cfg.stats.netPnlBaseline = Number((cfg.stats.netPnlBaseline + (netPnl.baseline || 0)).toFixed(4));
    cfg.position = null;
    cfg.cooldownUntil = (Number(candle.time) || 0) + shadow.cooldownBars5m * 300_000;
    return trade;
  }

  /**
   * 每根已收盘 5M K 线驱动一次。
   * @param {Object} o
   * @param {Object} o.candle5m 当根已收盘 K 线
   * @param {Object} o.signal   evaluateRegime 输出
   * @param {number} o.barKey   5M K 线 open time（去重）
   * @param {boolean} o.isNewHourlyBar 是否恰逢 1H 收盘
   * @param {Object} o.features buildFeatures 输出（ATR/结构）
   * @param {number} [o.fundingHourly] 资金费率（每小时）
   * @param {Object} [o.bookSample] { entryBps } 盘口滑点采样（可选）
   */
  function onBar({ candle5m, signal, barKey, isNewHourlyBar = false, features, fundingHourly = 0, bookSample = null }) {
    // 同根去重：同一 5M 只驱动一次（管理+入场都不得重复处理）
    if (barKey != null && barKey === lastProcessedBarKey) return [];
    if (barKey != null) lastProcessedBarKey = barKey;
    evaluations++;
    pushSignal(signal, barKey);
    const results = [];
    for (const cfg of configs.values()) {
      if (cfg.position) cfg.position.fundingHourly = fundingHourly;
      if (cfg.position) managePosition(cfg, candle5m, signal);
      if (!cfg.position) {
        const cooled = !cfg.cooldownUntil || !Number.isFinite(barKey) || barKey >= cfg.cooldownUntil;
        const { entryDirection } = cooled ? cfg.tracker.onEvaluation(signal, { barKey, isNewHourlyBar }) : { entryDirection: null };
        if (entryDirection) {
          const pos = openPosition(cfg, { ...signal, direction: entryDirection }, candle5m, features?.atr5m, features);
          if (pos && bookSample?.entryBps != null) pos.bookEntryBps = bookSample.entryBps;
          if (pos) results.push({ configId: cfg.def.id, event: 'entry', tradeId: pos.tradeId, side: pos.side });
        }
      }
    }
    return results;
  }

  function getState() {
    const perConfig = {};
    for (const [id, cfg] of configs) {
      perConfig[id] = {
        label: cfg.def.label,
        position: cfg.position ? { tradeId: cfg.position.tradeId, side: cfg.position.side, entryPrice: cfg.position.avgEntry, stopPrice: cfg.position.stopPrice } : null,
        stats: cfg.stats,
        recentTrades: cfg.trades.slice(0, 10),
      };
    }
    return {
      evaluations, lastSignal, perConfig,
      recentSignals: signals.slice(0, 20),
      equity: shadow.equity,
    };
  }

  function exportData() {
    const perConfig = {};
    for (const [id, cfg] of configs) {
      perConfig[id] = { trades: cfg.trades, stats: cfg.stats, position: cfg.position };
    }
    return { version: 1, evaluations, signals: signals.slice(0, 200), perConfig };
  }

  function loadData(data) {
    if (!data || typeof data !== 'object') return false;
    evaluations = Number(data.evaluations) || 0;
    if (Array.isArray(data.signals)) signals.splice(0, signals.length, ...data.signals.slice(0, 200));
    for (const [id, cfg] of configs) {
      const d = data.perConfig?.[id];
      if (!d) continue;
      cfg.trades = Array.isArray(d.trades) ? d.trades.slice(0, shadow.maxTradesPerConfig) : [];
      cfg.stats = { ...cfg.stats, ...(d.stats || {}) };
      cfg.position = d.position || null;
      if (cfg.position) cfg.position.fundingHourly = cfg.position.fundingHourly || 0;
    }
    return true;
  }

  return { onBar, getState, exportData, loadData, configs };
}
