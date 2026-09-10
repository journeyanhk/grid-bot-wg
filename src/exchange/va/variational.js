// VariationalExchange — LIVE adapter for Variational Omni (BTC perpetual grid).
//
// Implements the IExchange contract (see rs/types.js). Design decisions, all
// driven by the real 2026-09-08 captures (3 rounds) and the two design docs:
//
//   * POSITIVE fill confirmation only. Omni exposes orders/v2 terminal status
//     (limit fill terminal = `cleared`, `price` = actual fill — confirmed) plus
//     trades.source_rfq. Unlike RISEx (which GUESSES from a vanished order) we
//     NEVER infer a fill; if we cannot read the terminal row we keep tracking
//     and warn (fail-closed).
//   * rfq_id is the only order key. order_id is logged, never used for control.
//   * instrument identity = `P-BTC-USDC-3600` (funding_interval_s 3600, NOT
//     metadata's 28800 window). Every pending/history query carries `instrument=`.
//   * Soft-forget: the bot's forgetOrder(s) must not drop an order we are still
//     mid-cancel on — otherwise a fill that lands during the cancel is lost.
//   * closePosition goes through the verified indicative→accept path and its
//     order is `internal` (never re-emitted as a grid fill).
//
// HTTP + Cloudflare (curl_cffi bridge) live entirely in VaHttpClient; this file
// is pure strategy plumbing.
import { EventEmitter } from 'node:events';
import { logger } from '../../log.js';
import { CloudflareError, VaHttpClient, VaHttpError, VaRateLimitError } from './httpclient.js';
import { VaAuth, decodeJwtExp } from './auth.js';
import {
  DEFAULT_PRECISION, candlePeriod, formatStep, instrumentFor, instrumentKey,
  isCanceled, isFilled, nextPageOf, parseCandles, parseIndicative, parseOrderRow,
  parsePortfolio, parsePosition, parseSupportedAsset, parseTrade, roundPrice,
  roundQty, unwrapResult,
} from './market.js';

const POLL_MS = 2500;
const HISTORY_BUFFER_MS = 5 * 60_000;   // look-back padding when querying terminal rows
const RESOLVE_TIMEOUT_MS = 10 * 60_000; // a gone order unresolved this long -> loud dropped-level warning
const MAX_PAGES = 5;                     // pagination cap for orders/v2 + trades (100/page)
const TOKEN_WARN_MS = 24 * 3600_000;     // warn when the vr-token JWT has < 24h left

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.feeRate = Number(opts.feeRate) || 0.0001; // spread-based; ~0.005%
    this.pollMs = opts.pollMs || POLL_MS;
    this._graceMs = this.pollMs * 2;
    this.apiUrl = opts.baseUrl || undefined;
    this.maxNotional = null;              // from indicative at init (per-side cap for bot preflight)
    this.maxOpenOrders = Number(opts.maxOpenOrders) > 0 ? Number(opts.maxOpenOrders) : 50; // hard cap: 50/instrument/order-type (verified via probe; 51st => HTTP 422)
    this.balance = null; this.equity = null; this.realizedPnl = null;
    this.lastOkAt = 0; this.lastError = null; this.operationalIssue = null;
    this.rejectedOrders = 0; this.droppedLevels = 0; this.lateFills = 0;
    this.markets = new Map();        // marketId(number) -> market
    this._byUnderlying = new Map();  // 'BTC' -> marketId
    this._prices = new Map();        // marketId -> price
    this._positions = new Map();     // marketId -> {sizeBase, entryPrice, ...}
    this._posSeq = new Map();        // marketId -> last_local_sequence (cheap fill trigger)
    this._tracked = new Map();       // rfqId -> {orderId, marketId, side, price, sizeBase, levelIndex, reduceOnly, createdAt, seen, placedAt, goneFirstAt, canceling, forgotten, internal}
    this._timer = null; this._polling = false; this._tradingReady = false;
    this._lastAlertAt = 0;
    this._placementPausedUntil = 0; // set on a 50-order-cap 422; refuse new opens until it passes
    this.http = opts.http || new VaHttpClient({
      baseUrl: opts.baseUrl, address: opts.address, token: opts.token,
      transportMode: opts.transport, pythonPath: opts.pythonPath,
      privateKey: opts.privateKey,   // 仅透传给传输层注入 worker 环境，Node 侧不留存
    });
    // 会话生命周期：贴 token 优先，配了私钥则自动续签（SIWE）。
    this.auth = new VaAuth({
      http: this.http,
      address: opts.address,
      envToken: opts.token,
      hasPrivateKey: !!opts.privateKey,   // Node 侧只需知道能否自签，私钥只在 worker 环境
      cachePath: opts.tokenCachePath,
      // 续签成功=info（仅仪表盘，不推手机）；连续失败=❌（经告警环推手机）。
      onNotice: (m) => logger.info('va', m),
      onAlert: (m) => this.emit('error', new Error(m)),
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  async init() {
    this._tradingReady = false;
    try {
      await this._loadMarkets();
      // 会话解析：VARIATIONAL_TOKEN(有效) → 缓存 → 私钥自动登录 → 无。
      await this.auth.init().catch((e) => logger.warn('va', `会话初始化异常：${e?.message || e}`));
      if (this.http.hasToken()) {
        this._checkTokenLife();               // decode JWT exp; warn if < 24h；仅在不可自签时对过期抛错
        await this._refreshAccount();          // validates the vr-token cookie
        await this._initInstrumentCaps().catch((e) => logger.warn('va', `读取合约精度/杠杆失败，沿用默认值：${e?.message || e}`));
        await this._preflightInstrument();     // throws (blocks trading) on instrument-identity mismatch
        await this._refreshOrders().catch(() => {});
        this._tradingReady = true;
      } else if (this.auth.canRefresh()) {
        logger.warn('va', 'vr-token 自动登录暂未成功：仅行情可用，实盘交易锁定，将在轮询中重试续签。');
      } else {
        logger.warn('va', '未配置 VARIATIONAL_TOKEN 且无 VA_WALLET_PRIVATE_KEY：仅行情可用，实盘交易被锁定。');
      }
      // NOTE: leverage is intentionally NOT set here — the bot sets it in its
      // own _start (setting leverage while holding a position can be rejected or
      // silently change margin). See P1 in grid-review1.
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

  /**
   * 仪表盘热切换：接纳一枚粘贴的 vr-token，立即用 portfolio 验证并恢复交易。
   * 自动登录被 Cloudflare 挑战拦截时的人工兜底（token 7 天有效，每周一次一分钟）。
   */
  async adoptToken(token) {
    const info = this.auth.adopt(token);       // 空/过期直接抛错
    try {
      await this._refreshAccount();            // portfolio 打通才算 token 真的可用
      this._tradingReady = true;
      this.operationalIssue = null;
      this.lastError = null;
      this.lastOkAt = Date.now();
      return { ok: true, exp: info.exp, tradingReady: true };
    } catch (e) {
      // token 已落库但没验过：可能仍无效（如粘错/已吊销）。
      this._tradingReady = false;
      throw new Error(`token 已接纳但校验失败：${e?.message || e}`, { cause: e });
    }
  }

  _checkTokenLife() {
    const exp = decodeJwtExp(this.http.token);
    if (!exp) return;
    const msLeft = exp * 1000 - Date.now();
    if (msLeft <= 0) {
      // 配了私钥可自动续签时，过期不阻断连接——交给 auth.ensure 在轮询里重登。
      if (this.auth.canRefresh()) { logger.warn('va', 'vr-token 已过期，将尝试用私钥自动续签。'); return; }
      throw new VaHttpError('VARIATIONAL_TOKEN（vr-token）已过期，请重新获取会话 token 后重连。', 401);
    }
    // 可自签时临期无需打扰用户（auth 会在 <24h 自动续签）。
    if (msLeft < TOKEN_WARN_MS && !this.auth.canRefresh()) {
      const hrs = Math.max(1, Math.round(msLeft / 3600_000));
      logger.warn('va', `vr-token 将在约 ${hrs} 小时后过期，请及时更新 VARIATIONAL_TOKEN。`);
      // 转发到告警环 / 通知总线（⚠️ 前缀→warn 级推送），让用户在手机上及时看到。
      this.emit('error', new Error(`⚠️ Variational 会话 token 将在约 ${hrs} 小时后过期，请尽快更新 VARIATIONAL_TOKEN 并重连，否则实盘交易会中断。`));
    }
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
        currentLeverage: null, // 账户当前杠杆（indicative 回显填充，仅展示，不用于钳制）
        maxNotional: null, maxOpenOrders: this.maxOpenOrders,
        instrumentType: snap.instrumentType, marketStatus: snap.marketStatus,
        isCloseOnly: snap.isCloseOnly,
      });
      this._byUnderlying.set(underlying, marketId);
      this._prices.set(marketId, snap.price);
    }
  }

  /** Read REAL precision/leverage/max-notional from an indicative quote (token-gated). */
  async _initInstrumentCaps() {
    for (const [marketId, m] of this.markets) {
      const body = { instrument: instrumentFor(m.underlying, this.instrumentCfg), qty: '0.001' };
      const ind = parseIndicative(await this.http.post('/api/quotes/indicative', body, { auth: true, skipGap: true }));
      if (!ind) continue;
      if (ind.minQtyTick) m.stepSize = ind.minQtyTick;
      if (ind.minQty) m.minOrderSize = ind.minQty;
      // indicative 只回显【当前】杠杆，不覆盖 maxLeverage（真实上限来自
      // supported_assets.max_leverage 或默认 50），否则填 10x 会被静默压回当前值。
      if (ind.currentLeverage) m.currentLeverage = ind.currentLeverage;
      if (ind.markPrice) { m.lastPrice = ind.markPrice; this._prices.set(marketId, ind.markPrice); }
      m.maxNotional = ind.maxNotionalBid ?? ind.maxNotionalAsk ?? m.maxNotional;
      this.maxNotional = m.maxNotional;
      logger.info('va', `${m.underlying} 合约精度：step=${m.stepSize} min=${m.minOrderSize} maxLev=${m.maxLeverage} curLev=${m.currentLeverage ?? '?'} maxNotional≈${m.maxNotional ?? '?'}`);
    }
  }

  /** Block trading if a resting order's instrument echo differs from our identity. */
  async _preflightInstrument() {
    for (const m of this.markets.values()) {
      const key = instrumentKey(m.underlying, this.instrumentCfg);
      const json = await this.http.get(`/api/orders/v2?status=pending&instrument=${encodeURIComponent(key)}&limit=1`, { auth: true });
      const row = unwrapResult(json)[0];
      if (!row?.instrument) continue;
      const want = instrumentFor(m.underlying, this.instrumentCfg);
      const got = row.instrument;
      const mismatch = ['underlying', 'instrument_type', 'settlement_asset', 'funding_interval_s']
        .filter((k) => String(got[k]) !== String(want[k]));
      if (mismatch.length) {
        throw new VaHttpError(`Variational 合约身份回显不一致（${mismatch.join(',')}）：本地 ${JSON.stringify(want)} vs 交易所 ${JSON.stringify(got)}，已阻止交易。`, 0);
      }
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
  getMarket(marketId) { return this.markets.get(Number(marketId)) || null; }
  getPosition(marketId) { return this._positions.get(Number(marketId)) || null; }
  getOpenOrders(marketId) { return [...this._tracked.values()].filter((o) => o.marketId === Number(marketId) && !o.internal); }

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
    // Touched the 50-order server cap recently — back off new opens (reduce-only still allowed).
    if (!o.reduceOnly && this._placementPausedUntil && Date.now() < this._placementPausedUntil) {
      throw new Error('Variational 下单被拒 reject（已达 50 单/合约上限，暂停开仓约 60s）。');
    }
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
    let resp;
    try {
      resp = await this.http.post('/api/orders/new/limit', body);
    } catch (e) {
      // A 4xx at placement is a rejection path (risk/capacity). Surface a message
      // containing `reject` so bot._handleExError's back-off regex triggers.
      if (e instanceof VaHttpError && e.status >= 400 && e.status < 500) {
        this.rejectedOrders += 1;
        // The 50-order/instrument/order-type cap returns HTTP 422 with error_message
        // "user exceeds max orders per instrument limit ..." — pause opens for 60s.
        if (/max orders|exceeds max|per instrument limit/i.test(String(e.message))) {
          this._placementPausedUntil = Date.now() + 60_000;
          this._setIssue(e); this.operationalIssue.title = 'Variational 挂单已达 50 单上限';
        } else if (/limit|max|exceed|capacity/i.test(String(e.message))) {
          this._setIssue(e);
        }
        throw new Error(`Variational 下单被拒 reject（${e.message}）`, { cause: e });
      }
      throw e;
    }
    const rfqId = resp?.rfq_id != null ? String(resp.rfq_id) : null;
    if (!rfqId) throw new VaHttpError('Variational 下单响应缺少 rfq_id。', 0, resp);
    this._tracked.set(rfqId, {
      orderId: rfqId, marketId: m.marketId, side: body.side, price, sizeBase: qty,
      levelIndex: o.levelIndex, reduceOnly: !!o.reduceOnly, createdAt: null,
      seen: false, placedAt: Date.now(), goneFirstAt: 0, canceling: false,
      forgotten: false, internal: false, clientOrderId: o.clientOrderId,
    });
    return { orderId: rfqId };
  }

  async cancelOrder(marketId, orderId) {
    this._assertTradingReady();
    const id = String(orderId);
    const t = this._tracked.get(id);
    // Mark canceling instead of deleting: positive confirmation resolves the
    // fill-vs-cancel race. CRITICAL: a POST failure most often means the order
    // ALREADY FILLED — do NOT reset canceling here; let _refreshOrders adjudicate.
    if (t) t.canceling = true;
    try { await this.http.post('/api/orders/cancel', { rfq_id: id }); return true; }
    catch (e) {
      // Already gone / mid-clearing: the order is effectively canceled; keep
      // canceling=true so _refreshOrders resolves a possible race fill. Don't alarm.
      if (this._isBenignCancelError(e)) return true;
      this._logCancelError(id, e);
      this.emit('error', e); return false;
    }
  }

  // A cancel that 400s with "does not exist / is inactive / pending clearing" is
  // BENIGN: the order is already gone (canceled/filled) or mid-clearing (the
  // fill-vs-cancel race). Not a failure — cancelAll's re-read verifies the book is
  // clear, and _refreshOrders adjudicates any race fill. Confirmed live: canceling
  // an already-removed rfq returns exactly this 400.
  _isBenignCancelError(e) {
    if (!(e instanceof VaHttpError) || e.status !== 400) return false;
    const msg = String(e?.data?.error_message || e?.message || '');
    return /does not exist|is inactive|pending clearing/i.test(msg);
  }

  // Bounded (first 20) status+body log for a failed cancel — a systemic failure
  // (cancelAll returning non-2xx en masse, or a "zombie" order) is otherwise
  // invisible. Shared by cancelOrder and cancelAll so both paths log identically.
  _logCancelError(id, e) {
    if ((this._cancelErrLogged = (this._cancelErrLogged || 0) + 1) > 20) return;
    const st = e instanceof VaHttpError ? e.status : 0;
    const body = e?.data != null ? ` body=${String(JSON.stringify(e.data)).slice(0, 200)}` : '';
    logger.warn('va', `撤单失败 rfq=${id} status=${st}：${String(e?.message || e).slice(0, 200)}${body}`);
  }

  async cancelAll(marketId) {
    this._assertTradingReady();
    const mId = Number(marketId);
    const MAX_ROUNDS = 4;
    let residual = [];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      // Re-read the live set each round: cancelAll is unreliable in one pass, and
      // an order may have FILLED between rounds (must not treat that as failure).
      let open;
      try { open = await this.fetchOpenOrders(mId); }
      catch { open = this.getOpenOrders(mId); }
      if (!open.length) { residual = []; break; }
      for (const o of open) { const t = this._tracked.get(String(o.orderId)); if (t) t.canceling = true; }
      for (const o of open) {
        try { await this.http.post('/api/orders/cancel', { rfq_id: String(o.orderId) }); }
        catch (e) {
          if (e instanceof VaRateLimitError) { await sleep(e.retryAfterMs || 2000); this.emit('error', e); }
          else if (this._isBenignCancelError(e)) { /* already gone / mid-clear: benign, verified by next re-read */ }
          else { this._logCancelError(String(o.orderId), e); this.emit('error', e); } // real failure: log + surface
        }
      }
      residual = open;
      // Let the server settle before verifying; widen the gap each round.
      if (round < MAX_ROUNDS - 1) await sleep(2000 * (round + 1));
    }
    // Final verification: anything still resting is a real problem — flag it.
    let stillOpen;
    try { stillOpen = await this.fetchOpenOrders(mId); } catch { stillOpen = residual; }
    if (stillOpen.length) {
      this._setIssue(new Error(`cancelAll 后仍有 ${stillOpen.length} 个挂单未撤销（已重试 ${MAX_ROUNDS} 轮）。`), true);
      return false;
    }
    return true;
  }

  /** Paged GET over orders/v2/trades. Stops at next_page===null, `stop()` hit, or MAX_PAGES. */
  async _getPaged(buildPath, { auth = true, stop } = {}) {
    const rows = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const json = await this.http.get(buildPath(page * 100), { auth });
      for (const r of unwrapResult(json)) rows.push(r);
      if (nextPageOf(json) == null) break;
      if (stop && stop(rows)) break;
    }
    return rows;
  }

  /** RAW pending rows across all markets (ALL order types) — for the live set. */
  async _fetchPendingRaw() {
    const out = [];
    for (const m of this.markets.values()) {
      const key = instrumentKey(m.underlying, this.instrumentCfg);
      const raw = await this._getPaged((offset) => `/api/orders/v2?status=pending&instrument=${encodeURIComponent(key)}&limit=100&offset=${offset}`, { auth: true });
      for (const r of raw.map(parseOrderRow)) if (r?.rfqId) out.push(r);
    }
    return out;
  }

  /** REAL resting LIMIT orders (bot reconciliation) — instrument-filtered, limit-only, strict underlying. */
  async fetchOpenOrders(marketId) {
    const markets = marketId != null ? [this._market(marketId)] : [...this.markets.values()];
    const out = [];
    for (const m of markets) {
      const key = instrumentKey(m.underlying, this.instrumentCfg);
      const raw = await this._getPaged((offset) => `/api/orders/v2?status=pending&instrument=${encodeURIComponent(key)}&limit=100&offset=${offset}`, { auth: true });
      for (const r of raw.map(parseOrderRow)) {
        if (!r?.rfqId) continue;
        if (r.orderType !== 'limit') continue;          // skip in-flight market orders
        if (r.underlying && r.underlying !== m.underlying) { this.http.warnOnce('ufilter:' + r.underlying, `orders/v2 返回了非本市场 underlying=${r.underlying}，已忽略。`); continue; }
        out.push({ orderId: r.rfqId, marketId: m.marketId, side: r.side, price: r.limitPrice ?? r.price, sizeBase: r.qty, status: r.status, createdAt: r.createdAt });
      }
    }
    return out;
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase, reduceOnly, createdAt }) {
    this._tracked.set(String(orderId), {
      orderId: String(orderId), marketId: Number(marketId), side, price: Number(price), sizeBase: Number(sizeBase),
      levelIndex, reduceOnly: !!reduceOnly, createdAt: createdAt || null,
      seen: false, placedAt: Date.now(), goneFirstAt: 0, canceling: false, forgotten: false, internal: false,
    });
  }

  // SOFT-FORGET: the bot deletes a level after confirming it "left the book", but
  // "left the book" INCLUDES "filled". If we are mid-cancel, keep the entry alive
  // (marked forgotten) so _refreshOrders can adjudicate the terminal row.
  forgetOrder(orderId) {
    const t = this._tracked.get(String(orderId));
    if (!t) return;
    if (t.canceling) { t.forgotten = true; return; }
    this._tracked.delete(String(orderId));
  }
  forgetOrders(marketId) { for (const [id, o] of this._tracked) if (o.marketId === Number(marketId)) this.forgetOrder(id); }

  async closePosition(marketId) {
    this._assertTradingReady();
    const m = this._market(marketId);
    const pos = this.getPosition(marketId);
    if (!pos?.sizeBase) return true;
    const side = pos.sizeBase > 0 ? 'sell' : 'buy';
    const qty = formatStep(Math.abs(pos.sizeBase), m.stepSize); // position is already 1e-6, no dust
    // Verified market-close path: indicative -> accept. quote_id valid ~1-2s, so
    // both writes use skipGap to avoid the 1s belt expiring the quote.
    const q = parseIndicative(await this.http.post('/api/quotes/indicative', { instrument: instrumentFor(m.underlying, this.instrumentCfg), qty }, { auth: true, skipGap: true }));
    if (!q?.quoteId) throw new VaHttpError('Variational 平仓报价缺少 quote_id。', 0, q);
    const r = await this.http.post('/api/quotes/accept', { quote_id: q.quoteId, side, max_slippage: 0.01, is_reduce_only: true }, { auth: true, skipGap: true });
    const rfqId = r?.rfq_id != null ? String(r.rfq_id) : null;
    if (!rfqId) throw new VaHttpError('Variational 平仓 accept 缺少 rfq_id。', 0, r);
    // internal:true -> _refreshOrders will NOT emit a grid fill for it.
    this._tracked.set(rfqId, {
      orderId: rfqId, marketId: m.marketId, side, price: side === 'sell' ? q.bid : q.ask, sizeBase: Number(qty),
      levelIndex: -1, reduceOnly: true, createdAt: null, seen: false, placedAt: Date.now(),
      goneFirstAt: 0, canceling: false, forgotten: false, internal: true,
    });
    return true;
  }

  // ── polling / positive-confirmation fill detection ──────────────────────
  start() { if (!this._timer) { this._timer = setInterval(() => this._poll(), this.pollMs); this._timer.unref?.(); } }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  async _poll() {
    if (this._polling) return; this._polling = true;
    try {
      // 会话保活：token 缺失或 <24h 且可自签 → 续签（内部有节流，廉价）。
      if (this.auth.canRefresh()) {
        const ok = await this.auth.ensure().catch(() => false);
        if (ok && !this._tradingReady && this.http.hasToken()) this._tradingReady = true;
      }
      await this._refreshPrices();
      if (this._tradingReady) {
        await this._refreshAccount();
        await this._refreshOrders();
      }
      this.lastOkAt = Date.now(); this.lastError = null;
      if (this.operationalIssue?.transient) this.operationalIssue = null;
    } catch (e) {
      this.lastError = e?.message || String(e);
      if (e?.status === 401) {
        this._tradingReady = false; this._setIssue(e); this.operationalIssue.title = 'Variational vr-token 失效';
        // 401 立即强制续签（受 5min 节流 + 每小时上限约束）；成功则下一轮恢复交易。
        if (this.auth.canRefresh()) {
          const ok = await this.auth.ensure({ force: true }).catch(() => false);
          if (ok && this.http.hasToken()) {
            // 新 token 先用 portfolio 验一次再放行，避免\"登录成功→立刻又 401→再登录\"空转。
            try { await this._refreshAccount(); this._tradingReady = true; this.operationalIssue = null; }
            catch { /* 新 token 仍不可用：保持锁定，下轮受 60s force 节流约束再试 */ }
          }
        }
      } else this._setIssue(e, !!e?.transient);
    } finally { this._polling = false; }
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
    // Positions three-state: ok:false -> keep last + issue; ok:true&&pos:null -> flat.
    let raw;
    try { raw = await this.http.get('/api/positions', { auth: true }); }
    catch (e) { this.http.warnOnce('positions', `读取 /api/positions 失败（保持上次持仓，勿据此下单）：${e?.message || e}`); this.lastOkAt = Date.now(); return; }
    for (const [marketId, m] of this.markets) {
      const res = parsePosition(raw, m.underlying);
      if (!res.ok) { this.http.warnOnce('posparse:' + res.reason, `无法解析 ${m.underlying} 持仓（${res.reason}）——保持上次持仓，不据此判定已平仓。`); this._setIssue(new Error(`持仓结构无法解析：${res.reason}`), true); continue; }
      if (res.pos) {
        this._positions.set(marketId, res.pos);
        if (res.pos.lastLocalSequence != null) this._posSeq.set(marketId, res.pos.lastLocalSequence); // cheap fill trigger
      } else {
        this._positions.delete(marketId); // genuinely flat
      }
    }
    this.lastOkAt = Date.now();
  }

  async _refreshOrders() {
    const pending = await this._fetchPendingRaw(); // all markets, all order types
    const live = new Set(pending.map((o) => o.rfqId));
    const createdMap = new Map(pending.map((o) => [o.rfqId, o.createdAt]));
    const now = Date.now();
    for (const t of this._tracked.values()) {
      if (live.has(t.orderId)) { t.seen = true; t.goneFirstAt = 0; if (!t.createdAt) t.createdAt = createdMap.get(t.orderId) || null; }
    }
    const gone = [...this._tracked.values()].filter((t) => !live.has(t.orderId) && (t.seen || now - t.placedAt > this._graceMs));
    if (!gone.length) return;

    // Window terminal queries by each order's OWN created_at (survives restart-adoption
    // and long runs), padded by HISTORY_BUFFER_MS.
    const sinceMs = Math.min(...gone.map((t) => Date.parse(t.createdAt) || t.placedAt)) - HISTORY_BUFFER_MS;
    const since = new Date(sinceMs).toISOString();
    const wantIds = new Set(gone.map((t) => t.orderId));

    let historyById;
    try {
      const hist = [];
      // Probe-verified: the `rfq_id=` filter is IGNORED, but `status=` + `instrument=`
      // + `created_at_gte=` work. Query each terminal status separately (cleared=fill,
      // canceled=cancel/risk-reject) so pagination can't bury a terminal row behind
      // a wall of still-pending rows.
      for (const m of this.markets.values()) {
        const key = instrumentKey(m.underlying, this.instrumentCfg);
        for (const st of ['cleared', 'canceled']) {
          const raw = await this._getPaged(
            (offset) => `/api/orders/v2?status=${st}&instrument=${encodeURIComponent(key)}&limit=100&offset=${offset}&order_by=created_at&order=desc&created_at_gte=${encodeURIComponent(since)}`,
            { auth: true, stop: (rows) => rows.filter((r) => wantIds.has(String(r.rfq_id))).length >= wantIds.size },
          );
          for (const r of raw) hist.push(r);
        }
      }
      historyById = new Map(hist.map(parseOrderRow).filter((r) => r?.rfqId).map((r) => [r.rfqId, r]));
    } catch (e) {
      this._setIssue(e, true); // cannot read terminal rows -> resolve nothing (fail-closed)
      return;
    }

    const tradesByRfq = new Map();
    try {
      const trades = [];
      for (const m of this.markets.values()) {
        const key = instrumentKey(m.underlying, this.instrumentCfg);
        const raw = await this._getPaged(
          (offset) => `/api/trades?instrument=${encodeURIComponent(key)}&limit=100&offset=${offset}&order_by=created_at&order=desc&created_at_gte=${encodeURIComponent(since)}`,
          { auth: true, stop: (rows) => rows.filter((r) => wantIds.has(String(r.source_rfq))).length >= wantIds.size },
        );
        for (const r of raw) trades.push(r);
      }
      for (const tr of trades.map(parseTrade)) if (tr?.rfqId) tradesByRfq.set(tr.rfqId, tr);
    } catch { /* trades optional: fall back to order-row price */ }

    for (const t of gone) {
      const row = historyById.get(t.orderId);
      if (!row) {
        if (!t.goneFirstAt) { t.goneFirstAt = now; continue; }
        if (now - t.goneFirstAt < RESOLVE_TIMEOUT_MS) continue;
        // Timed out with no terminal row. For forgotten/internal orders the bot no
        // longer depends on them (level dropped / internal close) — stop tracking so
        // they don't leak in _tracked forever. Only NORMAL grid orders raise a hole alert.
        if (t.internal || t.forgotten) {
          this._tracked.delete(t.orderId);
          logger.warn('va', `${t.internal ? '平仓' : '已遗忘'}订单 ${t.orderId}（${t.side} @ ${t.price}）出簿 10 分钟仍无终态记录，停止跟踪。`);
        } else {
          this.droppedLevels += 1;
          logger.warn('va', `⚠️ 订单 ${t.orderId}（${t.side} @ ${t.price}）出簿 10 分钟仍无法从 orders/v2 确认终态，档位可能空洞（累计 ${this.droppedLevels}），请核对交易所并考虑重启网格补齐。`);
          t.goneFirstAt = now; // re-arm to throttle
        }
        continue;
      }
      const filled = isFilled(row.status);
      const canceled = isCanceled(row.status);
      const rejected = row.failedRiskChecks.length > 0;

      // INTERNAL (closePosition accept): update state, NEVER re-emit as a grid fill.
      if (t.internal) {
        if (filled) { logger.info('va', `平仓单 ${t.orderId} 已成交 @ ${row.price ?? t.price}。`); this._tracked.delete(t.orderId); }
        else if (canceled || rejected) { this._tracked.delete(t.orderId); this.emit('error', new Error(`Variational 平仓单 ${t.orderId} 未成交（${row.cancelReason || (rejected ? 'risk' : 'unknown')}），请重试平仓。`)); }
        else this.http.warnOnce('istatus:' + row.status, `Variational 平仓单出现未知状态 ${row.status}，保持跟踪。`);
        continue;
      }

      // FORGOTTEN (bot dropped the level, we were mid-cancel): a fill here is "late".
      if (t.forgotten) {
        if (filled) {
          this.lateFills += 1; this._tracked.delete(t.orderId);
          this.emit('error', new Error(`Variational 订单 ${t.orderId}（${t.side} @ ${t.price}）在撤单期间已成交，库存已变化，请核对持仓（累计迟到成交 ${this.lateFills}）。`));
        } else if (canceled || rejected) { this._tracked.delete(t.orderId); }
        else this.http.warnOnce('fstatus:' + row.status, `Variational 已遗忘订单出现未知状态 ${row.status}，保持跟踪。`);
        continue;
      }

      // NORMAL grid order.
      if (filled) {
        const tr = tradesByRfq.get(t.orderId);
        const fillPrice = row.price ?? tr?.price ?? t.price;   // row.price is the actual fill (may beat the limit)
        const fillQty = row.qty ?? tr?.qty ?? t.sizeBase;
        this._tracked.delete(t.orderId);
        this.emit('fill', { orderId: t.orderId, marketId: t.marketId, side: t.side, price: fillPrice, sizeBase: fillQty, levelIndex: t.levelIndex, clientOrderId: t.clientOrderId });
      } else if (rejected) {
        this._tracked.delete(t.orderId); this.rejectedOrders += 1;
        this.emit('error', new Error(`Variational 拒单 reject（风控 ${row.failedRiskChecks.join(',')}）：订单 ${t.orderId} ${t.side} @ ${t.price}，不补反向单（累计拒单 ${this.rejectedOrders}）。`));
      } else if (canceled) {
        this._tracked.delete(t.orderId);
        if (!t.canceling) this.emit('error', new Error(`Variational 订单 ${t.orderId}（${t.side} @ ${t.price}）被非本地撤销（${row.cancelReason || 'unknown'}），不视为成交、不补单。`));
      } else {
        this.http.warnOnce('status:' + row.status, `Variational 订单 ${t.orderId} 出现未知状态 ${row.status}，保持跟踪待下轮裁决。`);
      }
    }
  }

  _setIssue(error, transient = false) {
    const message = error?.message || String(error);
    this.operationalIssue = { title: 'Variational 交易所异常', message, transient };
    if (error instanceof CloudflareError) this.operationalIssue.title = 'Variational Cloudflare 拦截';
    if (Date.now() - this._lastAlertAt > 30_000) { this._lastAlertAt = Date.now(); this.emit('error', new Error(message)); }
  }
}
