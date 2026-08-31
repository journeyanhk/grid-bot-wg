// Robinhood Chain Lighter (RHC) LIVE adapter.
//
// Public/account data and signed transaction submission use REST so all calls
// share the program's existing undici proxy.  The official Python SDK is used
// only as an offline signer with explicit nonces.  HTTP acceptance is followed
// by authoritative active/inactive-order reconciliation; background polling
// automatically recovers after disconnections and never cancels orders merely
// because a connection went stale.
import { EventEmitter } from 'node:events';
import { LighterSignerBridge } from './signer.js';
import {
  CANDLE_RESOLUTIONS, RHC_API_URL, RHC_CHAIN_ID, RHC_WS_URL,
  makeClientOrderIndex, parseCandles, parseMarkets, RHC_MAX_CLIENT_ORDER_INDEX, toExchangeInteger,
} from './market.js';

const FINAL_FILLED = new Set(['filled']);
const FINAL_REJECTED = new Set([
  'canceled', 'canceled-post-only', 'canceled-reduce-only',
  'canceled-position-not-allowed', 'canceled-margin-not-allowed',
  'canceled-too-much-slippage', 'canceled-not-enough-liquidity',
  'canceled-self-trade', 'canceled-expired', 'canceled-oco',
  'canceled-child', 'canceled-liquidation', 'canceled-invalid-balance',
]);
const POLL_MS = 2000; // 快速轮询降低成交/补单延迟（完整 RHC WS /stream 推送需协议文档，暂未接入）
// Account PnL is an authenticated REST chart endpoint. It is authoritative for
// historical realised profit (the ordinary /account response only includes the
// currently-open RHC position and reports realised_pnl=0 for that row), but it
// does not need to be fetched on every 5-second account poll.
const PNL_POLL_MS = 30_000;
const MAX_BATCH = 15;
// Keep batches small enough for the signer/API request while allowing GridBot
// to submit the next batch immediately after the previous one is confirmed.
// A fixed delay made healthy accounts wait unnecessarily; actual 429/405
// responses now drive the retry backoff instead.
const SAFE_GRID_BATCH = 15;            // MAX_BATCH 即 15，140 单从 14 批减到 10 批
const SAFE_GRID_BATCH_PACE_MS = 1500;   // 批间强制 1.5s 间隔，防止启动铺单自我限流（429 自激根因）
const OPENING_RETRY_BASE_MS = 5_000;    // 非显式 retry-after 时重试地板抬高，避免 2s tick 驱动下连续撞墙
const OPENING_RETRY_MAX = 8;

export class LighterExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live'; this.network = 'mainnet'; this.apiUrl = RHC_API_URL; this.wsUrl = RHC_WS_URL; this.chainId = RHC_CHAIN_ID;
    this.accountIndex = Number(opts.accountIndex); this.apiKeyIndex = Number(opts.apiKeyIndex);
    this.apiPrivateKey = opts.apiPrivateKey || ''; this.apiPrivateKeyFile = opts.apiPrivateKeyFile || '';
    this.pythonPath = opts.pythonPath || ''; this.proxy = opts.proxy || '';
    this.feeRate = Number(opts.feeRate || 0.0005); this.dataSource = null;
    this.balance = null; this.equity = null; this.realizedPnl = null; this.accountTotalPnl = null;
    this.lastOkAt = 0; this.lastError = null; this.operationalIssue = null;
    this.markets = new Map(); this._prices = new Map(); this._positions = new Map(); this._tracked = new Map();
    this._accountUnrealizedPnl = 0; this._lastPnlAttemptAt = 0; this.lastPnlError = null;
    this._timer = null; this._polling = false; this._auth = null; this._authExpiresAt = 0; this._txTail = Promise.resolve();
    this._clientSeq = 0; this._lastAlertAt = 0; this._tradingReady = false;
    // GridBot capability/policy hints. Opening-order retries are allowed only
    // because GridBot performs two authoritative order snapshots and de-dupes
    // by grid level before every retry.
    this.supportsSafeOpeningRetry = true;
    this.orderBatchSize = SAFE_GRID_BATCH;
    this.orderBatchPaceMs = SAFE_GRID_BATCH_PACE_MS;
    this.openingRetryBaseMs = OPENING_RETRY_BASE_MS;
    this.openingRetryMax = OPENING_RETRY_MAX;
    this.signer = opts.signer || new LighterSignerBridge({
      pythonPath: this.pythonPath, apiUrl: this.apiUrl, chainId: this.chainId,
      accountIndex: this.accountIndex, apiKeyIndex: this.apiKeyIndex,
      apiPrivateKey: this.apiPrivateKey, apiPrivateKeyFile: this.apiPrivateKeyFile,
    });
  }

  async init() {
    this._tradingReady = false;
    try {
      this._validateConfig();
      await this.signer.start();
      const health = await this.signer.request('health');
      if (health?.chainId !== RHC_CHAIN_ID || health?.profile !== 'robinhood') throw new Error('RHC 签名器端点/链 ID 校验失败，已拒绝启动实盘。');
      await this._loadMarkets();
      await this._refreshAccount();
      await this._refreshPnl(true);
      // A signed authenticated read validates that the configured private API
      // key actually belongs to this account/key index without exposing the key.
      await this.fetchOpenOrders();
      this.dataSource = 'real'; this.lastOkAt = Date.now(); this.operationalIssue = null; this._tradingReady = true;
      this.start(); return true;
    } catch (error) {
      this._tradingReady = false; this.dataSource = null;
      await this.signer.stop().catch(() => {});
      this.lastError = error?.message || String(error); this._setIssue(error);
      throw error;
    }
  }

  _validateConfig() {
    if (!Number.isInteger(this.accountIndex) || this.accountIndex < 0) throw new Error('LIGHTER_ACCOUNT_INDEX 必须是非负整数。');
    if (!Number.isInteger(this.apiKeyIndex) || this.apiKeyIndex < 4 || this.apiKeyIndex > 254) throw new Error('LIGHTER_API_KEY_INDEX 必须在 4-254；0-3 是平台保留索引。');
    if (!this.apiPrivateKey && !this.apiPrivateKeyFile) throw new Error('RHC LIVE 模式需要 LIGHTER_API_PRIVATE_KEY 或 LIGHTER_API_PRIVATE_KEY_FILE。');
    if (this.apiUrl !== RHC_API_URL || this.chainId !== RHC_CHAIN_ID) throw new Error('RHC LIVE 只允许官方主网端点和 chainId=466324。');
  }

  async reconnect() {
    this._tradingReady = false;
    try {
      if (this._timer) clearInterval(this._timer); this._timer = null; this._auth = null; this._authExpiresAt = 0;
      await this.signer.stop().catch(() => {}); await this.signer.start();
      await this._loadMarkets(); await this._refreshAccount(); await this._refreshPnl(true); await this._refreshOrders();
      this.dataSource = 'real'; this.lastOkAt = Date.now(); this.operationalIssue = null; this._tradingReady = true; this.start(); return true;
    } catch (error) {
      this._tradingReady = false; this.dataSource = null;
      await this.signer.stop().catch(() => {});
      this.lastError = error?.message || String(error); this._setIssue(error);
      throw error;
    }
  }

  async _request(method, path, { form, headers = {}, retry = method === 'GET' } = {}) {
    // 写请求最小间隔保险带：即使未来有调用路径绕过批量配速，交易写入也不会超过 ~1 次/秒
    if (method === 'POST') {
      const gap = 1100 - (Date.now() - (this._lastWriteAt || 0));
      if (gap > 0) await sleep(gap);
      this._lastWriteAt = Date.now();
    }
    let last;
    for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
      try {
        const res = await fetch(this.apiUrl + path, {
          method,
          headers: {
            Accept: 'application/json',
            ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
            ...headers,
          },
          body: form ? new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text(); let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 500) }; }
        const codeOk = data?.code == null || Number(data.code) === 0 || Number(data.code) === 200;
        if (res.ok && codeOk) return data;
        const detail = data?.message || data?.error || `HTTP ${res.status}`;
        const err = new Error(this._friendlyError(res.status, detail)); err.status = res.status; err.data = data;
        if (res.status === 429 || res.status === 405) {
          err.rateLimited = true;
          err.retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after')) ?? OPENING_RETRY_BASE_MS;
        }
        throw err;
      } catch (e) {
        // Node exposes connection failures as the unhelpful top-level message
        // "fetch failed".  Preserve HTTP errors as-is, but translate transport
        // failures without leaking a possibly credential-bearing proxy URL.
        last = e?.status ? e : this._friendlyNetworkError(e, this.apiUrl + path);
        if (attempt + 1 < (retry ? 2 : 1)) await sleep(250);
      }
    }
    throw last;
  }

  _friendlyNetworkError(error, requestUrl) {
    const code = String(error?.cause?.code || error?.code || '').trim();
    const name = String(error?.cause?.name || error?.name || '').trim();
    const host = new URL(requestUrl).host;
    let message;
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || name === 'TimeoutError') {
      message = `无法连接 RHC 官方接口 ${host}（连接超时）。这不是 API 密钥错误；请在交易所官方状态页、浏览器和本机网络中确认该接口可达。接口或所在地区不可用时，程序会保持交易锁定。`;
    } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      message = `无法解析 RHC 官方接口 ${host}（DNS 错误${code ? `：${code}` : ''}）。请检查本机 DNS、网络和代理配置；程序会保持交易锁定。`;
    } else if (code === 'ECONNREFUSED' || code === 'UND_ERR_SOCKET') {
      message = `RHC 官方接口 ${host} 拒绝或中断了连接${code ? `（${code}）` : ''}。请稍后重试并核对官方服务状态；程序会保持交易锁定。`;
    } else {
      message = `无法连接 RHC 官方接口 ${host}${code ? `（${code}）` : ''}。请检查网络、代理和官方服务状态；程序会保持交易锁定。`;
    }
    const friendly = new Error(message, { cause: error });
    if (code) friendly.code = code;
    return friendly;
  }

  _friendlyError(status, detail) {
    if (status === 401 || status === 403) return 'RHC 鉴权失败：请核对 accountIndex、API key index、API 私钥和电脑时间。';
    if (status === 429 || status === 405) return 'RHC 接口限流；程序将按实际限流退避，并在重新核对交易所真实挂单后补挂未确认订单。';
    return `RHC 接口错误 ${status || ''}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  }

  _get(path, headers) { return this._request('GET', path, { headers }); }
  _postForm(path, form) { return this._request('POST', path, { form, retry: false }); }
  async _authorization() {
    if (this._auth && Date.now() < this._authExpiresAt - 60_000) return this._auth;
    const out = await this.signer.request('auth', { seconds: 8 * 60 });
    this._auth = out.token; this._authExpiresAt = Date.now() + Number(out.expiresIn || 480) * 1000; return this._auth;
  }

  async _loadMarkets() {
    const rows = parseMarkets(await this._get('/api/v1/orderBookDetails?filter=perp'));
    if (!rows.length) throw new Error('RHC 当前没有返回 active 状态的永续合约市场。');
    this.markets = new Map(rows.map((m) => [m.marketId, m]));
    for (const m of rows) { if (m.lastPrice > 0) this._prices.set(m.marketId, m.lastPrice); }
    const fees = rows.map((m) => m.makerFee).filter((x) => Number.isFinite(x) && x >= 0);
    const maxMarketFee = fees.length ? Math.max(...fees) : 0;
    if (maxMarketFee > 0) this.feeRate = maxMarketFee;
  }

  _market(marketId) { const m = this.markets.get(Number(marketId)); if (!m) throw new Error(`未知 RHC 市场 marketId=${marketId}`); return m; }
  _assertTradingReady() {
    if (!this._tradingReady || this.dataSource !== 'real') {
      throw new Error('RHC 实盘鉴权和账户快照尚未完整通过，已阻止签名交易；请先检查配置并执行“重连交易所”。');
    }
  }
  async getMarkets() { return [...this.markets.values()]; }
  async getCandles(marketId, intervalSec = 3600, n = 200) {
    this._market(marketId);
    const resolution = CANDLE_RESOLUTIONS.get(Number(intervalSec)) || '1h';
    const count = Math.min(500, Math.max(20, Number(n) || 200)); const end = Math.floor(Date.now() / 1000), start = end - count * Number(intervalSec || 3600);
    return parseCandles(await this._get(`/api/v1/candles?market_id=${Number(marketId)}&resolution=${resolution}&start_timestamp=${start}&end_timestamp=${end}&count_back=${count}`));
  }
  async getPrice(marketId) {
    const id = Number(marketId); this._market(id);
    if (!this._prices.has(id)) await this._loadMarkets(); return this._prices.get(id) ?? this.markets.get(id).lastPrice;
  }

  async _refreshAccount() {
    const data = await this._get(`/api/v1/account?by=index&value=${this.accountIndex}`);
    // The official endpoint returns DetailedAccounts even when queried by one
    // exact index. Keep a direct-object fallback for forward compatibility.
    const account = Array.isArray(data?.accounts)
      ? data.accounts.find((x) => Number(x?.index ?? x?.account_index) === this.accountIndex)
      : data;
    if (!account || Number(account?.index ?? account?.account_index) !== this.accountIndex) {
      throw new Error('RHC 未返回配置的 accountIndex；请核对账户编号和所选主网账户。');
    }
    this.balance = finite(account.available_balance, account.collateral);
    this.equity = finite(account.total_asset_value, account.cross_asset_value, account.collateral, account.available_balance);
    const positions = new Map(); let accountUnrealized = 0;
    for (const p of Array.isArray(account.positions) ? account.positions : []) {
      const marketId = Number(p.market_id), rawSize = Number(p.position || 0);
      const sign = Number(p.sign || Math.sign(rawSize) || 1); const sizeBase = Math.abs(rawSize) * (sign < 0 ? -1 : 1);
      const imf = Number(p.initial_margin_fraction || 0);
      accountUnrealized += Number(p.unrealized_pnl || 0);
      if (!sizeBase) continue;
      positions.set(marketId, {
        sizeBase, entryPrice: Number(p.avg_entry_price || 0), unrealizedPnl: Number(p.unrealized_pnl || 0),
        realizedPnl: Number(p.realized_pnl || 0), liquidationPrice: finite(p.liquidation_price),
        leverage: imf > 0 ? Math.max(1, Math.round(10_000 / imf)) : null,
        marginMode: Number(p.margin_mode) === 1 ? 'isolated' : 'cross',
      });
    }
    this._positions = positions; this._accountUnrealizedPnl = accountUnrealized; this.lastOkAt = Date.now();
  }
  getPosition(marketId) { return this._positions.get(Number(marketId)) || null; }

  async _refreshPnl(force = false) {
    const now = Date.now();
    if (!force && now - this._lastPnlAttemptAt < PNL_POLL_MS) return false;
    this._lastPnlAttemptAt = now;
    try {
      const auth = await this._authorization();
      const end = Math.floor(now / 1000), start = end - 24 * 60 * 60;
      const query = new URLSearchParams({
        by: 'index', value: String(this.accountIndex), resolution: '1h',
        start_timestamp: String(start), end_timestamp: String(end),
        count_back: '24', ignore_transfers: 'false',
      });
      const data = await this._get(`/api/v1/pnl?${query}`, { authorization: auth });
      const rows = Array.isArray(data?.pnl) ? data.pnl : [];
      const latest = rows
        .filter((row) => Number.isFinite(Number(row?.trade_pnl)))
        .sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0))
        .at(-1);
      if (!latest) throw new Error('RHC PnL 接口没有返回有效 trade_pnl。');

      // With ignore_transfers=false the official endpoint's trade_pnl is the
      // account trading result after cash inflows/outflows are removed. Split
      // that total into realised + the currently-open positions' unrealised PnL.
      const total = Number(latest.trade_pnl);
      this.accountTotalPnl = total;
      this.realizedPnl = total - this._accountUnrealizedPnl;
      this.lastPnlError = null;
      return true;
    } catch (error) {
      // A transient PnL-chart failure must not erase a previously valid result.
      // GridBot will fall back to equity-vs-startBalance if no valid result has
      // ever been obtained for this process.
      this.lastPnlError = error?.message || String(error);
      return false;
    }
  }

  async _nextNonce() {
    const data = await this._get(`/api/v1/nextNonce?account_index=${this.accountIndex}&api_key_index=${this.apiKeyIndex}`);
    const nonce = Number(data?.nonce); if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('RHC 未返回有效 nonce。'); return nonce;
  }
  _serializeTx(fn) {
    const run = this._txTail.then(fn, fn); this._txTail = run.catch(() => {}); return run;
  }
  async _sendSigned(tx) {
    const data = await this._postForm('/api/v1/sendTx', { tx_type: tx.txType, tx_info: tx.txInfo, price_protection: true });
    return { ...data, txHash: data.tx_hash || tx.txHash };
  }
  async _sendSignedBatch(transactions) {
    const data = await this._postForm('/api/v1/sendTxBatch', {
      tx_types: JSON.stringify(transactions.map((x) => x.txType)),
      tx_infos: JSON.stringify(transactions.map((x) => x.txInfo)),
    });
    return { ...data, txHashes: data.tx_hash || transactions.map((x) => x.txHash) };
  }

  _prepareOrder(order) {
    const market = this._market(order.marketId);
    const baseAmount = toExchangeInteger(order.sizeBase, market.sizeDecimals, 'down');
    const price = toExchangeInteger(order.price, market.priceDecimals, 'nearest');
    const normalizedSize = baseAmount / 10 ** market.sizeDecimals, normalizedPrice = price / 10 ** market.priceDecimals;
    if (!(baseAmount > 0) || normalizedSize < market.minOrderSize) throw new Error(`数量低于 RHC ${market.displayName} 最小下单量 ${market.minOrderSize}。`);
    if (!order.reduceOnly && market.minOrderNotional > 0 && normalizedPrice * normalizedSize < market.minOrderNotional) throw new Error(`订单名义价值低于 RHC ${market.displayName} 最低 ${market.minOrderNotional} USD。`);
    const requestedClientOrderIndex = Number(order.clientOrderId);
    const clientOrderIndex = Number.isSafeInteger(requestedClientOrderIndex)
      && requestedClientOrderIndex >= 0
      && requestedClientOrderIndex <= RHC_MAX_CLIENT_ORDER_INDEX
      ? requestedClientOrderIndex
      : makeClientOrderIndex(++this._clientSeq);
    return { order, market, baseAmount, price, normalizedSize, normalizedPrice, clientOrderIndex };
  }

  async placeLimitOrders(orders) {
    this._assertTradingReady();
    if (!Array.isArray(orders) || !orders.length || orders.length > MAX_BATCH) throw new Error('RHC 每个批量下单请求必须是 1-15 笔。');
    const prepared = orders.map((o) => this._prepareOrder(o));
    const marketIds = new Set(prepared.map((x) => x.market.marketId));
    if (marketIds.size !== 1) throw new Error('RHC 一个网格批次只能包含同一市场。');
    return this._serializeTx(async () => {
      const firstNonce = await this._nextNonce();
      const signed = await this.signer.request('sign_orders', { orders: prepared.map((x, i) => ({
        marketIndex: x.market.marketId, clientOrderIndex: x.clientOrderIndex,
        baseAmount: x.baseAmount, price: x.price, isAsk: String(x.order.side).toLowerCase() === 'sell',
        orderType: x.order.immediate ? 1 : 0,
        timeInForce: x.order.immediate ? 0 : 1,
        reduceOnly: !!x.order.reduceOnly, orderExpiry: x.order.immediate ? 0 : -1,
        nonce: firstNonce + i,
      })) }, 30_000);
      const txs = signed.transactions;
      try {
        if (txs.length === 1) await this._sendSigned(txs[0]); else await this._sendSignedBatch(txs);
      } catch (error) {
        // A write timeout is ambiguous. Resolve by client order index before
        // throwing, so an accepted batch is never abandoned as an orphan.
        const found = await this._findOrdersByClientIds(prepared.map((x) => x.clientOrderIndex), prepared[0].market.marketId).catch(() => new Map());
        if (found.size !== prepared.length) throw error;
      }
      // RHC acknowledges writes before the sequencer has necessarily accepted
      // them. Confirm once, serially, so startup cannot create a burst of
      // concurrent order-history requests across all grid batches.
      let rejected;
      try { rejected = await this._confirmAccepted(prepared); }
      catch (e) {
        // Do not report an unconfirmed write as a successful grid rung. GridBot
        // will wait, read two authoritative snapshots, adopt any order that did
        // land, and only then retry a genuinely empty level.
        this._setIssue(e);
        throw e;
      }
      return prepared.map((x) => {
        const orderId = String(x.clientOrderIndex);
        if (rejected?.has(orderId)) return null;
        this._tracked.set(orderId, {
          orderId, marketId: x.market.marketId, levelIndex: x.order.levelIndex, side: String(x.order.side).toLowerCase(),
          price: x.normalizedPrice, sizeBase: x.normalizedSize, reduceOnly: !!x.order.reduceOnly,
          placedAt: Date.now(), seen: true,
        });
        return { orderId, price: x.normalizedPrice, sizeBase: x.normalizedSize };
      });
    });
  }
  async placeLimitOrder(order) { return (await this.placeLimitOrders([order]))[0]; }

  async _confirmAccepted(prepared) {
    // 多轮等待：连发压力下 sequencer 落账可能慢于单次 350ms，给到 ~5.7s 总计
    // 等待窗，已接收未确认的批次几乎必然确认成功，不再整批涌入重试队列。
    const ids = prepared.map((x) => x.clientOrderIndex), marketId = prepared[0].market.marketId;
    let found = new Map();
    for (const wait of [350, 800, 1600, 3000]) {
      await sleep(wait);
      try { found = await this._findOrdersByClientIds(ids, marketId); } catch { /* 快照读失败视为未确认，继续等 */ }
      if (found.size === ids.length) {
        const rejected = new Set([...found.entries()]
          .filter(([, o]) => FINAL_REJECTED.has(String(o.status).toLowerCase()))
          .map(([id]) => String(id)));
        if (rejected.size) {
          const statuses = [...found.entries()].filter(([id]) => rejected.has(String(id))).map(([, o]) => o.status);
          this._setIssue(new Error(`RHC sequencer 拒绝 ${rejected.size} 笔订单：${statuses.join(', ')}`));
        }
        return rejected;
      }
    }
    throw new Error('RHC API 已接收下单，但 sequencer 快照尚未确认全部订单；程序将继续自动对账，禁止重复点击启动。');
  }
  async _findOrdersByClientIds(ids, marketId) {
    const wanted = new Set(ids.map(String)); const found = new Map();
    const active = await this._fetchActiveOrders(marketId);
    for (const o of active) { const id = remoteOrderId(o); if (wanted.has(id)) found.set(id, o); }
    if (found.size < wanted.size) {
      const inactive = await this._fetchInactiveOrders(marketId);
      for (const o of inactive) { const id = remoteOrderId(o); if (wanted.has(id)) found.set(id, o); }
    }
    return found;
  }

  async cancelOrder(marketId, orderId) {
    this._assertTradingReady();
    this._market(marketId);
    return this._serializeTx(async () => {
      const nonce = await this._nextNonce();
      const tx = await this.signer.request('sign_cancel', { marketIndex: Number(marketId), orderIndex: numericOrderId(orderId), nonce });
      await this._sendSigned(tx); return true;
    });
  }
  async cancelAll(marketId) {
    this._assertTradingReady();
    this._market(marketId);
    return this._serializeTx(async () => {
      const nonce = await this._nextNonce();
      const tx = await this.signer.request('sign_cancel_all', { marketIndex: Number(marketId), nonce });
      await this._sendSigned(tx); return true;
    });
  }
  async setLeverage(marketId, leverage) {
    this._assertTradingReady();
    const market = this._market(marketId); const value = Math.min(Math.max(1, Math.floor(Number(leverage))), market.maxLeverage || 50);
    return this._serializeTx(async () => {
      const nonce = await this._nextNonce();
      const tx = await this.signer.request('sign_update_leverage', { marketIndex: market.marketId, leverage: value, isolated: false, nonce });
      await this._sendSigned(tx); return true;
    });
  }

  async _fetchActiveOrders(marketId) {
    const auth = await this._authorization();
    const suffix = marketId == null ? '' : `&market_id=${Number(marketId)}`;
    const data = await this._get(`/api/v1/accountActiveOrders?account_index=${this.accountIndex}&market_type=perp${suffix}`, { authorization: auth });
    return Array.isArray(data?.orders) ? data.orders : [];
  }
  async _fetchInactiveOrders(marketId) {
    const auth = await this._authorization();
    const suffix = marketId == null ? '' : `&market_id=${Number(marketId)}`;
    const data = await this._get(`/api/v1/accountInactiveOrders?account_index=${this.accountIndex}&limit=100&market_type=perp${suffix}`, { authorization: auth });
    return Array.isArray(data?.orders) ? data.orders : [];
  }
  async fetchOpenOrders(marketId) {
    const rows = await this._fetchActiveOrders(marketId);
    return rows.map((o) => ({
      orderId: remoteOrderId(o), marketId: Number(o.market_index), side: o.is_ask ? 'sell' : 'buy',
      price: Number(o.price), sizeBase: Number(o.remaining_base_amount || o.initial_base_amount || 0),
      reduceOnly: !!o.reduce_only, status: o.status,
    }));
  }
  getOpenOrders(marketId) { return [...this._tracked.values()].filter((o) => o.marketId === Number(marketId)); }
  forgetOrder(orderId) { this._tracked.delete(String(orderId)); }
  forgetOrders(marketId) { for (const [id, o] of this._tracked) if (o.marketId === Number(marketId)) this._tracked.delete(id); }
  adoptOrder(order) { this._tracked.set(String(order.orderId), { ...order, orderId: String(order.orderId), marketId: Number(order.marketId), seen: true, placedAt: Date.now() }); }

  async _refreshOrders() {
    const activeRows = await this._fetchActiveOrders();
    const active = new Map(activeRows.map((o) => [remoteOrderId(o), o]));
    let needInactive = false;
    for (const tracked of this._tracked.values()) {
      if (active.has(tracked.orderId)) tracked.seen = true;
      else if (tracked.seen || Date.now() - tracked.placedAt > 1000) needInactive = true;
    }
    if (!needInactive) return;
    const inactive = new Map((await this._fetchInactiveOrders()).map((o) => [remoteOrderId(o), o]));
    for (const [id, tracked] of [...this._tracked]) {
      if (active.has(id)) continue;
      const row = inactive.get(id); if (!row) continue;
      const status = String(row.status || '').toLowerCase();
      if (FINAL_FILLED.has(status)) {
        this._tracked.delete(id);
        this.emit('fill', { orderId: id, marketId: tracked.marketId, side: tracked.side, price: Number(row.price || tracked.price), sizeBase: Number(row.filled_base_amount || tracked.sizeBase), levelIndex: tracked.levelIndex });
      } else if (FINAL_REJECTED.has(status)) {
        // 部分成交后被撤/被拒：若已有成交部分（filled_base_amount>0），必须补发
        // fill 事件，否则这部分库存进了仓位但网格永久不知道，长期积累方向性敞口。
        const filled = Number(row.filled_base_amount || 0);
        if (filled > 0) {
          this.emit('fill', { orderId: id, marketId: tracked.marketId, side: tracked.side, price: Number(row.price || tracked.price), sizeBase: filled, levelIndex: tracked.levelIndex });
        }
        this._tracked.delete(id);
      }
    }
  }

  async closePosition(marketId) {
    const pos = this.getPosition(marketId); if (!pos?.sizeBase) return true;
    const price = await this.getPrice(marketId); const side = pos.sizeBase > 0 ? 'sell' : 'buy';
    const worst = side === 'sell' ? price * 0.95 : price * 1.05;
    await this.placeLimitOrder({ marketId: Number(marketId), side, price: worst, sizeBase: Math.abs(pos.sizeBase), reduceOnly: true, immediate: true, levelIndex: -1, clientOrderId: makeClientOrderIndex(++this._clientSeq) });
    return true;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll(), POLL_MS); this._timer.unref?.();
  }
  stop() { /* monitoring remains active after the grid stops */ }
  /** 铺单降载开关：大规模铺单期间跳过重查询（account/pnl/orders），把请求预算让给下单。 */
  setPollLight(v) { this._pollLight = !!v; }

  async _poll() {
    if (this._polling) return; this._polling = true;
    try {
      await this._loadMarkets(); // 价格源保留：成交/风控依赖价格 tick
      for (const [marketId, price] of this._prices) this.emit('price', { marketId, price });
      if (!this._pollLight) { // 铺单期间跳过，让出请求预算给下单
        await this._refreshAccount(); await this._refreshPnl(); await this._refreshOrders();
      }
      this.lastOkAt = Date.now(); this.lastError = null; this.operationalIssue = null;
    } catch (e) { this.lastError = e?.message || String(e); this._setIssue(e); }
    finally { this._polling = false; }
  }
  _setIssue(error) {
    const message = error?.message || String(error);
    this.operationalIssue = { title: 'RHC Lighter 交易所异常', message };
    if (Date.now() - this._lastAlertAt > 30_000) { this._lastAlertAt = Date.now(); this.emit('error', new Error(message)); }
  }
}

function remoteOrderId(order) { return String(order?.client_order_index ?? order?.order_index ?? order?.client_order_id ?? order?.order_id ?? ''); }
function numericOrderId(value) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error(`RHC orderIndex 无效：${value}`); return n; }
function finite(...values) { for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; } return null; }
function parseRetryAfterMs(value) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
