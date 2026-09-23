// Propr 交易所适配器（net 单向净仓）。
//
// 范围（Review 2）：启动校验链、只读路径、行情、权益、订单/成交轮询与事件。
// 写路径（placeLimitOrder/placeLimitOrders/cancelOrder/cancelAll/closePosition/setLeverage）
// 属 Review 3，当前显式抛「未实现」，避免在未完成幂等与对账前误发真实写请求。
//
// 行情来源（ADR-007）：Propr 无公开行情端点，价格/K 线取自底层交易所 Hyperliquid 公开 API
// （allMids / candleSnapshot）。标记价与 HL 中间价可能有微小差异，网格按 tick 铺单足够。
import { EventEmitter } from 'node:events';
import { ProprClient } from './propr-sdk.js';
import { ProprStartupError } from './errors.js';
import { buildMarket, toEpochMs, PROPR_MAKER_FEE } from './market.js';
import { mapProprOrder, mapProprPosition, mapProprTrade, netPositionFromViews } from './mapper.js';
import { createDispatcher } from '../../proxy.js';
import { logger } from '../../log.js';
import { maskAccountId } from '../../redact.js';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const CANDLE_INTERVALS = new Map([
  [60, '1m'], [300, '5m'], [900, '15m'], [1800, '30m'], [3600, '1h'],
  [14400, '4h'], [43200, '12h'], [86400, '1d'], [604800, '1w'],
]);
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const EQUITY_STALE_MS = 60_000;

export class ProprExchange extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.mode = cfg.mode ?? 'sim-write';
    this.network = 'mainnet';
    this.apiUrl = cfg.apiUrl;
    this.wsUrl = cfg.wsUrl;
    this.base = String(cfg.base || 'BTC').toUpperCase();
    this.quote = 'USDC';
    this.accountId = cfg.accountId || '';
    this.attemptId = null;
    this.client = null;
    this.market = null;
    this.dataSource = null;
    this.operationalIssue = null;
    this.lastOkAt = 0;

    // 账户/权益（权威字段，ADR-004）
    this.equity = 0;
    this.balance = 0;
    this.realizedPnl = 0;
    this.highWaterMark = 0;
    this.availableBalance = 0;
    this.totalUnrealizedPnl = 0;
    this.equitySource = null;
    this.equityFreshAt = 0;
    this.equityStale = true;

    // 能力位
    this.positionMode = 'net';
    this.supportsSafeOpeningRetry = true; // intentId 幂等（Day-0 实测）
    this.orderBatchSize = 10;

    this._cfg = cfg;
    this._positions = [];
    this._orders = new Map();       // orderId → 内部订单视图（含 levelIndex）
    this._seenTrades = new Set();   // 去重：避免重启后重复补单
    this._price = 0;
    this._priceTimer = null;
    this._pollTimer = null;
    this._pollLight = false;
    this._stopped = false;
  }

  get orderBatchPaceMs() { return this._pollLight ? 400 : 200; }
  get openingRetryBaseMs() { return 3000; }
  get openingRetryMax() { return 3; }
  get displayFeeRate() { return this.market?.makerFee ?? PROPR_MAKER_FEE; }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  async init() {
    if (this._cfg.proxy) {
      const dispatcher = await createDispatcher(this._cfg.proxy);
      if (dispatcher) {
        const { setGlobalDispatcher } = await import('undici');
        setGlobalDispatcher(dispatcher);
      }
    }
    this.client = new ProprClient({ apiKey: this._cfg.apiKey, baseUrl: this.apiUrl, timeout: this._cfg.timeoutMs });

    await this.client.health();
    await this.client.healthServices();
    const user = await this.client.getUser();
    if (!user?.userId) throw new ProprStartupError('getUser 未返回 userId');

    const attempt = await this._bindAccount();
    this.attemptId = attempt.attemptId;
    if (attempt.status !== 'active') throw new ProprStartupError(`Challenge 状态非 active: ${attempt.status}`);

    const marginConfig = await this.client.getMarginConfig(this.base);
    const leverageLimits = await this.client.getLeverageLimits();
    this.market = buildMarket({
      base: this.base, quote: this.quote, marginConfig, leverageLimits,
      markPrice: await this._fetchMidPrice().catch(() => 0),
    });
    this.feeRate = Number(this._cfg.feeRate ?? this.market.makerFee);

    await this._refreshEquity();
    await this._refreshPositions();
    await this._refreshOpenOrders();
    await this._seedTrades();
    this._price = await this._fetchMidPrice().catch(() => this._price);

    this.dataSource = 'real';
    this.lastOkAt = Date.now();
    this.start();
    logger.info('propr', `已连接 Propr（${this.mode}），账户 ${maskAccountId(this.accountId)}，BTC 最大杠杆 ${this.market.maxLeverage}x`);
    return true;
  }

  async reconnect() {
    this.stop();
    this._stopped = false;
    return this.init();
  }

  start() {
    if (this._stopped) return;
    if (!this._priceTimer) {
      this._priceTimer = setInterval(() => this._pollPrice(), 2000);
      this._priceTimer.unref?.();
    }
    if (!this._pollTimer) {
      this._pollTimer = setInterval(() => this._poll(), this._cfg.orderPollMs || 3000);
      this._pollTimer.unref?.();
    }
  }

  stop() {
    if (this._priceTimer) clearInterval(this._priceTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._priceTimer = null;
    this._pollTimer = null;
  }

  setPollLight(value) { this._pollLight = !!value; }

  // ── 启动校验 ──────────────────────────────────────────────────────────────

  /** 严格绑定配置账户：绝不回退 active[0]（Review2 P0）。 */
  async _bindAccount() {
    const active = await this.client.getChallengeAttempts({ status: 'active' });
    const attempt = active.find((a) => a.accountId === this.accountId);
    if (!attempt) {
      throw new ProprStartupError(`指定账户 ${maskAccountId(this.accountId)} 不在 active attempts 中（禁止自动发现）`);
    }
    this.client.accountId = attempt.accountId;
    return attempt;
  }

  // ── 行情（HL 公开 API，ADR-007）────────────────────────────────────────────

  async _fetchMidPrice() {
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
    });
    if (!res.ok) throw new Error(`HL allMids HTTP ${res.status}`);
    const mids = await res.json();
    const px = Number(mids?.[this.base]);
    if (!Number.isFinite(px) || px <= 0) throw new Error(`无法获取 ${this.base} 中间价（HL allMids）`);
    return px;
  }

  async getMarkets() { return this.market ? [this.market] : []; }

  getMarket(marketId) { return this.market && String(marketId) === this.market.marketId ? this.market : null; }

  async getPrice() { return this._price; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const interval = CANDLE_INTERVALS.get(Number(intervalSec)) || '1h';
    const end = Date.now();
    const start = end - Number(n) * Number(intervalSec) * 1000;
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: this.base, interval, startTime: start, endTime: end } }),
    });
    if (!res.ok) throw new Error(`HL candleSnapshot HTTP ${res.status}`);
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : [])
      .map((r) => ({ time: toEpochMs(r.t), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v || 0) }))
      .filter((r) => r.time > 0 && Number.isFinite(r.close))
      .sort((a, b) => a.time - b.time);
  }

  // ── 分页（官方默认 limit:20/offset:0，Review1 复审要求）────────────────────

  async _paginate(fetchPage) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchPage(PAGE_LIMIT, page * PAGE_LIMIT);
      out.push(...(rows || []));
      if (!rows || rows.length < PAGE_LIMIT) break;
    }
    return out;
  }

  async getAllOrders(params = {}) {
    return this._paginate((limit, offset) => this.client.getOrders({ ...params, limit, offset }));
  }

  async getAllTrades(params = {}) {
    return this._paginate((limit, offset) => this.client.getTrades({ ...params, limit, offset }));
  }

  async getAllPositions(params = {}) {
    return this._paginate((limit, offset) => this.client.getPositions({ ...params, limit, offset, excludeZero: false }));
  }

  // ── 持仓（net 净仓）───────────────────────────────────────────────────────

  async _refreshPositions() {
    const rows = await this.client.getPositions({ base: this.base, status: 'open' });
    this._positions = rows.map(mapProprPosition);
  }

  /** GridBot 契约：同步返回带符号净仓（多正空负）。 */
  getPosition() {
    return netPositionFromViews(this._positions);
  }

  async getPositions() { return [...this._positions]; }

  // ── 订单 ──────────────────────────────────────────────────────────────────

  async _refreshOpenOrders() {
    const rows = await this.getAllOrders({ base: this.base, status: 'open' });
    const live = new Map();
    for (const raw of rows) {
      const known = this._orders.get(String(raw.orderId));
      const view = mapProprOrder(raw, { levelIndex: known?.levelIndex ?? null });
      live.set(view.orderId, view);
    }
    this._orders = live;
  }

  getOpenOrders() { return [...this._orders.values()]; }

  async fetchOpenOrders() {
    await this._refreshOpenOrders().catch(() => {});
    return [...this._orders.values()];
  }

  adoptOrder(order = {}) {
    const orderId = String(order.orderId ?? '');
    if (!orderId) return;
    const existing = this._orders.get(orderId);
    const view = mapProprOrder(order.raw ?? order, { levelIndex: order.levelIndex ?? existing?.levelIndex ?? null });
    // 合并而非覆盖：GridBot 的 adoptOrder 只带 levelIndex/side/price/sizeBase，
    // 不能因此丢掉 refreshOpenOrders 已拿到的 intentId（幂等键）等字段。
    this._orders.set(orderId, {
      ...existing,
      ...view,
      orderId,
      clientOrderId: view.clientOrderId ?? existing?.clientOrderId ?? null,
      levelIndex: order.levelIndex ?? existing?.levelIndex ?? null,
      side: order.side ?? existing?.side ?? view.side,
      price: order.price ?? existing?.price ?? view.price,
      sizeBase: order.sizeBase ?? existing?.sizeBase ?? view.sizeBase,
    });
  }

  forgetOrder(orderId) { this._orders.delete(String(orderId)); }

  forgetOrders() { this._orders.clear(); }

  // ── 成交 ──────────────────────────────────────────────────────────────────

  async _seedTrades() {
    const rows = await this.client.getTrades({ base: this.base, limit: 50 });
    for (const raw of rows) {
      const t = mapProprTrade(raw);
      if (t.tradeId) this._seenTrades.add(t.tradeId);
    }
  }

  async _refreshTrades() {
    const rows = (await this.client.getTrades({ base: this.base, limit: 50 })).map(mapProprTrade);
    const fresh = [];
    for (const t of rows) {
      if (!t.tradeId || this._seenTrades.has(t.tradeId)) continue;
      this._seenTrades.add(t.tradeId);
      fresh.push(t);
    }
    for (const t of fresh.reverse()) {
      const known = this._orders.get(t.orderId);
      this.realizedPnl += Number(t.realizedPnl || 0) - Number(t.fee || 0);
      this.emit('fill', {
        orderId: t.orderId,
        marketId: t.marketId ?? this.base,
        side: t.side,
        price: t.price,
        sizeBase: t.sizeBase,
        levelIndex: known?.levelIndex ?? null,
        clientOrderId: known?.clientOrderId ?? null,
      });
      this._orders.delete(t.orderId);
    }
  }

  async getTrades(params = {}) { return this.client.getTrades({ base: this.base, ...params }); }

  /** 审计用：按时间窗拉取成交（executedAt >= sinceMs）。 */
  async fetchTradesWindow(sinceMs = 0) {
    const rows = await this.getAllTrades({ base: this.base });
    return rows.map(mapProprTrade).filter((t) => t.executedAt >= Number(sinceMs || 0));
  }

  // ── 权益（权威字段 + 新鲜度，ADR-004）─────────────────────────────────────

  async _refreshEquity() {
    const attempt = await this.client.getChallengeAttempt(this.attemptId);
    const acc = attempt?.account || {};
    const balance = Number(acc.balance);
    if (!Number.isFinite(balance)) {
      this.equityStale = true;
      throw new ProprStartupError('Propr account.balance 不可用（权益字段缺失）');
    }
    this.balance = balance;
    this.equity = Number(acc.marginBalance ?? balance);
    this.highWaterMark = Number(acc.highWaterMark ?? 0);
    this.availableBalance = Number(acc.availableBalance ?? 0);
    this.totalUnrealizedPnl = Number(acc.totalUnrealizedPnl ?? 0);
    this.equitySource = 'propr_account';
    this.equityFreshAt = Date.now();
    this.equityStale = false;
  }

  get equityAgeMs() { return this.equityFreshAt ? Date.now() - this.equityFreshAt : Infinity; }

  isEquityStale(maxAgeMs = EQUITY_STALE_MS) { return this.equityStale || this.equityAgeMs > maxAgeMs; }

  // ── 轮询 ──────────────────────────────────────────────────────────────────

  async _pollPrice() {
    try {
      const px = await this._fetchMidPrice();
      if (px > 0) {
        this._price = px;
        this.lastOkAt = Date.now();
        this.emit('price', { marketId: this.base, price: px });
      }
    } catch (err) { this._emitError(err); }
  }

  async _poll() {
    try {
      await this._refreshPositions();
      await this._refreshOpenOrders();
      await this._refreshTrades();
      await this._refreshEquity().catch(() => { this.equityStale = true; });
      this.lastOkAt = Date.now();
    } catch (err) { this._emitError(err); }
  }

  _emitError(err) {
    const mapped = { kind: 'unknown', statusCode: null, code: null, message: err?.message ?? String(err) };
    logger.warn('propr', `Propr 轮询异常: ${mapped.message}`, mapped);
    if (this.listenerCount('error') > 0) {
      this.emit('error', Object.assign(new Error(mapped.message), mapped));
    }
  }

  // ── 写路径（Review 3 实现；当前显式拒绝，避免未完成幂等前误写）─────────────

  _notImplemented(action) {
    throw new Error(`Propr ${action} 将在 Review 3 提供（写路径 + intentId 幂等 + 对账）。`);
  }

  async setLeverage() { this._notImplemented('setLeverage'); }
  async placeLimitOrder() { this._notImplemented('placeLimitOrder'); }
  async placeLimitOrders() { this._notImplemented('placeLimitOrders'); }
  async cancelOrder() { this._notImplemented('cancelOrder'); }
  async cancelAll() { this._notImplemented('cancelAll'); }
  async closePosition() { this._notImplemented('closePosition'); }
}
