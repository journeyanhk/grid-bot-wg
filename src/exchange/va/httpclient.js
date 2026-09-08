// VaHttpClient — the ONE place that talks HTTP to omni.variational.io.
//
// Omni has no official API; the frontend sits behind Cloudflare. This client is
// the "can Node pass Cloudflare?" spike (per the agreed plan): plain Node fetch
// dressed in Chrome-ish headers. If Cloudflare starts returning its challenge
// page (HTTP 403 + challenge markers) this throws a tagged CloudflareError so
// the adapter can fail-closed — and we fall back to a Python (curl_cffi)
// transport later WITHOUT touching the adapter, by injecting opts.transport.
//
// Auth is a `vr-token` COOKIE (NOT a Bearer header) — verified by rbh-hedge-var.
// The token is pasted from .env for now (VARIATIONAL_TOKEN, 7-day JWT); the SIWE
// auto-login module plugs in later via setToken().
import { logger } from '../../log.js';
import { VA_BASE_URL } from './market.js';

// A stable, believable desktop-Chrome fingerprint (matches the real capture).
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': VA_BASE_URL,
};

export class CloudflareError extends Error {
  constructor(message) { super(message); this.name = 'CloudflareError'; this.cloudflare = true; }
}
export class VaHttpError extends Error {
  constructor(message, status, data) { super(message); this.name = 'VaHttpError'; this.status = status; this.data = data; }
}

export class VaHttpClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || VA_BASE_URL).replace(/\/$/, '');
    this.address = opts.address || '';          // vr-connected-address
    this.token = opts.token || '';              // vr-token cookie value (JWT)
    this.timeoutMs = opts.timeoutMs || 15000;
    this.minWriteGapMs = opts.minWriteGapMs ?? 1000; // <=1 write/sec safety belt
    this.transport = opts.transport || null;    // future: python curl_cffi bridge
    this._writeTail = Promise.resolve();         // serialize writes (one at a time)
    this._lastWriteAt = 0;
  }

  setToken(token) { this.token = token || ''; }
  hasToken() { return !!this.token; }

  _headers(extra = {}, { auth = false } = {}) {
    const h = { ...BROWSER_HEADERS, ...extra };
    if (this.address) h['vr-connected-address'] = this.address;
    if (auth) {
      if (!this.token) throw new VaHttpError('缺少 VARIATIONAL_TOKEN（vr-token 会话 cookie），无法访问账户接口。', 401);
      h['Cookie'] = `vr-token=${this.token}`;
      if (this.address) h['Cookie'] += `; vr-connected-address=${this.address}`;
      h['Referer'] = `${this.baseUrl}/portfolio`;
    } else {
      h['Referer'] = `${this.baseUrl}/perpetual/BTC`;
    }
    return h;
  }

  async _fetch(method, path, { body, auth = false } = {}) {
    if (this.transport) {
      // Seam for the Python (curl_cffi) fallback: same normalized contract.
      return this.transport.request(method, path, { body, auth, token: this.token, address: this.address });
    }
    const url = this.baseUrl + path;
    const headers = this._headers(body ? { 'content-type': 'application/json' } : {}, { auth });
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new VaHttpError(`连接 Variational 失败：${e?.message || e}`, 0);
    }
    const text = await res.text();
    // Cloudflare challenge detection: a 403 (or 503) whose body is the JS
    // challenge page, or a cf-mitigated header. This is the make-or-break signal
    // for the "Node vs Cloudflare" spike.
    const cfMitigated = res.headers.get('cf-mitigated');
    const looksChallenge = /just a moment|challenge-platform|cf-chl|enable javascript and cookies/i.test(text);
    if ((res.status === 403 || res.status === 503) && (cfMitigated || looksChallenge)) {
      throw new CloudflareError(`Cloudflare 拦截（HTTP ${res.status}）。Node 直连未通过挑战——需要启用 Python(curl_cffi) 传输层。`);
    }
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { _raw: text.slice(0, 500) }; }
    if (!res.ok) {
      const detail = data?.message || data?.error || data?._raw || `HTTP ${res.status}`;
      throw new VaHttpError(`Variational 接口错误 ${res.status}: ${detail}`, res.status, data);
    }
    return data;
  }

  get(path, { auth = false } = {}) { return this._fetch('GET', path, { auth }); }

  /**
   * All writes go through a serial queue with a >=1s spacing belt. Omni's OLP
   * risk checks + our own conservative rate posture make bursty writes a bad
   * idea, and serializing keeps place/cancel ordering deterministic.
   */
  post(path, body, { auth = true } = {}) {
    const run = this._writeTail.then(async () => {
      const gap = this.minWriteGapMs - (Date.now() - this._lastWriteAt);
      if (gap > 0) await sleep(gap);
      try { return await this._fetch('POST', path, { body, auth }); }
      finally { this._lastWriteAt = Date.now(); }
    });
    this._writeTail = run.then(() => {}, () => {});
    return run;
  }

  /** Public read: current price/index/status for one underlying (no auth, no CF cookie needed on reads per rbh). */
  async supportedAssets(underlying) {
    return this.get(`/api/metadata/supported_assets?cex_asset=${encodeURIComponent(underlying)}`);
  }
  warnOnce(key, msg) {
    this._warned = this._warned || new Set();
    if (this._warned.has(key)) return;
    this._warned.add(key);
    logger.warn('va', msg);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
