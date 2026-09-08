// Variational Omni market/instrument helpers + response parsers.
//
// Pure functions only — no network, no state — so they can be unit-tested
// against the real captured payloads (see test/va.test.js). All the tricky
// Omni-specific knowledge lives here so the adapter stays readable.
//
// THREE THINGS THAT WILL BITE YOU (pinned from the real 2026-09-08 capture):
//   1. instrument.funding_interval_s = 3600 is the INSTRUMENT IDENTITY that the
//      order body + pending echo use. metadata's supported_assets reports 28800,
//      which is the funding *settlement window* — putting 28800 into an order
//      builds a contract that does not exist. Never source the identity from
//      metadata. (rbh-hedge-var's _instrument_meta() does exactly that and is
//      wrong for BTC.)
//   2. One order carries TWO ids. rfq_id is the key for place/cancel and for
//      trades.source_rfq; order_id is only a history-row primary key. The
//      adapter tracks everything by rfq_id.
//   3. A BTC perp instrument has NO kind field (only RWA assets do). Adding a
//      stray kind changes the identity, so it is only attached when configured.

export const VA_BASE_URL = 'https://omni.variational.io';

export const DEFAULT_UNDERLYINGS = ['BTC'];

// Precision + limits are NOT published by supported_assets, so they come from
// config with conservative defaults. These MUST be confirmed against the live
// exchange (M0 experiment: binary-search min qty / tick) before scaling size.
export const DEFAULT_PRECISION = {
  stepSize: 0.000001,   // qty increment (capture showed 6dp: "0.001709")
  stepPrice: 0.01,      // price increment (capture showed 2dp: "58496.84")
  minOrderSize: 0.0001, // minimum base qty — UNVERIFIED, keep small and safe
  maxLeverage: 50,      // set_leverage response reported max 50
};

// intervalSec -> Omni candle period string. Unlisted periods fall back to 1h.
const CANDLE_PERIODS = new Map([
  [60, '1m'], [300, '5m'], [900, '15m'], [1800, '30m'],
  [3600, '1h'], [14400, '4h'], [86400, '1d'],
]);
export function candlePeriod(intervalSec) {
  return CANDLE_PERIODS.get(Number(intervalSec)) || '1h';
}

// Terminal order states from orders/v2 (confirmed against the capture):
//   pending  -> still resting
//   cleared  -> FILLED (all-or-nothing; success_trades_booked_into_pool)
//   canceled -> cancelled (cancel_reason=user_cancel, ...)
// A non-empty failed_risk_checks[] means the OLP/user risk limit rejected it.
export function isFilled(status) { return String(status).toLowerCase() === 'cleared'; }
export function isCanceled(status) { return String(status).toLowerCase() === 'canceled'; }
export function isPending(status) { return String(status).toLowerCase() === 'pending'; }

export function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the instrument identity object for an order body.
 * cfg: { instrumentType, settlementAsset, fundingIntervalS, kind }
 */
export function instrumentFor(underlying, cfg = {}) {
  const inst = {
    underlying,
    instrument_type: cfg.instrumentType || 'perpetual_future',
    settlement_asset: cfg.settlementAsset || 'USDC',
    funding_interval_s: cfg.fundingIntervalS ?? 3600, // IDENTITY, not the 28800 window
  };
  if (cfg.kind) inst.kind = cfg.kind; // RWA only; BTC perp must NOT carry kind
  return inst;
}

/**
 * supported_assets?cex_asset=BTC -> a compact snapshot for one underlying.
 * Response shape: { "BTC": [ { price, index_price, instrument_type, ... } ] }.
 * Returns null if the underlying is absent (fail-closed; never fabricate).
 */
export function parseSupportedAsset(json, underlying) {
  const arr = json?.[underlying];
  const row = Array.isArray(arr) ? arr[0] : (arr && typeof arr === 'object' ? arr : null);
  if (!row) return null;
  const price = numOrNull(row.price) ?? numOrNull(row.index_price);
  if (price == null) return null;
  return {
    underlying,
    price,
    indexPrice: numOrNull(row.index_price) ?? price,
    instrumentType: row.instrument_type || 'perpetual_future',
    marketStatus: row.market_status || 'unknown',
    isCloseOnly: !!row.is_close_only_mode,
    isIsolable: !!row.is_isolable,
    fundingRate: numOrNull(row.funding_rate),
    // NOTE: this is the 28800 settlement window, NOT the order-identity 3600.
    fundingWindowS: numOrNull(row.funding_interval_s),
    maxLeverage: numOrNull(row.max_leverage),
  };
}

/** candles?period=1h -> [{time(ms), open, high, low, close, volume}]. */
export function parseCandles(json) {
  const arr = Array.isArray(json) ? json : (Array.isArray(json?.result) ? json.result : []);
  return arr
    .map((c) => ({
      time: Number(c.unix_time_ms ?? c.time ?? 0),
      open: Number(c.open), high: Number(c.high), low: Number(c.low),
      close: Number(c.close), volume: Number(c.volume || 0),
    }))
    .filter((c) => Number.isFinite(c.close) && c.time > 0);
}

/** portfolio?compute_margin=true -> { balance, equity, available }. */
export function parsePortfolio(json) {
  if (!json || typeof json !== 'object') return null;
  const balance = numOrNull(json.balance);
  const upnl = numOrNull(json.upnl) ?? 0;
  const sub = json.sub_accounts || {};
  const available = numOrNull(sub.cross_available)
    ?? numOrNull(sub.cross_free_to_mm)
    ?? numOrNull(sub.cross?.balance)
    ?? balance;
  if (balance == null) return null;
  return { balance, equity: balance + upnl, available: available ?? balance, upnl };
}

/**
 * A single orders/v2 row -> normalized order.
 * The adapter keys everything by rfqId. price is the executed/mark price on a
 * cleared row; limitPrice is the resting limit. failedRiskChecks non-empty
 * or status=canceled are both terminal non-fills.
 */
export function parseOrderRow(row) {
  if (!row) return null;
  return {
    rfqId: row.rfq_id != null ? String(row.rfq_id) : null,
    orderId: row.order_id != null ? String(row.order_id) : null,
    status: String(row.status || '').toLowerCase(),
    side: String(row.side || '').toLowerCase(),
    orderType: row.order_type || null,
    limitPrice: numOrNull(row.limit_price),
    price: numOrNull(row.price),
    qty: numOrNull(row.qty),
    cancelReason: row.cancel_reason || null,
    clearingStatus: row.clearing_status || null,
    failedRiskChecks: Array.isArray(row.failed_risk_checks) ? row.failed_risk_checks : [],
    executionTimestamp: row.execution_timestamp || null,
    createdAt: row.created_at || null,
    underlying: row.instrument?.underlying || null,
    reduceOnly: !!row.is_reduce_only,
  };
}

/** Unwrap the paginated { result: [...] } envelope used by orders/v2 + trades. */
export function unwrapResult(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.result)) return json.result;
  return [];
}

/** A single trades row -> normalized fill (keyed back to the order by rfqId). */
export function parseTrade(row) {
  if (!row) return null;
  return {
    tradeId: row.id != null ? String(row.id) : null,
    rfqId: row.source_rfq != null ? String(row.source_rfq) : null,
    price: numOrNull(row.price),
    qty: numOrNull(row.qty),
    side: String(row.side || '').toLowerCase(),
    role: row.role || null,
    status: String(row.status || '').toLowerCase(),
    ts: row.created_at || null,
    underlying: row.instrument?.underlying || null,
  };
}

/**
 * Defensive parser for /api/positions. The exact shape was NOT in the capture
 * (WS pushed positions:[]), so this accepts several plausible shapes and returns
 * null when it cannot confidently read a signed size — NEVER a fabricated zero
 * that could mask a real position. Confirm the real shape in M1 and tighten.
 */
export function parsePosition(json, underlying) {
  const rows = unwrapResult(json?.positions ? { result: json.positions } : json);
  for (const raw of rows) {
    const info = raw?.position_info || raw; // rbh saw a nested position_info row
    const u = info?.instrument?.underlying || info?.underlying || raw?.underlying;
    if (u && String(u).toUpperCase() !== String(underlying).toUpperCase()) continue;
    const rawSize = numOrNull(info?.size) ?? numOrNull(info?.qty) ?? numOrNull(info?.position);
    if (rawSize == null) continue;
    let sizeBase = rawSize;
    const side = String(info?.side || '').toLowerCase();
    if (side === 'short' || side === 'sell') sizeBase = -Math.abs(rawSize);
    else if (side === 'long' || side === 'buy') sizeBase = Math.abs(rawSize);
    if (sizeBase === 0) return null;
    const entryPrice = numOrNull(info?.avg_entry_price) ?? numOrNull(info?.entry_price) ?? 0;
    const unrealizedPnl = numOrNull(info?.unrealized_pnl) ?? numOrNull(info?.upnl) ?? 0;
    return { sizeBase, entryPrice, unrealizedPnl };
  }
  return null;
}

/** Round a base quantity DOWN to the market step (never over-order). */
export function roundQty(qty, stepSize) {
  const step = Number(stepSize) || DEFAULT_PRECISION.stepSize;
  return Math.floor(Number(qty) / step) * step;
}
/** Round a price to the nearest tick. */
export function roundPrice(price, stepPrice) {
  const tick = Number(stepPrice) || DEFAULT_PRECISION.stepPrice;
  return Math.round(Number(price) / tick) * tick;
}
/** Format a number to the decimals implied by a step (avoids float tails in the body). */
export function formatStep(value, step) {
  const decimals = decimalsOf(step);
  return Number(value).toFixed(decimals);
}
function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}
