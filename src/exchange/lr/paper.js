import { EventEmitter } from 'node:events';
import { CANDLE_RESOLUTIONS, RHC_API_URL, parseCandles, parseMarkets } from './market.js';

const FALLBACK = [
  { marketId: 0, name: 'ETH-USD', displayName: 'ETH-USD', symbol: 'ETH', lastPrice: 3000, stepSize: 0.0001, stepPrice: 0.01, sizeDecimals: 4, priceDecimals: 2, minOrderSize: 0.001, minOrderNotional: 1, maxOrderSize: Infinity, maxLeverage: 50 },
  { marketId: 1, name: 'BTC-USD', displayName: 'BTC-USD', symbol: 'BTC', lastPrice: 65000, stepSize: 0.00001, stepPrice: 0.1, sizeDecimals: 5, priceDecimals: 1, minOrderSize: 0.0001, minOrderNotional: 1, maxOrderSize: Infinity, maxLeverage: 50 },
];

export class PaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper'; this.network = 'mainnet'; this.apiUrl = RHC_API_URL;
    this.balance = Number(opts.startBalance || 10_000); this.equity = this.balance;
    this.feeRate = Number(opts.feeRate || 0.0005); this.dataSource = 'connecting';
    this.markets = new Map(); this.orders = new Map(); this.positions = new Map(); this.prices = new Map();
    this.realizedPnl = 0; this.lastOkAt = Date.now(); this._seq = 0; this._timer = null;
  }

  async init() {
    try {
      const data = await this._get('/api/v1/orderBookDetails?filter=perp');
      const rows = parseMarkets(data);
      if (!rows.length) throw new Error('没有市场');
      this._setMarkets(rows); this.dataSource = 'real';
    } catch {
      this._setMarkets(FALLBACK); this.dataSource = 'synthetic';
    }
    this.start(); return true;
  }

  async reconnect() { await this.init(); return true; }
  _setMarkets(rows) {
    this.markets = new Map(rows.map((m) => [m.marketId, m]));
    for (const m of rows) if (!this.prices.has(m.marketId)) this.prices.set(m.marketId, m.lastPrice || 100);
  }
  async _get(path) {
    const res = await fetch(this.apiUrl + path, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`RHC 行情接口 HTTP ${res.status}`);
    return res.json();
  }
  async getMarkets() { return [...this.markets.values()]; }
  async getCandles(marketId, intervalSec = 3600, n = 200) {
    if (this.dataSource === 'real') {
      try {
        const resolution = CANDLE_RESOLUTIONS.get(Number(intervalSec)) || '1h';
        const end = Math.floor(Date.now() / 1000), count = Math.min(500, Math.max(20, Number(n) || 200));
        const start = end - count * Number(intervalSec || 3600);
        const data = await this._get(`/api/v1/candles?market_id=${Number(marketId)}&resolution=${resolution}&start_timestamp=${start}&end_timestamp=${end}&count_back=${count}`);
        const rows = parseCandles(data); if (rows.length) return rows;
      } catch { /* synthetic fallback */ }
    }
    return synthCandles(this.prices.get(Number(marketId)) || 100, Number(n) || 200, Number(intervalSec) || 3600);
  }
  async getPrice(marketId) { return this.prices.get(Number(marketId)); }
  async setLeverage() { return true; }
  async placeLimitOrder(order) {
    const orderId = `lr-paper-${++this._seq}`;
    this.orders.set(orderId, { ...order, orderId, marketId: Number(order.marketId) }); return { orderId };
  }
  async placeLimitOrders(orders) { return Promise.all(orders.map((o) => this.placeLimitOrder(o))); }
  async cancelOrder(_marketId, orderId) { this.orders.delete(String(orderId)); return true; }
  async cancelAll(marketId) { for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) this.orders.delete(id); return true; }
  getOpenOrders(marketId) { return [...this.orders.values()].filter((o) => o.marketId === Number(marketId)); }
  async fetchOpenOrders(marketId) { return this.getOpenOrders(marketId).map((o) => ({ orderId: String(o.orderId), marketId: o.marketId, side: o.side, price: Number(o.price) })); }
  forgetOrder(id) { this.orders.delete(String(id)); }
  forgetOrders(marketId) { for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) this.orders.delete(id); }
  adoptOrder(order) { this.orders.set(String(order.orderId), { ...order, orderId: String(order.orderId), marketId: Number(order.marketId) }); }
  getPosition(marketId) {
    const p = this.positions.get(Number(marketId)); if (!p?.sizeBase) return null;
    const price = this.prices.get(Number(marketId)) || p.entryPrice;
    return { ...p, unrealizedPnl: p.sizeBase * (price - p.entryPrice) };
  }
  async closePosition(marketId) {
    const p = this.positions.get(Number(marketId)); if (!p?.sizeBase) return true;
    this._fill(Number(marketId), p.sizeBase > 0 ? 'sell' : 'buy', this.prices.get(Number(marketId)), Math.abs(p.sizeBase)); return true;
  }
  start() { if (!this._timer) { this._timer = setInterval(() => this._tick(), 1000); this._timer.unref?.(); } }
  stop() { /* keep paper market/account monitoring alive */ }
  async _refresh() {
    try {
      const rows = parseMarkets(await this._get('/api/v1/orderBookDetails?filter=perp'));
      if (rows.length) { this._setMarkets(rows); for (const m of rows) if (m.lastPrice > 0) this.prices.set(m.marketId, m.lastPrice); this.dataSource = 'real'; }
    } catch { /* retain last price */ }
  }
  _tick() {
    if (this.dataSource === 'real' && Date.now() - this.lastOkAt > 5000) this._refresh().finally(() => { this.lastOkAt = Date.now(); });
    for (const [id, old] of this.prices) {
      const next = this.dataSource === 'real' ? old : Math.max(1e-8, old * (1 + (Math.random() * 2 - 1) * 0.0015));
      this.prices.set(id, next); this.emit('price', { marketId: id, price: next });
      for (const order of this.getOpenOrders(id)) {
        if (!(order.side === 'buy' ? next <= order.price : next >= order.price)) continue;
        if (order.reduceOnly && !this._reduces(id, order.side)) { this.orders.delete(order.orderId); continue; }
        this.orders.delete(order.orderId); this._fill(id, order.side, Number(order.price), Number(order.sizeBase));
        this.emit('fill', { ...order, price: Number(order.price), sizeBase: Number(order.sizeBase) });
      }
    }
  }
  _reduces(id, side) { const p = this.positions.get(id); return !!p?.sizeBase && (side === 'sell' ? p.sizeBase > 0 : p.sizeBase < 0); }
  _fill(id, side, price, quantity) {
    const fee = price * quantity * this.feeRate; this.balance -= fee; this.realizedPnl -= fee;
    const p = this.positions.get(id) || { sizeBase: 0, entryPrice: 0, leverage: null, liquidationPrice: null };
    const signed = side === 'buy' ? quantity : -quantity;
    if (!p.sizeBase || Math.sign(p.sizeBase) === Math.sign(signed)) {
      const next = p.sizeBase + signed; p.entryPrice = (Math.abs(p.sizeBase) * p.entryPrice + quantity * price) / Math.abs(next); p.sizeBase = next;
    } else {
      const closed = Math.min(Math.abs(p.sizeBase), quantity), pnl = p.sizeBase > 0 ? closed * (price - p.entryPrice) : closed * (p.entryPrice - price);
      this.balance += pnl; this.realizedPnl += pnl; const next = p.sizeBase + signed;
      if (!next || Math.sign(next) === Math.sign(p.sizeBase)) { p.sizeBase = next; if (!next) p.entryPrice = 0; } else { p.sizeBase = next; p.entryPrice = price; }
    }
    this.equity = this.balance; this.positions.set(id, p);
  }
}

function synthCandles(start, count, intervalSec) {
  const out = []; let price = start, time = Math.floor(Date.now() / 1000) - count * intervalSec;
  for (let i = 0; i < count; i++) { const open = price, close = price * (1 + (Math.random() * 2 - 1) * 0.006); out.push({ time, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 100 }); price = close; time += intervalSec; }
  return out;
}
