// 行情与市场元数据。Propr 没有行情接口，价格/K 线一律取 Hyperliquid 公共 info。
// 这一层不碰账户，纯公开数据，失败不影响账户读取（由调用方降级）。
const HL_INFO = 'https://api.hyperliquid.xyz/info';

/** 5k 1-Step 默认交易标的。Propr 的 asset 用 symbol 本身（HIP-3 才带 xyz: 前缀）。 */
export const BTC_MARKET = Object.freeze({
  marketId: 0,
  symbol: 'BTC',
  asset: 'BTC',
  base: 'BTC',
  quote: 'USDC',
  minSize: 0.001,
  sizeStep: 0.001,
  priceStep: 0.5,
  maxLeverage: 10,
  displayName: 'BTC/USDC',
});

const INTERVALS = new Map([[60, '1m'], [300, '5m'], [900, '15m'], [3600, '1h'], [14400, '4h'], [86400, '1d']]);

export function roundSize(x, step = BTC_MARKET.sizeStep) {
  const n = Math.floor(Number(x) / step + 1e-9) * step;
  return Math.round(n * 1e8) / 1e8;
}

export function roundPrice(x, step = BTC_MARKET.priceStep) {
  const n = Math.round(Number(x) / step) * step;
  return Math.round(n * 1e8) / 1e8;
}

export class HlMarketData {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = HL_INFO, priceTtlMs = 2_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.priceTtlMs = priceTtlMs;
    this._mids = { at: 0, data: null };
    this._inflight = null;
  }

  async _post(body) {
    const res = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HL info ${res.status}`);
    return res.json();
  }

  /** 中间价（用 allMids，一请求拿全市场）。带 2s 缓存与并发合并。 */
  async getPrice(symbol = 'BTC') {
    const now = Date.now();
    if (this._mids.data && now - this._mids.at < this.priceTtlMs) return Number(this._mids.data[symbol]);
    if (this._inflight) { await this._inflight; return Number(this._mids.data?.[symbol]); }
    this._inflight = (async () => {
      const d = await this._post({ type: 'allMids' });
      this._mids = { at: Date.now(), data: d };
    })();
    try { await this._inflight; } finally { this._inflight = null; }
    const px = Number(this._mids.data?.[symbol]);
    if (!Number.isFinite(px) || px <= 0) throw new Error(`HL 无有效 ${symbol} 中间价`);
    return px;
  }

  /** K 线：[{time,open,high,low,close,volume}]，升序，丢弃未收盘那根。 */
  async getCandles(symbol = 'BTC', intervalSec = 3600, n = 200) {
    const interval = INTERVALS.get(Number(intervalSec));
    if (!interval) throw new Error(`不支持的 K 线周期: ${intervalSec}s`);
    const end = Date.now();
    const span = Number(intervalSec) * 1000 * (n + 2);
    const rows = await this._post({ type: 'candleSnapshot', req: { coin: symbol, interval, startTime: end - span, endTime: end } });
    const list = (rows || []).map((b) => ({
      time: Number(b.t), open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v),
    }));
    // 最后一根若仍在形成（收盘时间 > now），去掉
    const last = list[list.length - 1];
    if (last && last.time + Number(intervalSec) * 1000 > Date.now()) list.pop();
    return list.slice(-n);
  }
}