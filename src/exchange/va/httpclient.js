// VaHttpClient — the ONE place that talks HTTP to omni.variational.io.
//
// Omni has no official API; the frontend sits behind Cloudflare. Node `fetch`
// (and plain curl) get a 403 challenge; a Chrome TLS/JA3 impersonation via the
// Python curl_cffi transport (transport.js + transport_worker.py) gets 200. So:
//   * transport = 'bridge' (default for live) routes every request through the
//     Python worker. This is the ONLY mode that actually passes Cloudflare.
//   * transport = 'node' keeps the plain-fetch path (kept for the record / for
//     hosts where fetch somehow works) — it WILL throw CloudflareError in prod.
// Either way, Cloudflare-challenge detection and VaHttpError shaping live here,
// so both transports have identical semantics.
//
// Auth is a `vr-token` COOKIE (NOT a Bearer header) — verified by rbh-hedge-var.
// The token is pasted from .env for now (VARIATIONAL_TOKEN, 7-day JWT); the SIWE
// auto-login module plugs in later via setToken().
import { logger } from '../../log.js';
import { VA_BASE_URL } from './market.js';
import { VaTransport } from './transport.js';

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
export class VaRateLimitError extends VaHttpError {
  constructor(message, retryAfterMs) { super(message, 429); this.name = 'VaRateLimitError'; this.transient = true; this.retryAfterMs = retryAfterMs; }
}

export class VaHttpClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || VA_BASE_URL).replace(/\/$/, '');
    this.address = opts.address || '';          // vr-connected-address
    this.token = opts.token || '';              // vr-token cookie value (JWT)
    this.timeoutMs = opts.timeoutMs || 15000;
    this.minWriteGapMs = opts.minWriteGapMs ?? 1000; // <=1 write/sec safety belt
    // Transport: 'bridge' (curl_cffi, passes Cloudflare) | 'node' (plain fetch).
    // opts.transport may also be a ready-made object (tests inject a MockHttp).
    this.transportMode = opts.transportMode || (typeof opts.transport === 'string' ? opts.transport : 'bridge');
    if (opts.transport && typeof opts.transport === 'object') {
      this.transport = opts.transport;
    } else if (this.transportMode === 'bridge') {
      this.transport = new VaTransport({ baseUrl: this.baseUrl, pythonPath: opts.pythonPath });
    } else {
      this.transport = null; // plain-fetch path
    }
    this._writeTail = Promise.resolve();         // serialize writes (one at a time)
    this._lastWriteAt = 0;
  }

  setToken(token) { this.token = token || ''; }
  hasToken() { return !!this.token; }
  async close() { if (this.transport?.stop) await this.transport.stop(); }

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

  // Shared Cloudflare-challenge + error shaping for BOTH transports.
  _process(status, text, getHeader) {
    const cfMitigated = getHeader('cf-mitigated');
    const looksChallenge = /just a moment|challenge-platform|cf-chl|enable javascript and cookies/i.test(text || '');
    if ((status === 403 || status === 503) && (cfMitigated || looksChallenge)) {
      throw new CloudflareError(`Cloudflare 拦截（HTTP ${status}）。需要启用 Python(curl_cffi) 传输层（VA_TRANSPORT=bridge）。`);
    }
    if (status === 429) {
      const ra = Number(getHeader('retry-after'));
      const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000;
      throw new VaRateLimitError(`Variational 限速（HTTP 429），${Math.round(retryAfterMs / 1000)}s 后重试。`, retryAfterMs);
    }
    let data;
    // Omni returns bare `null` on a successful cancel (HTTP 2xx). JSON.parse('null')
    // === null is a VALID success body — never assert an object here.
    try { data = text ? JSON.parse(text) : null; }
    catch { data = { _raw: String(text).slice(0, 500) }; }
    if (status < 200 || status >= 300) {
      const detail = data?.message || data?.error || data?._raw || `HTTP ${status}`;
      throw new VaHttpError(`Variational 接口错误 ${status}: ${detail}`, status, data);
    }
    return data;
  }

  async _fetch(method, path, { body, auth = false } = {}) {
    if (this.transport) {
      let res;
      try {
        res = await this.transport.request(method, path, { body, auth, token: this.token, address: this.address });
      } catch (e) {
        throw new VaHttpError(`连接 Variational 失败（传输层）：${e?.message || e}`, 0);
      }
      // MockHttp (tests) may already return parsed data instead of {status,text}.
      if (res && typeof res === 'object' && 'status' in res && ('text' in res || 'headers' in res)) {
        const headers = res.headers || {};
        return this._process(Number(res.status), res.text ?? '', (k) => headers[String(k).toLowerCase()]);
      }
      return res;
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
    return this._process(res.status, text, (k) => res.headers.get(k));
  }

  get(path, { auth = false } = {}) { return this._fetch('GET', path, { auth }); }

  /**
   * All writes go through a serial queue with a >=1s spacing belt. Omni's OLP
   * risk checks + our own conservative rate posture make bursty writes a bad
   * idea, and serializing keeps place/cancel ordering deterministic.
   *
   * skipGap: bypass the 1s belt for latency-sensitive pairs (indicative→accept,
   * whose quote_id expires within ~1-2s). Still serialized, just no forced sleep.
   */
  post(path, body, { auth = true, skipGap = false } = {}) {
    const run = this._writeTail.then(async () => {
      if (!skipGap) {
        const gap = this.minWriteGapMs - (Date.now() - this._lastWriteAt);
        if (gap > 0) await sleep(gap);
      }
      try { return await this._fetch('POST', path, { body, auth }); }
      finally { this._lastWriteAt = Date.now(); }
    });
    this._writeTail = run.then(() => {}, () => {});
    return run;
  }

  /** Public read: current price/index/status for one underlying. */
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
