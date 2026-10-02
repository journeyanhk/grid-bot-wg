// VaAuth — Variational 会话生命周期管理。
//
// 三种模式（mode）：
//   refresh：持 vr-ll-token（长期）+ 一枚同会话 vr-token（可过期）→ 每 ~3.5 分钟
//            POST /api/auth/refresh 换 5 分钟新 access token（探针 v2：ll-only 会被
//            400 拒绝，必须同时携带同会话 vr-token；ll-token 实测不轮换）。
//   siwe：   私钥 SIWE 自动登录（历史路径；/api/auth/login 常被 Cloudflare 拦住）。
//   manual： 人工粘贴 access token。
//
// 解析优先级（init）：refresh（有 ll-token）→ env/cache access token → siwe → 无。
// 防护：refresh 节流 10s + 10 分钟上限 12 次 + 并发合并；连续失败 ≥2 warn、≥4 或
//       401/403 critical 并提示重贴。私钥/ll-token 均不进日志。
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../log.js';

const HOUR = 3600_000;
const REFRESH_BELOW_MS = 24 * HOUR;       // siwe/manual：剩余低于此值且可自签 → 续签
const RELOGIN_THROTTLE_MS = 5 * 60_000;   // 两次登录最小间隔（健康续签）
const RELOGIN_FORCE_THROTTLE_MS = 60_000; // 401 强制续签的最小间隔（防 401 风暴）
const RELOGIN_MAX_PER_HOUR = 6;

// refresh 模式（access token 仅 5 分钟）
const ACCESS_REFRESH_BELOW_MS = 90_000;   // 剩余 < 90s 续期
const REFRESH_THROTTLE_MS = 10_000;       // 两次 refresh 最小间隔
const REFRESH_MAX_PER_10MIN = 12;         // 10 分钟上限（自然需 ~3 次，留 4x 余量）
const TEN_MIN = 600_000;

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
  constructor({ http, address, envToken, llToken, hasPrivateKey, cachePath, onNotice, onAlert } = {}) {
    this.http = http || null;
    this.address = address || '';
    this.envToken = envToken || '';
    this.envLLToken = llToken || '';
    this.hasPrivateKey = !!hasPrivateKey;
    this.cachePath = cachePath || '';
    this.onNotice = typeof onNotice === 'function' ? onNotice : null;
    this.onAlert = typeof onAlert === 'function' ? onAlert : null;
    this.token = '';
    this.exp = null;              // 秒
    this.llToken = String(llToken || '').trim();  // 构造期即可判 mode()；init 时按 cache/env 规则再校准
    this._loginTimes = [];        // 近 1h 登录尝试时间戳（节流）
    this._lastLoginAt = 0;
    this._refreshTimes = [];      // 近 10min refresh 时间戳（节流）
    this._lastRefreshAt = 0;
    this._totalRefresh = 0;       // 续期成功计数（核账报告用）
    this._totalRefreshFail = 0;
    this._lastRefreshOkAt = 0;
    this._failStreak = 0;
    this._inflight = null;
    this._coldStartAlerted = false;
  }

  /** 模式：refresh（ll-token 自动续期）/ siwe（私钥）/ manual（人工 token）。 */
  mode() {
    if (this.llToken && typeof this.http?.refresh === 'function') return 'refresh';
    if (this.hasPrivateKey && typeof this.http?.login === 'function') return 'siwe';
    return 'manual';
  }
  /** 是否具备自动维持会话能力（refresh 或 siwe）。 */
  canRefresh() { return this.mode() !== 'manual'; }
  hasToken() { return !!this.token; }
  /** 当前 token 剩余毫秒；无 exp 但有 token 视为 Infinity（贴 token 无法判断的场景）。 */
  msLeft() { return this.exp ? this.exp * 1000 - Date.now() : (this.token ? Infinity : 0); }

  /** 供面板/核账展示的续期统计。 */
  stats() {
    return {
      mode: this.mode(),
      lastRefreshOkAt: this._lastRefreshOkAt || null,
      totalRefresh: this._totalRefresh,
      totalRefreshFail: this._totalRefreshFail,
      failStreak: this._failStreak,
      hasLLToken: !!this.llToken,
    };
  }

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

  /**
   * ll-token 解析：默认 cache 优先（未来若服务端轮换 ll-token，重启不会退回 .env 旧值）；
   * 若 .env 的 VA_LL_TOKEN 与缓存记录的 envSeed 不一致（用户改了 .env）→ env 优先。
   */
  /** .env 的 VA_LL_TOKEN 是否与上次记录不同（envSeed 缺失时回退与 cache.llToken 对照）。 */
  _envLLTokenChanged(cache) {
    const env = this.envLLToken || '';
    if (!env) return false;
    const ref = cache?.envSeed || cache?.llToken || '';
    return env !== ref;
  }

  _resolveLLToken(cache) {
    if (this._envLLTokenChanged(cache)) return this.envLLToken;
    return cache?.llToken || this.envLLToken || '';
  }

  _pickSeed() {
    const cache = this._readCache() || {};
    this.llToken = this._resolveLLToken(cache);
    if (this.mode() === 'refresh') {
      // 同会话原则（Review24 P2-2）：refresh 需要与 ll-token 同会话的 access token。
      // - .env 换了新 ll-token（envChanged）→ 缓存 token 属旧会话 → 用 env token（没有则空=冷启动提示）
      // - 否则 → 缓存 token 由上次成功续期写入，必然同会话 → 缓存优先（不按 exp 选，防旧会话高 exp 污染）
      const envChanged = this._envLLTokenChanged(cache);
      return envChanged ? (this.envToken || '') : (cache.token || this.envToken || '');
    }
    // manual/siwe：候选取"仍有 >1h 余量"的，再按 exp 选最新一枚
    const cands = [this.envToken, cache.token].filter((t) => this._valid(t, HOUR));
    cands.sort((a, b) => (decodeJwtExp(b) || 0) - (decodeJwtExp(a) || 0));
    return cands[0] || '';
  }

  /** 启动解析 + 必要时首次续期/登录。返回最终 token（可能为空=只读）。 */
  async init() {
    const seed = this._pickSeed();
    if (seed) this._use(seed);
    // .env 里贴了 access token 但已失效，且我们改用了缓存/自动登录 → 提醒用户清空。
    // refresh 模式下 access token 过期属常态（ll-token 才是长期凭证），不告警。
    if (this.mode() !== 'refresh' && this.envToken && !this._valid(this.envToken, 0) && seed !== this.envToken) {
      logger.warn('va', '.env 中的 VARIATIONAL_TOKEN 已失效，已改用缓存/自动登录；可清空该项。');
    }
    if (this.mode() === 'refresh') {
      logger.info('va', `Variational 会话续期模式已启用（ll-token ${this.llToken ? '已就绪' : '缺失'}）。`);
    }
    await this.ensure({ boot: true });
    return this.token;
  }

  /**
   * 仪表盘热切换：接纳人工粘贴的凭证。
   * - refresh 模式：{ token, llToken } 同会话一枚 access（可过期）+ ll-token；
   * - manual 模式：{ token } 有效 access token（原行为）。
   * 返回 { exp, hrs, mode }；不可用直接抛错。
   */
  adopt(token, llToken = '') {
    const t = String(token || '').trim();
    const ll = String(llToken || '').trim();
    if (ll) this.llToken = ll;
    if (!t) {
      if (this.mode() === 'refresh' && this.hasToken()) {
        this._writeCache(this.token);
        this._failStreak = 0;
        return { exp: this.exp, hrs: null, mode: 'refresh' };
      }
      throw new Error('token 为空；首次启用自动续期请同时粘贴 vr-token + vr-ll-token（同一会话）。');
    }
    const exp = decodeJwtExp(t);
    // refresh 模式允许过期 access token（同会话即可续）；manual 模式必须未过期
    if (exp != null && exp * 1000 <= Date.now() && this.mode() !== 'refresh') {
      throw new Error('该 vr-token 已过期，请粘贴一枚新的。');
    }
    this._use(t);
    this._writeCache(t);
    this._failStreak = 0;
    const hrs = exp ? Math.max(1, Math.round((exp * 1000 - Date.now()) / HOUR)) : null;
    logger.info('va', `已接纳手动粘贴的凭证（模式 ${this.mode()}）${hrs && exp * 1000 > Date.now() ? `，access token 有效约 ${hrs} 小时` : ''}。`);
    return { exp, hrs, mode: this.mode() };
  }

  /** 被动捕获服务端 Set-Cookie（轮换兼容；实测当前不轮换）。 */
  onServerCookies(cookies) {
    if (!cookies) return;
    if (cookies['vr-token']) this._use(cookies['vr-token']);
    const ll = cookies['vr-ll-token'];
    if (ll && ll !== this.llToken) {
      this.llToken = ll;
      this._writeCache(this.token);
      logger.info('va', 'vr-ll-token 已被服务端轮换，已采纳并更新缓存。');
    }
  }

  /**
   * 确保会话健康。
   * refresh 模式：剩余 < 90s（或 force）→ refresh；需要 ll-token + 同会话 token。
   * manual/siwe：原语义（缺失或 <24h 且可自签 → 登录）。
   */
  async ensure({ force = false, boot = false } = {}) {
    const left = this.msLeft();
    if (this.mode() === 'refresh') {
      if (!force && this.hasToken() && left > ACCESS_REFRESH_BELOW_MS) return true;
      return this._ensureRefresh({ force, boot });
    }
    const healthy = this.hasToken() && left > REFRESH_BELOW_MS;
    if (!force && healthy) return true;
    if (!this.canRefresh()) {
      // 不能自签：贴 token 场景，健康与否交给调用方（401/临期告警）。
      return this.hasToken() && left > 0;
    }
    const now = Date.now();
    this._loginTimes = this._loginTimes.filter((t) => now - t < HOUR);
    if (!boot) {
      const gap = force ? RELOGIN_FORCE_THROTTLE_MS : RELOGIN_THROTTLE_MS;
      if (now - this._lastLoginAt < gap) return this.hasToken();
    }
    if (this._loginTimes.length >= RELOGIN_MAX_PER_HOUR) {
      logger.warn('va', '自动登录已达每小时上限（6 次），暂缓续签。');
      return this.hasToken();
    }
    if (this._inflight) return this._inflight;
    this._inflight = this._login().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _ensureRefresh({ force = false, boot = false } = {}) {
    if (!this.llToken) return this.hasToken() && this.msLeft() > 0;
    if (!this.hasToken()) {
      // 冷启动缺同会话 vr-token：ll-only 会被 400 拒绝（探针 v2）→ 需人工粘贴一次两者
      if (!this._coldStartAlerted) {
        this._coldStartAlerted = true;
        this.onAlert?.('⚠️ Variational 续期模式缺少 vr-token（同会话）：请打开 Dashboard→VA 面板，同时粘贴 vr-token + vr-ll-token（同一会话、F12 Cookies 相邻两行）以启用自动续期。');
      }
      return false;
    }
    const now = Date.now();
    this._refreshTimes = this._refreshTimes.filter((t) => now - t < TEN_MIN);
    if (!boot) {
      if (now - this._lastRefreshAt < REFRESH_THROTTLE_MS) return this.hasToken() && this.msLeft() > 0;
    }
    if (this._refreshTimes.length >= REFRESH_MAX_PER_10MIN) {
      logger.warn('va', '会话续期已达 10 分钟上限（12 次），暂缓。');
      return this.hasToken() && this.msLeft() > 0;
    }
    if (this._inflight) return this._inflight;
    this._inflight = this._refresh().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _refresh() {
    this._lastRefreshAt = Date.now();
    this._refreshTimes.push(this._lastRefreshAt);
    try {
      const out = await this.http.refresh({ llToken: this.llToken, token: this.token, address: this.address });
      if (!out?.ok || !out.token) {
        const err = new Error(`续期被拒（HTTP ${out?.status}）${out?.detail ? `：${out.detail}` : ''}`);
        err.status = out?.status;
        throw err;
      }
      this._use(out.token);
      const rotated = out.setCookies?.['vr-ll-token'];
      if (rotated && rotated !== this.llToken) {
        this.llToken = rotated;
        this.onNotice?.('vr-ll-token 已被服务端轮换，已更新缓存。');
      }
      this._writeCache(this.token);
      this._failStreak = 0;
      this._totalRefresh++;
      this._lastRefreshOkAt = Date.now();
      // 日志限流：refresh 每 ~3.5 分钟一次，info 收敛到每小时一条（其余静默计数）
      if (Date.now() - (this._lastRefreshLogAt || 0) > 55 * 60_000) {
        this._lastRefreshLogAt = Date.now();
        const expTxt = this.exp ? new Date(this.exp * 1000).toISOString().slice(11, 19) : '?';
        logger.info('va', `会话已续期（refresh），新 token 有效至 ${expTxt}Z（累计 ${this._totalRefresh} 次）。`);
      }
      return true;
    } catch (e) {
      this._failStreak++;
      this._totalRefreshFail++;
      const msg = e?.message || String(e);
      const status = e?.status;
      if (status === 400) {
        // 探针证实：400=无法续期（ll-only/旧会话/ll 失效）——重试不会自愈，立即 critical
        this.onAlert?.(`❌ Variational 会话续期被拒（400）：vr-ll-token 与 vr-token 可能不是同一会话（或 ll-token 已失效）。请在网页登录后，于面板同时粘贴两枚新凭证（同一会话）。`);
      } else if (this._failStreak >= 4 || status === 401 || status === 403) {
        this.onAlert?.(`❌ Variational 会话续期失败（连续 ${this._failStreak} 次）：${msg}。请在网页重新登录后，于面板同时粘贴新的 vr-token + vr-ll-token。`);
      } else if (this._failStreak >= 2) {
        this.onAlert?.(`⚠️ Variational 会话续期连续 ${this._failStreak} 次失败：${msg}`);
      } else {
        logger.warn('va', `会话续期失败（第 ${this._failStreak} 次）：${msg}`);
      }
      return false;
    }
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
      // Cloudflare 对 /api/auth/login 设了 managed challenge（需浏览器执行 JS 拿
      // cf_clearance），curl_cffi 过不去、重试无意义 → 直接给出可操作提示（贴 token 兜底）。
      const challenged = /just a moment|challenge-platform|cf-chl|enable javascript|cloudflare/i.test(msg);
      if (challenged) {
        this.onAlert?.('❌ Variational 自动登录被 Cloudflare 挑战拦截（/api/auth/login 需浏览器验证）。请粘贴 vr-token + vr-ll-token（仪表盘 VA 面板）以启用自动续期。');
      } else if (this._failStreak >= 2) {
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
      const payload = { token, exp: this.exp, at: Date.now() };
      if (this.llToken) payload.llToken = this.llToken;
      if (this.envLLToken) payload.envSeed = this.envLLToken; // 用于"用户改了 .env → env 优先"判定
      fs.writeFileSync(this.cachePath, JSON.stringify(payload), { mode: 0o600 });
      try { fs.chmodSync(this.cachePath, 0o600); } catch { /* best-effort */ }
    } catch (e) { logger.warn('va', `token 缓存写入失败：${e?.message || e}`); }
  }
}
