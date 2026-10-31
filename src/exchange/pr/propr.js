// Propr 交易所适配器（GridBot 契约）。三种模式：
//   paper     — 真实 HL 行情 + 本地账本，不发任何请求
//   shadow    — 只读真实账户，绝不写
//   sim-write — 只允许 Free Trial 写入（challenge/live 在构造时硬拒绝）
//
// 关键立场：long / short 永远分开读、分开对账、分开平仓，绝不合并成净仓。
import { EventEmitter } from 'node:events';
import { ProprClient } from './client.js';
import { ProprWriter } from './write.js';
import { ProprPaper } from './paper.js';
import { HlMarketData, BTC_MARKET, roundPrice, roundSize } from './market.js';
import { parseAccount, splitPositions, openOrders, parseTrade, closeSide } from './mapper.js';
import { computeRiskState, evaluateWriteGate } from './risk.js';
import { ProprReadOnlyError, ProprOpeningBlockedError } from './errors.js';

const MODES = new Set(['paper', 'shadow', 'sim-write']);

export class ProprExchange extends EventEmitter {
  constructor(cfg = {}) {
    super();
    const mode = String(cfg.mode || 'paper').toLowerCase();
    if (!MODES.has(mode)) throw new Error(`PR_MODE=${mode} 被拒绝：challenge/live 不开放`);
    this.mode = mode;
    this.cfg = cfg;
    this.market = BTC_MARKET;
    this.feeRate = cfg.feeMaker ?? 0.00015;
    // bot 的间距校验里 displayFeeRate 按「费率」用（再 ×2×100 转 %），必须是 0.00015，不能是 0.015
    this.displayFeeRate = this.feeRate;
    this.balance = null;
    this.equity = null;
    this.realizedPnl = 0;
    this.operationalIssue = null;
    this.dataSource = null;
    this.lastOkAt = 0;
    this.supportsSafeOpeningRetry = true;
    this.orderBatchSize = 1;            // Propr 一次只允许一个入场单
    this.orderBatchPaceMs = 120;
    this.openingRetryBaseMs = 15_000;
    this.openingRetryMax = 6;
    this._tracked = new Map();          // orderId -> {levelIndex, side, price, sizeBase, reduceOnly, opening}
    this._seenTrades = new Set();
    this._lastPrice = null;
    this._timer = null;
    this._pollInFlight = false;
    this._paper = mode === 'paper' ? new ProprPaper({ startBalance: cfg.startBalance ?? 5000 }) : null;
    this._marketData = new HlMarketData({});
    this._risk = null;
    this._dualAck = false;
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  async init() {
    if (this.mode === 'paper') {
      this.balance = 5000;
      this.equity = 5000;
      this.dataSource = 'paper';
      this.lastOkAt = Date.now();
      this.start();
      return true;
    }
    if (!this.cfg.apiKey && !this.cfg.apiKeyFile) throw new Error('Propr 需要 PR_API_KEY 或 PR_API_KEY_FILE');
    if (!this.cfg.accountId) throw new Error('Propr 需要 PR_ACCOUNT_ID');
    this.client = new ProprClient({
      apiKey: this.cfg.apiKey,
      baseUrl: this.cfg.baseUrl,
      allowWrites: this.mode === 'sim-write',
      timeoutMs: 15_000,
    });
    const attempt = await this._resolveAttempt();
    this.attempt = attempt;
    await this._refresh();
    this.dataSource = 'real';
    this.lastOkAt = Date.now();
    this.start();
    return true;
  }

  async reconnect() {
    this.stop();
    return this.init();
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll().catch(() => {}), this.cfg.pollMs ?? 5000);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  setPollLight() { /* Propr 5s 轮询本身很轻，忽略 */ }

  async _resolveAttempt() {
    const body = await this.client.getAttempts({ limit: 50 });
    const rows = body?.data ?? [];
    const norm = (x) => String(x).replace(/^urn:prp-account:/, '');
    const hits = rows.filter((a) => norm(a.accountId) === norm(this.cfg.accountId));
    if (hits.length !== 1) throw new Error(`PR_ACCOUNT_ID 命中 ${hits.length} 个 attempt（应为 1）`);
    if (String(hits[0].status).toLowerCase() !== 'active') throw new Error(`attempt 状态 ${hits[0].status}，不是 active`);
    return hits[0];
  }

  // ── 轮询 ────────────────────────────────────────────────────────────────
  async _poll() {
    if (this._pollInFlight) return;
    this._pollInFlight = true;
    try {
      if (this.mode === 'paper') {
        const px = await this._marketData.getPrice(this.market.symbol);
        const fills = this._paper.onPrice(px);
        for (const f of fills) this.emit('fill', { orderId: f.orderId, marketId: 0, side: f.side, price: f.price, sizeBase: f.qty, levelIndex: this._tracked.get(f.orderId)?.levelIndex });
        this.balance = this._paper.cash;
        this.equity = this._paper.equity(px);
        this._emitPrice(px);
        this.lastOkAt = Date.now();
        return;
      }
      await this._refresh();
      this.lastOkAt = Date.now();
      this.operationalIssue = null;
    } catch (e) {
      this.operationalIssue = { title: 'Propr 数据异常', message: e.message };
      this.emit('error', e);
    } finally {
      this._pollInFlight = false;
    }
  }

  async _refresh() {
    const [acct, pos, ord, trd] = await Promise.all([
      this.client.getAccount(this.cfg.accountId),
      this.client.getPositions(this.cfg.accountId),
      this.client.getOrders(this.cfg.accountId, { status: 'open' }),
      this.client.getTradesPage(this.cfg.accountId, { limit: 100, offset: 0 }),
    ]);
    this._pruneTracked(new Set(openOrders(ord.rows).map((o) => String(o.orderId))));
    const a = parseAccount(acct);
    this.balance = a.balance;
    this.equity = a.equity;
    this._positions = splitPositions(pos.rows);
    this._openOrders = openOrders(ord.rows);
    this._risk = computeRiskState({
      equity: a.equity, balance: a.balance,
      dayStartBalance: this._dayStart ?? a.balance, startBalance: this.cfg.startBalance ?? 5000,
    });
    this._dayStart = this._dayKey() === this._dayKeyAt ? this._dayStart : a.balance;
    this._dayKeyAt = this._dayKey();

    // 成交 → fill 事件（只认本地跟踪过的单，避免幽灵成交）
    for (const raw of trd?.data ?? []) {
      const t = parseTrade(raw);
      if (!t.tradeId || this._seenTrades.has(t.tradeId)) continue;
      this._seenTrades.add(t.tradeId);
      const known = this._tracked.get(String(t.orderId));
      if (!known) continue;
      this.emit('fill', {
        orderId: String(t.orderId), marketId: 0, side: t.side,
        price: t.price, sizeBase: t.qty, levelIndex: known.levelIndex,
      });
      this._tracked.delete(String(t.orderId));   // 成交即离场：不论开/平，都不能再算作在途挂单
    }
    // 双边持仓：进入时告警一次；退出时复位
    if (this._positions?.dualSide && !this._dualSideActive) {
      this._dualSideActive = true;
      this.emit('dualside', { long: this._positions.long?.size ?? 0, short: this._positions.short?.size ?? 0 });
    } else if (!this._positions?.dualSide) {
      this._dualSideActive = false;
    }
    const px = await this._marketData.getPrice(this.market.symbol).catch(() => null);
    if (px) this._emitPrice(px);
  }

  _dayKey(now = Date.now()) { return Math.floor(now / 86_400_000); }

  /** 快照里已不存在、且已过宽限期的挂单 → 从 tracked 清掉（否则库存虚高、补挂被误挡）。 */
  _pruneTracked(liveIds, now = Date.now(), graceMs = 60_000) {
    let n = 0;
    for (const [id, t] of this._tracked) {
      if (liveIds.has(id)) continue;
      if (now - (t.placedAt || 0) > graceMs) { this._tracked.delete(id); n++; }
    }
    return n;
  }

  _emitPrice(px) {
    if (px === this._lastPrice) return;
    this._lastPrice = px;
    this.emit('price', { marketId: 0, price: px });
  }

  // ── 市场数据 ────────────────────────────────────────────────────────────
  async getMarkets() { return [this.market]; }
  getMarket() { return this.market; }
  async getPrice() { return this._marketData.getPrice(this.market.symbol); }
  async getCandles(_id, intervalSec = 3600, n = 200) { return this._marketData.getCandles(this.market.symbol, intervalSec, n); }

  // ── 持仓：两侧分开，绝不合并 ─────────────────────────────────────────────
  getPositions() {
    if (this.mode === 'paper') {
      const rows = this._paper.getPositions();
      const long = rows.find((p) => p.side === 'long') || null;
      const short = rows.find((p) => p.side === 'short') || null;
      return {
        long: long ? { side: 'long', size: long.size, entryPrice: long.entryPrice } : null,
        short: short ? { side: 'short', size: short.size, entryPrice: short.entryPrice } : null,
        dualSide: !!(long && short),
        netSize: (long?.size ?? 0) - (short?.size ?? 0),
      };
    }
    return this._positions || { long: null, short: null, dualSide: false, netSize: 0 };
  }

  getPosition() {
    const p = this.getPositions();
    const one = p.long || p.short;
    if (!one) return null;
    return {
      marketId: 0, side: one.side, sizeBase: one.size, entryPrice: one.entryPrice,
      markPrice: one.markPrice, liquidationPrice: one.liquidationPrice,
      unrealizedPnl: one.uPnl, marginUsed: one.marginUsed, leverage: one.leverage,
      dualSide: p.dualSide,
    };
  }

  /**
   * paired 模式：对腿只减仓。
   * 卖单只有在"有多仓可减"时才 reduceOnly；买单同理。初始铺单时两侧都为空，
   * 因此 seed 的买卖仍是开仓单（保留中性网格的对称入场）。
   */
  resolveReduceOnly({ side }) {
    if (this.cfg.gridSidePolicy !== 'paired') return undefined;
    const p = this.getPositions();
    return side === 'sell' ? (p.long?.size ?? 0) > 0 : (p.short?.size ?? 0) > 0;
  }

  // ── 订单 ────────────────────────────────────────────────────────────────
  /** bot 契约：必须返回**数组**（撤单确认按数组过滤 orderId）。 */
  async fetchOpenOrders() {
    if (this.mode === 'paper') {
      return [...this._paper.orders.values()].map((o) => ({ orderId: o.orderId, side: o.side, price: o.price, sizeBase: o.sizeBase, reduceOnly: o.reduceOnly }));
    }
    const res = await this.client.getOrders(this.cfg.accountId, { status: 'open' });
    return openOrders(res.rows).map((o) => ({ orderId: o.orderId, side: o.side, price: o.price, sizeBase: o.qty, reduceOnly: o.reduceOnly, positionSide: o.positionSide }));
  }

  getOpenOrders() { return [...this._tracked.entries()].map(([orderId, o]) => ({ orderId, ...o })); }
  adoptOrder(o) { this._tracked.set(String(o.orderId), { levelIndex: o.levelIndex, side: o.side, price: o.price, sizeBase: o.sizeBase, reduceOnly: !!o.reduceOnly, opening: o.opening !== false }); }
  forgetOrder(id) { this._tracked.delete(String(id)); }
  forgetOrders() { this._tracked.clear(); }

  async placeLimitOrder(o) {
    if (this.mode === 'shadow') throw new ProprReadOnlyError('下单');
    // bot 的 payload 不含 positionSide：按「开/平」推导
    //   开仓：buy→long / sell→short；平仓：sell→long / buy→short
    const positionSide = o.positionSide || (o.side === 'buy'
      ? (o.reduceOnly ? 'short' : 'long')
      : (o.reduceOnly ? 'long' : 'short'));
    if (this.mode === 'paper') {
      const r = this._paper.placeLimitOrder({ side: o.side, price: o.price, sizeBase: o.sizeBase, reduceOnly: o.reduceOnly, positionSide });
      this._tracked.set(r.orderId, { ...o });
      return r;
    }
    // 写门（P0）：只有「开仓」需要过闸；reduceOnly / 平仓永远放行。
    if (this.mode === 'sim-write' && !o.reduceOnly) {
      const px = Number(o.price) || 0;
      const qty = Number(o.sizeBase) || 0;
      const gate = evaluateWriteGate({
        mode: this.mode,
        allowLive: !!this.cfg.allowLive,
        attemptStatus: this.attempt?.status,
        accountAgeMs: Date.now() - (this.lastOkAt || 0),
        positions: this.getPositions(),
        risk: this._risk,
        notional: this._exposureNotional(px),
        maxOpenNotional: this.cfg.maxInvUsd,
        newNotional: px * qty,
        inventoryBtc: this._inventoryBtc(),
        maxInventoryBtc: this.cfg.maxInvBtc,
        newQty: qty,
      });
      if (!gate.allowOpen) throw new ProprOpeningBlockedError(gate.reasons);
    }
    if (!this.writer) this.writer = new ProprWriter({ client: this.client, accountId: this.cfg.accountId, asset: this.market.asset, paceMs: 120 });
    let row;
    try {
      row = await this.writer.placeLimitOrder({
        ...o, positionSide,
        timeInForce: o.timeInForce || this.cfg.timeInForce || 'GTC',
      });
    } catch (e) {
      if (isNoPositionToReduce(e)) {
        const benign = new Error(`无仓可减，丢弃该 reduceOnly 腿（${o.side} @ ${o.price}）`);
        benign.benign = true;
        throw benign;
      }
      throw e;
    }
    this._tracked.set(String(row.orderId), { levelIndex: o.levelIndex, side: o.side, price: o.price, sizeBase: o.sizeBase, reduceOnly: !!o.reduceOnly, opening: o.opening !== false, placedAt: Date.now() });
    return { orderId: row.orderId, price: o.price, sizeBase: o.sizeBase };
  }

  /** bot 契约：等长、同序、逐项。串行执行，失败项返回 null。 */
  async placeLimitOrders(list) {
    const out = [];
    for (const o of list) {
      try { out.push(await this.placeLimitOrder(o)); }
      catch (e) {
        if (e?.benign) { out.push({ benign: true, error: e.message }); continue; }
        this.emit('error', e); out.push(null);
      }
      if (this.orderBatchPaceMs) await new Promise((r) => setTimeout(r, this.orderBatchPaceMs));
    }
    return out;
  }

  async cancelOrder(_marketId, orderId) {
    if (this.mode === 'shadow') throw new ProprReadOnlyError('撤单');
    if (this.mode === 'paper') { this._paper.cancelOrder(orderId); this._tracked.delete(String(orderId)); return true; }
    const r = await this.writer.cancelOrder(orderId);
    this._tracked.delete(String(orderId));
    return r;
  }

  async cancelAll() {
    if (this.mode === 'shadow') throw new ProprReadOnlyError('批量撤单');
    if (this.mode === 'paper') { this._paper.cancelAll(); this._tracked.clear(); return { cancelled: [], remaining: 0 }; }
    if (!this.writer) this.writer = new ProprWriter({ client: this.client, accountId: this.cfg.accountId, asset: this.market.asset });
    const r = await this.writer.cancelAll();
    if (r.remaining === 0) this._tracked.clear();
    return r;
  }

  async closePosition() {
    if (this.mode === 'shadow') throw new ProprReadOnlyError('平仓');
    if (this.mode === 'paper') {
      this._paper.cancelAll();
      for (const p of this._paper.getPositions()) {
        this._paper.placeLimitOrder({ side: closeSide(p.side), price: this._lastPrice, sizeBase: p.size, reduceOnly: true, positionSide: p.side, timeInForce: 'IOC' });
      }
      this._paper.onPrice(this._lastPrice);
      return { closed: true };
    }
    if (!this.writer) this.writer = new ProprWriter({ client: this.client, accountId: this.cfg.accountId, asset: this.market.asset });
    return this.writer.closePosition(this.market.asset);
  }

  /** 当前敞口：持仓名义 + 所有未成交 opening 挂单名义（含 reduceOnly? 不含）。 */
  _exposureNotional(px = 0) {
    const p = this.getPositions();
    const price = px || this._lastPrice || 0;
    const posN = ((p.long?.size || 0) + (p.short?.size || 0)) * price;
    let ordN = 0;
    for (const t of this._tracked.values()) {
      if (t.reduceOnly) continue;
      ordN += (Number(t.price) || 0) * (Number(t.sizeBase) || 0);
    }
    return posN + ordN;
  }

  /** gross 库存（long+short）＋ 在途 opening 挂单，不是 net。 */
  _inventoryBtc() {
    const p = this.getPositions();
    let q = (p.long?.size || 0) + (p.short?.size || 0);
    for (const t of this._tracked.values()) {
      if (!t.reduceOnly) q += Number(t.sizeBase) || 0;
    }
    return q;
  }

  /** 面板用状态：账户脱敏、双侧持仓、双边冻结、写尝试次数。 */
  getState() {
    const p = this.getPositions();
    const mask = (x) => (x ? String(x).replace(/(urn:prp-account:.{4}).*/, '$1…') : null);
    return {
      mode: this.mode,
      accountId: mask(this.cfg.accountId),
      attemptStatus: this.attempt?.status ?? null,
      long: p.long?.size ?? 0,
      short: p.short?.size ?? 0,
      dualSide: !!p.dualSide,
      net: roundSize(p.netSize ?? 0),
      gross: roundSize((p.long?.size ?? 0) + (p.short?.size ?? 0)),
      inventoryCapBtc: this.cfg.maxInvBtc ?? null,
      openOrders: this.mode === 'paper' ? this._paper.orders.size : (this._openOrders?.length ?? 0),
      equity: typeof this.equity === 'number' ? Math.round(this.equity * 100) / 100 : null,
      balance: typeof this.balance === 'number' ? Math.round(this.balance * 100) / 100 : null,
      writeAttemptCount: this.client?.writeAttemptCount ?? 0,
      apiStatus: this.operationalIssue ? 'degraded' : (this.dataSource || 'init'),
      lastOkAt: this.lastOkAt || null,
      policy: { gridSide: this.cfg.gridSidePolicy || 'dual', dualSide: this.cfg.dualSidePolicy || 'freeze' },
      risk: this._risk ?? null,
    };
  }

  async setLeverage() {
    // 规则不允许交易者改杠杆；返回 null 表示「该所不支持此调用」，
    // bot 只对 === false 告警，因此不会刷屏。
    return null;
  }
}

function isNoPositionToReduce(e) {
  if (!e) return false;
  const msg = String(e.message || '');
  return e.status === 400 && /reduce|position|no position/i.test(msg);
}

export { parseAccount, splitPositions, openOrders, roundPrice, roundSize };