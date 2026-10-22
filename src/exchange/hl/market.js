// Hyperliquid (HL) market constants and pure parsers for the "io" dex namespace.
// Market metadata comes from metaAndAssetCtxs; candles from candleSnapshot.
// HIP-3 assets are addressed by their string name (e.g. "io:ANTH") directly,
// mirroring the official Python SDK behaviour instead of manual asset ids.
//
// 契约已按 2026-09-07 对主网的真实探测校准（SDK 0.24.0）：
// - metaAndAssetCtxs 返回数组 [meta, assetCtxs]，universe[i] 与 assetCtxs[i] 下标对齐
// - universe 元素只有 szDecimals（无 pxDecimals）；maxLeverage 在 universe 里
// - HL 价格约束：≤5 位有效数字，小数位 ≤ (6 - szDecimals) → stepPrice = 10 ** -(6 - szDecimals)
// - 基础费率约 maker 0.015% / taker 0.045%（io dex deployerFeeScale 1.0 无加成）
export const HL_API_URL = 'https://api.hyperliquid.xyz';
export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HL_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
export const HL_DEX = 'io';
export const HL_MAINNET_CHAIN_ID = 42161; // Arbitrum 主网（421614 是 Sepolia 测试网）
export const HL_MIN_NOTIONAL_USD = 10;     // HL 最小订单名义 $10
export const HL_MAX_LEVERAGE = 6;          // io 系市场最大杠杆（强制逐仓）兜底

export const CANDLE_RESOLUTIONS = new Map([
  [60, '1m'], [300, '5m'], [900, '15m'], [1800, '30m'],
  [3600, '1h'], [14400, '4h'], [43200, '12h'],
  [86400, '1d'], [604800, '1w'],
]);

// HL 基础费率（deployerFeeScale 1.0 无加成时的默认值；首笔真实成交后按账户实际费率复核）
export const HL_MAKER_FEE = 0.00015;
export const HL_TAKER_FEE = 0.00045;

export function parseMarkets(data) {
  const meta = Array.isArray(data) ? data[0] : data;
  const ctxs = Array.isArray(data) ? data[1] : data?.assetCtxs;
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const assetCtxs = Array.isArray(ctxs) ? ctxs : [];
  const out = [];
  for (let i = 0; i < universe.length; i++) {
    const raw = universe[i];
    const ctx = assetCtxs[i] || {};
    const name = String(raw.name || '');
    // 只保留当前 dex 命名空间的市场（如 "io:ANTH"）；跳过 core 市场
    if (!name.includes(':') || !name.toLowerCase().startsWith((HL_DEX + ':').toLowerCase())) continue;
    const szDecimals = Number(raw.szDecimals ?? 0);
    if (szDecimals < 0) continue;
    const markPx = Number(ctx.markPx || 0);
    const maxLeverage = Math.max(1, Math.floor(Number(raw.maxLeverage || 0)) || HL_MAX_LEVERAGE);
    // HL 价格约束：小数位 ≤ (6 - szDecimals)，且报价 ≤5 位有效数字（下单前另做校验）
    const priceDecimals = Math.max(0, 6 - szDecimals);
    out.push({
      marketId: i,                      // 以 universe 下标作为内部 marketId（HIP-3 无公开数字 id）
      name,
      displayName: name,
      symbol: name.split(':').pop(),
      status: 'active',
      lastPrice: markPx,
      stepSize: 1 / 10 ** szDecimals,
      stepPrice: 1 / 10 ** priceDecimals,
      sizeDecimals: szDecimals,
      priceDecimals,
      minOrderSize: 1 / 10 ** szDecimals,
      minOrderNotional: HL_MIN_NOTIONAL_USD, // 名义价值下限 $10
      maxOrderSize: Infinity,
      maxLeverage,
      onlyIsolated: raw.onlyIsolated !== false,
      makerFee: HL_MAKER_FEE,
      takerFee: HL_TAKER_FEE,
      raw,
    });
  }
  return out.sort((a, b) => Number(b.raw?.openInterest || 0) - Number(a.raw?.openInterest || 0));
}

export function parseCandles(data) {
  // candleSnapshot 直接返回数组（无 {candles:} 包装）
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.candles) ? data.candles : []);
  return rows.map((row) => ({
    time: normalizeEpochMs(row.t),
    open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c), volume: Number(row.v || 0),
  })).filter((row) => row.time > 0 && Number.isFinite(row.close)).sort((a, b) => a.time - b.time);
}

// HL 报价约束：≤5 位有效数字。下单前对价格取整校验，否则会被交易所拒单。
export function toExchangeInteger(value, decimals, direction = 'nearest') {
  const number = Number(value);
  const factor = 10 ** Number(decimals);
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(Math.round(number * factor))) {
    throw new Error(`数值 ${value} 无法按 ${decimals} 位精度转换。`);
  }
  const scaled = number * factor;
  if (direction === 'down') return Math.floor(scaled + 1e-9);
  if (direction === 'up') return Math.ceil(scaled - 1e-9);
  return Math.round(scaled);
}

// HL 5 位有效数字取整：报价必须 ≤5 位有效数字（如 1994.56 → 1994.6；0.00123456 → 0.0012346）
export function roundToSignificantDigits(value, digits = 5) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return number;
  const magnitude = Math.pow(10, Math.floor(Math.log10(number)) - (digits - 1));
  const rounded = Math.round(number / magnitude) * magnitude;
  // 消除浮点尾巴（1994.6000000000001 → 1994.6）
  const decimals = Math.max(0, Math.min(15, (digits - 1) - Math.floor(Math.log10(number))));
  return Number(rounded.toFixed(decimals));
}

function normalizeEpochMs(value) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  if (timestamp < 100_000_000_000) timestamp *= 1000;       // seconds
  else if (timestamp >= 100_000_000_000_000_000) timestamp /= 1_000_000; // ns
  else if (timestamp >= 100_000_000_000_000) timestamp /= 1000;           // us
  return Math.trunc(timestamp);
}