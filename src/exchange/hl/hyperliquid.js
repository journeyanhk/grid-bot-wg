// Hyperliquid (HL) LIVE adapter for the "io" dex namespace.
//
// Hyperliquid exposes an authoritative fills API, so the three-layer evidence
// chain built for EX/LR is unnecessary here: every fill is confirmed from
// userFillsByTime (incremental by startTime), no price-crossing inference.
// Public reads use the /info endpoint; signed writes go through the Python
// signer worker (agent wallet, can trade but cannot withdraw).  All requests
// carry dex:"io" so HIP-3 assets such as io:ANTH are addressed correctly.
//
// 契约已按 2026-09-07 主网实测校准：metaAndAssetCtxs 返回数组 [meta, ctxs]、
// userFills 无 cursor（增量用 userFillsByTime + startTime）、candleSnapshot 直接
// 返回数组、HL 报价必须 ≤5 位有效数字。
// HIP-3 铁律：接入 builder-dex 时，每个按 user 查询的端点都要问一遍"它认不认
// dex 参数"——clearinghouseState ✓、frontendOpenOrders ✓（缺它曾导致 14 单翻倍
// 成 42 单）、userFillsByTime（实测不带 dex 也返回 io 成交，保持不带）、
// metaAndAssetCtxs 本身按 dex 查询。
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../../log.js';
import { HLSignerBridge } from './signer.js';
import {
  CANDLE_RESOLUTIONS, HL_API_URL, HL_DEX, HL_INFO_URL, HL_MIN_NOTIONAL_USD,
  HL_MAINNET_CHAIN_ID, parseCandles, parseMarkets, roundToSignificantDigits,
  toExchangeInteger,
} from './market.js';

const POLL_MS = 2000;
const MAX_BATCH = 15;
const SAFE_GRID_BATCH = 15;
const SAFE_GRID_BATCH_PACE_MS = 1500;
const OPENING_RETRY_BASE_MS = 5_000;
const OPENING_RETRY_MAX = 8;
const FILLS_BACKFILL_MS = 5 * 60_000;      // 首次/重连回填窗口
const FILLS_SEEN_MAX = 5000;               // _filledSeen 环形上限，防内存泄漏
const FILLS_SEEN_TRIM = 1000;              // 超出上限后一次裁剪数量

export class HyperliquidExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live'; this.network = 'mainnet'; this.apiUrl = HL_API_URL; this.infoUrl = HL_INFO_URL;
    this.chainId = HL_MAINNET_CHAIN_ID; this.dex = HL_DEX;
    this.accountAddress = opts.accountAddress || '';
    this.agentPrivateKey = opts.agentPrivateKey || ''; this.agentPrivateKeyFile = opts.agentPrivateKeyFile || '';
    this.pythonPath = opts.pythonPath || ''; this.proxy = opts.proxy || '';
    this.feeRate = Number(opts.feeRate || 0.0005); this.dataSource = null;
    this.balance = null; this.equity = null; this.realizedPnl = null; this.accountTotalPnl = null;
    this.lastOkAt = 0; this.lastError = null; this.operationalIssue = null;
    this.markets = new Map(); this._prices = new Map(); this._positions = new Map(); this._tracked = new Map();
    this._fillsStartMs = Date.now() - FILLS_BACKFILL_MS; this._filledSeen = new Set(); // 环形上限，防内存泄漏
    this._timer = null; this._polling = false; this._tradingReady = false;
    this._lastAlertAt = 0; this._emptyStreakStart = 0; this._lastEmptyWarnAt = 0; this._clientSeq = 0;
    this.supportsSafeOpeningRetry = true;
    this.orderBatchSize = SAFE_GRID_BATCH;
    this._adaptivePaceMs = SAFE_GRID_BATCH_PACE_MS;
    this.openingRetryBaseMs = OPENING_RETRY_BASE_MS;
    this.openingRetryMax = OPENING_RETRY_MAX;
    this.signer = opts.signer || new HLSignerBridge({
      pythonPath: this.pythonPath, apiUrl: this.apiUrl,
      accountAddress: this.accountAddress,
      agentPrivateKey: this.agentPrivateKey, agentPrivateKeyFile: this.agentPrivateKeyFile,
    });
  }

  /** AIMD 自适应批间配速：bot 每次 _placeMany 实时读取。 */
  get orderBatchPaceMs() { return this._adaptivePaceMs; }

  async init() {
    this._tradingReady = false;
    try {
      this._validateConfig();
      await this.signer.start();
      const health = await this.signer.request('health');
      if (health?.profile !== 'hyperliquid' || health?.accountAddress !== this.accountAddress) {
        throw new Error('HL 签名器配置校验失败，已拒绝启动实盘。');
      }
      await this._loadMarkets();
      await this._refreshAccount();
      await this._refreshFills();
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
    if (!this.accountAddress) throw new Error('HL_ACCOUNT_ADDRESS（agent 钱包地址）不能为空。');
    if (!this.agentPrivateKey && !this.agentPrivateKeyFile) throw new Error('HL 需要 HL_AGENT_PRIVATE_KEY 或 HL_AGENT_PRIVATE_KEY_FILE。');
  }

  async reconnect() {
    this._tradingReady = false;
    try {
      if (this._timer) clearInterval(this._timer); this._timer = null;
      await this.signer.stop().catch(() => {}); await this.signer.start();
      await this._loadMarkets(); await this._refreshAccount(); await this._refreshFills(); await this._refreshOrders();
      this.dataSource = 'real'; this.lastOkAt = Date.now(); this.operationalIssue = null; this._tradingReady = true; this.start(); return true;
    } catch (error) {
      this._tradingReady = false; this.dataSource = null;
      await this.signer.stop().catch(() => {});
      this.lastError = error?.message || String(error); this._setIssue(error);
      throw error;
    }
  }

  async _postInfo(payload, retry = true) {
    let last;
    for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
      try {
        const res = await fetch(this.infoUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text(); let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 500) }; }
        if (res.ok) return data;
        const detail = data?.message || data?.error || `HTTP ${res.status}`;
        const err = new Error(`HL 接口错误 ${res.status || ''}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
        err.status = res.status; err.data = data;
        if (res.status === 429) {
          err.rateLimited = true;
          this._adaptivePaceMs = Math.min(40_000, this._adaptivePaceMs * 2);
        }
        throw err;
      } catch (e) {
        last = e?.status ? e : new Error(`无法连接 HL 官方接口 ${this.infoUrl}（${e?.cause?.code || e?.code || e?.message || ''}）。程序会保持交易锁定。`, { cause: e });
        if (attempt + 1 < (retry ? 2 : 1)) await sleep(250);
      }
    }
    throw last;
  }

  _friendlyError(status, detail) {
    if (status === 401 || status === 403) return 'HL 鉴权失败：请核对 agent 钱包地址和私钥。';
    if (status === 429) return 'HL 接口限流；程序将按实际限流退避。';
    return `HL 接口错误 ${status || ''}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  }

  async _loadMarkets() {
    const data = await this._postInfo({ type: 'metaAndAssetCtxs', dex: this.dex });
    const rows = parseMarkets(data);
    if (!rows.length) throw new Error('HL io dex 当前没有返回可交易市场。');
    this.markets = new Map(rows.map((m) => [m.marketId, m]));
    for (const m of rows) { if (m.lastPrice > 0) this._prices.set(m.marketId, m.lastPrice); }
    const fees = rows.map((m) => m.makerFee).filter((x) => Number.isFinite(x) && x >= 0);
    if (fees.length) this.feeRate = Math.max(...fees);
  }

  _market(marketId) { const m = this.markets.get(Number(marketId)); if (!m) throw new Error(`未知 HL 市场 marketId=${marketId}`); return m; }
  _assertTradingReady() {
    if (!this._tradingReady || this.dataSource !== 'real') {
      throw new Error('HL 实盘鉴权和账户快照尚未完整通过，已阻止签名交易；请先检查配置并执行"重连交易所"。');
    }
  }
  async getMarkets() { return [...this.markets.values()]; }
  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const market = this._market(marketId);
    const resolution = CANDLE_RESOLUTIONS.get(Number(intervalSec)) || '1h';
    const count = Math.min(500, Math.max(20, Number(n) || 200));
    const end = Math.floor(Date.now() / 1000), start = end - count * Number(intervalSec || 3600);
    const data = await this._postInfo({ type: 'candleSnapshot', req: { coin: market.name, interval: resolution, startTime: start * 1000, endTime: end * 1000 } });
    return parseCandles(data);
  }
  async getPrice(marketId) {
    const id = Number(marketId); this._market(id);
    if (!this._prices.has(id)) await this._loadMarkets(); return this._prices.get(id) ?? this.markets.get(id).lastPrice;
  }

  async _refreshAccount() {
    // 保证金与持仓在 dex 作用域内（HIP-3 建设者市场有独立清算账户）：
    // 不带 dex:"io" 读的是核心 Perps 清算账户，io dex 的保证金/持仓会永远显示 0
    const data = await this._postInfo({ type: 'clearinghouseState', user: this.accountAddress, dex: this.dex });
    const marginSummary = data?.marginSummary || {};
    this.balance = finite(marginSummary.accountValue, marginSummary.totalMarginUsed);
    this.equity = finite(marginSummary.accountValue, marginSummary.totalMarginUsed);
    const positions = new Map();
    for (const p of Array.isArray(data?.assetPositions) ? data.assetPositions : []) {
      const pos = p?.position || {};
      const name = String(pos.coin || '');
      const m = [...this.markets.values()].find((x) => x.name === name);
      if (!m) continue;
      const sizeBase = Number(pos.szi || 0);
      if (!sizeBase) continue;
      positions.set(m.marketId, {
        sizeBase, entryPrice: Number(pos.entryPx || 0), unrealizedPnl: Number(pos.unrealizedPnl || 0),
        realizedPnl: Number(pos.realizedPnl || 0),
        liquidationPrice: finite(pos.liquidationPx),
        leverage: finite(pos.leverage?.value) ? Number(pos.leverage.value) : null,
        marginMode: String(pos.marginMode || 'isolated').toLowerCase() === 'cross' ? 'cross' : 'isolated',
      });
    }
    this._positions = positions; this.lastOkAt = Date.now();
  }
  getPosition(marketId) { return this._positions.get(Number(marketId)) || null; }

  // userFillsByTime 增量（userFills 无 cursor；首拉回填 5 分钟窗口）
  async _refreshFills() {
    const payload = { type: 'userFillsByTime', user: this.accountAddress, startTime: this._fillsStartMs };
    const data = await this._postInfo(payload, false);
    const fills = Array.isArray(data) ? data : [];
    let maxTime = this._fillsStartMs;
    for (const f of fills) {
      const t = Number(f.time || 0);
      if (t > maxTime) maxTime = t;
      const name = String(f.coin || '');
      const m = [...this.markets.values()].find((x) => x.name === name);
      if (!m) continue;
      const marketId = m.marketId;
      const key = `${name}:${f.tid ?? f.time ?? f.oid ?? ''}`;
      if (this._filledSeen.has(key)) continue;
      this._filledSeen.add(key);
      if (this._filledSeen.size > FILLS_SEEN_MAX) { // 环形裁剪防内存泄漏
        const list = [...this._filledSeen];
        for (let i = 0; i < FILLS_SEEN_TRIM && list.length; i++) this._filledSeen.delete(list.shift());
      }
      this.realizedPnl = (this.realizedPnl || 0) + Number(f.pnl || 0);
      // 从 userFills 权威确认本地跟踪订单的成交（无需穿越推定）。
      // 匹配键：oid 优先，cloid 兜底（与下单实际提交的 clientOrderId 同源）。
      const fillCloid = String(f.cloid || '').toLowerCase();
      for (const [id, tracked] of [...this._tracked]) {
        if (tracked.marketId !== marketId) continue;
        const oidMatch = String(tracked.orderId) === String(f.oid);
        const cloidMatch = !!fillCloid && String(tracked.clientOrderId || '').toLowerCase() === fillCloid;
        if (!oidMatch && !cloidMatch) continue;
        if (tracked.side !== (String(f.side) === 'B' ? 'buy' : 'sell')) continue;
        this._tracked.delete(id);
        this.emit('fill', { orderId: id, marketId, side: tracked.side, price: Number(f.px || tracked.price), sizeBase: Number(f.sz || tracked.sizeBase), levelIndex: tracked.levelIndex });
      }
    }
    this._fillsStartMs = maxTime + 1; // 增量游标：下次只拉更新的成交
  }

  async _refreshOrders() {
    const rows = await this._fetchActiveOrders();
    // 空快照守卫（对齐 EX v1.5.4）：一次空数组不给全梯启动 gone 计时
    if (Array.isArray(rows) && rows.length === 0 && this._tracked.size >= 10) {
      if (!this._emptyStreakStart) this._emptyStreakStart = Date.now();
      if (this._emptyStreakStart && Date.now() - this._emptyStreakStart > 3 * 60_000) {
        this.operationalIssue = { title: 'HL 活跃挂单快照持续为空', message: '成交检测暂停中，请检查交易所状态 / 代理出口 IP' };
      }
      if (Date.now() - (this._lastEmptyWarnAt || 0) > 60_000) {
        this._lastEmptyWarnAt = Date.now();
        logger.warn('hl', `快照为空但本地跟踪 ${this._tracked.size} 单，本轮跳过 gone 判定（已持续 ${Math.round((Date.now() - this._emptyStreakStart) / 1000)}s）。`);
      }
      return;
    }
    this._emptyStreakStart = 0;
    if (this.operationalIssue?.title === 'HL 活跃挂单快照持续为空') this.operationalIssue = null;
    const active = new Map(rows.map((o) => [String(o.orderId), o]));
    const nowX = Date.now();
    for (const [id, tracked] of [...this._tracked]) {
      if (active.has(id)) { tracked.seen = true; tracked.goneFirstAt = 0; continue; }
      // 出簿但 fills 未确认：短暂计时后由 userFillsByTime 权威兜底；出簿 10 分钟仍
      // 无成交记录 -> 死亡计数 + 响亮告警（对齐 EX droppedLevels 监控口径）。
      if (!tracked.goneFirstAt && tracked.seen) tracked.goneFirstAt = nowX;
      else if (tracked.goneFirstAt && nowX - tracked.goneFirstAt >= 10 * 60_000) {
        this.droppedLevels = (this.droppedLevels || 0) + 1;
        logger.warn('hl', `⚠️ 订单 ${id}（${tracked.side} @ ${tracked.price}）10 分钟仍无法确认终态，该档位可能已空洞（累计 ${this.droppedLevels}），请核对交易所真实成交并考虑重启网格补齐。`);
        tracked.goneFirstAt = nowX;
      }
    }
  }

  async _fetchActiveOrders(marketId) {
    // 挂单快照必须在 dex 作用域查询：不带 dex:"io" 的 frontendOpenOrders 不返回
    // builder-dex 的订单（2026-09-08 事故：14 单被空快照骗成 42 单）
    const data = await this._postInfo({ type: 'frontendOpenOrders', user: this.accountAddress, dex: this.dex });
    const rows = Array.isArray(data) ? data : [];
    return rows
      .filter((o) => marketId == null || this.markets.get(Number(marketId))?.name === String(o.coin))
      .map((o) => ({
        orderId: String(o.oid), marketId: this._marketIdByCoin(String(o.coin)),
        side: String(o.side).toLowerCase() === 'buy' ? 'buy' : 'sell',
        price: Number(o.limitPx), sizeBase: Number(o.sz),
        reduceOnly: !!o.reduceOnly, status: 'open',
        cloid: String(o.cloid || ''), raw: o,
      }));
  }
  _marketIdByCoin(name) {
    const m = [...this.markets.values()].find((x) => x.name === name);
    return m ? m.marketId : -1;
  }

  async fetchOpenOrders(marketId) { return this._fetchActiveOrders(marketId); }
  getOpenOrders(marketId) { return [...this._tracked.values()].filter((o) => o.marketId === Number(marketId)); }
  forgetOrder(orderId) { this._tracked.delete(String(orderId)); }
  forgetOrders(marketId) { for (const [id, o] of this._tracked) if (o.marketId === Number(marketId)) this._tracked.delete(id); }
  adoptOrder(order) { this._tracked.set(String(order.orderId), { ...order, orderId: String(order.orderId), marketId: Number(order.marketId), seen: true, placedAt: Date.now() }); }

  _prepareOrder(order) {
    const market = this._market(order.marketId);
    const baseAmount = toExchangeInteger(order.sizeBase, market.sizeDecimals, 'down');
    const normalizedSize = baseAmount / 10 ** market.sizeDecimals;
    // HL 报价约束：≤5 位有效数字 + 小数位 ≤ priceDecimals
    const priceRounded = roundToSignificantDigits(Number(order.price), 5);
    const price = toExchangeInteger(priceRounded, market.priceDecimals, 'nearest');
    const normalizedPrice = price / 10 ** market.priceDecimals;
    if (!(baseAmount > 0) || normalizedSize < market.minOrderSize) throw new Error(`数量低于 HL ${market.displayName} 最小下单量 ${market.minOrderSize}。`);
    if (!order.reduceOnly && normalizedPrice * normalizedSize < HL_MIN_NOTIONAL_USD) throw new Error(`订单名义价值低于 HL 最低 ${HL_MIN_NOTIONAL_USD} USD。`);
    // HL Cloid.from_str 要求 0x + 32 位 hex（16 字节）：外部传入的必须是合规格式，
    // 否则用 randomBytes 生成（Cloid 用于成交匹配，格式不符会 TypeError）
    const rawClientOrderId = String(order.clientOrderId || '');
    const clientOrderId = /^0x[0-9a-f]{32}$/i.test(rawClientOrderId)
      ? rawClientOrderId
      : '0x' + randomBytes(16).toString('hex');
    return { order, market, normalizedSize, normalizedPrice, clientOrderId };
  }

  async placeLimitOrders(orders) {
    this._assertTradingReady();
    if (!Array.isArray(orders) || !orders.length || orders.length > MAX_BATCH) throw new Error('HL 每个批量下单请求必须是 1-15 笔。');
    // HL 无批量下单端点：逐笔签名发送（本适配器支持 placeLimitOrders 但退化为串行）
    const results = [];
    for (const order of orders) {
      results.push(await this._placeOne(order));
    }
    this._adaptivePaceMs = Math.max(SAFE_GRID_BATCH_PACE_MS, Math.round(this._adaptivePaceMs * 0.85));
    return results;
  }
  async placeLimitOrder(order) { return (await this._placeOne(order))[0]; }

  async _placeOne(order) {
    this._assertTradingReady();
    const prepared = this._prepareOrder(order);
    const signed = await this.signer.request('place_order', {
      order: {
        coin: prepared.market.name, isBuy: String(prepared.order.side).toLowerCase() === 'buy',
        sizeBase: prepared.normalizedSize, price: prepared.normalizedPrice,
        reduceOnly: !!prepared.order.reduceOnly, immediate: !!prepared.order.immediate,
        clientOrderId: prepared.clientOrderId,
      },
    }, 30_000);
    const response = signed?.order;
    // SDK exchange.order 返回 { status, response: { data: { statuses: [...] } } }
    const status = response?.response?.data?.statuses?.[0];
    if (!status) throw new Error('HL 下单未返回状态。');
    if (status.error) throw new Error(`HL 下单被拒：${status.error}`);
    const orderId = String(status.resting?.oid ?? '');
    if (!orderId) throw new Error('HL 下单未返回订单号（可能已立即成交）。');
    const tracked = prepared;
    this._tracked.set(orderId, {
      orderId, marketId: tracked.market.marketId, levelIndex: tracked.order.levelIndex,
      side: String(tracked.order.side).toLowerCase(), price: tracked.normalizedPrice,
      sizeBase: tracked.normalizedSize, reduceOnly: !!tracked.order.reduceOnly,
      placedAt: Date.now(), seen: true, goneFirstAt: null,
      clientOrderId: tracked.clientOrderId, // 下单实际提交的 cloid（成交匹配同源）
    });
    return [{ orderId, price: tracked.normalizedPrice, sizeBase: tracked.normalizedSize }];
  }

  async cancelOrder(marketId, orderId) {
    this._assertTradingReady();
    const market = this._market(marketId);
    await this.signer.request('cancel', { coin: market.name, oid: Number(orderId) });
    return true;
  }
  async cancelAll(marketId) {
    this._assertTradingReady();
    const market = this._market(marketId);
    const open = await this._fetchActiveOrders(marketId);
    const oids = open.map((o) => Number(o.orderId));
    if (!oids.length) return true;
    // HL SDK 无 cancel_all：用 bulk_cancel 一次性撤（或逐笔撤）
    const result = await this.signer.request('bulk_cancel', { coin: market.name, oids });
    if (result?.status?.some?.((s) => s?.error)) {
      const errors = result.status.filter((s) => s?.error).map((s) => s.error).join('; ');
      throw new Error(`HL 批量撤单部分失败：${errors}`);
    }
    return true;
  }
  async setLeverage(marketId, leverage) {
    this._assertTradingReady();
    const market = this._market(marketId);
    const value = Math.min(Math.max(1, Math.floor(Number(leverage))), market.maxLeverage || 6);
    await this.signer.request('update_leverage', { coin: market.name, leverage: value });
    return true;
  }

  async closePosition(marketId) {
    const pos = this.getPosition(marketId); if (!pos?.sizeBase) return true;
    const market = this._market(marketId);
    const price = await this.getPrice(marketId);
    const side = pos.sizeBase > 0 ? 'sell' : 'buy';
    // 对齐其他适配器：±5% 激进限价 + IOC（mark 价挂 GTC 可能一直躺在簿上平不掉）
    const worst = side === 'sell' ? price * 0.95 : price * 1.05;
    await this.placeLimitOrder({ marketId: Number(marketId), side, price: worst, sizeBase: Math.abs(pos.sizeBase), reduceOnly: true, immediate: true, levelIndex: -1 });
    return true;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll(), POLL_MS); this._timer.unref?.();
  }
  stop() { /* monitoring remains active after the grid stops */ }
  setPollLight(v) { this._pollLight = !!v; }

  async _poll() {
    if (this._polling) return; this._polling = true;
    try {
      await this._loadMarkets();
      for (const [marketId, price] of this._prices) {
        if (price > 0) this.emit('price', { marketId, price });
      }
      if (!this._pollLight) {
        await this._refreshAccount(); await this._refreshFills(); await this._refreshOrders();
      }
      this.lastOkAt = Date.now(); this.lastError = null; this.operationalIssue = null;
    } catch (e) { this.lastError = e?.message || String(e); this._setIssue(e); }
    finally { this._polling = false; }
  }
  _setIssue(error) {
    const message = error?.message || String(error);
    this.operationalIssue = { title: 'HL Hyperliquid 交易所异常', message };
    if (Date.now() - this._lastAlertAt > 30_000) { this._lastAlertAt = Date.now(); this.emit('error', new Error(message)); }
  }
}

function finite(...values) { for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; } return null; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }