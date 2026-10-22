// Arcus market metadata, response parsers and startup guards.
//
// Everything here is a PURE function of an HTTP payload or a market object, so
// the ambiguous parts of the Arcus contract live in one place and are covered by
// test/ar.test.js. When a live payload turns out to differ, the fix belongs in
// this file and its test — never sprinkled through the adapter.
//
// Contract facts this file encodes (verified against docs.arcus.xyz and the
// live /v1/markets payload on 2026-10-22):
//   - markets carry string decimals + tickTiers; fee fields are ppm, not bps
//   - max leverage has to be derived from initialMarginFraction (0.025 → 40x)
//   - 42 of 70 markets are stock perps with regularTradingHours (off-hours
//     price bands) — a 24/7 grid must stay off them
//   - candles are ORACLE-derived (not trade-derived) and keyed by `openTime` in
//     epoch MICROSECONDS, with a `timeframe` parameter (not `resolution`)
//   - IDs/timestamps arrive in µs or ns depending on the endpoint

export const AR_CRYPTO_CATEGORY = 'CRYPTO';

/** Coerce to a finite number, else `fallback`. */
function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalize the several epoch units Arcus uses into milliseconds.
 * Since the first digit is indistinguishable between µs and ns (both 19 digits
 * at present), this thresholds on magnitude — good until the year 2286.
 */
export function normalizeEpochMs(value) {
  const t = Number(value);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (t < 1e11) return Math.trunc(t * 1000);        // seconds
  if (t >= 1e17) return Math.trunc(t / 1e6);        // nanoseconds
  if (t >= 1e14) return Math.trunc(t / 1000);       // microseconds
  return Math.trunc(t);                            // already milliseconds
}

/** Parse `GET /v1/markets` into the adapter's Market shape. */
export function parseMarkets(payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.markets ?? []);
  // An empty list is legitimate; a missing `markets` key is not — it means the
  // response shape changed and we would silently trade on zero markets.
  if (!Array.isArray(payload) && !Array.isArray(payload?.markets)) {
    throw new Error('markets 响应缺少 markets 数组，契约可能已变更。');
  }
  return rows.map((m) => {
    const tickSize = String(m.tickSize ?? '');
    const stepSizeStr = String(m.stepSize ?? '');
    const imf = num(m.initialMarginFraction, 0);
    const market = {
      marketId: Number(m.marketId),
      displayName: m.marketDisplayName || `${m.baseAsset}-${m.quoteAsset}`,
      // Arcus addresses markets by ticker everywhere outside /v1/markets
      // (`/v1/bbo/BTC-USD`, `?market=BTC-USD`, WS `id`), so the ticker is the
      // canonical handle — NOT the bare base asset (`BTC` is rejected).
      symbol: m.marketDisplayName || `${m.baseAsset}-${m.quoteAsset}`,
      status: m.status || null,
      lastPrice: num(m.markPrice ?? m.lastTradePrice, 0),
      // Decimals stay as strings: 1e-8 as a JS float is fine, but any string
      // comparison against the signed payload must not go through float.
      tickSize,
      stepSizeStr,
      stepPrice: num(tickSize, 0),          // contract name: price step
      stepSize: num(stepSizeStr, 0),        // contract name: size step
      minOrderSize: num(m.minOrderSize, 0),
      minOrderNotional: num(m.minOrderNotional, 0),
      maxOrderSize: num(m.maxOrderSize, Infinity),
      maxLeverage: imf > 0 ? Math.floor(1 / imf) : 1,
      makerFeePpm: num(m.effectiveMakerFeePpm ?? m.baseMakerFeePpm, null),
      takerFeePpm: num(m.effectiveTakerFeePpm ?? m.baseTakerFeePpm, null),
      category: m.category || null,
      hasTradingHours: Boolean(m.regularTradingHours),
      fundingRate: num(m.fundingRate, null),
      nextFundingAt: num(m.nextFundingAt, null),
      raw: m,
    };
    // Derive tradability here so the dashboard list, the default-market picker
    // and the order gate all read the SAME predicate — they used to disagree
    // (`tradable` was never set, so every market looked untradable).
    market.untradableReason = gridUntradableReason(market);
    market.tradable = !market.untradableReason;
    return market;
  });
}

/**
 * Refuse markets a 24/7 grid cannot safely run: stock perps have trading hours
 * and off-hours price bands, so a resting ladder would sit through gaps that the
 * band logic does not model.
 */
export function gridUntradableReason(market) {
  if (!market) return '未找到市场。';
  if (market.hasTradingHours) return `${market.displayName} 有交易时段（非 24/7），网格不支持；请选 CRYPTO 市场。`;
  if (market.category && market.category !== AR_CRYPTO_CATEGORY) return `${market.displayName} 类别为 ${market.category}，非 ${AR_CRYPTO_CATEGORY}，网格不支持。`;
  if (market.status && market.status !== 'ONLINE') return `${market.displayName} 状态为 ${market.status}，不可交易。`;
  if (!market.tickSize || !market.stepSizeStr) return `${market.displayName} 缺少 tickSize/stepSize，无法换算签名整数。`;
  return null;
}

export function assertGridTradable(market) {
  const reason = gridUntradableReason(market);
  if (reason) throw new Error(reason);
  return true;
}

/**
 * The whole strategy is premised on zero maker fees: one grid is worth ~1 cent,
 * so a single ppm of maker fee is a meaningful share of the edge. Fail fast.
 */
export function assertMakerFree(market) {
  if (market?.makerFeePpm == null) return true; // unknown: adapter logs a warning
  if (market.makerFeePpm > 0) {
    throw new Error(`${market.displayName} maker 费 ${market.makerFeePpm} ppm 超过上限 0 ppm（网格毛利约 1 美分/格），拒绝启动。`);
  }
  return true;
}

/** Parse `GET /v1/candles` payload (`bars` or `candles`). */
export function parseCandles(payload) {
  const rows = Array.isArray(payload) ? payload
    : (payload?.bars ?? payload?.candles ?? payload?.data ?? []);
  return rows
    .map((c) => ({
      time: normalizeEpochMs(c.openTime ?? c.time ?? c.t),
      open: num(c.open, NaN),
      high: num(c.high, NaN),
      low: num(c.low, NaN),
      close: num(c.close, NaN),
      volume: num(c.volume ?? c.takerVolume, 0),
    }))
    .filter((c) => c.time > 0 && Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

const TIMEFRAMES = [
  ['1w', 604800], ['1d', 86400], ['12h', 43200], ['8h', 28800],
  ['4h', 14400], ['1h', 3600], ['30m', 1800], ['15m', 900], ['5m', 300], ['1m', 60],
];

/**
 * Arcus takes a `timeframe` token, not a second count. Non-standard intervals
 * (e.g. the dynamic grid's 7200s) degrade to the largest token that divides them,
 * which keeps an ATR computation alive instead of throwing.
 */
export function timeframeFor(intervalSec) {
  const sec = Math.max(60, Math.round(Number(intervalSec) || 3600));
  const exact = TIMEFRAMES.find(([, s]) => s === sec);
  if (exact) return exact[0];
  const divisor = TIMEFRAMES.find(([, s]) => sec % s === 0);
  return divisor ? divisor[0] : '1h';
}

/**
 * Shared row reader. Arcus has shipped both snake_case and camelCase, and the
 * docs' examples are static placeholders, so accept the documented names first
 * and fail with the actual key list — that message is what makes D3 debuggable.
 */
function pick(row, names) {
  for (const n of names) if (row?.[n] != null && row[n] !== '') return row[n];
  return undefined;
}

function readOrderRow(row) {
  const orderId = pick(row, ['orderId', 'order_id', 'id']);
  const price = pick(row, ['price']);
  // Arcus 的挂单/成交行用 originalSize / remainingSize / filledSize，
  // 没有 quantity/size。挂单以 remainingSize 为准（部分成交后剩余量）。
  const qty = pick(row, ['quantity', 'size', 'qty', 'remainingSize', 'originalSize', 'filledSize']);
  if (orderId == null || price == null || qty == null) {
    throw new Error(`挂单行缺少 orderId/price/quantity（实际字段：${Object.keys(row || {}).join(',')}）`);
  }
  const sideRaw = String(pick(row, ['side', 'direction', 'orderSide']) || '').toUpperCase();
  return {
    orderId: String(orderId),
    marketId: Number(pick(row, ['marketId', 'market_id', 'market']) ?? 0),
    side: sideRaw.startsWith('B') ? 'buy' : 'sell',
    price: Number(price),
    sizeBase: Number(qty),
    filledSize: num(pick(row, ['filledSize', 'filled_size']), 0),
    remainingSize: num(pick(row, ['remainingSize', 'remaining_size']), null),
    reduceOnly: Boolean(pick(row, ['reduceOnly', 'reduce_only'])),
    clientOrderId: pick(row, ['clientId', 'clientOrderId', 'client_order_id']) ?? null,
    status: pick(row, ['status']) ?? null,
    role: pick(row, ['role', 'liquidity']) ?? null,
    fee: num(pick(row, ['fee', 'feeAmount']), null),
    createdAt: normalizeEpochMs(pick(row, ['createdAt', 'created_at', 'timestamp']) ?? 0),
    raw: row,
  };
}

function rowsOf(payload, keys) {
  if (Array.isArray(payload)) return payload;
  for (const k of keys) {
    const v = payload?.[k];
    if (Array.isArray(v)) return v;
    // Arcus 的 /v1/positions 回的是按 marketId 键的对象（{"positions":{"1":{...}}}），
    // 只认数组会把有仓当成没仓——平仓、离场判定全都会静默跳过。
    if (v && typeof v === 'object') return Object.values(v);
  }
  return [];
}

/** Parse `GET /v1/openOrders`. */
export function parseOpenOrders(payload) {
  return rowsOf(payload, ['orders', 'openOrders', 'data']).map(readOrderRow);
}

/** Parse `GET /v1/fills` (newest-first from the server; caller re-sorts). */
export function parseFills(payload) {
  return rowsOf(payload, ['fills', 'data']).map((row) => {
    const base = readOrderRow({ ...row, status: row.status });
    return {
      ...base,
      isFill: true,
      createdAt: normalizeEpochMs(pick(row, ['createdAt', 'created_at', 'timestamp']) ?? 0),
      fee: num(pick(row, ['fee', 'feeAmount']), null),
    };
  }).sort((a, b) => a.createdAt - b.createdAt);
}

/** Parse `GET /v1/positions`. Shorts come back as a negative `sizeBase`. */
export function parsePositions(payload) {
  return rowsOf(payload, ['positions', 'data']).map((row) => {
    const size = Number(pick(row, ['size', 'quantity', 'sizeBase']) ?? 0);
    const sideRaw = String(pick(row, ['side', 'direction']) || '').toUpperCase();
    const signed = sideRaw ? (sideRaw.startsWith('S') ? -Math.abs(size) : Math.abs(size)) : size;
    return {
      marketId: Number(pick(row, ['marketId', 'market_id', 'market']) ?? 0),
      sizeBase: signed,
      // Arcus 用 averageEntryPrice；不补这一个别名，entryPrice 永远是 null，
      // 离场/回收梯就失去了成本基准。
      entryPrice: num(pick(row, ['averageEntryPrice', 'entryPrice', 'entry_price']), null),
      markPrice: num(pick(row, ['markPx', 'markPrice']), null),
      unrealizedPnl: num(pick(row, ['unrealizedPnl', 'unrealized_pnl']), null),
      marginUsed: num(pick(row, ['marginUsed', 'margin_used']), null),
      leverage: num(pick(row, ['leverage']), null),
      liquidationPrice: num(pick(row, ['liquidationPrice', 'liquidation_price']), null),
      marginMode: pick(row, ['marginMode', 'margin_mode']) ?? null,
      raw: row,
    };
  });
}

/** Parse `GET /v1/account` (equity / free collateral / balance). */
export function parseAccount(payload) {
  const obj = (payload && typeof payload === 'object' && 'equity' in payload)
    ? payload
    : (payload?.data ?? payload?.account ?? {});
  return {
    equity: num(pick(obj, ['equity', 'accountEquity', 'totalEquity']), null),
    balance: num(pick(obj, ['netQuoteBalance', 'balance', 'accountValue', 'collateral']), null),
    freeCollateral: num(pick(obj, ['freeCollateral', 'availableBalance', 'available']), null),
    marginUsed: num(pick(obj, ['marginUsed', 'totalMarginUsed']), null),
    unrealizedPnl: num(pick(obj, ['unrealizedPnl', 'unrealized_pnl']), null),
    realizedPnl: num(pick(obj, ['realizedPnl', 'realized_pnl']), null),
    raw: payload,
  };
}

// Arcus mainnet/testnet chain ids (EIP-712 domain for one-off key registration;
// kept here so the probe and the docs cross-check against one constant).
export const AR_MAINNET_CHAIN_ID = 4663;
export const AR_TESTNET_CHAIN_ID = 46630;

/** Resolve the REST base: explicit value wins, otherwise the network default. */
export function normalizeBase(apiUrl, network) {
  const raw = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (raw) return raw;
  return network === 'testnet' ? 'https://api.testnet.arcus.xyz' : 'https://api.arcus.xyz';
}

/**
 * Resolve the WebSocket URL. The path is always `/v1/ws`, so accept either the
 * bare host or the full endpoint — an operator who pastes the docs URL must not
 * end up at `wss://…/v1/ws/v1/ws`.
 */
export function normalizeWs(wsUrl, apiUrl) {
  const raw = String(wsUrl || '').trim().replace(/\/+$/, '');
  if (raw) {
    if (raw.endsWith('/v1/ws')) return raw;
    // Only a bare origin gets the standard path appended; an explicit custom
    // path is taken as-is so a proxy/gateway URL still works.
    const path = raw.replace(/^wss?:\/\/[^/]+/i, '');
    return path === '' ? `${raw}/v1/ws` : raw;
  }
  const base = String(apiUrl || '').trim().replace(/\/+$/, '').replace(/^http/i, 'ws');
  return `${base}/v1/ws`;
}

/**
 * First open order from either an envelope (`{orders:[…]}`) or a bare row.
 *
 * The bare-row form matters: adapters iterate the envelope's rows one by one.
 * Treating a row as if it were an envelope silently yields "no orders", which
 * reads downstream as "everything was filled/cancelled".
 */
export function parseOpenOrder(payload) {
  const first = parseOpenOrders(payload)[0];
  if (first) return first;
  const isRow = payload && typeof payload === 'object' && !Array.isArray(payload)
    && (payload.orderId != null || payload.order_id != null);
  return isRow ? readOrderRow(payload) : null;
}
