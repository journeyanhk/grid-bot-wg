export const RHC_API_URL = 'https://api.rh.lighter.xyz';
export const RHC_WS_URL = 'wss://api.rh.lighter.xyz/stream';
export const RHC_CHAIN_ID = 466324;
export const RHC_MAX_CLIENT_ORDER_INDEX = 2 ** 48 - 1;

export const CANDLE_RESOLUTIONS = new Map([
  [60, '1m'], [300, '5m'], [900, '15m'], [1800, '30m'],
  [3600, '1h'], [14400, '4h'], [43200, '12h'],
  [86400, '1d'], [604800, '1w'],
]);

export function parseMarkets(data) {
  const rows = Array.isArray(data?.order_book_details) ? data.order_book_details : [];
  const out = [];
  for (const raw of rows) {
    if (String(raw.market_type || 'perp').toLowerCase() !== 'perp') continue;
    if (String(raw.status || '').toLowerCase() !== 'active') continue;
    const marketId = Number(raw.market_id);
    const sizeDecimals = Number(raw.supported_size_decimals ?? raw.size_decimals ?? 0);
    const priceDecimals = Number(raw.supported_price_decimals ?? raw.price_decimals ?? 0);
    const imf = Number(raw.min_initial_margin_fraction || raw.default_initial_margin_fraction || 0);
    const lastPrice = Number(raw.last_trade_price || 0);
    const symbol = String(raw.symbol || '').toUpperCase();
    if (!Number.isInteger(marketId) || !symbol || sizeDecimals < 0 || priceDecimals < 0) continue;
    out.push({
      marketId,
      name: `${symbol}-USD`,
      displayName: `${symbol}-USD`,
      symbol,
      status: raw.status,
      lastPrice,
      stepSize: 10 ** -sizeDecimals,
      stepPrice: 10 ** -priceDecimals,
      sizeDecimals,
      priceDecimals,
      minOrderSize: Number(raw.min_base_amount || 10 ** -sizeDecimals),
      minOrderNotional: Number(raw.min_quote_amount || 0),
      maxOrderSize: Infinity,
      maxLeverage: imf > 0 ? Math.max(1, Math.floor(10_000 / imf)) : 50,
      makerFee: Number(raw.maker_fee || 0),
      takerFee: Number(raw.taker_fee || 0),
      raw,
    });
  }
  return out.sort((a, b) => Number(b.raw?.open_interest || 0) - Number(a.raw?.open_interest || 0));
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

export function parseCandles(data) {
  const rows = Array.isArray(data?.c) ? data.c : [];
  return rows.map((row) => ({
    // Browser Date/Chart consumers use milliseconds. RHC candle timestamps
    // have appeared as either seconds or milliseconds, so normalize both here
    // instead of letting a seconds value render as January 1970.
    time: normalizeEpochMs(row.t),
    open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c), volume: Number(row.v || 0),
  })).filter((row) => row.time > 0 && Number.isFinite(row.close)).sort((a, b) => a.time - b.time);
}

export function makeClientOrderIndex(seed = 0) {
  // RHC encodes ClientOrderIndex as uint48. Use 41 bits of wall-clock
  // milliseconds plus 7 sequence bits: unique for 128 orders in one
  // millisecond, restart-safe in practice, and always <= 2^48 - 1.
  const timePart = BigInt(Date.now()) & ((1n << 41n) - 1n);
  const numericSeed = Number(seed);
  const safeSeed = Number.isFinite(numericSeed) ? Math.abs(Math.trunc(numericSeed)) : 0;
  const sequencePart = BigInt(safeSeed % 128);
  return Number((timePart << 7n) | sequencePart);
}

function normalizeEpochMs(value) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  if (timestamp < 100_000_000_000) timestamp *= 1000;       // seconds
  else if (timestamp >= 100_000_000_000_000_000) timestamp /= 1_000_000; // ns
  else if (timestamp >= 100_000_000_000_000) timestamp /= 1000;           // us
  return Math.trunc(timestamp);
}
