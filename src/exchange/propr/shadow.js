// Propr shadow 适配器：读取真实行情与账户（只读），订单只在本地模拟撮合，绝不写 Propr。
//
// 设计：
// - 继承 PaperExchange 复用本地撮合/持仓/成交模拟；
// - 用 HL 公开行情替换 paper 的随机游走（真实价格驱动本地成交）；
// - 通过 createReadOnlyClient() 包装 Propr 客户端：任何写方法调用立即抛 ProprReadOnlyError，
//   从代码层面保证 shadow 模式写请求数恒为 0（可测试）。
import { PaperExchange } from './paper.js';
import { ProprClient } from './propr-sdk.js';
import { ProprReadOnlyError, ProprStartupError } from './errors.js';
import { createDispatcher } from '../../proxy.js';
import { mapProprPosition, mapProprError, netPositionFromViews } from './mapper.js';
import { buildMarket } from './market.js';
import { maskAccountId } from '../../redact.js';
import { logger } from '../../log.js';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const PRICE_POLL_MS = 2000;
const ACCOUNT_POLL_MS = 15000;

/**
 * 只读客户端包装：显式列白读方法，写方法一律抛错（不用 Proxy，行为可读可测）。
 */
export function createReadOnlyClient(client) {
  const guard = (name) => () => { throw new ProprReadOnlyError(name); };
  return {
    get accountId() { return client.accountId; },
    set accountId(v) { client.accountId = v; },
    setup: (id) => client.setup(id),
    health: () => client.health(),
    healthServices: () => client.healthServices(),
    getUser: () => client.getUser(),
    getChallenges: (p) => client.getChallenges(p),
    getChallengeAttempts: (p) => client.getChallengeAttempts(p),
    getChallengeAttempt: (id) => client.getChallengeAttempt(id),
    getOrders: (p) => client.getOrders(p),
    getPositions: (p) => client.getPositions(p),
    getOpenPositions: (b) => client.getOpenPositions(b),
    getTrades: (p) => client.getTrades(p),
    getMarginConfig: (a) => client.getMarginConfig(a),
    getLeverageLimits: () => client.getLeverageLimits(),
    maxLeverage: (a) => client.maxLeverage(a),
    // 写方法：shadow 下绝对禁止
    createOrder: guard('createOrder'),
    createOrders: guard('createOrders'),
    cancelOrder: guard('cancelOrder'),
    cancelAllOrders: guard('cancelAllOrders'),
    setLeverage: guard('setLeverage'),
    updateMarginConfig: guard('updateMarginConfig'),
    marketBuy: guard('marketBuy'),
    marketSell: guard('marketSell'),
    limitBuy: guard('limitBuy'),
    limitSell: guard('limitSell'),
    closePosition: guard('closePosition'),
  };
}

export class ShadowExchange extends PaperExchange {
  constructor(cfg = {}) {
    super({ startBalance: cfg.startBalance, feeRate: cfg.feeRate });
    this.mode = 'shadow';
    this.dataSource = null;
    this.operationalIssue = null;
    this.lastOkAt = 0;
    this._cfg = cfg;
    this.base = String(cfg.base || 'BTC').toUpperCase();
    this.readClient = null;
    this.attemptId = null;
    this.proprEquity = null;
    this.proprPositions = [];
    this.proprNetPosition = null;
    // 快照新鲜度：读取失败时保留上次快照并标 stale，绝不伪装成空仓/零权益（Review2 P1）
    this.proprAccountStale = false;
    this.proprAccountError = null;
    this.proprEquityFreshAt = 0;
    this.proprPositionStale = false;
    this.proprPositionError = null;
    this.proprPositionFreshAt = 0;
    this._realPriceTimer = null;
    this._accountTimer = null;
  }

  async init() {
    if (this._cfg.proxy) {
      const dispatcher = await createDispatcher(this._cfg.proxy);
      if (dispatcher) {
        const { setGlobalDispatcher } = await import('undici');
        setGlobalDispatcher(dispatcher);
      }
    }
    const raw = new ProprClient({ apiKey: this._cfg.apiKey, baseUrl: this._cfg.apiUrl, timeout: this._cfg.timeoutMs });
    await raw.health();
    const active = await raw.getChallengeAttempts({ status: 'active' });
    const attempt = active.find((a) => a.accountId === this._cfg.accountId);
    if (!attempt) {
      throw new ProprStartupError(`指定账户 ${maskAccountId(this._cfg.accountId)} 不在 active attempts 中（禁止自动发现）`);
    }
    raw.accountId = attempt.accountId;
    this.attemptId = attempt.attemptId;
    this.readClient = createReadOnlyClient(raw);

    // 用真实账户的 marginConfig/leverageLimits 构建市场（覆盖 paper 兜底元数据）
    const marginConfig = await raw.getMarginConfig(this.base);
    const leverageLimits = await raw.getLeverageLimits();
    const px = await this._fetchMidPrice().catch(() => 0);
    this.market = buildMarket({ base: this.base, quote: 'USDC', marginConfig, leverageLimits, markPrice: px });
    this._setMarkets([this.market]);
    if (px > 0) this.prices.set(this._marketId(), px);
    // 费率：配置留空时用实测 maker 费率（Review2 P2）
    this.feeRate = Number.isFinite(this._cfg.feeRate) ? this._cfg.feeRate : this.market.makerFee;

    await this._refreshProprAccount();
    if (this.proprAccountStale) throw new ProprStartupError('Propr 账户权益读取失败，拒绝启动 shadow');
    this.dataSource = 'real';
    this.lastOkAt = Date.now();
    this.start();
    logger.info('propr', `shadow 已连接（只读），账户 ${maskAccountId(this._cfg.accountId)}，写请求恒为 0`);
    return true;
  }

  start() {
    if (!this._realPriceTimer) {
      this._realPriceTimer = setInterval(() => this._pollRealPrice(), PRICE_POLL_MS);
      this._realPriceTimer.unref?.();
    }
    if (!this._accountTimer) {
      this._accountTimer = setInterval(() => { this._refreshProprAccount().catch(() => {}); }, ACCOUNT_POLL_MS);
      this._accountTimer.unref?.();
    }
  }

  stop() {
    if (this._realPriceTimer) clearInterval(this._realPriceTimer);
    if (this._accountTimer) clearInterval(this._accountTimer);
    this._realPriceTimer = null;
    this._accountTimer = null;
  }

  _marketId() { return this.markets.keys().next().value; }

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

  async _pollRealPrice() {
    try {
      const px = await this._fetchMidPrice();
      if (!(px > 0)) return;
      const id = this._marketId();
      this.prices.set(id, px);
      this.lastOkAt = Date.now();
      this.emit('price', { marketId: id, price: px });
      this.matchTick(); // 用真实价格本地撮合，不写 Propr
    } catch (err) {
      this._emitSafeError(err);
    }
  }

  /** 统一安全错误事件（分类 + 脱敏），供 server/SSE/通知/AI 消费。 */
  _emitSafeError(err) {
    const mapped = mapProprError(err);
    logger.warn('propr', `shadow 异常(${mapped.kind}): ${mapped.message}`, mapped);
    if (this.listenerCount('error') > 0) {
      this.emit('error', Object.assign(new Error(mapped.message), mapped));
    }
  }

  /**
   * 只读刷新 Propr 账户快照（权益/持仓），仅用于观察与展示。
   * 失败语义：保留上一次已知快照并置 stale，绝不把失败伪装成"空仓/零权益"（Review2 P1）。
   */
  async _refreshProprAccount() {
    try {
      const attempt = await this.readClient.getChallengeAttempt(this.attemptId);
      const acc = attempt?.account || {};
      this.proprEquity = {
        balance: Number(acc.balance ?? 0),
        marginBalance: Number(acc.marginBalance ?? 0),
        availableBalance: Number(acc.availableBalance ?? 0),
        highWaterMark: Number(acc.highWaterMark ?? 0),
        totalUnrealizedPnl: Number(acc.totalUnrealizedPnl ?? 0),
        currency: acc.currency ?? 'USDC',
        equitySource: 'propr_account',
        equityFreshAt: Date.now(),
      };
      this.proprAccountStale = false;
      this.proprAccountError = null;
      this.proprEquityFreshAt = Date.now();
    } catch (err) {
      this.proprAccountStale = true;
      this.proprAccountError = mapProprError(err).message;
      this._emitSafeError(err);
    }

    try {
      const positions = await this.readClient.getPositions({ base: this.base, status: 'open' });
      this.proprPositions = positions.map(mapProprPosition);
      this.proprNetPosition = netPositionFromViews(this.proprPositions);
      this.proprPositionStale = false;
      this.proprPositionError = null;
      this.proprPositionFreshAt = Date.now();
    } catch (err) {
      // 保留上次已知持仓（不回退为空数组）
      this.proprPositionStale = true;
      this.proprPositionError = mapProprError(err).message;
      this._emitSafeError(err);
    }
    this.lastOkAt = Date.now();
  }

  /** 仪表盘公开信息（shadow 写请求恒为 0；Propr 快照失败时标 stale，不伪装空仓）。 */
  getPublicInfo() {
    return {
      exchange: 'Propr',
      mode: 'shadow',
      accountIdMasked: maskAccountId(this._cfg.accountId),
      attemptId: this.attemptId,
      positionMode: 'net',
      tradingLocked: false,
      writeRequests: 0,
      proprEquity: this.proprEquity,
      proprNetPosition: this.proprNetPosition,
      proprAccountStale: this.proprAccountStale,
      proprAccountError: this.proprAccountError,
      proprPositionStale: this.proprPositionStale,
      proprPositionError: this.proprPositionError,
      price: this.prices.get(this._marketId()) ?? null,
    };
  }
}
