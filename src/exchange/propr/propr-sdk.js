// Propr 官方 JavaScript/TypeScript SDK 的 ESM vendor 版本。
// 来源：https://www.propr.xyz/developers/javascript-sdk（官方“复制粘贴”分发，npm 无 propr-sdk 包）。
// 变更（相对官方）：
//  1) 去除 TS 类型标注改为 ESM + JSDoc；
//  2) 错误消息在抛出前统一脱敏（Review1 P0，防止 API 返回文本携带凭证外泄）；
//  3) 官方 `createOrder()` 会自造并覆盖 `intentId`，项目内**禁用**，故改名 `createOrderRaw()`
//     （Review3 要求：避免误用导致幂等键失效）；项目下单一律走 `createOrders()`。
// 其余请求路径/字段/错误语义与官方源码保持一致，升级时按官方文档逐段比对。依赖 ulid。
import { ulid } from 'ulid';
import { redactSecrets } from '../../redact.js';

const DEFAULT_BASE_URL = 'https://api.propr.xyz/v1';

/** Propr API 错误（与官方 SDK 同构：statusCode + code + message）。 */
export class ProprAPIError extends Error {
  constructor(statusCode, code, message) {
    super(`[${statusCode}] ${code}: ${message}`);
    this.name = 'ProprAPIError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ProprClient {
  /** @param {{apiKey?:string, baseUrl?:string, timeout?:number}} [options] */
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.PROPR_API_KEY || '';
    this.baseUrl = options.baseUrl || process.env.PROPR_API_URL || DEFAULT_BASE_URL;
    this.timeout = options.timeout || 30_000;
    this.accountId = null;

    if (!this.apiKey) {
      throw new Error(
        'API key required. Set PROPR_API_KEY env var or pass apiKey option.\n' +
          'Get your key at https://app.propr.xyz/settings',
      );
    }
  }

  async request(method, path, options = {}) {
    let url = `${this.baseUrl}${path}`;

    if (options.params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== null) searchParams.set(key, String(value));
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let code = null;
        let message = 'unknown_error';
        try {
          const body = await response.json();
          code = body.code ?? null;
          message = body.message ?? message;
        } catch { /* 非 JSON 错误体：保留默认 message */ }
        throw new ProprAPIError(response.status, code, redactSecrets(message));
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  get(path, params) { return this.request('GET', path, { params }); }
  post(path, body) { return this.request('POST', path, { body }); }
  put(path, body) { return this.request('PUT', path, { body }); }

  accountPath(suffix) {
    if (!this.accountId) {
      throw new Error('accountId not set. Call client.setup() first or set client.accountId manually.');
    }
    return `/accounts/${this.accountId}${suffix}`;
  }

  // ── Setup ──

  async setup(accountId) {
    if (accountId) {
      this.accountId = accountId;
      return this.accountId;
    }

    const attempts = await this.getChallengeAttempts({ status: 'active' });
    if (!attempts.length) {
      throw new Error(
        'No active challenge found. Purchase a challenge at https://app.propr.xyz/dashboard first.',
      );
    }
    this.accountId = attempts[0].accountId;
    return this.accountId;
  }

  // ── Health ──

  async health() { return this.get('/health'); }
  async healthServices() { return this.get('/health/services'); }

  // ── User ──

  async getUser() { return this.get('/users/me'); }

  // ── Challenges ──

  async getChallenges(params = {}) {
    const res = await this.get('/challenges', { limit: 20, offset: 0, ...params });
    return res.data ?? [];
  }

  async getChallengeAttempts(params = {}) {
    const res = await this.get('/challenge-attempts', { limit: 20, offset: 0, ...params });
    return res.data ?? [];
  }

  async getChallengeAttempt(attemptId) {
    return this.get(`/challenge-attempts/${attemptId}`);
  }

  // ── Orders ──

  async getOrders(params = {}) {
    const res = await this.get(this.accountPath('/orders'), { limit: 20, offset: 0, ...params });
    return res.data ?? [];
  }

  // ⚠️ 项目内禁用：官方原始下单接口会自造并覆盖 intentId，使幂等键失效。
  // 项目下单必须走 createOrders()（保留调用方 intentId）。
  async createOrderRaw(params) {
    const order = {
      accountId: this.accountId,
      intentId: ulid(),
      exchange: 'hyperliquid',
      type: params.orderType,
      side: params.side,
      positionSide: params.positionSide,
      productType: 'perp',
      timeInForce: params.timeInForce ?? (params.orderType === 'market' ? 'IOC' : 'GTC'),
      asset: params.asset,
      base: params.base,
      quote: params.quote,
      quantity: params.quantity,
      reduceOnly: params.reduceOnly ?? false,
      closePosition: params.closePosition ?? false,
    };
    if (params.price !== undefined) order.price = params.price;
    if (params.triggerPrice !== undefined) order.triggerPrice = params.triggerPrice;

    const res = await this.post(this.accountPath('/orders'), { orders: [order] });
    return res.data ?? [];
  }

  // 注意：官方 createOrder 会自造并覆盖 intentId；只有本方法保留调用方传入的 intentId，
  // 因此项目内所有下单（含单笔）都必须走 createOrders，幂等键才有效。
  async createOrders(orders) {
    for (const order of orders) {
      if (!order.intentId) order.intentId = ulid();
      if (!order.accountId) order.accountId = this.accountId;
    }

    const res = await this.post(this.accountPath('/orders'), { orders });
    return res.data ?? [];
  }

  async cancelOrder(orderId) {
    try {
      return await this.post(this.accountPath(`/orders/${orderId}/cancel`));
    } catch (err) {
      if (err instanceof ProprAPIError && err.statusCode === 400) {
        return null; // 官方语义：已成交/已撤销
      }
      throw err;
    }
  }

  async cancelAllOrders(base) {
    const params = { status: 'open' };
    if (base) params.base = base;

    const openOrders = await this.getOrders(params);
    const cancelled = [];

    for (const order of openOrders) {
      const result = await this.cancelOrder(order.orderId);
      if (result) cancelled.push(result);
    }
    return cancelled;
  }

  // ── Positions ──

  async getPositions(params = {}) {
    const { excludeZero = true, ...queryParams } = params;

    const res = await this.get(this.accountPath('/positions'), { limit: 20, offset: 0, ...queryParams });

    let positions = res.data ?? [];
    if (excludeZero) positions = positions.filter((p) => parseFloat(p.quantity) > 0);
    return positions;
  }

  async getOpenPositions(base) {
    return this.getPositions({ base, status: 'open', excludeZero: true });
  }

  // ── Trades ──

  async getTrades(params = {}) {
    const res = await this.get(this.accountPath('/trades'), { limit: 20, offset: 0, ...params });
    return res.data ?? [];
  }

  // ── Margin Configuration ──

  async getMarginConfig(asset) {
    return this.get(this.accountPath(`/margin-config/${asset}`));
  }

  async updateMarginConfig(configId, asset, leverage, marginMode = 'cross') {
    return this.put(this.accountPath(`/margin-config/${configId}`), {
      exchange: 'hyperliquid',
      asset,
      marginMode,
      leverage,
    });
  }

  // ── Leverage Limits ──

  async getLeverageLimits() {
    return this.get('/leverage-limits/effective');
  }

  async maxLeverage(asset) {
    const limits = await this.getLeverageLimits();
    return limits.overrides?.[asset] ?? limits.defaultMax;
  }

  // ── Convenience Methods ──

  async marketBuy(base, quantity, quote = 'USDC') {
    return this.createOrderRaw({
      side: 'buy', positionSide: 'long', orderType: 'market', asset: base, base, quote, quantity,
    });
  }

  async marketSell(base, quantity, quote = 'USDC', reduceOnly = true) {
    return this.createOrderRaw({
      side: 'sell', positionSide: 'long', orderType: 'market', asset: base, base, quote, quantity, reduceOnly,
    });
  }

  async limitBuy(base, quantity, price, quote = 'USDC') {
    return this.createOrderRaw({
      side: 'buy', positionSide: 'long', orderType: 'limit', asset: base, base, quote, quantity, price,
    });
  }

  async limitSell(base, quantity, price, quote = 'USDC', reduceOnly = true) {
    return this.createOrderRaw({
      side: 'sell', positionSide: 'long', orderType: 'limit', asset: base, base, quote, quantity, price, reduceOnly,
    });
  }

  // 注意：官方实现只平 positions[0]（多空并存时不全平）。项目内不使用本方法，
  // 适配器自行实现全平（见 propr.js closePosition）。
  async closePosition(base, quote = 'USDC') {
    const positions = await this.getOpenPositions(base);
    if (!positions.length) return [];

    const pos = positions[0];
    const closeSide = pos.positionSide === 'long' ? 'sell' : 'buy';

    return this.createOrderRaw({
      side: closeSide,
      positionSide: pos.positionSide,
      orderType: 'market',
      asset: base,
      base,
      quote,
      quantity: pos.quantity,
      reduceOnly: true,
      closePosition: true,
    });
  }

  async setLeverage(asset, leverage, marginMode = 'cross') {
    const config = await this.getMarginConfig(asset);
    return this.updateMarginConfig(config.configId, asset, leverage, marginMode);
  }
}
