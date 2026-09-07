// Hyperliquid (HL) market constants and pure parsers for the "io" dex namespace.
// Market metadata comes from metaAndAssetCtxs; candles from candleSnapshot.
// HIP-3 assets are addressed by their string name (e.g. "io:ANTH") directly,
// mirroring the official Python SDK behaviour instead of manual asset ids.
export const HL_API_URL = 'https://api.hyperliquid.xyz';
export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HL_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
export const HL_DEX = 'io';
export const HL_MAINNET_CHAIN_ID = 421614; // Arbitrum 主网（HIP-3 部署市场与 core 同链）
export const HL_MIN_NOTIONAL_USD = 10;     // HL 最小订单名义 $10
export const HL_MAX_LEVERAGE = 6;          // io 系市场最大杠杆（强制逐仓）

export const CANDLE_RESOLUTIONS = new Map([
  [60, '1m'], [300, '5m'], [900, '15m'], [1800, '30m'],
  [3600, '1h'], [14400, '4h'], [43200, '12h'],
  [86400, '1d'], [604800, '1w'],
]);

export function parseMarkets(data) {
  const universe = Array.isArray(data?.universe) ? data.universe : [];
  const assetCtxs = Array.isArray(data?.assetCtxs) ? data.assetCtxs : [];
  const out = [];
  for (let i = 0; i < universe.length; i++) {
    const raw = universe[i];
    const ctx = assetCtxs[i] || {};
    const name = String(raw.name || '');
    // 只保留当前 dex 命名空间的市场（如 "io:ANTH"）；跳过 core 市场
    if (!name.includes(':') || !name.toLowerCase().startsWith((HL_DEX + ':').toLowerCase())) continue;
    const szDecimals = Number(raw.szDecimals ?? 0);
    const pxDecimals = Number(raw.pxDecimals ?? 0);
    if (szDecimals < 0 || pxDecimals < 0) continue;
    const markPx = Number(ctx.markPx || 0);
    const maxLeverage = Math.max(1, Math.floor(Number(ctx.maxLeverage || 0)) || HL_MAX_LEVERAGE);
    out.push({
      marketId: i,                      // 以 universe 下标作为内部 marketId（HIP-3 无公开数字 id）
      name,
      displayName: name,
      symbol: name.split(':').pop(),
      status: 'active',
      lastPrice: markPx,
      stepSize: 1 / 10 ** szDecimals,
      stepPrice: 1 / 10 ** pxDecimals,
      sizeDecimals: szDecimals,
      priceDecimals: pxDecimals,
      minOrderSize: 1 / 10 ** szDecimals,
      minOrderNotional: HL_MIN_NOTIONAL_USD, // 名义价值下限 $10
      maxOrderSize: Infinity,
      maxLeverage,
      onlyIsolated: raw.onlyIsolated !== false,
      makerFee: 0,                      // HL maker 费用（通常 0.00035，perp 常为 0）
      takerFee: 0,
      raw,
    });
  }
  return out.sort((a, b) => Number(b.raw?.openInterest || 0) - Number(a.raw?.openInterest || 0));
}

export function parseCandles(data) {
  const rows = Array.isArray(data?.candles) ? data.candles : [];
  return rows.map((row) => ({
    time: normalizeEpochMs(row.t),
    open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c), volume: Number(row.v || 0),
  })).filter((row) => row.time > 0 && Number.isFinite(row.close)).sort((a, b) => a.time - b.time);
}

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

function normalizeEpochMs(value) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  if (timestamp < 100_000_000_000) timestamp *= 1000;       // seconds
  else if (timestamp >= 100_000_000_000_000_000) timestamp /= 1_000_000; // ns
  else if (timestamp >= 100_000_000_000_000) timestamp /= 1000;           // us
  return Math.trunc(timestamp);
}