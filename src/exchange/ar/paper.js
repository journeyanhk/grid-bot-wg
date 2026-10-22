// ArcusPaper: simulated fills on top of REAL Arcus prices.
//
// Mirrors the live adapter's public surface (same methods / events / fields) so
// the GridBot, the dashboard and the tests cannot tell paper from live apart —
// except that orders are matched locally against the real price path instead of
// being signed and sent. Market metadata, mark prices and candles all come from
// `api.arcus.xyz`, so the paper grid trades the same ticks/steps the live one
// would; only the matching is simulated.
//
// Fill model: a resting BUY fills when the price trades at or below its limit,
// a resting SELL when at or above. Like the live ALO path, fills pay the
// market's MAKER fee (0 ppm on Arcus today), so paper P&L is not inflated by a
// missing fee line: set feeRate from the market metadata, not a constant.
import { EventEmitter } from 'node:events';
import { normalizeBase, parseMarkets } from './market.js';

const FALLBACK_MARKETS = [
  {
    marketId: 1, displayName: 'BTC-USD', symbol: 'BTC', lastPrice: 80000,
    stepSize: 1e-8, stepPrice: 0.1, minOrderSize: 0.0001, minOrderNotional: 5,
    maxLeverage: 40, makerFee: 0, takerFee: 0.000225, status: 'ONLINE',
  },
];

export class ArcusPaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.network = (opts.network || 'mainnet').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';
    // 行情来源优先级：AR_PAPER_API_URL → 主网官方端点 → 测试网（只影响行情，不影响资金）。
    // paper 的意义是"用真实盘口验证策略"，所以默认吃主网；测试盘口太薄会打出假成交。
    const sourceNet = (opts.paperNetwork || 'mainnet').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';
    const other = sourceNet === 'testnet' ? 'mainnet' : 'testnet';
    this.sourceNetwork = sourceNet;
    this.candidates = [...new Set([normalizeBase(opts.apiUrl, sourceNet),
      normalizeBase('', sourceNet), normalizeBase('', other)].filter(Boolean))];
    this.apiUrl = this.candidates[0];
    this.startBalance = Number(opts.startBalance) || 10000;
    this.balance = this.startBalance;
    this.realizedPnl = 0;
    this.dataSource = 'connecting';    // 'real' | 'synthetic'
    this.tickMs = opts.tickMs ?? 1000;
    this.pollMs = opts.pollMs ?? 2000;
    this.markets = new Map();
    this.orders = new Map();
    this.positions = new Map();
    this.prices = new Map();
    this.realTarget = new Map();
    this._leverage = new Map();
    this._seq = 1;
    this._tickTimer = null;
    this._pollTimer = null;
    this.lastOkAt = 0;
    this.lastError = null;
    this.operationalIssue = null;
  }

  async init() {
    let chosen = null, list = null;
    for (const url of this.candidates) {
      const got = await fetchMarkets(url);
      if (got && got.length) { chosen = url; list = got; break; }
    }
    if (chosen) {
      this.apiUrl = chosen;
      this.dataSource = 'real';
      for (const m of list) {
        this.markets.set(m.marketId, m);
        this.prices.set(m.marketId, m.lastPrice || 0);
      }
    } else {
      this.dataSource = 'synthetic';
      for (const m of FALLBACK_MARKETS) {
        this.markets.set(m.marketId, { ...m });
        this.prices.set(m.marketId, m.lastPrice);
      }
    }
    this.feeRate = this.markets.get(1)?.makerFee ?? 0;
    this.lastOkAt = Date.now();
    this.start();
    return true;
  }

  async reconnect() { this.lastError = null; await this.init(); return true; }

  async getMarkets() { return [...this.markets.values()]; }
  async getPrice(marketId) { return this.prices.get(Number(marketId)) ?? null; }
  async setLeverage(marketId, x) { this._leverage.set(Number(marketId), Number(x)); return true; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    if (this.dataSource === 'real') {
      try {
        const tf = Math.max(60, Math.floor(Number(intervalSec) || 3600));
        const url = `${this.apiUrl}/v1/candles?market=${encodeURIComponent(String(marketId))}`
          + `&timeframe=${tf}&limit=${Math.min(500, Math.max(2, Number(n) || 200))}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const j = await res.json();
          const rows = Array.isArray(j) ? j : (j.candles || j.data || []);
          const out = rows.map((c) => ({
            time: Number(c.time ?? c.t ?? c.ts ?? 0) > 1e12 ? Number(c.time ?? c.t ?? c.ts) : Number(c.time ?? c.t ?? c.ts) * 1000,
            open: Number(c.open ?? c.o), high: Number(c.high ?? c.h), low: Number(c.low ?? c.l), close: Number(c.close ?? c.c),
            volume: Number(c.volume ?? c.v ?? 0),
          })).filter((c) => Number.isFinite(c.close) && c.close > 0);
          if (out.length >= 20) return out.sort((a, b) => a.time - b.time);
        }
      } catch { /* fall through to synthetic */ }
    }
    return synthCandles(this.prices.get(Number(marketId)) || 100, n);
  }

  async placeLimitOrder(o) {
    const mId = Number(o.marketId);
    const m = this.markets.get(mId);
    if (!m) throw new Error(`未知市场 ${o.marketId}`);
    const price = Number(o.price), size = Number(o.sizeBase);
    if (!(price > 0) || !(size > 0)) throw new Error('价格/数量必须为正');
    if (m.minOrderNotional && price * size < Number(m.minOrderNotional)) {
      throw new Error(`单笔名义 ${(price * size).toFixed(2)} 低于最小 ${m.minOrderNotional}`);
    }
    const orderId = `paper-ar-${this._seq++}`;
    this.orders.set(orderId, {
      orderId, marketId: mId, side: o.side === 'sell' ? 'sell' : 'buy',
      price, sizeBase: size, reduceOnly: !!o.reduceOnly,
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId || null,
    });
    return { orderId, status: 'ACK', clientOrderId: o.clientOrderId || null };
  }

  async cancelOrder(_marketId, orderId) { this.orders.delete(String(orderId)); return true; }

  async cancelAll(marketId) {
    for (const [id, o] of [...this.orders]) if (Number(o.marketId) === Number(marketId)) this.orders.delete(id);
    return true;
  }

  getOpenOrders(marketId) {
    return [...this.orders.values()].filter((o) => Number(o.marketId) === Number(marketId));
  }

  async fetchOpenOrders(marketId) {
    return this.getOpenOrders(marketId).map((o) => ({
      orderId: String(o.orderId), price: Number(o.price), side: o.side,
      sizeBase: Number(o.sizeBase), reduceOnly: !!o.reduceOnly,
    }));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    this.orders.set(String(orderId), {
      orderId: String(orderId), marketId: Number(marketId), levelIndex,
      side: side === 'buy' ? 'buy' : 'sell', price: Number(price), sizeBase: Number(sizeBase), reduceOnly: false,
    });
  }

  forgetOrder(orderId) { this.orders.delete(String(orderId)); }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    if (!p || !p.sizeBase) return null;
    const last = this.prices.get(Number(marketId)) ?? p.entryPrice;
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl: p.sizeBase * (last - p.entryPrice) };
  }

  async closePosition(marketId) {
    const id = Number(marketId);
    const p = this.positions.get(id);
    if (!p || !p.sizeBase) return null;
    const price = this.prices.get(id);
    this._applyFill(id, p.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(p.sizeBase), true);
    return true;
  }

  /** 权益 = 余额 + 未实现；bot 用 typeof ex.equity === 'number' 判定可用。 */
  get equity() {
    let upnl = 0;
    for (const [id, p] of this.positions) {
      if (!p.sizeBase) continue;
      upnl += p.sizeBase * ((this.prices.get(id) ?? p.entryPrice) - p.entryPrice);
    }
    return this.balance + upnl;
  }

  start() {
    if (!this._tickTimer) {
      this._tickTimer = setInterval(() => this._tick(), this.tickMs);
      this._tickTimer.unref?.();
    }
    if (this.dataSource === 'real' && !this._pollTimer) {
      this._pollTimer = setInterval(() => this._pollReal(), this.pollMs);
      this._pollTimer.unref?.();
    }
  }

  stop() { /* 行情循环常驻：停网格 ≠ 停行情，面板仍要显示价格 */ }

  async _pollReal() {
    try {
      const ids = new Set([...this.orders.values()].map((o) => o.marketId));
      if (!ids.size) ids.add(1);
      for (const id of ids) {
        const m = this.markets.get(id);
        if (!m) continue;
        const url = `${this.apiUrl}/v1/bbo/${encodeURIComponent(m.displayName)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) continue;
        const j = await res.json();
        const bid = Number(j?.bestBid?.price), ask = Number(j?.bestAsk?.price);
        if (bid > 0 && ask > 0) { this.realTarget.set(id, (bid + ask) / 2); this.lastOkAt = Date.now(); }
      }
    } catch (e) { this.lastError = e; /* transient */ }
  }

  _tick() {
    for (const [id, price] of this.prices) {
      const target = this.realTarget.get(id) ?? price;
      // 逼近真实中价（避免用最后一跳造成假穿越），合成模式用随机游走兜底。
      let next;
      if (this.dataSource === 'real') {
        next = price + (target - price) * 0.5;
        if (Math.abs(next - target) / Math.max(1, target) < 1e-6) next = target;
      } else {
        next = Math.max(0.0001, price * (1 + (Math.random() * 2 - 1) * 0.0015));
      }
      this.prices.set(id, next);
      this.emit('price', { marketId: id, price: next });
      this._matchFills(id, next);
    }
  }

  _matchFills(marketId, cur) {
    for (const o of [...this.orders.values()]) {
      if (o.marketId !== marketId) continue;
      const hit = o.side === 'buy' ? cur <= o.price : cur >= o.price;
      if (!hit) continue;
      if (o.reduceOnly && !this._reduces(marketId, o.side)) { this.orders.delete(o.orderId); continue; }
      this.orders.delete(o.orderId);
      this._applyFill(marketId, o.side, o.price, o.sizeBase);
      this.emit('fill', {
        orderId: o.orderId, marketId, side: o.side, price: o.price,
        sizeBase: o.sizeBase, levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
      });
    }
  }

  _reduces(marketId, side) {
    const p = this.positions.get(marketId);
    if (!p || !p.sizeBase) return false;
    return side === 'sell' ? p.sizeBase > 0 : p.sizeBase < 0;
  }

  _applyFill(marketId, side, price, qty, taker = false) {
    const m = this.markets.get(marketId);
    const rate = taker ? Number(m?.takerFee ?? 0.000225) : Number(m?.makerFee ?? 0);
    const fee = price * qty * rate;
    this.balance -= fee;
    this.realizedPnl -= fee;
    const p = this.positions.get(marketId) || { sizeBase: 0, entryPrice: 0 };
    const signed = side === 'buy' ? qty : -qty;
    if (!p.sizeBase || Math.sign(p.sizeBase) === Math.sign(signed)) {
      const newSize = p.sizeBase + signed;
      p.entryPrice = (Math.abs(p.sizeBase) * p.entryPrice + Math.abs(signed) * price) / Math.abs(newSize);
      p.sizeBase = newSize;
    } else {
      const closeQty = Math.min(Math.abs(p.sizeBase), Math.abs(signed));
      const pnl = p.sizeBase > 0 ? closeQty * (price - p.entryPrice) : closeQty * (p.entryPrice - price);
      this.realizedPnl += pnl;
      this.balance += pnl;
      const remaining = p.sizeBase + signed;
      if (!remaining) { p.sizeBase = 0; p.entryPrice = 0; }
      else if (Math.sign(remaining) === Math.sign(p.sizeBase)) p.sizeBase = remaining;
      else { p.sizeBase = remaining; p.entryPrice = price; }
    }
    this.positions.set(marketId, p);
  }
}

async function fetchMarkets(base) {
  try {
    const res = await fetch(`${base}/v1/markets`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const out = parseMarkets(await res.json());
    return out.length ? out : null;
  } catch { return null; }
}

function synthCandles(start, n) {
  const out = [];
  let price = Number(start) || 100;
  let t = Date.now() - n * 3600_000;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price * (1 + (Math.random() * 2 - 1) * 0.006);
    out.push({ time: t, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 100 });
    price = close; t += 3600_000;
  }
  return out;
}