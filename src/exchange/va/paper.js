// PaperExchange: simulated trading on top of REAL Variational Omni prices.
//
// Omni has no orderbook — prices come from the public supported_assets
// endpoint (index/mark price per underlying) and candles from /api/candles.
// Both are public (no vr-token needed), so paper mode can mirror the live
// price path exactly while simulating fills against it. If Cloudflare blocks
// us or the endpoint is unreachable, we fall back to a synthetic random walk
// and label dataSource='synthetic' so the dashboard can show the difference.
//
// This mirrors the marketId numbering of VariationalExchange._loadMarkets
// (1-based over the configured underlyings) so a bot can switch live<->paper
// without the grid re-indexing markets.
import { EventEmitter } from 'node:events';
import { VaHttpClient } from './httpclient.js';
import {
  DEFAULT_PRECISION, DEFAULT_UNDERLYINGS, candlePeriod,
  parseCandles, parseSupportedAsset,
} from './market.js';

export class PaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.balance = opts.startBalance ?? 10000;
    this.underlyings = (opts.underlyings && opts.underlyings.length ? opts.underlyings : DEFAULT_UNDERLYINGS).map((u) => u.toUpperCase());
    this.precision = { ...DEFAULT_PRECISION, ...(opts.precision || {}) };
    this.http = new VaHttpClient({ baseUrl: opts.baseUrl, proxy: opts.proxy, transportMode: opts.transport || 'bridge', pythonPath: opts.pythonPath });
    this.dataSource = 'connecting'; // 'real' | 'synthetic'
    this.tickMs = opts.tickMs ?? 1000;
    this.pollMs = opts.pollMs ?? 4000;
    this.volPerTick = opts.volPerTick ?? 0.0012; // synthetic fallback only
    this.feeRate = Number(opts.feeRate) || 0.0001; // Omni is spread-based; keep tiny
    this.markets = new Map();       // marketId -> market
    this._byUnderlying = new Map(); // underlying -> marketId
    this.orders = new Map();        // orderId -> order
    this.positions = new Map();     // marketId -> {sizeBase, entryPrice}
    this.realizedPnl = 0;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.prices = new Map();      // displayed/simulated price
    this.realTarget = new Map();  // latest real price target
    this._seq = 1;
    this._tickTimer = null;
    this._pollTimer = null;
  }

  async init() {
    const list = await this._probeMarkets();
    if (list && list.length) {
      this.dataSource = 'real';
      this._setMarkets(list);
    } else {
      this.dataSource = 'synthetic';
      this._setMarkets(this._fallbackMarkets());
    }
    for (const [id, m] of this.markets) {
      this.prices.set(id, m.lastPrice || 100);
      this.realTarget.set(id, m.lastPrice || 100);
    }
    this._startLoops();
    return true;
  }

  async reconnect() {
    try {
      const list = await this._probeMarkets();
      if (list && list.length && this.dataSource !== 'real') { // upgrade only
        this.dataSource = 'real';
        this._setMarkets(list);
        for (const [id, m] of this.markets) { this.prices.set(id, m.lastPrice || 100); this.realTarget.set(id, m.lastPrice || 100); }
      }
    } catch { /* keep current mode */ }
    this._startLoops();
    this.lastOkAt = Date.now();
    return true;
  }

  async _probeMarkets() {
    const out = [];
    let idx = 0;
    for (const underlying of this.underlyings) {
      try {
        const snap = parseSupportedAsset(await this.http.supportedAssets(underlying), underlying);
        if (!snap) continue;
        const marketId = idx + 1; idx += 1;
        out.push({
          marketId, underlying,
          displayName: `${underlying}-PERP`, symbol: underlying, lastPrice: snap.price,
          stepSize: this.precision.stepSize, stepPrice: this.precision.stepPrice,
          minOrderSize: this.precision.minOrderSize,
          maxLeverage: snap.maxLeverage || this.precision.maxLeverage,
        });
      } catch (e) { this.lastError = e?.message || String(e); }
    }
    return out;
  }

  _fallbackMarkets() {
    let idx = 0;
    return this.underlyings.map((underlying) => {
      const marketId = idx + 1; idx += 1;
      return {
        marketId, underlying, displayName: `${underlying}-PERP`, symbol: underlying,
        lastPrice: underlying === 'BTC' ? 60000 : underlying === 'ETH' ? 3000 : 100,
        stepSize: this.precision.stepSize, stepPrice: this.precision.stepPrice,
        minOrderSize: this.precision.minOrderSize, maxLeverage: this.precision.maxLeverage,
      };
    });
  }

  _setMarkets(list) {
    this.markets.clear(); this._byUnderlying.clear();
    for (const m of list) { this.markets.set(m.marketId, m); this._byUnderlying.set(m.underlying, m.marketId); }
  }

  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const m = this.markets.get(Number(marketId));
    if (m && this.dataSource === 'real') {
      try {
        const period = candlePeriod(intervalSec);
        const end = new Date();
        const start = new Date(end.getTime() - Number(n) * Number(intervalSec) * 1000);
        const q = `period=${period}&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&cex_asset=${encodeURIComponent(m.underlying)}`;
        const data = parseCandles(await this.http.get(`/api/candles?${q}`));
        if (data.length >= 20) return data;
      } catch { /* fall through to synthetic */ }
    }
    return synthCandles(this.prices.get(Number(marketId)) || 100, n);
  }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }
  async setLeverage() { return true; }

  async placeLimitOrder(o) {
    const id = `paper-${this._seq++}`;
    this.orders.set(id, { orderId: id, ...o, marketId: Number(o.marketId) });
    return { orderId: id };
  }
  async cancelOrder(_m, orderId) { this.orders.delete(String(orderId)); return true; }
  async cancelAll(marketId) { for (const [id, o] of this.orders) if (o.marketId === Number(marketId)) this.orders.delete(id); return true; }
  getOpenOrders(marketId) { return [...this.orders.values()].filter((o) => o.marketId === Number(marketId)); }
  async fetchOpenOrders(marketId) {
    return [...this.orders.values()]
      .filter((o) => Number(o.marketId) === Number(marketId))
      .map((o) => ({ orderId: String(o.orderId), price: Number(o.price), side: o.side }));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase, reduceOnly }) {
    this.orders.set(String(orderId), { orderId: String(orderId), marketId: Number(marketId), levelIndex, side, price: Number(price), sizeBase: Number(sizeBase), reduceOnly: !!reduceOnly });
  }

  forgetOrder(orderId) { this.orders.delete(String(orderId)); }

  forgetOrders(marketId) {
    for (const [id, o] of this.orders) if (Number(o.marketId) === Number(marketId)) this.orders.delete(id);
  }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    if (!p || p.sizeBase === 0) return null;
    const last = this.prices.get(Number(marketId));
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl: p.sizeBase * (last - p.entryPrice) };
  }

  async closePosition(marketId) {
    const id = Number(marketId);
    const p = this.positions.get(id);
    if (!p || !p.sizeBase) return null;
    const price = this.prices.get(id);
    this._applyFill(id, p.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(p.sizeBase));
    return true;
  }

  start() { this._startLoops(); }
  stop() { /* keep price feed alive across bot stop/start */ }

  _startLoops() {
    if (!this._tickTimer) { this._tickTimer = setInterval(() => this._tick(), this.tickMs); this._tickTimer.unref?.(); }
    if (this.dataSource === 'real' && !this._pollTimer) {
      this._pollTimer = setInterval(() => this._pollReal(), this.pollMs); this._pollTimer.unref?.();
    }
  }

  async _pollReal() {
    for (const [id, m] of this.markets) {
      try {
        const snap = parseSupportedAsset(await this.http.supportedAssets(m.underlying), m.underlying);
        if (snap?.price && this.realTarget.has(id)) this.realTarget.set(id, snap.price);
      } catch (e) { this.lastError = e?.message || String(e); }
    }
  }

  _tick() {
    this.lastOkAt = Date.now();
    for (const [id, price] of this.prices) {
      let next;
      if (this.dataSource === 'real') {
        const target = this.realTarget.get(id) ?? price;
        next = price + (target - price) * 0.25;
        if (Math.abs(next - target) / target < 1e-5) next = target;
      } else {
        const seed = this.markets.get(id)?.lastPrice || price;
        const drift = (seed - price) / seed * 0.02;
        const shock = (Math.random() * 2 - 1) * this.volPerTick;
        next = Math.max(0.0001, price * (1 + drift + shock));
      }
      this.prices.set(id, next);
      this.emit('price', { marketId: id, price: next });
      this._matchFills(id, price, next);
    }
  }

  _matchFills(marketId, prev, cur) {
    for (const o of [...this.orders.values()]) {
      if (o.marketId !== marketId) continue;
      const crossedBuy = o.side === 'buy' && cur <= o.price;
      const crossedSell = o.side === 'sell' && cur >= o.price;
      if (!crossedBuy && !crossedSell) continue;
      if (o.reduceOnly && !this._reduces(marketId, o.side)) { this.orders.delete(o.orderId); continue; }
      this.orders.delete(o.orderId);
      this._applyFill(marketId, o.side, o.price, o.sizeBase);
      this.emit('fill', { orderId: o.orderId, marketId, side: o.side, price: o.price, sizeBase: o.sizeBase, levelIndex: o.levelIndex, clientOrderId: o.clientOrderId });
    }
  }

  _reduces(marketId, side) {
    const p = this.positions.get(marketId);
    if (!p || p.sizeBase === 0) return false;
    return side === 'sell' ? p.sizeBase > 0 : p.sizeBase < 0;
  }

  _applyFill(marketId, side, price, qty) {
    const fee = price * qty * this.feeRate;
    this.balance -= fee;
    this.realizedPnl -= fee;
    const p = this.positions.get(marketId) || { sizeBase: 0, entryPrice: 0 };
    const signed = side === 'buy' ? qty : -qty;
    if (p.sizeBase === 0 || Math.sign(p.sizeBase) === Math.sign(signed)) {
      const newSize = p.sizeBase + signed;
      p.entryPrice = (Math.abs(p.sizeBase) * p.entryPrice + Math.abs(signed) * price) / Math.abs(newSize);
      p.sizeBase = newSize;
    } else {
      const closeQty = Math.min(Math.abs(p.sizeBase), Math.abs(signed));
      const pnl = p.sizeBase > 0 ? closeQty * (price - p.entryPrice) : closeQty * (p.entryPrice - price);
      this.realizedPnl += pnl; this.balance += pnl;
      const remaining = p.sizeBase + signed;
      if (Math.sign(remaining) === Math.sign(p.sizeBase) || remaining === 0) { p.sizeBase = remaining; if (remaining === 0) p.entryPrice = 0; }
      else { p.sizeBase = remaining; p.entryPrice = price; }
    }
    this.positions.set(marketId, p);
  }
}

function synthCandles(start, n) {
  const out = []; let price = start; let t = Date.now() - n * 3600_000;
  const regime = Math.random() < 0.34 ? 0.0012 : Math.random() < 0.5 ? -0.0012 : 0;
  for (let i = 0; i < n; i++) {
    const open = price, close = price * (1 + regime + (Math.random() * 2 - 1) * 0.006);
    out.push({ time: t, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 100 });
    price = close; t += 3600_000;
  }
  return out;
}
