// HL (Hyperliquid) paper adapter: in-memory matching with synthetic candles.
// Mirrors the lr/paper.js structure so GridBot logic is identical.
import { EventEmitter } from 'node:events';
import { HL_API_URL, HL_DEX } from './market.js';

const FALLBACK = [
  { marketId: 0, name: 'io:ANTH', displayName: 'io:ANTH', symbol: 'ANTH', lastPrice: 1994, stepSize: 0.001, stepPrice: 0.1, sizeDecimals: 3, priceDecimals: 1, minOrderSize: 0.001, minOrderNotional: 10, maxOrderSize: Infinity, maxLeverage: 6, onlyIsolated: true },
  { marketId: 1, name: 'io:SNDK', displayName: 'io:SNDK', symbol: 'SNDK', lastPrice: 1783, stepSize: 0.001, stepPrice: 0.1, sizeDecimals: 3, priceDecimals: 1, minOrderSize: 0.001, minOrderNotional: 10, maxOrderSize: Infinity, maxLeverage: 10, onlyIsolated: true },
];

export class PaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper'; this.network = 'mainnet'; this.apiUrl = HL_API_URL; this.dex = HL_DEX;
    this.balance = Number(opts.startBalance || 10_000); this.equity = this.balance;
    this.feeRate = Number(opts.feeRate || 0.0005); this.dataSource = 'synthetic';
    this.markets = new Map(); this.orders = new Map(); this.positions = new Map(); this.prices = new Map();
    this.realizedPnl = 0; this.lastOkAt = Date.now(); this._seq = 0; this._timer = null;
    this._setMarkets(FALLBACK);
  }

  async init() { this.start(); return true; }
  async reconnect() { return true; }
  _setMarkets(rows) {
    this.markets = new Map(rows.map((m) => [m.marketId, m]));
    for (const m of rows) if (!this.prices.has(m.marketId)) this.prices.set(m.marketId, m.lastPrice || 100);
  }
  async getMarkets() { return [...this.markets.values()]; }
  async getCandles(marketId, intervalSec = 3600, n = 200) {
    return synthCandles(this.prices.get(Number(marketId)) || 100, Number(n) || 200, Number(intervalSec) || 3600);
  }
  async getPrice(marketId) { return this.prices.get(Number(marketId)); }
  async setLeverage() { return true; }
  async placeLimitOrder(order) {
    const orderId = `hl-paper-${++this._seq}`;
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
  _tick() {
    for (const [id, old] of this.prices) {
      const next = Math.max(1e-8, old * (1 + (Math.random() * 2 - 1) * 0.0015));
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
    const p = this.positions.get(id) || { sizeBase: 0, entryPrice: 0, leverage: null, liquidationPrice: null, marginMode: 'isolated' };
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