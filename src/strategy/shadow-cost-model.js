// 影子成本模型（阶段1）：四档成本情景 + 真实盘口滑点采样 + 资金费率。
// 原则：确定性（不用随机数）——makerFillRate 作为费率期望权重；滑点仅计市价腿；
// 真实盘口滑点由 l2Book 采样独立记录（可信度校验），不混入情景计算。

export const COST_SCENARIOS = Object.freeze([
  { id: 'optimistic', label: '乐观', makerFillRate: 0.8, takerSlippageBps: 1.5 },
  { id: 'baseline', label: '基准', makerFillRate: 0.5, takerSlippageBps: 2 },
  { id: 'conservative', label: '保守', makerFillRate: 0.2, takerSlippageBps: 4 },
  { id: 'allTaker', label: '全Taker', makerFillRate: 0, takerSlippageBps: 4 },
]);

// HL 基础档费率（首笔真实成交后按账户实际费率复核）
export const FEE_DEFAULTS = Object.freeze({ makerFeeRate: 0.00015, takerFeeRate: 0.00045 });

/**
 * 单腿费用与滑点。
 * @param {Object} o
 * @param {number} o.notional      名义价值（USD）
 * @param {boolean} o.isMarket     市价腿（止损/信号退出）恒 taker + 滑点；限价腿按 makerFillRate 期望
 */
export function legCost({ notional, isMarket = false }, scenario, fees = FEE_DEFAULTS) {
  const n = Math.abs(Number(notional) || 0);
  const rate = isMarket
    ? fees.takerFeeRate
    : scenario.makerFillRate * fees.makerFeeRate + (1 - scenario.makerFillRate) * fees.takerFeeRate;
  const feeUsd = n * rate;
  const slippageUsd = isMarket ? (n * scenario.takerSlippageBps) / 10_000 : 0;
  return { feeUsd, slippageUsd };
}

/** 按腿集合汇总某情景成本。legs: [{notional, isMarket}] */
export function scenarioCosts(legs, scenario, fees = FEE_DEFAULTS) {
  let feeUsd = 0, slippageUsd = 0;
  for (const leg of legs || []) {
    const c = legCost(leg, scenario, fees);
    feeUsd += c.feeUsd; slippageUsd += c.slippageUsd;
  }
  return { feeUsd, slippageUsd, totalUsd: feeUsd + slippageUsd };
}

/** 全情景汇总。返回 { [scenarioId]: {feeUsd, slippageUsd, totalUsd} } */
export function allScenarioCosts(legs, scenarios = COST_SCENARIOS, fees = FEE_DEFAULTS) {
  const out = {};
  for (const sc of scenarios) out[sc.id] = scenarioCosts(legs, sc, fees);
  return out;
}

/**
 * 资金费率成本（HL funding 为每小时费率）。
 * 多头在正费率下支付（成本为正）；空头在正费率下收取（成本为负）。
 * @returns {number} USD（正=成本）
 */
export function fundingCost({ notional, hourlyRate, holdingMs, side }) {
  const hours = Math.max(0, Number(holdingMs) || 0) / 3_600_000;
  const sign = side === 'long' ? 1 : -1;
  return sign * Math.abs(Number(notional) || 0) * (Number(hourlyRate) || 0) * hours;
}

/**
 * 真实盘口滑点采样（纯函数）：按假设 size 吃单估算 VWAP 相对最优价的滑点。
 * book: HL l2Book 响应 { levels: [bids[], asks[]] }，档位 {px, sz, n}
 * side: 'buy' 吃 asks / 'sell' 吃 bids
 * @returns {Object|null} { filled, requested, vwap, bestPx, bps, depthUsed }
 */
export function slippageFromBook(book, side, sizeBase) {
  const levels = book?.levels;
  if (!Array.isArray(levels) || levels.length < 2) return null;
  const sideLevels = side === 'buy' ? levels[1] : levels[0];
  if (!Array.isArray(sideLevels) || !sideLevels.length) return null;
  const requested = Math.abs(Number(sizeBase) || 0);
  if (!(requested > 0)) return null;
  let filled = 0, cost = 0, depthUsed = 0;
  for (const lvl of sideLevels) {
    const px = Number(lvl.px), sz = Number(lvl.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    const take = Math.min(sz, requested - filled);
    cost += px * take; filled += take; depthUsed++;
    if (filled >= requested) break;
  }
  if (!(filled > 0)) return null;
  const bestPx = Number(sideLevels[0].px);
  const vwap = cost / filled;
  const bps = side === 'buy'
    ? (vwap / bestPx - 1) * 10_000
    : (1 - vwap / bestPx) * 10_000;
  return { filled, requested, vwap, bestPx, bps: Number(bps.toFixed(3)), depthUsed };
}
