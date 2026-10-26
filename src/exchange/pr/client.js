// Propr 只读客户端（M1）：**没有通用 request(method, path)**。
// 只有下面这张 GET 白名单，写操作在 M1 里既没有实现、也不可达。
// 契约与安全边界见 docs/propr/M1-DECISIONS.md。
import crypto from 'node:crypto';
import { ProprApiError, ProprReadOnlyError, CODES } from './errors.js';

const DEFAULT_BASE = 'https://api.propr.xyz/v1';

/** GET 路由白名单。新增端点必须改这里 —— 这是唯一的出网入口。 */
export const GET_ROUTES = Object.freeze({
  health: () => '/health',
  healthServices: () => '/health/services',
  me: () => '/users/me',
  challenges: () => '/challenges',
  attempts: () => '/challenge-attempts',
  attempt: (id) => `/challenge-attempts/${id}`,
  account: (id) => `/accounts/${id}`,
  positions: (id) => `/accounts/${id}/positions`,
  orders: (id) => `/accounts/${id}/orders`,
  trades: (id) => `/accounts/${id}/trades`,
  marginConfig: (id, asset) => `/accounts/${id}/margin-config/${asset}`,
  leverageLimits: () => '/leverage-limits/effective',
});

const NO_AUTH = new Set(['health', 'healthServices']);

/** 写路由白名单。只有 sim-write / challenge 模式会放开（allowWrites）。 */
export const WRITE_ROUTES = Object.freeze({
  createOrder: (id) => `/accounts/${id}/orders`,
  cancelOrder: (id, orderId) => `/accounts/${id}/orders/${orderId}/cancel`,
  marginConfig: (id, configId) => `/accounts/${id}/margin-config/${configId}`,
});

// ULID：26 字符，时间有序，适合做 intentId（幂等键）
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()) {
  let t = now;
  let head = '';
  for (let i = 0; i < 10; i++) { head = B32[t % 32] + head; t = Math.floor(t / 32); }
  const buf = crypto.randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += B32[buf[i] % 32];
  return head + tail;
}

export class ProprClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey        必填（health 除外）
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs]
   * @param {Function} [opts.fetchImpl] 注入用（单测）
   * @param {number} [opts.maxPages]    分页上限，超限抛错而不是静默截断
   * @param {number} [opts.pageLimit]
   */
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || '';
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
    this.timeoutMs = Number(opts.timeoutMs) || 15_000;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.maxPages = Number(opts.maxPages) || 20;
    this.pageLimit = Number(opts.pageLimit) || 100;
    this.allowWrites = !!opts.allowWrites;   // 默认 false：M1 只读语义不变
    this.writeAttemptCount = 0;
    this.lastLatencyMs = null;
    this.requestCount = 0;
  }

  _url(path, params) {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /** 唯一的网络出口。route 必须是白名单 key，method 恒为 GET。 */
  async get(route, args = [], params = {}) {
    const build = GET_ROUTES[route];
    if (typeof build !== 'function') throw new Error(`Propr GET 路由未登记: ${route}`);
    const path = build(...args);
    const url = this._url(path, params);
    const headers = { Accept: 'application/json' };
    if (!NO_AUTH.has(route)) {
      if (!this.apiKey) throw new ProprApiError(401, CODES.UNAUTHORIZED, '缺少 API key', { endpoint: path, retryable: false });
      headers['X-API-Key'] = this.apiKey;
    }
    const t0 = Date.now();
    let res;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const err = new ProprApiError(0, null, `网络错误: ${e.message}`, { endpoint: path, retryable: true, mayExist: true });
      err.cause = e;
      throw err;
    } finally {
      this.lastLatencyMs = Date.now() - t0;
      this.requestCount++;
    }

    const text = await res.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 300) }; }
    }
    if (!res.ok) {
      throw new ProprApiError(res.status, body?.code ?? null, body?.message || `HTTP ${res.status}`, { endpoint: path });
    }
    return body;
  }

  /**
   * 分页拉全。少于一页才停；到达 maxPages 仍未完 → 抛错（拒绝静默截断）。
   * @returns {Promise<{rows:any[], pages:number, complete:boolean}>}
   */
  async getAll(route, args = [], params = {}) {
    const rows = [];
    for (let page = 0; page < this.maxPages; page++) {
      const body = await this.get(route, args, { ...params, limit: this.pageLimit, offset: page * this.pageLimit });
      const data = body?.data ?? (Array.isArray(body) ? body : []);
      rows.push(...data);
      if (data.length < this.pageLimit) return { rows, pages: page + 1, complete: true };
    }
    throw new Error(`Propr 分页超过 ${this.maxPages} 页仍未结束（${route}）—— 拒绝静默截断`);
  }

  // ── 具名只读方法（shadow 脚本只用这些）────────────────────────────────
  health() { return this.get('health'); }
  healthServices() { return this.get('healthServices'); }
  getUser() { return this.get('me'); }
  getChallenges(params) { return this.get('challenges', [], params); }
  getAttempts(params) { return this.get('attempts', [], params); }
  getAttempt(id) { return this.get('attempt', [id]); }
  getAccount(id) { return this.get('account', [id]); }
  getPositions(id, params) { return this.getAll('positions', [id], params); }
  getOrders(id, params) { return this.getAll('orders', [id], params); }
  getTrades(id, params) { return this.getAll('trades', [id], params); }
  getTradesPage(id, params) { return this.get('trades', [id], params); }
  getMarginConfig(id, asset) { return this.get('marginConfig', [id, asset]); }
  getLeverageLimits() { return this.get('leverageLimits'); }

  // ── 写操作：只有 allowWrites 才可达；否则计数 + 抛 ProprReadOnlyError ──────
  _refuseWrite(what) {
    this.writeAttemptCount++;
    throw new ProprReadOnlyError(what);
  }

  // 安全网：client 本身不提供业务写方法，误用一律拒绝（真实写路径在 ProprWriter）
  placeLimitOrder() { return this._refuseWrite('下单（请用 ProprWriter）'); }
  placeLimitOrders() { return this._refuseWrite('批量下单（请用 ProprWriter）'); }
  cancelOrder() { return this._refuseWrite('撤单（请用 ProprWriter）'); }
  cancelAll() { return this._refuseWrite('批量撤单（请用 ProprWriter）'); }
  closePosition() { return this._refuseWrite('平仓（请用 ProprWriter）'); }
  setLeverage() { return this._refuseWrite('修改杠杆'); }

  async post(route, args = [], body = null) {
    const build = WRITE_ROUTES[route];
    if (typeof build !== 'function') throw new Error(`Propr 写路由未登记: ${route}`);
    if (!this.allowWrites) this._refuseWrite(route);
    this.writeAttemptCount++;
    const path = build(...args);
    const url = this._url(path, {});
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': this.apiKey },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const err = new ProprApiError(0, null, `网络错误: ${e.message}`, { endpoint: path, method: 'POST', retryable: true, mayExist: true });
      err.cause = e;
      throw err;
    }
    const text = await res.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = { message: text.slice(0, 300) }; } }
    if (!res.ok) {
      throw new ProprApiError(res.status, parsed?.code ?? null, parsed?.message || `HTTP ${res.status}`, { endpoint: path, method: 'POST' });
    }
    return parsed;
  }
}