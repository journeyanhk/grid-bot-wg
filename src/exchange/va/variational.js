// VariationalExchange — LIVE adapter for Variational Omni (BTC perpetual grid).
//
// Implements the IExchange contract (see rs/types.js). Design decisions, all
// driven by the real 2026-09-08 capture and the two design docs:
//
//   * POSITIVE fill confirmation only. Omni exposes orders/v2 terminal status
//     (cleared/canceled) + trades.source_rfq, so — unlike the RISEx adapter,
//     which has no status endpoint and must GUESS from a vanished order — we
//     NEVER infer a fill. A tracked order that leaves the pending list is
//     resolved by reading its terminal row; if we cannot read it, we keep
//     tracking and warn (fail-closed), never fabricate a fill.
//   * rfq_id is the only order key. order_id is logged, never used for control.
//   * instrument identity funding_interval_s = 3600 (NOT metadata's 28800).
//   * Auth is the vr-token cookie (pasted from .env for now); a 401 marks the
//     adapter not-trading-ready and raises so the bot pauses replacement.
//
// HTTP + Cloudflare live entirely in VaHttpClient; this file is pure strategy
// plumbing so the transport can later swap to a Python bridge with no changes.
import { EventEmitter } from 'node:events';
import { logger } from '../../log.js';
import { CloudflareError, VaHttpClient, VaHttpError } from './httpclient.js';
import {
  DEFAULT_PRECISION, candlePeriod, formatStep, instrumentFor, isCanceled, isFilled,
  parseCandles, parseOrderRow, parsePortfolio, parsePosition, parseSupportedAsset,
  parseTrade, roundPrice, roundQty, unwrapResult,
} from './market.js';

const POLL_MS = 2500;
const HISTORY_BUFFER_MS = 5 * 60_000;   // look-back padding when querying terminal rows
const RESOLVE_TIMEOUT_MS = 10 * 60_000; // a gone order unresolved this long -> loud dropped-level warning

export class VariationalExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.network = 'mainnet';
    this.dataSource = null;
    this.underlyings = (opts.underlyings && opts.underlyings.length ? opts.underlyings : ['BTC']).map((u) => u.toUpperCase());
    this.precision = { ...DEFAULT_PRECISION, ...(opts.precision || {}) };
    this.instrumentCfg = opts.instrument || {}; // { instrumentType, settlementAsset, fundingIntervalS, kind }
    this.slippageLimit = String(opts.slippageLimit ?? '0.005');
    this.leverage = Number(opts.leverage) || null;
    this.feeRate = Number(opts.feeRate) || 0.0001; // base_spread/2 ~ 0.005%; confirm from /metadata/stats
    this.pollMs = opts.pollMs || POLL_MS;
    this._graceMs = this.pollMs * 2;
    this.apiUrl = opts.baseUrl || undefined;
    this.balance = null; this.equity = null; this.realizedPnl = null;
    this.lastOkAt = 0; this.lastError = null; this.operationalIssue = null;
    this.rejectedOrders = 0; this.droppedLevels = 0;
    this.markets = new Map();       // marketId(number) -> market
    this._byUnderlying = new Map();  // 'BTC' -> marketId
    this._prices = new Map();        // marketId -> price
    this._positions = new Map();     // marketId -> {sizeBase, entryPrice, unrealizedPnl}
    this._tracked = new Map();       // rfqId -> {orderId, marketId, side, price, sizeBase, levelIndex, reduceOnly, seen, placedAt, goneFirstAt, canceling}
    this._timer = null; this._polling = false; this._tradingReady = false;
    this._lastAlertAt = 0;
    this.http = opts.http || new VaHttpClient({
      baseUrl: opts.baseUrl, address: opts.address, token: opts.token,
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  async init() {
    this._tradingReady = false;
    try {
      await this._loadMarkets();
      if (this.http.hasToken()) {
        await this._refreshAccount();     // validates the vr-token cookie
        await this._refreshOrders().catch(() => {});
        this._tradingReady = true;
      } else {
        // No token: read-only price/candles still work (public endpoints), but
        // trading is refused until VARIATIONAL_TOKEN is provided.
        logger.warn('va', '未配置 VARIATIONAL_TOKEN：仅行情可用，实盘交易被锁定，请贴入 7 天会话 token。');
      }
      if (this.leverage) { for (const u of this.underlyings) await this.setLeverage(this._byUnderlying.get(u), this.leverage).catch(() => {}); }
      this.dataSource = 'real';
      this.lastOkAt = Date.now();
      this.operationalIssue = null;
      this.start();
      return true;
    } catch (error) {
      this.dataSource = null; this._tradingReady = false;
      this.lastError = error?.message || String(error);
      this._setIssue(error);
      throw error;
    }
  }

  async reconnect() {
    this.stop(); this._polling = false; this.lastError = null;
    return this.init();
  }

  async _loadMarkets() {
    let idx = 0;
    for (const underlying of this.underlyings) {
      const snap = parseSupportedAsset(await this.http.supportedAssets(underlying), underlying);
      if (!snap) throw new VaHttpError(`Variational 未返回 ${underlying} 的行情，无法加载市场。`, 0);
      const marketId = idx + 1; idx += 1;
      this.markets.set(marketId, {
        marketId, underlying,
        displayName: `${underlying}-PERP`, symbol: underlying,
        lastPrice: snap.price,
        stepSize: this.precision.stepSize, stepPrice: this.precision.stepPrice,
        minOrderSize: this.precision.minOrderSize,
        maxLeverage: snap.maxLeverage || this.precision.maxLeverage,
        instrumentType: snap.instrumentType, marketStatus: snap.marketStatus,
        isCloseOnly: snap.isCloseOnly,
      });
      this._byUnderlying.set(underlying, marketId);
      this._prices.set(marketId, snap.price);
    }
  }

  _market(marketId) {
    const m = this.markets.get(Number(marketId));
    if (!m) throw new VaHttpError(`未知 Variational 市场 marketId=${marketId}`, 0);
    return m;
  }
  _assertTradingReady() {
    if (!this._tradingReady || this.dataSource !== 'real') {
      throw new Error('Variational 实盘鉴权（vr-token）尚未通过，已阻止交易；请检查 VARIATIONAL_TOKEN 后执行“重连交易所”。');
    }
  }

  async getMarkets() { return [...this.markets.values()]; }
  getPosition(marketId) { return this._positions.get(Number(marketId)) || null; }
  getOpenOrders(marketId) { return [...this._tracked.values()].filter((o) => o.marketId === Number(marketId)); }

  async getPrice(marketId) {
    const id = Number(marketId); const m = this._market(id);
    try {
      const snap = parseSupportedAsset(await this.http.supportedAssets(m.underlying), m.underlying);
      if (snap?.price) { this._prices.set(id, snap.price); m.lastPrice = snap.price; }
    } catch { /* keep last price */ }
    return this._prices.get(id) ?? m.lastPrice;
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const m = this._market(marketId);
    const period = candlePeriod(intervalSec);
    const end = new Date();
    const start = new Date(end.getTime() - Number(n) * Number(intervalSec) * 1000);
    const q = `period=${period}&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&cex_asset=${encodeURIComponent(m.underlying)}`;
    try { return parseCandles(await this.http.get(`/api/candles?${q}`)); }
    catch { return []; }
  }

  async setLeverage(marketId, x) {
    const m = this._market(marketId);
    const value = Math.min(Math.max(1, Math.floor(Number(x))), m.maxLeverage || 50);
    try {
      const out = await this.http.post('/api/settlement_pools/set_leverage', { leverage: String(value), asset: m.underlying });
      return { current: Number(out?.current ?? value), max: Number(out?.max ?? m.maxLeverage) };
    } catch (e) { this.emit('error', e); return false; }
  }

  // ── orders ──────────────────────────────────────────────────────────────
  async placeLimitOrder(o) {
    this._assertTradingReady();
    const m = this._market(o.marketId);
    if (m.isCloseOnly && !o.reduceOnly) throw new Error(`Variational ${m.underlying} 处于只减仓模式，拒绝开仓单。`);
    const qty = roundQty(o.sizeBase, m.stepSize);
    if (!(qty >= m.minOrderSize)) throw new Error(`数量 ${o.sizeBase} 低于 ${m.underlying} 最小下单量 ${m.minOrderSize}。`);
    const price = roundPrice(o.price, m.stepPrice);
    const body = {
      order_type: 'limit',
      limit_price: formatStep(price, m.stepPrice),
      side: o.side === 'buy' ? 'buy' : 'sell',
      instrument: instrumentFor(m.underlying, this.instrumentCfg),
      qty: formatStep(qty, m.stepSize),
      slippage_limit: this.slippageLimit,
      is_auto_resize: false,
      use_mark_price: false,
      is_reduce_only: !!o.reduceOnly,
    };
    const resp = await this.http.post('/api/orders/new/limit', body);
    const rfqId = resp?.rfq_id != null ? String(resp.rfq_id) : null;
    if (!rfqId) throw new VaHttpError('Variational 下单响应缺少 rfq_id。', 0, resp);
    this._tracked.set(rfqId, {
      orderId: rfqId, marketId: m.marketId, side: body.side, price, sizeBase: qty,
      levelIndex: o.levelIndex, reduceOnly: !!o.reduceOnly,
      seen: false, placedAt: Date.now(), goneFirstAt: 0, canceling: false,
      clientOrderId: o.clientOrderId,
    });
    return { orderId: rfqId };
  }

  async cancelOrder(marketId, orderId) {
    this._assertTradingReady();
    const id = String(orderId);
    const t = this._tracked.get(id);
    // Mark canceling instead of deleting: positive confirmation resolves the
    // fill-vs-cancel race — if it turns out this order actually filled between
    // our decision and the cancel landing, _refreshOrders emits the fill.
    if (t) t.canceling = true;
    try { await this.http.post('/api/orders/cancel', { rfq_id: id }); return true; }
    catch (e) { if (t) t.canceling = false; this.emit('error', e); return false; }
  }

  async cancelAll(marketId) {
    this._assertTradingReady();
    const mId = Number(marketId);
    let open;
    try { open = await this.fetchOpenOrders(mId); } catch { open = this.getOpenOrders(mId); }
    for (const o of open) { const t = this._tracked.get(String(o.orderId)); if (t) t.canceling = true; }
    let ok = true;
    for (const o of open) {
      try { await this.http.post('/api/orders/cancel', { rfq_id: String(o.orderId) }); }
      catch (e) { ok = false; this.emit('error', e); }
    }
    return ok;
  }

  /** REAL resting orders (pending) on the exchange — used by the bot for reconciliation. */
  async fetchOpenOrders(marketId) {
    const rows = unwrapResult(await this.http.get('/api/orders/v2?status=pending', { auth: true })).map(parseOrderRow);
    const wantUnderlying = marketId != null ? this._market(marketId).underlying : null;
    return rows
      .filter((r) => r && r.rfqId && (!wantUnderlying || !r.underlying || r.underlying === wantUnderlying))
      .map((r) => ({
        orderId: r.rfqId,
        marketId: this._byUnderlying.get(r.underlying) ?? Number(marketId),
        side: r.side, price: r.limitPrice ?? r.price, sizeBase: r.qty, status: r.status,
      }));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase, reduceOnly }) {
    this._tracked.set(String(orderId), {
      orderId: String(orderId), marketId: Number(marketId), side, price: Number(price), sizeBase: Number(sizeBase),
      levelIndex, reduceOnly: !!reduceOnly, seen: false, placedAt: Date.now(), goneFirstAt: 0, canceling: false,
    });
  }
  forgetOrder(orderId) { this._tracked.delete(String(orderId)); }
  forgetOrders(marketId) { for (const [id, o] of this._tracked) if (o.marketId === Number(marketId)) this._tracked.delete(id); }

  async closePosition(marketId) {
    const pos = this.getPosition(marketId); if (!pos?.sizeBase) return true;
    const m = this._market(marketId);
    const price = await this.getPrice(marketId);
    const side = pos.sizeBase > 0 ? 'sell' : 'buy';
    // Aggressive reduce-only limit that crosses the OLP quote (Omni is
    // all-or-nothing; a crossing limit fills like a taker). The market endpoint
    // (indicative -> new/market) is deferred until its body is captured.
    const cross = side === 'sell' ? price * (1 - 0.02) : price * (1 + 0.02);
    await this.placeLimitOrder({ marketId: m.marketId, side, price: cross, sizeBase: Math.abs(pos.sizeBase), reduceOnly: true, levelIndex: -1 });
    return true;
  }

  // ── polling / positive-confirmation fill detection ──────────────────────
  start() { if (!this._timer) { this._timer = setInterval(() => this._poll(), this.pollMs); this._timer.unref?.(); } }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  async _poll() {
    if (this._polling) return; this._polling = true;
    try {
      await this._refreshPrices();
      if (this._tradingReady) {
        await this._refreshAccount();
        await this._refreshOrders();
      }
      this.lastOkAt = Date.now(); this.lastError = null;
      if (this.operationalIssue?.transient) this.operationalIssue = null;
    } catch (e) { this.lastError = e?.message || String(e); this._setIssue(e); }
    finally { this._polling = false; }
  }

  async _refreshPrices() {
    for (const [marketId, m] of this.markets) {
      try {
        const snap = parseSupportedAsset(await this.http.supportedAssets(m.underlying), m.underlying);
        if (snap?.price) { this._prices.set(marketId, snap.price); m.lastPrice = snap.price; this.emit('price', { marketId, price: snap.price }); }
      } catch { /* keep last */ }
    }
  }

  async _refreshAccount() {
    const port = parsePortfolio(await this.http.get('/api/portfolio?compute_margin=true', { auth: true }));
    if (port) { this.balance = port.balance; this.equity = port.equity; this.available = port.available; }
    // Positions: shape unverified -> parse defensively, never fabricate.
    try {
      const raw = await this.http.get('/api/positions', { auth: true });
      const next = new Map();
      for (const [marketId, m] of this.markets) {
        const p = parsePosition(raw, m.underlying);
        if (p) next.set(marketId, p);
      }
      this._positions = next;
    } catch (e) {
      this.http.warnOnce('positions', `读取 /api/positions 失败（保持上次持仓，勿据此下单）：${e?.message || e}`);
    }
    this.lastOkAt = Date.now();
  }

  async _refreshOrders() {
    const pending = await this.fetchOpenOrders(); // all underlyings
    const live = new Set(pending.map((o) => String(o.orderId)));
    const now = Date.now();
    for (const t of this._tracked.values()) {
      if (live.has(t.orderId)) { t.seen = true; t.goneFirstAt = 0; }
    }
    // Which tracked orders have left the pending list (and deserve resolution)?
    const gone = [...this._tracked.values()].filter((t) => !live.has(t.orderId) && (t.seen || now - t.placedAt > this._graceMs));
    if (!gone.length) return;

    const since = new Date(Math.min(...gone.map((t) => t.placedAt)) - HISTORY_BUFFER_MS).toISOString();
    let historyById; const tradesByRfq = new Map();
    try {
      const hist = unwrapResult(await this.http.get(`/api/orders/v2?limit=100&order_by=created_at&order=desc&created_at_gte=${encodeURIComponent(since)}`, { auth: true })).map(parseOrderRow);
      historyById = new Map(hist.filter((r) => r?.rfqId).map((r) => [r.rfqId, r]));
    } catch (e) {
      // Cannot read terminal rows -> resolve nothing this round (fail-closed).
      this._setIssue(e, true);
      return;
    }
    try {
      const trades = unwrapResult(await this.http.get(`/api/trades?limit=100&order_by=created_at&order=desc&created_at_gte=${encodeURIComponent(since)}`, { auth: true })).map(parseTrade);
      for (const tr of trades) { if (tr?.rfqId) tradesByRfq.set(tr.rfqId, tr); }
    } catch { /* trades optional: fall back to order-row price */ }

    for (const t of gone) {
      const row = historyById.get(t.orderId);
      if (!row) {
        // Not yet in history — keep tracking, time it, warn (never fabricate).
        if (!t.goneFirstAt) t.goneFirstAt = now;
        else if (now - t.goneFirstAt >= RESOLVE_TIMEOUT_MS) {
          this.droppedLevels += 1;
          logger.warn('va', `⚠️ 订单 ${t.orderId}（${t.side} @ ${t.price}）出簿 10 分钟仍无法从 orders/v2 确认终态，该档位可能空洞（累计 ${this.droppedLevels}），请核对交易所并考虑重启网格补齐。`);
          t.goneFirstAt = now; // re-arm to throttle the warning
        }
        continue;
      }
      if (isFilled(row.status)) {
        const tr = tradesByRfq.get(t.orderId);
        const fillPrice = tr?.price ?? row.price ?? t.price;
        const fillQty = tr?.qty ?? row.qty ?? t.sizeBase;
        this._tracked.delete(t.orderId);
        this.emit('fill', { orderId: t.orderId, marketId: t.marketId, side: t.side, price: fillPrice, sizeBase: fillQty, levelIndex: t.levelIndex, clientOrderId: t.clientOrderId });
      } else if (row.failedRiskChecks.length) {
        this._tracked.delete(t.orderId); this.rejectedOrders += 1;
        this.emit('error', new Error(`Variational 拒单（风控 ${row.failedRiskChecks.join(',')}）：订单 ${t.orderId} ${t.side} @ ${t.price}，不补反向单（累计拒单 ${this.rejectedOrders}）。`));
      } else if (isCanceled(row.status)) {
        this._tracked.delete(t.orderId);
        if (!t.canceling) {
          // Cancelled but WE didn't cancel it -> manual/website cancel. Surface
          // as an error so the bot pauses replacement rather than guessing.
          this.emit('error', new Error(`Variational 订单 ${t.orderId}（${t.side} @ ${t.price}）被非本地撤销（${row.cancelReason || 'unknown'}），不视为成交、不补单。`));
        }
      } // else: still pending in history (snapshot lag) -> keep tracking
    }
  }

  _setIssue(error, transient = false) {
    const message = error?.message || String(error);
    this.operationalIssue = { title: 'Variational 交易所异常', message, transient };
    if (error instanceof CloudflareError) this.operationalIssue.title = 'Variational Cloudflare 拦截';
    if (Date.now() - this._lastAlertAt > 30_000) { this._lastAlertAt = Date.now(); this.emit('error', new Error(message)); }
  }
}
