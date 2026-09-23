// Propr 市场常量与纯解析/取整工具。
//
// 精度（Day-0 探针实测）：Propr API 层**不校验**数量/价格/名义——1e-7 数量、5 位小数价格、
// 名义 $0.87 的限价单均被接受且保持 open（exchangeOrderId=null）。因此适配器必须自行保守取整，
// 不能依赖服务端拒单。Propr 路由到 Hyperliquid，BTC 采用 HL 主网规格：
//   szDecimals=5 → stepSize=1e-5；价格小数位 ≤ 6-szDecimals=1 → stepPrice=0.1；最小名义 $10。
export const PROPR_MAKER_FEE = 0.00015;
export const PROPR_TAKER_FEE = 0.00045;
export const PROPR_MIN_NOTIONAL_USD = 10;
export const PROPR_SZ_DECIMALS = 5;
export const PROPR_PRICE_DECIMALS = 1;
export const PROPR_POSITION_MODE = 'net';

/** 小数位 → 步长（1e-5 → 0.00001）。 */
export function toStepSize(decimals) {
  return 1 / 10 ** Number(decimals);
}

/**
 * 构建统一市场对象。marketId 使用 base 字符串（如 'BTC'），与 Propr 的 asset 口径一致。
 * positionMode 恒为 'net'（探针已确认 Propr 为单向净仓）。
 */
export function buildMarket({
  base = 'BTC',
  quote = 'USDC',
  marginConfig = {},
  leverageLimits = {},
  markPrice = 0,
  sizeDecimals = PROPR_SZ_DECIMALS,
  priceDecimals = PROPR_PRICE_DECIMALS,
} = {}) {
  const override = leverageLimits?.overrides?.[base];
  const fallback = leverageLimits?.defaults?.crypto ?? 2;
  const maxLeverage = Math.max(1, Math.floor(Number(override ?? fallback)) || 2);
  const stepSize = toStepSize(sizeDecimals);
  const stepPrice = toStepSize(priceDecimals);
  return {
    marketId: base,
    name: base,
    displayName: `${base} Perpetual`,
    symbol: base,
    base,
    quote,
    status: 'active',
    lastPrice: Number(markPrice) || 0,
    stepSize,
    stepPrice,
    sizeDecimals,
    priceDecimals,
    minOrderSize: stepSize,
    minOrderNotional: PROPR_MIN_NOTIONAL_USD,
    maxOrderSize: Infinity,
    maxLeverage,
    makerFee: PROPR_MAKER_FEE,
    takerFee: PROPR_TAKER_FEE,
    marginMode: marginConfig?.marginMode ?? 'cross',
    leverage: Number(marginConfig?.leverage ?? 1) || 1,
    positionMode: PROPR_POSITION_MODE,
    raw: { marginConfig, leverageLimits },
  };
}

/** 按小数位取整（down=向下，nearest=就近，up=向上），带浮点尾巴消除。 */
export function roundTo(value, decimals, direction = 'nearest') {
  const number = Number(value);
  const factor = 10 ** Number(decimals);
  const scaled = number * factor;
  if (!Number.isFinite(scaled) || !Number.isSafeInteger(Math.round(scaled))) {
    throw new Error(`数值 ${value} 无法按 ${decimals} 位精度取整。`);
  }
  if (direction === 'down') return Math.floor(scaled + 1e-9) / factor;
  if (direction === 'up') return Math.ceil(scaled - 1e-9) / factor;
  return Math.round(scaled) / factor;
}

/** 数量取整：向下取整到 stepSize（宁可少下不可多下）。 */
export function roundQty(value, market) {
  return roundTo(value, market?.sizeDecimals ?? PROPR_SZ_DECIMALS, 'down');
}

/** 价格取整：就近取整到 stepPrice。 */
export function roundPrice(value, market) {
  return roundTo(value, market?.priceDecimals ?? PROPR_PRICE_DECIMALS, 'nearest');
}

/**
 * 下单前精度/最小名义校验（服务端不校验，必须本地拦截）。
 * @returns {{ok:true}} 或抛出带原因的 Error
 */
export function assertOrderPrecision({ price, sizeBase }, market) {
  const qty = Number(sizeBase);
  const px = Number(price);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error(`数量非法: ${sizeBase}`);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`价格非法: ${price}`);
  const step = market?.stepSize ?? toStepSize(PROPR_SZ_DECIMALS);
  const tick = market?.stepPrice ?? toStepSize(PROPR_PRICE_DECIMALS);
  if (Math.abs(qty / step - Math.round(qty / step)) > 1e-6) throw new Error(`数量 ${qty} 不符合步长 ${step}`);
  if (Math.abs(px / tick - Math.round(px / tick)) > 1e-6) throw new Error(`价格 ${px} 不符合步长 ${tick}`);
  if (qty < (market?.minOrderSize ?? step)) throw new Error(`数量 ${qty} 低于最小下单量 ${market?.minOrderSize ?? step}`);
  const notional = qty * px;
  if (notional < (market?.minOrderNotional ?? PROPR_MIN_NOTIONAL_USD)) {
    throw new Error(`名义价值 ${notional.toFixed(2)} 低于下限 ${market?.minOrderNotional ?? PROPR_MIN_NOTIONAL_USD}`);
  }
  return { ok: true, notional };
}

/** 时间戳归一化为 epoch ms（Propr 返回 ISO 字符串）。 */
export function toEpochMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}
