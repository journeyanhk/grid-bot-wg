// 写路径（M2）：下单 / 撤单 / 全撤 / 平仓。全部经 client.post，因此：
//   1) shadow/paper 下不可达（allowWrites=false）
//   2) 每次写都会计入 writeAttemptCount
//   3) 幂等冲突（13084）→ 先对账，绝不盲目重发
import { ProprApiError, ProprReadOnlyError, CODES, classify } from './errors.js';
import { buildLimitOrder, closeSide, openOrders, parseOrder, splitPositions } from './mapper.js';
import { placeBatch, toBotResults } from './batch.js';
import { ulid } from './client.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProprWriter {
  constructor({ client, accountId, asset = 'BTC', paceMs = 120, sleep = defaultSleep, quote = 'USDC' }) {
    if (!client) throw new Error('ProprWriter 需要 client');
    if (!accountId) throw new Error('ProprWriter 需要 accountId');
    this.client = client;
    this.accountId = accountId;
    this.asset = asset;
    this.quote = quote;
    this.paceMs = paceMs;
    this.sleep = sleep;
  }

  get writeAttempts() { return this.client.writeAttemptCount; }

  /** 单笔限价单。返回原始 order 行。 */
  async placeLimitOrder(o) {
    const payload = buildLimitOrder({
      accountId: this.accountId,
      asset: o.asset || this.asset,
      side: o.side,
      positionSide: o.positionSide,
      qty: Number(o.qty ?? o.sizeBase),
      price: Number(o.price),
      reduceOnly: !!o.reduceOnly,
      timeInForce: o.timeInForce || 'GTC',
      intentId: o.intentId || ulid(),
    });
    try {
      const body = await this.client.post('createOrder', [this.accountId], { orders: [payload] });
      const row = body?.data?.[0];
      if (!row?.orderId) throw new Error('下单响应缺少 orderId');
      return row;
    } catch (e) {
      // 13084 / 超时 / 5xx：单可能已经建了 —— 先按 (side, price, qty) 对账
      const c = classify(e);
      if (c.mayExist) {
        const found = await this._findExisting(payload);
        if (found) return found;
      }
      throw e;
    }
  }

  /** 串行批量。返回等长同序的逐项结果（见 batch.js）。 */
  async placeLimitOrders(list) {
    const results = await placeBatch({
      orders: list, paceMs: this.paceMs, sleep: this.sleep,
      placeOne: (o) => this.placeLimitOrder(o),
    });
    return { items: results, bot: toBotResults(results) };
  }

  /** 撤单：201/200 成功；400 视为已终结（已成交/已撤），返回 null。 */
  async cancelOrder(orderId) {
    try {
      const body = await this.client.post('cancelOrder', [this.accountId, orderId], null);
      return body?.data ?? body ?? { orderId };
    } catch (e) {
      if (e?.status === 400) return null;           // 已成交/已撤/已过期：可忽略
      if (e?.status === 404) return null;
      throw e;
    }
  }

  /** 全撤 + 终态确认：分页拉全，逐张撤，再拉一次直到 open=0（或达上限）。 */
  async cancelAll({ attempts = 6, verifyDelayMs = 800 } = {}) {
    const cancelled = [];
    for (let round = 0; round < attempts; round++) {
      const res = await this.client.getOrders(this.accountId, { status: 'open' });
      const open = openOrders(res.rows);
      if (!open.length) return { cancelled, remaining: 0, rounds: round };
      for (const o of open) {
        const r = await this.cancelOrder(o.orderId);
        if (r) cancelled.push(o.orderId);
      }
      if (verifyDelayMs) await this.sleep(verifyDelayMs);
    }
    const left = getLeft(await this.client.getOrders(this.accountId, { status: 'open' }));
    return { cancelled, remaining: left, rounds: attempts };
  }

  /** 平掉某标的的两侧（有哪侧平哪侧），全部 reduceOnly + closePosition。 */
  async closePosition(asset = this.asset) {
    const res = await this.client.getPositions(this.accountId, { asset });
    const { long, short } = splitPositions(res.rows);
    const out = [];
    for (const p of [long, short]) {
      if (!p || p.size <= 0) continue;
      const row = await this.placeMarketOrder({
        side: closeSide(p.side), positionSide: p.side, qty: p.size, reduceOnly: true, closePosition: true, asset,
      });
      out.push({ side: p.side, size: p.size, orderId: row.orderId });
    }
    return out;
  }

  /** 市价单：只用于止损/平仓，taker 费率。 */
  async placeMarketOrder({ side, positionSide, qty, reduceOnly = true, closePosition = false, asset = this.asset }) {
    const payload = {
      accountId: this.accountId,
      intentId: ulid(),
      exchange: 'hyperliquid',
      type: 'market',
      side,
      positionSide,
      productType: 'perp',
      timeInForce: 'IOC',
      asset,
      base: asset,
      quote: this.quote,
      quantity: String(qty),
      reduceOnly: !!reduceOnly,
      closePosition: !!closePosition,
    };
    const body = await this.client.post('createOrder', [this.accountId], { orders: [payload] });
    const row = body?.data?.[0];
    if (!row?.orderId) throw new Error('市价单响应缺少 orderId');
    return row;
  }

  async _findExisting(payload) {
    const res = await this.client.getOrders(this.accountId, { status: 'open', base: payload.base });
    const hit = openOrders(res.rows).find((o) =>
      o.side === payload.side &&
      Number(o.price) === Number(payload.price) &&
      Math.abs(o.qty - Number(payload.quantity)) < 1e-9);
    return hit ? hit.raw : null;
  }
}

function getLeft(res) {
  const rows = res?.rows ?? [];
  return openOrders(rows).length;
}

export { ProprApiError, ProprReadOnlyError, CODES, parseOrder };