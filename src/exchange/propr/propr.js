// Propr 交易所适配器（net 单向净仓）。
//
// 范围（Review 2）：启动校验链、只读路径、行情、权益、订单/成交轮询与事件。
// 写路径（placeLimitOrder/placeLimitOrders/cancelOrder/cancelAll/closePosition/setLeverage）
// 属 Review 3，当前显式抛「未实现」，避免在未完成幂等与对账前误发真实写请求。
//
// 行情来源（ADR-007）：Propr 无公开行情端点，价格/K 线取自底层交易所 Hyperliquid 公开 API
// （allMids / candleSnapshot）。标记价与 HL 中间价可能有微小差异，网格按 tick 铺单足够。
import { EventEmitter } from 'node:events';
import { ulid } from 'ulid';
import { ProprClient } from './propr-sdk.js';
import { ProprStartupError, UnknownOrderStateError, isIdempotencyConflict } from './errors.js';
import { buildMarket, toEpochMs, roundQty, roundPrice, assertOrderPrecision, PROPR_MAKER_FEE } from './market.js';
import {
  mapProprOrder, mapProprPosition, mapProprTrade, mapProprMargin, mapProprError,
  netPositionFromViews, LIVE_STATUSES, TERMINAL_STATUSES, ALL_STATUSES,
} from './mapper.js';
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
// 成交轮询：常规轮询最多翻 5 页（500 条），并在游标前留 30s 重叠窗口防边界漏单；
// 重连/恢复走 full 全量（最多 MAX_PAGES 页）。
const TRADE_OVERLAP_MS = 30_000;
const TRADE_MAX_PAGES = 5;
const MAX_INTENTS = 500;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    // 新鲜度分离（Review4 P1）：行情来自 HL 公开 API，账户/订单/持仓/权益来自 Propr API。
    // 二者必须分开计时，否则「Propr API 失联但行情正常」会被看门狗误判为健康。
    this.lastPriceOkAt = 0;
    this.lastApiOkAt = 0;
    this._dispatcher = null;

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
    this.attemptStatus = null;     // 挑战状态（active/passed/failed）→ 风控 BREACHED 判定
    this.startingBalance = null;   // 挑战起始余额（平台口径）
    this.riskState = null;         // 挑战风控层写入，经 getPublicInfo 透出
    this.riskGateEnabled = false;  // 风控层启用标记：true 时开仓必须经风险状态硬拦截（fail closed）

    // 能力位
    this.positionMode = 'net';
    this.supportsSafeOpeningRetry = true; // intentId 幂等（Day-0 实测）
    this.orderBatchSize = 10;

    this._cfg = cfg;
    this._positions = [];
    this._orders = new Map();       // orderId → 内部订单视图（含 levelIndex）
    this._seenTrades = new Set();   // 去重：避免重启/重叠窗口重复补单
    this._lastTradeAt = 0;          // 成交时间游标（epoch ms）
    this._price = 0;
    this._priceTimer = null;
    this._pollTimer = null;
    this._pollLight = false;
    this._stopped = false;
    // 写路径（Review 3）：意图日志（幂等键 → 意图）+ 交易锁定
    this._intents = new Map();
    this.tradingLocked = false;
    this.lockReason = null;
    // 活动订单快照完整性（Review3 复审 P0）：任一状态查询失败即置 stale，禁止开仓
    this.ordersSnapshotStale = false;
    this.ordersSnapshotError = null;
  }

  get orderBatchPaceMs() { return this._pollLight ? 400 : 200; }
  get openingRetryBaseMs() { return 3000; }
  get openingRetryMax() { return 3; }
  get displayFeeRate() { return this.market?.makerFee ?? PROPR_MAKER_FEE; }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  async init({ resume = false } = {}) {
    // PR_PROXY 走 per-client dispatcher，绝不改全局 dispatcher（避免与其它交易所代理竞态）
    if (this._cfg.proxy) {
      this._dispatcher = await createDispatcher(this._cfg.proxy);
      if (!this._dispatcher) throw new ProprStartupError('PR_PROXY 无法初始化，拒绝启动（避免直连）');
    }
    this.client = new ProprClient({
      apiKey: this._cfg.apiKey, baseUrl: this.apiUrl, timeout: this._cfg.timeoutMs,
      dispatcher: this._dispatcher,
    });

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
    // 费率：配置留空时用实测市场 maker 费率（0.00015），不覆盖市场值（Review2 P2）
    this.feeRate = Number.isFinite(this._cfg.feeRate) ? this._cfg.feeRate : this.market.makerFee;

    await this._refreshEquity();
    await this._refreshPositions();
    await this._refreshOpenOrders();
    if (resume) {
      // 重连补偿：全量成交对账，把断线期间漏掉的成交补发为 fill（tradeId 去重，绝不重复补单）
      await this._refreshTrades({ full: true });
      logger.warn('propr', '重连完成：已对账并补偿断线期间的成交');
    } else {
      await this._seedTrades();
    }
    this._price = await this._fetchMidPrice().catch(() => this._price);

    this.dataSource = 'real';
    this.lastOkAt = Date.now();
    this.lastApiOkAt = this.lastOkAt; // 初始化/对账全部完成后即视为 API 健康（Review6）
    this.start();
    logger.info('propr', `已连接 Propr（${this.mode}），账户 ${maskAccountId(this.accountId)}，BTC 最大杠杆 ${this.market.maxLeverage}x`);
    return true;
  }

  async reconnect() {
    // 同进程重连：需要补偿断线期间的成交（emit 缺失 fill，_seenTrades 去重保证只补一次）；
    // 进程重启走 init() 的 seed 路径，不补发历史成交（避免重复补单），由 bot.resume 对账接管。
    const resume = this.dataSource != null;
    this.stop();
    this._stopped = false;
    return this.init({ resume });
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
      ...(this._dispatcher ? { dispatcher: this._dispatcher } : {}),
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
      ...(this._dispatcher ? { dispatcher: this._dispatcher } : {}),
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

  /**
   * 活动挂单 = pending / open / partially_filled（Review2 P1）。
   * 只查 open 会漏掉刚提交（pending）与部分成交（partially_filled）的订单，
   * 导致对账误判订单不存在并重复补单。
   * Review3 复审 P0：**任一状态查询失败即视为快照不完整**——保留旧快照、置 stale、抛错，
   * 绝不用部分结果覆盖本地订单表（否则失败状态的订单会"消失"）。
   */
  async _refreshOpenOrders() {
    const results = await Promise.allSettled(
      LIVE_STATUSES.map((status) => this.getAllOrders({ base: this.base, status })),
    );
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) {
      this._markOrdersSnapshotStale(failed.reason);
      throw failed.reason ?? new Error('活动挂单刷新失败');
    }
    const live = new Map();
    for (const r of results) {
      for (const raw of r.value) {
        const id = String(raw.orderId);
        if (live.has(id)) continue;
        const known = this._orders.get(id);
        live.set(id, mapProprOrder(raw, { levelIndex: known?.levelIndex ?? null }));
      }
    }
    this._orders = live;
    this.ordersSnapshotStale = false;
    this.ordersSnapshotError = null;
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

  /** 分页拉取成交：full=true 用于重连/恢复（全量，最多 MAX_PAGES 页）；常规轮询用游标+重叠窗口。 */
  async _pullTrades({ full = false } = {}) {
    const maxPages = full ? MAX_PAGES : TRADE_MAX_PAGES;
    const out = [];
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.client.getTrades({ base: this.base, limit: PAGE_LIMIT, offset: page * PAGE_LIMIT });
      const mapped = (batch || []).map(mapProprTrade);
      out.push(...mapped);
      if (!batch || batch.length < PAGE_LIMIT) break;
      const oldest = mapped.reduce((min, t) => Math.min(min, t.executedAt || Infinity), Infinity);
      if (!full && this._lastTradeAt > 0 && oldest < this._lastTradeAt - TRADE_OVERLAP_MS) break;
    }
    return out;
  }

  async _seedTrades() {
    const rows = await this._pullTrades({ full: true });
    for (const t of rows) {
      if (t.tradeId) this._seenTrades.add(t.tradeId);
      if (t.executedAt > this._lastTradeAt) this._lastTradeAt = t.executedAt;
    }
  }

  async _refreshTrades({ full = false } = {}) {
    const rows = await this._pullTrades({ full });
    // Review3 复审 P1：tradeId 去重是最终标准，**不得用时间窗口丢弃未见过的成交**
    //（漏一笔成交=漏一条补单；重复可由 tradeId 兜住）。游标只在最后推进，仅用于减少后续分页范围。
    const fresh = [];
    for (const t of rows) {
      if (!t.tradeId || this._seenTrades.has(t.tradeId)) continue;
      this._seenTrades.add(t.tradeId);
      fresh.push(t);
    }
    for (const t of rows) {
      if (t.executedAt > this._lastTradeAt) this._lastTradeAt = t.executedAt;
    }
    fresh.sort((a, b) => a.executedAt - b.executedAt);
    for (const t of fresh) {
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

  /** 原始成交（保持 Propr 字段口径）。 */
  async getRawTrades(params = {}) { return this.client.getTrades({ base: this.base, ...params }); }

  /** 内部统一成交视图（与其它路径同口径，Review2 P2）。 */
  async getTrades(params = {}) { return (await this.getRawTrades(params)).map(mapProprTrade); }

  /** 审计用：按时间窗拉取成交（全量分页后过滤 executedAt >= sinceMs）。 */
  async fetchTradesWindow(sinceMs = 0) {
    const rows = await this._pullTrades({ full: true });
    return rows.filter((t) => t.executedAt >= Number(sinceMs || 0));
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
    this.attemptStatus = attempt?.status ?? null;
    this.startingBalance = Number(attempt?.phases?.[0]?.startingBalance) || this.startingBalance || null;
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
        this.lastPriceOkAt = Date.now(); // 只代表行情健康，不代表 Propr API 健康（Review4 P1）
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
      this.lastApiOkAt = Date.now();
      this.lastOkAt = this.lastApiOkAt; // 看门狗（sim-write/challenge）以此为准
    } catch (err) { this._emitError(err); }
  }

  _emitError(err) {
    // 统一走 mapProprError（分类 + 脱敏）：事件会被 server/SSE/通知/AI 直接消费（Review2 P1）
    const mapped = mapProprError(err);
    logger.warn('propr', `Propr 轮询异常(${mapped.kind}): ${mapped.message}`, mapped);
    if (this.listenerCount('error') > 0) {
      this.emit('error', Object.assign(new Error(mapped.message), mapped));
    }
  }

  // ── 写路径（Review 3）：intentId 幂等 + 撤单复核 + 全平 + 未知态锁定 ─────────
  //
  // 锁定语义：tradingLocked 只拦截**开仓/改杠杆**；撤单与平仓（降低风险）始终允许。
  // 所有下单统一走 createOrders（保留自有 intentId）；官方 createOrderRaw 项目内禁用。

  _lockTrading(reason) {
    if (this.tradingLocked) return;
    this.tradingLocked = true;
    this.lockReason = reason;
    logger.error('propr', `交易锁定: ${reason}`);
    if (this.listenerCount('error') > 0) {
      this.emit('error', Object.assign(new Error(reason), { kind: 'unknown_order_state' }));
    }
  }

  unlockTrading(reason = '人工解锁') {
    if (!this.tradingLocked) return;
    this.tradingLocked = false;
    this.lockReason = null;
    logger.warn('propr', `交易解锁: ${reason}`);
  }

  isTradingLocked() { return this.tradingLocked; }

  _assertCanOpen() {
    if (this.tradingLocked) throw new Error(`Propr 交易已锁定（${this.lockReason}），拒绝开仓/改杠杆`);
    if (this.ordersSnapshotStale) throw new Error(`Propr 活动订单快照不完整（${this.ordersSnapshotError}），拒绝开仓`);
  }

  /**
   * 挑战风控硬拦截（Review6 P0 / Review6-1 P0）：**fail closed**。
   * - 风控层未启用（paper/shadow，`riskGateEnabled=false`）→ 放行；
   * - 已启用但状态缺失/未评估（null）→ 拒绝（绝不因"还没评估"而放行）；
   * - 仅 OK/WARNING 允许开仓；REDUCE_ONLY/HALT/LOCKED/BREACHED 一律拒绝**开仓**。
   * reduce-only 降风险操作不走本检查，即便 tradingLocked / 快照不完整也放行。
   */
  _assertRiskAllowsOpening() {
    if (!this.riskGateEnabled) return;
    const status = this.riskState?.status;
    if (status !== 'OK' && status !== 'WARNING') {
      throw new Error(`Propr 风控状态 ${status ?? '未评估'}，拒绝开仓（仅允许 reduce-only 降风险操作）`);
    }
  }

  _markOrdersSnapshotStale(err) {
    this.ordersSnapshotStale = true;
    this.ordersSnapshotError = mapProprError(err).message;
    logger.warn('propr', `活动订单快照不完整: ${this.ordersSnapshotError}`);
  }

  _rememberIntent(intent) {
    this._intents.set(intent.intentId, intent);
    while (this._intents.size > MAX_INTENTS) this._intents.delete(this._intents.keys().next().value);
  }

  getIntents() { return [...this._intents.values()]; }

  _buildRecord({ side, positionSide, price, sizeBase, reduceOnly = false, intentId, orderType = 'limit', timeInForce = 'GTC', closePosition = false }) {
    const record = {
      accountId: this.accountId,
      intentId,
      exchange: 'hyperliquid',
      type: orderType,
      side,
      positionSide,
      productType: 'perp',
      timeInForce,
      asset: this.base,
      base: this.base,
      quote: this.quote,
      quantity: String(sizeBase),
      reduceOnly: !!reduceOnly,
      closePosition: !!closePosition,
    };
    if (price != null) record.price = String(price);
    return record;
  }

  /** 按 intentId 跨全部状态查找（对账核心；只查 open 会漏 pending/partial 与终态）。 */
  async _findOrdersByIntent(intentId) {
    const found = new Map();
    for (const status of ALL_STATUSES) {
      const rows = await this.getAllOrders({ base: this.base, status }).catch(() => []);
      for (const raw of rows) if (raw.intentId === intentId) found.set(String(raw.orderId), raw);
    }
    return [...found.values()];
  }

  /**
   * 权威订单查询（Review3 复审 P0）：Day-0 未验证 `getOrders({orderId})` 过滤器是否生效，
   * 因此先试 orderId 直查，再用**全状态分页扫描**兜底。返回三种确定语义：
   *   { state:'found', order } | { state:'missing' }（全状态扫描成功但确实没有） | { state:'query_failed', error }
   * 只有 found+终态 才能判定"已结束"；missing 不得当作成功。
   */
  async _findOrderAuthoritative(orderId) {
    const id = String(orderId);
    try {
      const rows = await this.client.getOrders({ orderId, limit: 5 });
      const hit = (rows || []).find((r) => String(r.orderId) === id);
      if (hit) return { state: 'found', order: hit };
    } catch { /* 过滤器不可用：忽略，走全量扫描 */ }
    try {
      for (const status of ALL_STATUSES) {
        const rows = await this.getAllOrders({ base: this.base, status });
        const hit = rows.find((r) => String(r.orderId) === id);
        if (hit) return { state: 'found', order: hit };
      }
      return { state: 'missing' };
    } catch (err) {
      return { state: 'query_failed', error: err };
    }
  }

  /** 成交佐证：订单查不到时，用成交记录判断它是否已成交（只作佐证，不作唯一依据）。 */
  async _hasTradeForOrder(orderId) {
    const id = String(orderId);
    try {
      const rows = await this.client.getTrades({ orderId, limit: 5 });
      if ((rows || []).some((r) => String(r.orderId) === id)) return true;
    } catch { /* 过滤器不可用则走扫描 */ }
    try {
      const rows = await this._pullTrades({ full: false });
      return rows.some((t) => t.orderId === id);
    } catch { return false; }
  }

  _adoptCreated(raw, intent) {
    intent.state = 'accepted';
    intent.orderId = String(raw.orderId);
    const view = mapProprOrder(raw, { levelIndex: intent.levelIndex });
    this._orders.set(view.orderId, view);
    return { orderId: view.orderId, price: view.price, sizeBase: view.sizeBase, clientOrderId: intent.intentId, status: view.status };
  }

  /**
   * 下单异常恢复（核心幂等）：
   * - 先按 intentId 对账；命中 → 返回既有订单，绝不重复创建；
   * - 明确 400 参数错误（非幂等冲突）→ 视为未创建，抛原错；
   * - 其余（超时/网络/429/5xx/13084 对账不到）→ 未知态：锁定交易并抛 UnknownOrderStateError。
   */
  async _recoverIntent(err, intent) {
    const existing = await this._findOrdersByIntent(intent.intentId).catch(() => []);
    if (existing.length) {
      logger.warn('propr', `下单异常但已按 intentId 对账到订单（不重复创建）: ${intent.intentId}`, mapProprError(err));
      intent.state = 'reconciled';
      return { ...this._adoptCreated(existing[0], intent), reconciled: true };
    }
    if (err?.statusCode === 400 && !isIdempotencyConflict(err)) {
      this._intents.delete(intent.intentId);
      throw err;
    }
    intent.state = 'unknown';
    this._lockTrading(`订单状态未知（intentId=${intent.intentId}, ${mapProprError(err).kind}），需人工核查`);
    throw new UnknownOrderStateError(`订单状态未知（intentId=${intent.intentId}），已锁定交易`, { intentId: intent.intentId, cause: mapProprError(err) });
  }

  async placeLimitOrder(order = {}) {
    // reduce-only 是降风险操作：不受 tradingLocked / 快照不完整 / 风控状态限制（Review6-1）
    if (order.reduceOnly) {
      // 跳过开仓检查
    } else {
      this._assertCanOpen();
      this._assertRiskAllowsOpening();
    }
    const marketId = String(order.marketId ?? this.base);
    if (marketId !== this.base) throw new Error(`Propr 适配器仅支持 ${this.base}，收到 ${marketId}`);
    const price = roundPrice(order.price, this.market);
    const sizeBase = roundQty(order.sizeBase, this.market);
    assertOrderPrecision({ price, sizeBase }, this.market);
    const positionSide = order.positionSide ?? (order.side === 'buy' ? 'long' : 'short');
    const intent = {
      intentId: order.clientOrderId || ulid(), marketId, side: order.side, positionSide,
      price, sizeBase, reduceOnly: !!order.reduceOnly, levelIndex: order.levelIndex ?? null,
      state: 'created', createdAt: Date.now(),
    };
    this._rememberIntent(intent);
    const record = this._buildRecord({ side: intent.side, positionSide, price, sizeBase, reduceOnly: intent.reduceOnly, intentId: intent.intentId });
    try {
      const rows = await this.client.createOrders([record]);
      const raw = rows?.[0];
      if (!raw?.orderId) throw new UnknownOrderStateError(`下单未返回 orderId（intentId=${intent.intentId}）`, { intentId: intent.intentId });
      return this._adoptCreated(raw, intent);
    } catch (err) {
      return this._recoverIntent(err, intent);
    }
  }

  async placeLimitOrders(orders = []) {
    if (!orders.length) return [];
    // 全为 reduce-only → 降风险批量，放行；含任一开仓单 → 走完整开仓检查
    if (orders.some((o) => !o.reduceOnly)) {
      this._assertCanOpen();
      this._assertRiskAllowsOpening();
    }
    const prepared = orders.map((order) => {
      const marketId = String(order.marketId ?? this.base);
      if (marketId !== this.base) throw new Error(`Propr 适配器仅支持 ${this.base}，收到 ${marketId}`);
      const price = roundPrice(order.price, this.market);
      const sizeBase = roundQty(order.sizeBase, this.market);
      assertOrderPrecision({ price, sizeBase }, this.market);
      const positionSide = order.positionSide ?? (order.side === 'buy' ? 'long' : 'short');
      const intent = {
        intentId: order.clientOrderId || ulid(), marketId: this.base, side: order.side, positionSide,
        price, sizeBase, reduceOnly: !!order.reduceOnly, levelIndex: order.levelIndex ?? null,
        state: 'created', createdAt: Date.now(),
      };
      this._rememberIntent(intent);
      return { intent, record: this._buildRecord({ side: intent.side, positionSide, price, sizeBase, reduceOnly: intent.reduceOnly, intentId: intent.intentId }) };
    });

    let rows = [];
    let batchErr = null;
    try {
      rows = await this.client.createOrders(prepared.map((p) => p.record));
    } catch (err) {
      batchErr = err;
    }

    const byIntent = new Map((rows || []).map((r) => [r.intentId, r]));
    const results = prepared.map((p) => {
      const raw = byIntent.get(p.intent.intentId);
      return raw?.orderId ? this._adoptCreated(raw, p.intent) : null;
    });
    if (results.every(Boolean)) return results;

    if (batchErr?.statusCode === 400 && !isIdempotencyConflict(batchErr)) {
      for (const p of prepared) this._intents.delete(p.intent.intentId);
      throw batchErr;
    }
    // 缺失项逐个对账；对不上则锁定（结果必须与输入等长，GridBot 强校验）
    for (let i = 0; i < prepared.length; i++) {
      if (results[i]) continue;
      const p = prepared[i];
      const existing = await this._findOrdersByIntent(p.intent.intentId).catch(() => []);
      if (existing.length) results[i] = { ...this._adoptCreated(existing[0], p.intent), reconciled: true };
      else p.intent.state = 'unknown';
    }
    const stillMissing = prepared.filter((p) => p.intent.state === 'unknown');
    if (stillMissing.length) {
      this._lockTrading(`批量下单 ${stillMissing.length} 笔状态未知（intentId=${stillMissing.map((p) => p.intent.intentId).join(',')}），已锁定`);
      throw new UnknownOrderStateError(`批量下单部分状态未知（${stillMissing.length} 笔）`, { intents: stillMissing.map((p) => p.intent.intentId) });
    }
    return results;
  }

  /**
   * 撤单并**权威复核**真实状态（Review3 复审 P0）：
   * 不信任官方 400=已撤/已成交 的吞并语义，也不依赖未验证的 orderId 过滤器。
   * 只有「查到且为终态」或「查不到但有成交佐证」才返回 true；
   * 查询失败/无法确认一律返回 false（宁可让上层重试，也不误报已撤）。降风险操作，锁定期间仍允许。
   */
  async cancelOrder(_marketId, orderId) {
    const id = String(orderId);
    try { await this.client.cancelOrder(id); } catch (err) { if (err?.statusCode !== 400) logger.warn('propr', `撤单请求异常: ${mapProprError(err).message}`); }

    const first = await this._findOrderAuthoritative(id);
    if (first.state === 'query_failed') { this._markOrdersSnapshotStale(first.error); return false; }
    if (first.state === 'found') {
      if (TERMINAL_STATUSES.includes(first.order.status)) { this._orders.delete(id); return true; }
      // 仍活动：再撤一次并复核
      try { await this.client.cancelOrder(id); } catch { /* ignore */ }
      await sleep(1200);
      const second = await this._findOrderAuthoritative(id);
      if (second.state === 'query_failed') { this._markOrdersSnapshotStale(second.error); return false; }
      if (second.state === 'found' && TERMINAL_STATUSES.includes(second.order.status)) { this._orders.delete(id); return true; }
      logger.warn('propr', `撤单后订单仍活动: ${id} status=${second.order?.status ?? 'unknown'}`);
      return false;
    }
    // missing：无法确认是否已结束，必须靠成交佐证
    if (await this._hasTradeForOrder(id)) { this._orders.delete(id); return true; }
    logger.warn('propr', `撤单后无法确认订单状态（全状态扫描无此单且无成交佐证）: ${id}`);
    return false;
  }

  /** 批量撤单：快照不完整时不使用旧快照下结论，一律返回 false（Review3 复审 P1）。 */
  async cancelAll() {
    try {
      await this._refreshOpenOrders();
    } catch {
      // 快照失败：仍尽力撤掉本地已知订单，但结果必须标记为不完整
      for (const o of [...this._orders.values()]) {
        await this.cancelOrder(this.base, o.orderId).catch(() => false);
      }
      return false;
    }
    const targets = [...this._orders.values()];
    let ok = true;
    for (const o of targets) {
      const done = await this.cancelOrder(this.base, o.orderId).catch(() => false);
      if (!done) ok = false;
    }
    try {
      await this._refreshOpenOrders();
      if (this._orders.size > 0) ok = false;
    } catch {
      ok = false;
    }
    return ok;
  }

  /**
   * 市价 reduce-only 平仓单：与开仓走**同一条 intent 恢复路径**（Review3 复审 P1）。
   * 未知态会置 tradingLocked（只拦开仓；平仓本身仍可继续重试，属降风险操作）。
   */
  async _placeReduceOnlyMarket({ positionSide, sizeBase }) {
    const closeSide = positionSide === 'long' ? 'sell' : 'buy';
    const intentId = ulid();
    const intent = {
      intentId, marketId: this.base, side: closeSide, positionSide,
      price: null, sizeBase, reduceOnly: true, levelIndex: null, state: 'created', createdAt: Date.now(),
    };
    this._rememberIntent(intent);
    const record = this._buildRecord({
      side: closeSide, positionSide, sizeBase, reduceOnly: true, intentId,
      orderType: 'market', timeInForce: 'IOC', closePosition: true,
    });
    try {
      const rows = await this.client.createOrders([record]);
      const raw = rows?.[0];
      if (!raw?.orderId) throw new UnknownOrderStateError(`平仓未返回 orderId（intentId=${intentId}）`, { intentId });
      this._adoptCreated(raw, intent);
      return { ok: true, orderId: intent.orderId, recovered: false };
    } catch (err) {
      const recovered = await this._recoverIntent(err, intent);
      return { ok: true, orderId: recovered.orderId, recovered: true };
    }
  }

  /** 全平：遍历全部非零持仓逐个市价 reduceOnly 平仓，循环复核至空（官方 closePosition 只平 [0]）。 */
  async closePosition() {
    const retryDelayMs = Number.isFinite(this._cfg.closeRetryDelayMs) ? this._cfg.closeRetryDelayMs : 2000;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const positions = await this.client.getPositions({ base: this.base, status: 'open' });
      if (!positions.length) { this._positions = []; return true; }
      for (const p of positions) {
        try {
          const res = await this._placeReduceOnlyMarket({ positionSide: p.positionSide, sizeBase: Number(p.quantity) });
          logger.info('propr', `平仓单已提交（第 ${attempt} 轮, ${p.positionSide} ${p.quantity}${res.recovered ? ', 对账恢复' : ''}）`);
        } catch (err) {
          // 未知态：_recoverIntent 已锁定开仓；继续下一轮 reduce-only 重试（降风险）
          logger.warn('propr', `平仓状态未知（第 ${attempt} 轮, ${p.positionSide}）: ${mapProprError(err).message}`);
        }
      }
      await sleep(retryDelayMs);
    }
    const left = await this.client.getPositions({ base: this.base, status: 'open' });
    this._positions = left.map(mapProprPosition);
    if (left.length) {
      this._lockTrading('平仓后仍有残留仓位，需人工处理');
      return false;
    }
    return true;
  }

  async setLeverage(_marketId, leverage) {
    this._assertCanOpen();
    const riskStatus = this.riskState?.status;
    if (riskStatus && riskStatus !== 'OK' && riskStatus !== 'WARNING') {
      throw new Error(`Propr 风控状态 ${riskStatus}，禁止修改杠杆`);
    }
    const lev = Math.floor(Number(leverage));
    if (!Number.isFinite(lev) || lev < 1) throw new Error(`杠杆非法: ${leverage}`);
    if (lev > this.market.maxLeverage) throw new Error(`杠杆 ${lev} 超过 ${this.base} 上限 ${this.market.maxLeverage}`);
    const config = await this.client.getMarginConfig(this.base);
    const updated = await this.client.updateMarginConfig(config.configId, this.base, lev, config.marginMode ?? 'cross');
    const mapped = mapProprMargin(updated);
    this.market = { ...this.market, leverage: mapped.leverage ?? lev, marginMode: mapped.marginMode ?? this.market.marginMode };
    logger.info('propr', `杠杆已设为 ${this.market.leverage}x（${this.market.marginMode}）`);
    return true;
  }

  /** 对账：刷新活动挂单并按 intentId 回填意图；返回未匹配订单供 GridBot 接纳。 */
  async reconcileOrders() {
    await this._refreshOpenOrders();
    const unmatched = [];
    for (const view of this._orders.values()) {
      const intent = view.clientOrderId ? this._intents.get(view.clientOrderId) : null;
      if (intent) { intent.state = 'open'; intent.orderId = view.orderId; }
      else unmatched.push(view);
    }
    return { open: [...this._orders.values()], unmatched };
  }

  /** 仪表盘公开信息（不含任何凭证；accountId 已掩码）。 */
  getPublicInfo() {
    return {
      exchange: 'Propr',
      mode: this.mode,
      accountIdMasked: maskAccountId(this.accountId),
      positionMode: this.positionMode,
      tradingLocked: this.tradingLocked,
      lockReason: this.lockReason,
      ordersSnapshotStale: this.ordersSnapshotStale,
      ordersSnapshotError: this.ordersSnapshotError,
      equitySource: this.equitySource,
      equityFreshAt: this.equityFreshAt,
      equityStale: this.isEquityStale(),
      highWaterMark: this.highWaterMark,
      availableBalance: this.availableBalance,
      totalUnrealizedPnl: this.totalUnrealizedPnl,
      intents: this._intents.size,
      openOrdersTracked: this._orders.size,
      price: this._price || null,
      lastPriceOkAt: this.lastPriceOkAt || null,
      lastApiOkAt: this.lastApiOkAt || null,
      attemptStatus: this.attemptStatus,
      startingBalance: this.startingBalance,
      risk: this.riskState,
    };
  }
}
