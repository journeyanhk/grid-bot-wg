// VaAuth — Variational vr-token 生命周期管理（贴 token 优先 + 私钥自动续签）。
//
// 解析优先级（init）：VARIATIONAL_TOKEN(有效) → 缓存文件(有效) → 私钥 SIWE 登录 → 无。
// 运行期（ensure）：token 缺失或剩余 < 24h 且可自签 → 续签；401 可 force 立即续签。
// 防护：两次登录最小间隔 5 分钟 + 每小时上限 6 次（避免 401 风暴打爆 Cloudflare）；
//       连续 2 次失败 → critical 告警。私钥在 Python worker 环境里，Node 侧不接触。
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../log.js';

const HOUR = 3600_000;
const REFRESH_BELOW_MS = 24 * HOUR;      // 剩余低于此值且可自签 → 续签
const RELOGIN_THROTTLE_MS = 5 * 60_000;  // 两次登录最小间隔
const RELOGIN_MAX_PER_HOUR = 6;

/** 解码 JWT 的 exp（秒），不验签。无法解析返回 null。 */
export function decodeJwtExp(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const exp = Number(JSON.parse(json).exp);
    return Number.isFinite(exp) ? exp : null;
  } catch { return null; }
}

export class VaAuth {
  constructor({ http, address, envToken, privateKey, cachePath, onNotice, onAlert } = {}) {
    this.http = http || null;
    this.address = address || '';
    this.envToken = envToken || '';
    this.privateKey = privateKey || '';
    this.cachePath = cachePath || '';
    this.onNotice = typeof onNotice === 'function' ? onNotice : null;
    this.onAlert = typeof onAlert === 'function' ? onAlert : null;
    this.token = '';
    this.exp = null;              // 秒
    this._loginTimes = [];        // 近 1h 登录尝试时间戳（节流）
    this._lastLoginAt = 0;
    this._failStreak = 0;
    this._inflight = null;
  }

  /** 是否具备私钥自动续签能力（需私钥 + bridge 传输）。 */
  canRefresh() { return !!(this.privateKey && this.http?.login); }
  hasToken() { return !!this.token; }
  /** 当前 token 剩余毫秒；无 exp 但有 token 视为 Infinity（贴 token 无法判断的场景）。 */
  msLeft() { return this.exp ? this.exp * 1000 - Date.now() : (this.token ? Infinity : 0); }

  _use(token) {
    this.token = token || '';
    this.exp = token ? decodeJwtExp(token) : null;
    this.http?.setToken?.(this.token);
  }

  _valid(token, minMs) {
    if (!token) return false;
    const e = decodeJwtExp(token);
    if (e == null) return true;                 // 无 exp 无法判断，贴 token 场景视为可用
    return e * 1000 - Date.now() > minMs;
  }

  _pickSeed() {
    if (this._valid(this.envToken, HOUR)) return this.envToken;
    const c = this._readCache();
    if (c?.token && this._valid(c.token, HOUR)) return c.token;
    return '';
  }

  /** 启动解析 + 必要时首登。返回最终 token（可能为空=只读）。 */
  async init() {
    const seed = this._pickSeed();
    if (seed) this._use(seed);
    await this.ensure({ boot: true });
    return this.token;
  }

  /**
   * 确保 token 健康：缺失或剩余 < 24h 且可自签 → 续签。
   * @param {{force?:boolean, boot?:boolean}} o force=401 立即续签（绕过健康判断，仍受节流）
   * @returns {Promise<boolean>} 结束时是否持有有效 token
   */
  async ensure({ force = false, boot = false } = {}) {
    const left = this.msLeft();
    const healthy = this.hasToken() && left > REFRESH_BELOW_MS;
    if (!force && healthy) return true;
    if (!this.canRefresh()) {
      // 不能自签：贴 token 场景，健康与否交给调用方（401/临期告警）。
      return this.hasToken() && left > 0;
    }
    const now = Date.now();
    this._loginTimes = this._loginTimes.filter((t) => now - t < HOUR);
    if (!force && !boot && now - this._lastLoginAt < RELOGIN_THROTTLE_MS) return this.hasToken();
    if (this._loginTimes.length >= RELOGIN_MAX_PER_HOUR) {
      logger.warn('va', '自动登录已达每小时上限（6 次），暂缓续签。');
      return this.hasToken();
    }
    if (this._inflight) return this._inflight;   // 合并并发续签
    this._inflight = this._login().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _login() {
    this._lastLoginAt = Date.now();
    this._loginTimes.push(this._lastLoginAt);
    try {
      const out = await this.http.login(this.address);   // {status, token, exp}
      if (!out?.token) throw new Error('登录返回缺少 token');
      this._use(out.token);
      this._writeCache(out.token);
      this._failStreak = 0;
      const hrs = this.exp ? Math.max(1, Math.round((this.exp * 1000 - Date.now()) / HOUR)) : null;
      logger.info('va', `会话已自动续签${hrs ? `，有效至约 ${hrs} 小时后` : ''}。`);
      this.onNotice?.(`Variational 会话已自动续签${hrs ? `，有效期约 ${hrs} 小时` : ''}。`);
      return true;
    } catch (e) {
      this._failStreak++;
      const msg = e?.message || String(e);
      if (this._failStreak >= 2) {
        this.onAlert?.(`❌ Variational 自动登录连续 ${this._failStreak} 次失败：${msg}。实盘交易可能中断，请检查 VA_WALLET_PRIVATE_KEY / 网络。`);
      } else {
        logger.warn('va', `自动登录失败（第 ${this._failStreak} 次）：${msg}`);
      }
      return false;
    }
  }

  _readCache() {
    if (!this.cachePath) return null;
    try { return JSON.parse(fs.readFileSync(this.cachePath, 'utf8')); } catch { return null; }
  }

  _writeCache(token) {
    if (!this.cachePath) return;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify({ token, exp: this.exp, at: Date.now() }), { mode: 0o600 });
      try { fs.chmodSync(this.cachePath, 0o600); } catch { /* best-effort */ }
    } catch (e) { logger.warn('va', `token 缓存写入失败：${e?.message || e}`); }
  }
}
