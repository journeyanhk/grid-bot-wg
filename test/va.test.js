// Variational Omni (VA) adapter tests.
//
// Covers the two things that make this adapter different from the guess-based
// RISEx template: (1) pure parsers against capture-shaped payloads, and (2) the
// POSITIVE-confirmation fill state machine — cleared→fill, failed_risk_checks→
// reject, canceled(local)→silent, canceled(remote)→error, the cancel-vs-fill
// race, and fail-closed when terminal rows can't be read.
import { strict as assert } from 'node:assert';
import {
  instrumentFor, parseSupportedAsset, parseOrderRow, parseTrade, parsePortfolio,
  parsePosition, unwrapResult, roundQty, roundPrice, formatStep, isFilled, isCanceled,
} from '../src/exchange/va/market.js';
import { VariationalExchange } from '../src/exchange/va/variational.js';

// ── A controllable in-memory HTTP double (matches VaHttpClient's surface) ───
class MockHttp {
  constructor() {
    this.price = 60000;
    this.pending = [];
    this.history = [];
    this.trades = [];
    this.portfolio = { balance: 1000, upnl: 0, sub_accounts: { cross_available: 900 } };
    this.positions = { positions: [] };
    this.failHistory = false;
    this.posted = [];
    this._seq = 1000;
  }
  hasToken() { return true; }
  setToken() {}
  async supportedAssets(u) {
    return { [u]: [{ price: this.price, index_price: this.price, instrument_type: 'perpetual_future', market_status: 'open', max_leverage: 50, funding_interval_s: 28800 }] };
  }
  async get(path) {
    if (path.includes('orders/v2?status=pending')) return { result: this.pending };
    if (path.includes('orders/v2?limit=')) {
      if (this.failHistory) throw new Error('history 503');
      return { result: this.history };
    }
    if (path.includes('/api/trades?')) return { result: this.trades };
    if (path.includes('/api/portfolio')) return this.portfolio;
    if (path.includes('/api/positions')) return this.positions;
    return {};
  }
  async post(path, body) {
    this.posted.push({ path, body });
    if (path.includes('orders/new/limit')) return { rfq_id: String(this._seq++) };
    if (path.includes('set_leverage')) return { current: body.leverage, max: 50 };
    return {};
  }
  warnOnce() {}
}

const mkEx = (http) => new VariationalExchange({ underlyings: ['BTC'], leverage: 0, http });
const collect = (ex) => { const ev = { fills: [], errors: [] }; ex.on('fill', (f) => ev.fills.push(f)); ex.on('error', (e) => ev.errors.push(e)); return ev; };

// ─────────────────────────────────────────────────────────────────────────
// ① Pure parsers
{
  const snap = parseSupportedAsset({ BTC: [{ price: '58496.84', index_price: '58490.0', max_leverage: 50, funding_interval_s: 28800 }] }, 'BTC');
  assert.equal(snap.price, 58496.84);
  assert.equal(snap.maxLeverage, 50);
  assert.equal(snap.fundingWindowS, 28800, 'metadata reports the 28800 settlement window');
}
{
  // instrument identity: funding_interval_s must be 3600 by default, NOT 28800,
  // and a BTC perp must NOT carry a kind field.
  const inst = instrumentFor('BTC', {});
  assert.equal(inst.funding_interval_s, 3600, 'order identity uses 3600, not metadata 28800');
  assert.equal('kind' in inst, false, 'BTC perp must not carry kind');
  const rwa = instrumentFor('AAPL', { kind: 'rwa', fundingIntervalS: 86400 });
  assert.equal(rwa.kind, 'rwa');
  assert.equal(rwa.funding_interval_s, 86400);
}
{
  const row = parseOrderRow({ rfq_id: 42, order_id: 999, status: 'CLEARED', side: 'BUY', limit_price: '58000', qty: '0.001', failed_risk_checks: [], instrument: { underlying: 'BTC' } });
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
  const pos = parsePosition({ positions: [{ instrument: { underlying: 'BTC' }, size: '0.5', side: 'short', avg_entry_price: '60000' }] }, 'BTC');
  assert.equal(pos.sizeBase, -0.5, 'short -> negative size');
  assert.equal(pos.entryPrice, 60000);
  assert.equal(parsePosition({ positions: [] }, 'BTC'), null, 'no position -> null, never a fabricated zero');
}
{
  assert.equal(roundQty(0.0017095, 0.000001), 0.001709);
  assert.ok(Math.abs(roundPrice(58496.843, 0.01) - 58496.84) < 1e-6);
  assert.equal(formatStep(0.001709, 0.000001), '0.001709');
  assert.ok(isCanceled('CANCELED'));
}

// ─────────────────────────────────────────────────────────────────────────
// Helper: bring an exchange to trading-ready with one BTC market loaded.
async function ready(http) {
  const ex = mkEx(http);
  const ev = collect(ex);
  await ex.init();
  ex.stop(); // drive _refreshOrders manually; no background polling
  return { ex, ev };
}

// ② cleared -> fill (price from the trade row)
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 58000, sizeBase: 0.001, levelIndex: 3 });
  // First refresh: still resting -> becomes "seen".
  http.pending = [{ rfq_id: orderId, side: 'buy', limit_price: '58000', qty: '0.001', status: 'pending', instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0, 'resting order does not fill');
  // Next refresh: gone from pending, history says cleared, trade carries source_rfq.
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'cleared', side: 'buy', qty: '0.001', price: '58000', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  http.trades = [{ id: 1, source_rfq: orderId, price: '58001.25', qty: '0.001', side: 'buy' }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 1, 'cleared -> exactly one fill');
  assert.equal(ev.fills[0].price, 58001.25, 'fill price comes from the trade row');
  assert.equal(ev.fills[0].levelIndex, 3);
  assert.equal(ex.getOpenOrders(1).length, 0, 'filled order removed from tracking');
}

// ③ failed_risk_checks -> reject (error, no fill, counter++)
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'sell', price: 62000, sizeBase: 0.001, levelIndex: 5 });
  http.pending = [{ rfq_id: orderId, side: 'sell', limit_price: '62000', qty: '0.001', status: 'pending', instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'canceled', side: 'sell', qty: '0.001', failed_risk_checks: ['max_position'], instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0, 'rejected order never fills');
  assert.equal(ex.rejectedOrders, 1, 'reject counter incremented');
  assert.ok(ev.errors.some((e) => /风控|拒单/.test(e.message)), 'reject surfaces as an error');
}

// ④ canceled by US (canceling=true) -> silent, no error
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 57000, sizeBase: 0.001, levelIndex: 1 });
  http.pending = [{ rfq_id: orderId, side: 'buy', limit_price: '57000', qty: '0.001', status: 'pending', instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  await ex.cancelOrder(1, orderId); // marks canceling=true, posts cancel
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'canceled', side: 'buy', qty: '0.001', cancel_reason: 'user_cancel', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0);
  assert.equal(ev.errors.length, 0, 'our own cancel is silent');
  assert.equal(ex.getOpenOrders(1).length, 0, 'cancelled order removed');
}

// ⑤ canceled REMOTELY (we didn't cancel) -> error, not treated as fill
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 57000, sizeBase: 0.001, levelIndex: 2 });
  http.pending = [{ rfq_id: orderId, side: 'buy', limit_price: '57000', qty: '0.001', status: 'pending', instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'canceled', side: 'buy', qty: '0.001', cancel_reason: 'olp_reject', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0, 'remote cancel is not a fill');
  assert.ok(ev.errors.some((e) => /非本地撤销/.test(e.message)), 'remote cancel raises an error');
}

// ⑥ cancel-vs-fill RACE: we asked to cancel, but it actually cleared -> fill wins
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 58000, sizeBase: 0.001, levelIndex: 4 });
  http.pending = [{ rfq_id: orderId, side: 'buy', limit_price: '58000', qty: '0.001', status: 'pending', instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  await ex.cancelOrder(1, orderId); // canceling=true
  http.pending = [];
  http.history = [{ rfq_id: orderId, status: 'cleared', side: 'buy', qty: '0.001', price: '58000', failed_risk_checks: [], instrument: { underlying: 'BTC' } }];
  http.trades = [{ id: 2, source_rfq: orderId, price: '58000', qty: '0.001', side: 'buy' }];
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 1, 'positive confirmation: a cleared order fills even if we tried to cancel');
  assert.equal(ev.errors.length, 0);
}

// ⑦ fail-closed: terminal rows unreadable -> resolve nothing, keep tracking
{
  const http = new MockHttp();
  const { ex, ev } = await ready(http);
  const { orderId } = await ex.placeLimitOrder({ marketId: 1, side: 'buy', price: 58000, sizeBase: 0.001, levelIndex: 0 });
  http.pending = [{ rfq_id: orderId, side: 'buy', limit_price: '58000', qty: '0.001', status: 'pending', instrument: { underlying: 'BTC' } }];
  await ex._refreshOrders();
  http.pending = [];
  http.failHistory = true; // orders/v2 history read fails
  await ex._refreshOrders();
  assert.equal(ev.fills.length, 0, 'never fabricate a fill when the terminal row is unreadable');
  assert.equal(ex.getOpenOrders(1).length, 1, 'order stays tracked (fail-closed)');
  assert.ok(ex.operationalIssue, 'an operational issue is surfaced');
}

console.log('✓ va.test.js 全部通过');
