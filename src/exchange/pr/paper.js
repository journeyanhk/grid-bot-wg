// 本地模拟账户：只模拟"账本语义"，不模拟撮合保真度。
//   - long / short 两本账独立（正是 Propr 的双边语义）
//   - reduceOnly 无仓可减 → 拒单（与 Propr 一致）
//   - 手续费按 maker/taker 计；挂单成交记 maker，IOC 记 taker
//   - 不模拟部分成交、GTX 排队、盘口深度（这些用 fixture 单测覆盖，不在 paper 里造假）
import { BTC_MARKET } from './market.js';

let SEQ = 0;

export class ProprPaper {
  constructor({ startBalance = 5000, makerFee = 0.00015, takerFee = 0.00045, market = BTC_MARKET } = {}) {
    this.market = market;
    this.startBalance = startBalance;
    this.cash = startBalance;
    this.makerFee = makerFee;
    this.takerFee = takerFee;
    this.orders = new Map();
    this.positions = { long: { size: 0, entry: 0 }, short: { size: 0, entry: 0 } };
    this.trades = [];
    this.feesPaid = 0;
    this.realized = 0;
  }

  placeLimitOrder({ side, price, sizeBase, reduceOnly = false, positionSide, timeInForce = 'GTC' }) {
    if (!(price > 0) || !(sizeBase > 0)) throw new Error('paper: price/sizeBase 必须为正');
    if (!['buy', 'sell'].includes(side)) throw new Error(`paper: 非法 side ${side}`);
    const opposite = side === 'buy' ? this.positions.short : this.positions.long;
    if (reduceOnly && opposite.size <= 0) {
      const e = new Error('paper: 无仓可减（reduceOnly 拒单）');
      e.code = 13056;
      e.benign = true;
      throw e;
    }
    if (!reduceOnly && opposite.size > 0) {
      // 与 Propr 一致：不报错，开的是反向新仓（这就是双边持仓的来源）
      // 但我们要让调用方知道这是危险动作
      this.lastDualSideWarningAt = Date.now();
    }
    const orderId = `paper-order-${++SEQ}`;
    this.orders.set(orderId, { orderId, side, price, sizeBase, reduceOnly, positionSide, timeInForce, createdAt: Date.now() });
    return { orderId, price, sizeBase };
  }

  cancelOrder(orderId) {
    if (!this.orders.has(orderId)) return null;
    this.orders.delete(orderId);
    return { orderId, status: 'cancelled' };
  }

  cancelAll() {
    const ids = [...this.orders.keys()];
    this.orders.clear();
    return ids;
  }

  /** 价格拍：撮合所有可成交的挂单，返回本拍成交。 */
  onPrice(px) {
    const fills = [];
    for (const [id, o] of [...this.orders]) {
      const hit = o.side === 'buy' ? px <= o.price : px >= o.price;
      if (!hit) continue;
      this.orders.delete(id);
      fills.push(this._fill(o, o.price));
    }
    return fills;
  }

  _fill(o, px) {
    const qty = o.sizeBase;
    const notional = px * qty;
    const feeRate = o.timeInForce === 'GTC' ? this.makerFee : this.takerFee;
    const fee = notional * feeRate;
    this.cash -= fee;
    this.feesPaid += fee;

    const book = o.side === 'buy' ? this.positions.long : this.positions.short;
    const opp = o.side === 'buy' ? this.positions.short : this.positions.long;
    const signed = o.side === 'buy' ? 1 : -1;
    let realized = 0;

    if (o.reduceOnly) {
      // 只有 reduceOnly 才平反向仓；且不会翻向，最多减到 0
      const closeQty = Math.min(qty, opp.size);
      realized += signed * (opp.entry - px) * closeQty;
      this.cash += realized;   // 已实现盈亏进现金，权益 = 现金 + 未实现
      opp.size = Math.round((opp.size - closeQty) * 1e8) / 1e8;
      if (opp.size === 0) opp.entry = 0;
    } else {
      // 非 reduceOnly：永远开/加自己这一侧 —— 这正是 Propr 双边持仓的来源
      book.entry = book.size > 0 ? (book.entry * book.size + px * qty) / (book.size + qty) : px;
      book.size = Math.round((book.size + qty) * 1e8) / 1e8;
    }
    this.realized += realized;

    const trade = {
      tradeId: `paper-trade-${++SEQ}`,
      orderId: o.orderId, side: o.side, qty, price: px, fee, feeRate,
      realizedPnl: realized, executedAt: new Date().toISOString(),
    };
    this.trades.push(trade);
    return trade;
  }

  getPositions() {
    const out = [];
    for (const side of ['long', 'short']) {
      const p = this.positions[side];
      if (p.size > 0) out.push({ side, size: p.size, entryPrice: p.entry });
    }
    return out;
  }

  get dualSide() {
    return this.positions.long.size > 0 && this.positions.short.size > 0;
  }

  equity(px) {
    const longPnl = this.positions.long.size * (px - this.positions.long.entry);
    const shortPnl = this.positions.short.size * (this.positions.short.entry - px);
    return this.cash + longPnl + shortPnl;
  }

  snapshot(px) {
    return {
      balance: this.cash,
      equity: px != null ? this.equity(px) : this.cash,
      positions: this.getPositions(),
      dualSide: this.dualSide,
      openOrders: this.orders.size,
      trades: this.trades.length,
      feesPaid: this.feesPaid,
      realized: this.realized,
    };
  }
}