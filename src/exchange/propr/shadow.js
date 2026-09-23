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
import { mapProprPosition, netPositionFromViews } from './mapper.js';
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
    this._setMarkets([buildMarket({ base: this.base, quote: 'USDC', marginConfig, leverageLimits, markPrice: px })]);
    if (px > 0) this.prices.set(this._marketId(), px);

    await this._refreshProprAccount();
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
      logger.warn('propr', `shadow 行情异常: ${err?.message ?? err}`);
      if (this.listenerCount('error') > 0) this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** 只读刷新 Propr 账户快照（权益/持仓），仅用于观察与展示。 */
  async _refreshProprAccount() {
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
    const positions = await this.readClient.getPositions({ base: this.base, status: 'open' }).catch(() => []);
    this.proprPositions = positions.map(mapProprPosition);
    this.proprNetPosition = netPositionFromViews(this.proprPositions);
    this.lastOkAt = Date.now();
  }
}
