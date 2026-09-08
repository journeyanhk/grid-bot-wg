// Variational Omni (VA) adapter tests.
//
// Covers the two things that make this adapter different from the guess-based
// RISEx template: (1) pure parsers against capture-shaped payloads, and (2) the
// POSITIVE-confirmation fill state machine — cleared→fill, failed_risk_checks→
// reject, canceled(local)→silent, canceled(remote)→error, the cancel-vs-fill
// race, fail-closed when terminal rows can't be read — PLUS the five review-driven
// boundary fixes: soft-forget late fills, created_at windowing, pagination,
// internal-close no-fill, and fail-closed position parsing.
import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import {
  instrumentFor, instrumentKey, parseSupportedAsset, parseOrderRow, parseTrade, parsePortfolio,
  parsePosition, parseIndicative, unwrapResult, roundQty, roundPrice, formatStep, isFilled, isCanceled,
} from '../src/exchange/va/market.js';
import { VariationalExchange } from '../src/exchange/va/variational.js';

// ── A controllable in-memory HTTP double (matches VaHttpClient's surface) ───
class MockHttp {
  constructor() {
    this.price = 60000;
    this.pending = [];
    this.history = [];
    this.historyByOffset = null; // { 0:[...], 100:[...] } to exercise pagination
    this.trades = [];
    this.portfolio = { balance: 1000, upnl: 0, sub_accounts: { cross_available: 900 } };
    this.positions = []; // BARE ARRAY (confirmed real shape)
    this.failHistory = false;
    this.posted = [];
    this._seq = 1000;
    this.lastHistoryPath = null;
    // A realistic indicative response (drives init precision/leverage + closePosition).
    this.indicative = {
      quote_id: 'q-1', bid: '59990', ask: '60010', mark_price: '60000', index_price: '60000',
      qty_limits: { bid: { min_qty_tick: '0.000001', min_qty: '0.000002', max_qty: '1000' }, ask: { min_qty_tick: '0.000001', min_qty: '0.000002', max_qty: '1000' } },
      margin_params: { params: { asset_params: { BTC: { futures_initial_margin: '0.02' } } } },
      margin_requirements: { bid_max_notional_delta: '6900', ask_max_notional_delta: '6900' },
    };
  }
  hasToken() { return true; }
  setToken() {}
  async supportedAssets(u) {
    return { [u]: [{ price: this.price, index_price: this.price, instrument_type: 'perpetual_future', market_status: 'open', max_leverage: 50, funding_interval_s: 28800 }] };
  }
  async get(path) {
    if (path.includes('/api/portfolio')) return this.portfolio;
    if (path.includes('/api/positions')) return this.positions;
    if (path.includes('/api/trades')) return { result: this.trades };
    if (path.includes('status=pending')) return { result: this.pending };
    // Anything else on orders/v2 is a terminal-window (created_at_gte) query.
    this.lastHistoryPath = path;
    if (this.failHistory) throw new Error('history 503');
    if (this.historyByOffset) {
      const off = Number((path.match(/offset=(\d+)/) || [])[1] || 0);
      const maxOff = Math.max(...Object.keys(this.historyByOffset).map(Number));
      return { result: this.historyByOffset[off] || [], pagination: { next_page: off < maxOff ? 'next' : null } };
    }
    return { result: this.history };
  }
  async post(path, body) {
    this.posted.push({ path, body });
    if (path.includes('orders/new/limit')) return { rfq_id: String(this._seq++) };
    if (path.includes('quotes/indicative')) return this.indicative;
    if (path.includes('quotes/accept')) return { rfq_id: String(this._seq++) };
    if (path.includes('orders/cancel')) return null; // real API: HTTP 2xx + body null
    if (path.includes('set_leverage')) return { current: body.leverage, max: 50 };
    return {};
  }
  warnOnce() {}
}

const mkEx = (http) => new VariationalExchange({ underlyings: ['BTC'], leverage: 0, http });
const collect = (ex) => { const ev = { fills: [], errors: [] }; ex.on('fill', (f) => ev.fills.push(f)); ex.on('error', (e) => ev.errors.push(e)); return ev; };
const pendRow = (rfq, extra = {}) => ({ rfq_id: rfq, order_type: 'limit', side: 'buy', limit_price: '58000', qty: '0.001', status: 'pending', instrument: { underlying: 'BTC' }, ...extra });

// ─────────────────────────────────────────────────────────────────────────
// ① Pure parsers
{
  const snap = parseSupportedAsset({ BTC: [{ price: '58496.84', index_price: '58490.0', max_leverage: 50, funding_interval_s: 28800 }] }, 'BTC');
  assert.equal(snap.price, 58496.84);
  assert.equal(snap.maxLeverage, 50);
  assert.equal(snap.fundingWindowS, 28800, 'metadata reports the 28800 settlement window');
}
{
  const inst = instrumentFor('BTC', {});
  assert.equal(inst.funding_interval_s, 3600, 'order identity uses 3600, not metadata 28800');
  assert.equal('kind' in inst, false, 'BTC perp must not carry kind');
  assert.equal(instrumentKey('BTC', {}), 'P-BTC-USDC-3600', 'instrument identity string');
  const rwa = instrumentFor('AAPL', { kind: 'rwa', fundingIntervalS: 86400 });
  assert.equal(rwa.kind, 'rwa');
  assert.equal(rwa.funding_interval_s, 86400);
}
{
  const row = parseOrderRow({ rfq_id: 42, order_id: 999, status: 'CLEARED', side: 'BUY', order_type: 'limit', limit_price: '58000', qty: '0.001', failed_risk_checks: [], instrument: { underlying: 'BTC' } });
  assert.equal(row.rfqId, '42');
  assert.equal(row.orderId, '999');
  assert.ok(isFilled(row.status));
  assert.equal(row.underlying, 'BTC');
  const tr = parseTrade({ id: 7, source_rfq: 42, price: '58001.5', qty: '0.001', side: 'buy' });
  assert.equal(tr.rfqId, '42', 'trade keyed back to order via source_rfq');
  assert.equal(tr.price, 58001.5);
}
{
  const port = parsePortfolio({ balance: '1000', upnl: '12.5', sub_accounts: { cross_available: '900' } });
  assert.equal(port.balance, 1000);
  assert.equal(port.equity, 1012.5, 'equity = balance + upnl');
  assert.equal(port.available, 900);
  assert.equal(unwrapResult({ result: [1, 2] }).length, 2);
  // Three-state parsePosition against the confirmed bare-array shape.
  const pr = parsePosition([{ position_info: { instrument: { underlying: 'BTC' }, qty: '-0.5', avg_entry_price: '60000', last_local_sequence: 3 }, upnl: '-1.2', price_info: { price: '60010' }, rpnl: '0' }], 'BTC');
  assert.ok(pr.ok && pr.pos, 'readable position');
  assert.equal(pr.pos.sizeBase, -0.5, 'qty is already signed (short negative)');
  assert.equal(pr.pos.entryPrice, 60000);
  assert.equal(pr.pos.unrealizedPnl, -1.2, 'upnl read from OUTER level');
  const flat = parsePosition([], 'BTC');
  assert.ok(flat.ok && flat.pos === null, 'empty array -> genuinely flat');
  const bad = parsePosition({ not: 'array' }, 'BTC');
  assert.equal(bad.ok, false, 'non-array -> unreadable (fail-closed), never a fabricated zero');
}
{
  const ind = parseIndicative({ quote_id: 'x', bid: '10', ask: '11', mark_price: '10.5', qty_limits: { bid: { min_qty_tick: '0.000001', min_qty: '0.000002' } }, margin_params: { params: { asset_params: { BTC: { futures_initial_margin: '0.02' } } } }, margin_requirements: { bid_max_notional_delta: '6900' } });
  assert.equal(ind.quoteId, 'x');
  assert.equal(ind.minQty, 0.000002);
  assert.equal(ind.maxLeverage, 50, '1/0.02 = 50x');
  assert.equal(ind.maxNotionalBid, 6900);
}
{
  assert.equal(roundQty(0.0017095, 0.000001), 0.001709);
  assert.ok(Math.abs(roundPrice(58496.843, 0.01) - 58496.84) < 1e-6);
  assert.equal(formatStep(0.001709, 0.000001), '0.001709');
  assert.ok(isCanceled('CANCELED'));
}

// ─────────────────────────────────────────────────────────────────────────
async function ready(http) {
  const ex = mkEx(http);
  const ev = collect(ex);
  await ex.init();
  ex.stop(); // drive _refreshOrders manually; no background polling
  return { ex, ev };
}

// ② cleared -> fill (row.price is the actual fill)
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 58000, sizeBase: 0.001, levelIndex: 3 });
  http.pending = [pendRow(orderId)];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0, 'resting order does not fill');
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'cleared', side: 'buy', qty: '0.001', price: '58000', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  http.trades = [{ id: 1, source_rfq: orderId, price: '58001.25', qty: '0.001', side: 'buy' }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 1, 'cleared -> exactly one fill');
  assert.equal(ev.fills[0].price, 58000, 'fill price comes from the order row (actual fill)');
  assert.equal(ev.fills[0].levelIndex, 3);
  assert.equal(ex.getOpenOrders(1).length, 0, 'filled order removed from tracking');
}

// ③ failed_risk_checks -> reject (error carries `reject`, no fill, counter++)
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'sell', price: 62000, sizeBase: 0.001, levelIndex: 5 });
  http.pending = [pendRow(orderId, { side: 'sell', limit_price: '62000' })];
  await ex._refreshOrders();
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'canceled', side: 'sell', qty: '0.001', failed_risk_checks: ['max_position'], instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0, 'rejected order never fills');
  assert.equal(ex.rejectedOrders, 1, 'reject counter incremented');
  assert.ok(ev.errors.some((e) => /reject/i.test(e.message)), 'reject error carries the bot back-off keyword');
}

// ④ canceled by US -> silent
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 57000, sizeBase: 0.001, levelIndex: 1 });
  http.pending = [pendRow(orderId, { limit_price: '57000' })];
  await ex._refreshOrders();
  await ex.cancelOrder(1, orderId);
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'canceled', side: 'buy', qty: '0.001', cancel_reason: 'user_cancel', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0);
  assert.equal(ev.errors.length, 0, 'our own cancel is silent');
  assert.equal(ex.getOpenOrders(1).length, 0);
}

// ⑤ canceled REMOTELY -> error
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 57000, sizeBase: 0.001, levelIndex: 2 });
  http.pending = [pendRow(orderId, { limit_price: '57000' })];
  await ex._refreshOrders();
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'canceled', side: 'buy', qty: '0.001', cancel_reason: 'olp_reject', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0);
  assert.ok(ev.errors.some((e) => /非本地撤销/.test(e.message)), 'remote cancel raises an error');
}

// ⑥ cancel-vs-fill RACE -> fill wins
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 58000, sizeBase: 0.001, levelIndex: 4 });
  http.pending = [pendRow(orderId)];
  await ex._refreshOrders();
  await ex.cancelOrder(1, orderId);
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'cleared', side: 'buy', qty: '0.001', price: '58000', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 1, 'a cleared order fills even if we tried to cancel');
  assert.equal(ev.errors.length, 0);
}

// ⑦ fail-closed: terminal rows unreadable -> resolve nothing
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 58000, sizeBase: 0.001, levelIndex: 0 });
  http.pending = [pendRow(orderId)];
  await ex._refreshOrders();
  http.pending = [];
  http.failHistory = true;
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0, 'never fabricate a fill when the terminal row is unreadable');
  assert.equal(ex.getOpenOrders(1).length, 1, 'order stays tracked (fail-closed)');
  assert.ok(ex.operationalIssue, 'an operational issue is surfaced');
}

// ⑧ SOFT-FORGET: mid-cancel + bot forgetOrder, then cleared -> NO grid fill, lateFills++
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 58000, sizeBase: 0.001, levelIndex: 7 });
  http.pending = [pendRow(orderId)];
  await ex._refreshOrders();          // seen
  await ex.cancelOrder(1, orderId);   // canceling = true
  ex.forgetOrder(orderId);            // bot drops the level -> soft-forget (kept)
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'cleared', side: 'buy', qty: '0.001', price: '58000', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0, 'a fill during cancel is NOT re-emitted onto the (already dropped) grid level');
  assert.equal(ex.lateFills, 1, 'counted as a late fill');
  assert.ok(ev.errors.some((e) => /撤单期间已成交/.test(e.message)), 'operator warned that inventory changed');
}

// ⑨ created_at WINDOW: adopted order (created ~1h ago) resolves in the correct window
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const oldCreated = new Date(Date.now() - 3600_000).toISOString();
  ex.adoptOrder({ orderId: 'AA', marketId: 1, levelIndex: 9, side: 'buy', price: 58000, sizeBase: 0.001, createdAt: oldCreated });
  http.pending = [pendRow('AA', { created_at: oldCreated })];
  await ex._refreshOrders();          // seen; createdAt already carried from adopt
  http.pending = [];
  http.history = [{ rfq_id: 'AA', status: 'cleared', side: 'buy', qty: '0.001', price: '58050', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  const gte = Date.parse(decodeURIComponent((http.lastHistoryPath.match(/created_at_gte=([^&]+)/) || [])[1]));
  assert.ok(gte < Date.now() - 50 * 60_000, 'terminal window anchored to the order created_at (~1h ago), not placedAt(now)');
  assert.equal(ev.fills.length, 1, 'fill resolved because the window reached back far enough');
}

// ⑩ PAGINATION: target terminal row sits on page 2 -> must page through and find it
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 58000, sizeBase: 0.001, levelIndex: 11 });
  http.pending = [pendRow(orderId)];
  await ex._refreshOrders();
  http.pending = [];
  http.historyByOffset = {
    0: [{ rfq_id: 'noise', status: 'cleared', side: 'buy', qty: '0.001', price: '1', failed_risk_checks: [], instrument: { underlying: 'BTC' } }],
    100: [{ rfq_id: orderId, status: 'cleared', side: 'buy', qty: '0.001', price: '58000', failed_risk_checks: [], instrument: { underlying: 'BTC' } }],
  };
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 1, 'found the terminal row on page 2 via pagination');
}

// ⑪ INTERNAL close (indicative→accept) -> never re-emitted as a grid fill
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  http.positions = [{ position_info: { instrument: { underlying: 'BTC' }, qty: '0.001', avg_entry_price: '60000', last_local_sequence: 1 }, upnl: '0', price_info: { price: '60000' } }];
  await ex._refreshAccount();
  assert.ok(ex.getPosition(1), 'position present before close');
  await ex.closePosition(1);
  assert.ok(http.posted.some((p) => p.path.includes('quotes/indicative')), 'closePosition asked for an indicative quote');
  assert.ok(http.posted.some((p) => p.path.includes('quotes/accept')), 'closePosition accepted the quote');
  const internalId = [...ex._tracked.keys()].at(-1);
  ex._tracked.get(internalId).placedAt = Date.now() - 10_000; // past grace so it counts as gone
  http.pending = [];
  http.history = [{ rfq_id: internalId, status: 'cleared', side: 'sell', qty: '0.001', price: '60000', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0, 'internal close does NOT emit a grid fill');
  assert.equal(ex._tracked.size, 0, 'internal order cleared from tracking');
}

// ⑫ POSITION fail-closed: unreadable positions keep the last known position
{
  const http = new MockHttp();
  const { ex } = await ready(http);
  http.positions = [{ position_info: { instrument: { underlying: 'BTC' }, qty: '0.002', avg_entry_price: '60000', last_local_sequence: 2 }, upnl: '1', price_info: { price: '60010' } }];
  await ex._refreshAccount();
  assert.equal(ex.getPosition(1)?.sizeBase, 0.002, 'position read');
  http.positions = { garbage: true }; // unreadable
  ex.operationalIssue = null;
  await ex._refreshAccount();
  assert.equal(ex.getPosition(1)?.sizeBase, 0.002, 'unreadable positions keep the last known position');
  assert.ok(ex.operationalIssue, 'unreadable positions surface an issue');
}

// JWT exp decode is exercised implicitly (MockHttp has no token field -> null exp -> no throw).
void Buffer;

console.log('✓ va.test.js 全部通过');
