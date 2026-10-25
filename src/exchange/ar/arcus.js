// ArcusExchange: LIVE 适配器（Arcus beta，永续，Ed25519 API key）。
//
// 与仓库其它六所的差异（都已按 2026-10-22 官方文档 + 只读实测校准）：
//   1. 签名分两套：Scheme 1（类型化载荷，p/q 为整数 tick/quantum）用于
//      place/cancel/modify；Scheme 2（timestamp + action + canonical body）用于
//      cancelAllOrders / setLeverage / scheduleCancel。
//   2. 每张单必须带 goodTilTime（µs，≥now+1 个月）；签名里 g = µs × 1000（ns）。
//   3. 全单走 ALO（TIF=3，post-only）：maker 0 ppm，且 ALO 批量跳过 50ms taker
//      speed bump。taker 单次 22.5bps ≈ 3.7 格利润，网格绝不能吃单。
//   4. 成交真值是公开 REST /v1/fills（from/to 微秒游标，无需鉴权），照抄 hl 的
//      userFillsByTime 增量模式；WS 只负责行情（bbo），断线只是降级不是事故。
//   5. Arcus 没有断线自动撤单 → 必须用 scheduleCancel 死手开关兜底（60s 续期，
//      deadline 4 分钟）。
//
// 下单走 REST 而非 WS：WS 下单是异步 ACK、错误帧不回显 id、连接 24h 强制断，
// 而 REST 同步返回 orderId，与 bot 的 reconcile 天然一致。
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { logger } from '../../log.js';
import {
  canonicalJson, privateKeyFromHex, apiKeyFromPrivate, signMessage,
  nowNs, roundToUnit,
} from './signer.js';
import {
  normalizeBase, normalizeWs, parseMarkets, parseCandles, parseOpenOrders, parseOpenOrder,
  parsePositions, parseAccount, timeframeFor, normalizeEpochMs,
  assertGridTradable, assertMakerFree,
  AR_MAINNET_CHAIN_ID, AR_TESTNET_CHAIN_ID,
} from './market.js';

const OP_PLACE = 1;
const OP_CANCEL = 2;
const TIF_ALO = 3;
const TIF_IOC = 2;
const SIDE_BUY = 0;
const SIDE_SELL = 1;

const GOOD_TIL_MS = 35 * 24 * 3600 * 1000;   // ≥1 个月，留 5 天余量
const FILL_POLL_MS = 1000;                    // /v1/fills（权重 20）
const ACCOUNT_POLL_MS = 5000;                 // /v1/account + /v1/positions（权重 2+2）
const PRICE_POLL_MS = 2000;                   // WS 掉线时的 bbo 兜底（权重 2）
const WS_SILENCE_MS = 30_000;                 // WS 30 秒没有任何帧 = 半开连接，必须强断重连
const MARKETS_TTL_MS = 5 * 60_000;            // /v1/markets（权重 20）
const DMS_REFRESH_MS = 20_000;                // 死手续期间隔（20s：4 分 50 秒 deadline 内留 14 次机会）
const DMS_DEADLINE_MS = 4 * 60_000 + 50_000;  // 死手 deadline（官方上限 5 分钟，取 4m50s 留余量）
const DMS_TRIGGER_QUOTA = 10;                 // 官方配额：自动撤单每日最多触发 10 次
const DMS_TRIGGER_GRACE_MS = 15_000;          // deadline 过后这么久仍没续上 = 已被触发
const DMS_QUOTA_WINDOW_MS = 24 * 3600_000;
const FILLS_OVERLAP_MS = 3000;                // 游标回退窗口，防漏单（配合去重）
const FILLS_SEEN_MAX = 5000;
// 未跟踪成交里低于这个名义额（USDC）的一律当测试网碎单，只记 info 不报警。
export function isDustFill(fill, dustUsd = UNTRACKED_DUST_USD) {
  const notional = Math.abs(Number(fill?.sizeBase) || 0) * (Number(fill?.price) || 0);
  return notional < dustUsd;
}

const UNTRACKED_DUST_USD = 1;
// 未跟踪成交告警的自愈窗口：这么久没有新的未跟踪成交就自动清除，避免 health 永久红。
const UNTRACKED_TTL_MS = 30 * 60_000;

const FILLS_PAGE_LIMIT = 200;                 // 服务端单页上限
const FILLS_MAX_PAGES = 20;                   // 一次回补最多 4000 笔，防死循环
const CANCEL_BATCH = 100;
const PLACE_BATCH = 15;                       // bot.js 也硬压 15
const WS_ROTATE_MS = 20 * 3600_000;           // 连接寿命 24h，提前轮换
const CLOCK_TOLERANCE_MS = 4000;   // 服务端 ct 容差 ±5s，留 1s 余量
const CLOCK_WARN_MS = 1200;         // 超过就告警：抖动会吃掉签名窗口

/**
 * 单次幂等键：orderId + clientId + 原始微秒时间 + 数量/价格。
 * 时间必须用交易所返回的微秒戳：Arcus 同一订单在同一毫秒内可以出多笔部分成交，
 * 归一化到毫秒会把它们判成同一笔 —— 后来那笔被静默丢弃，网格就永远少一格。
 */
function fillKey(f) {
  return `${f.orderId}|${f.clientId || ''}|${f.rawTs ?? f.createdAt}|${f.sizeBase}|${f.price}`;
}

/** 从成交行里取原始时间戳（µs；部分字段可能是 ns，交给调用方归一）。 */
function rawFillTs(row) {
  const t = Number(row?.createdAt ?? row?.time ?? row?.timestamp ?? 0);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

export class ArcusExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.network = (opts.network || 'mainnet').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet';
    this.apiUrl = normalizeBase(opts.apiUrl, this.network);
    this.wsUrl = normalizeWs(opts.wsUrl, this.apiUrl);
    this.chainId = this.network === 'testnet' ? AR_TESTNET_CHAIN_ID : AR_MAINNET_CHAIN_ID;
    this.address = String(opts.address || '').toLowerCase();
    this.accountIndex = Number.isFinite(Number(opts.accountIndex)) ? Number(opts.accountIndex) : 0;
    // 两种命名都收：工厂（config 的 AR_API_SIGNING_KEY）传 signingKey，
    // 探针/测试传 keyHex；早期只认 keyHex，导致 server 的 live 模式永远缺钥。
    this.keyPath = opts.keyPath || opts.signingKeyFile || '';
    this.keyHex = opts.keyHex || opts.signingKey || '';
    this.proxy = opts.proxy || '';
    this.marketHint = opts.market || '';       // 可选：默认市场（如 BTC-USD）

    this.markets = new Map();
    this._prices = new Map();
    this._tracked = new Map();                 // orderId -> {levelIndex, side, price, sizeBase, reduceOnly, placedAt, seen}
    this._pos = new Map();                     // marketId -> Position
    this._watch = new Set();                   // 需要行情/价格的市场
    this._watchTouch = new Map();

    this.balance = null;
    this.equity = null;
    this.realizedPnl = null;
    this.feeRate = 0;                          // maker ppm / 1e6（0 = 免费，合法值）
    this.dataSource = null;
    this.lastOkAt = 0;
    this.lastError = null;
    this.operationalIssue = null;
    this.clockSkewMs = null;
    this._lastSigNs = 0n;                      // 上一个签名时间戳，保证 ct 严格递增

    this.supportsSafeOpeningRetry = false;     // v1 保守：不开"两次快照去重"重试
    // 停机超过 4 分钟，死手开关已经把这批挂单撤光了。续跑时"在簿 0 单"是
    // 常态而非异常，adopt 路径无单可认领，必须改走全新铺梯（见 server 续跑）。
    this.resumeWithoutOrders = true;
    this.orderBatchSize = PLACE_BATCH;
    this._ready = false;
    this._stopping = false;

    this._key = null;
    this._apiKeyHex = '';
    this._fillsFromMs = Date.now() - 5 * 60_000;
    this._fillsSeen = new Set();
    this._lastFillPollAt = 0;
    // 首次轮询只做"水位对齐"：进程刚起来时 _fillsFromMs 是 0，会把历史成交
    // 全当成新成交重放，逐条报"未跟踪订单"并污染 operationalIssue。
    this._fillsPrimed = false;
    this._startedAt = Date.now();
    this._marketsAt = 0;
    this._dmsArms = [];            // 24h 内续期时间戳（观测用，不消耗配额）
    this._dmsTriggers = [];        // 24h 内"已判定被交易所自动撤单"的时间戳（吃配额）
    this._dmsQuotaRejectedAt = 0;  // 最近一次因配额被拒的时间
    this._dmsArmedAt = 0;
    this._dmsDeadlineMs = 0;
    this._ws = null;
    this._wsReady = false;
    this._wsTimer = null;
    this._wsRetryMs = 1000;
    this._wsOpenedAt = 0;
    this._wsDegraded = null;
    this._wsSubscribed = new Set();
    this._lastErrEmitAt = 0;
    this._consecutiveErrors = 0;

    this._timers = {};
    this._loops = { fills: false, account: false, price: false, dms: false, markets: false };
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async init() {
    this._validateConfig();
    this._key = privateKeyFromHex(this.keyHex || readKeyFile(this.keyPath));
    this._apiKeyHex = apiKeyFromPrivate(this._key);
    await this._checkClock();
    await this._loadMarkets(true);
    this._assertStartupGates();
    await this._refreshAccount().catch(() => {});
    this._ready = true;
    this.start();
    return true;
  }

  /**
   * 启动闸门（D2 ③）：默认市场必须 24/7 可交易，且主网必须 maker 免费。
   * testnet 的费用表是模拟值（150/450 ppm），只告警不拦，否则测试网无法跑单。
   */
  _assertStartupGates() {
    const target = this.marketHint
      ? [...this.markets.values()].find((m) => m.displayName === this.marketHint || String(m.marketId) === String(this.marketHint))
      : this._defaultMarket();
    if (!target) throw new Error(`找不到默认市场 ${this.marketHint || '(无)'}。`);
    assertGridTradable(target);
    if (this.network === 'testnet') {
      if (target.makerFeePpm > 0) logger.warn('ar', `testnet 费用表为模拟值 maker ${target.makerFeePpm} ppm / taker ${target.takerFeePpm} ppm；主网才是 0/225，此处不拦。`);
      return;
    }
    assertMakerFree(target);
  }

  _validateConfig() {
    if (!/^0x[0-9a-f]{40}$/.test(this.address)) {
      throw new Error('AR_ADDRESS 必须是 0x 开头的 40 位小写以太坊地址（API key 的主地址）。');
    }
    if (!Number.isInteger(this.accountIndex) || this.accountIndex < 0 || this.accountIndex > 9) {
      throw new Error(`AR_ACCOUNT_INDEX 必须是 0-9 的整数，当前 ${this.accountIndex}。`);
    }
    if (!this.keyHex && !this.keyPath) {
      throw new Error('缺少 AR_API_SIGNING_KEY（或 AR_API_SIGNING_KEY_FILE）。请在 Arcus 网页注册 API key 后填入六十四位十六进制私钥。');
    }
  }

  /** 签名用的当前时间：叠加启动时测得的时钟偏差，避免本机漂移直接打死所有签名单。 */
  _nowNs() {
    // nowNs() 只有毫秒分辨率：同一毫秒内连发的两单会拿到完全相同的 ct，
    // 服务端按请求时间戳去重（request timestamp already used / 401）直接把后一单拒掉。
    // 实测连环成交时段一秒内要连发十几单，必然踩中，表现为补腿丢失→阶梯空洞。
    // 因此这里保证本进程发出的 ct 严格递增（同毫秒内逐个 +1ns）。
    const base = nowNs() + BigInt(Math.round(this.clockSkewMs || 0)) * 1_000_000n;
    const ts = base > this._lastSigNs ? base : this._lastSigNs + 1n;
    this._lastSigNs = ts;
    return ts;
  }

  /** ct 只有 ±5s 容差：时钟漂移会让每一单签名失败，必须在启动时暴露。 */
  async _checkClock() {
    try {
      const t0 = Date.now();
      const j = await this._http('GET', '/v1/time', { weight: 1, timeoutMs: 8000 });
      const t1 = Date.now();
      const server = Number(j?.timeNs) / 1e6;
      if (Number.isFinite(server) && server > 0) {
        this.clockSkewMs = Math.round(server - (t0 + t1) / 2);
        if (Math.abs(this.clockSkewMs) > CLOCK_TOLERANCE_MS) {
          throw new Error(`本机时钟与 Arcus 偏差 ${this.clockSkewMs}ms（签名容差 ±5s）。请先校准 NTP 再启动。`);
        }
        if (Math.abs(this.clockSkewMs) > CLOCK_WARN_MS) {
          logger.warn('ar', `本机时钟偏差 ${this.clockSkewMs}ms，已按偏差补偿签名时间戳（请尽快校准 NTP）。`);
        }
      }
    } catch (e) {
      if (/时钟与 Arcus 偏差/.test(e.message)) throw e;
      logger.warn('ar', `时钟校准跳过：${e.message}`);
    }
  }

  start() {
    if (this._stopping) return;
    this._startLoop('fills', FILL_POLL_MS, () => this._pollFills());
    this._startLoop('account', ACCOUNT_POLL_MS, () => this._refreshAccount());
    this._startLoop('price', PRICE_POLL_MS, () => this._pollPrices());
    this._startLoop('markets', MARKETS_TTL_MS, () => this._loadMarkets(false).catch(() => {}));
    this._startDms();
    this._connectWs();
  }

  stop() {
    for (const t of Object.values(this._timers)) clearInterval(t);
    this._timers = {};
    this._clearWs();
    this._ready = false;
  }

  /**
   * 网络闪断后重建连接：不动挂单与持仓。
   * Arcus 的 REST 是无状态签名，重连成本极低——只需要重探一次账户、重置 WS。
   */
  async reconnect() {
    this._lastErrEmitAt = 0;
    this._consecutiveErrors = 0;
    this.lastError = null;
    await this._checkClock().catch(() => {});
    await this._refreshAccount();
    this._clearWs();
    this._wsRetryMs = 1000;
    this._connectWs();
    this._ready = true;
    return true;
  }

  _startLoop(name, ms, fn) {
    if (this._timers[name]) clearInterval(this._timers[name]);
    this._timers[name] = setInterval(() => {
      if (this._loops[name]) return;              // 上一轮没跑完，跳过（防重入）
      this._loops[name] = true;
      Promise.resolve()
        .then(fn)
        .catch((e) => this._fail(e, name))
        .finally(() => { this._loops[name] = false; });
    }, ms);
  }

  _fail(e, where = '') {
    this.lastError = e;
    this._consecutiveErrors += 1;
    const msg = e?.message || String(e);
    if (this._consecutiveErrors >= 3) {
      this.operationalIssue = {
        title: 'Arcus 连续失败',
        message: `${where || '轮询'} 连续 ${this._consecutiveErrors} 次失败：${msg}`,
      };
    }
    if (Date.now() - this._lastErrEmitAt > 30_000) {
      this._lastErrEmitAt = Date.now();
      this.emit('error', e instanceof Error ? e : new Error(msg));
    } else {
      logger.warn('ar', `${where} 失败（已节流）：${msg}`);
    }
  }

  // ── HTTP 底座 ───────────────────────────────────────────────────────────

  /**
   * 统一请求：公共读无需鉴权；写操作由调用方传入 headers。
   * 429 语义（官方文档）：body.reason 区分 ip / account_empty / account_partial，
   * 写操作额外给 retryAfterMs，比 Retry-After 头（向上取整秒）更精确。
   */
  async _http(method, path, { body, query, headers, timeoutMs = 15_000, weight = 0 } = {}) {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const url = `${this.apiUrl}${path}${qs}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = new Error(`Arcus ${method} ${path} 网络失败：${e.message}`, { cause: e });
      err.transient = true;
      throw err;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

    if (res.status === 429) {
      const err = new Error(`Arcus 限流（${json?.reason || 'ip'}）：${json?.error || 'rate limited'}`);
      err.rateLimited = true;
      err.reason = json?.reason || 'ip';
      err.retryAfterMs = Number(json?.retryAfterMs) || (Number(res.headers.get('retry-after') || 1) * 1000);
      err.weight = weight;
      throw err;
    }
    if (!res.ok) {
      const detail = json?.error?.message || json?.error || json?.message || text.slice(0, 200);
      const err = new Error(`Arcus ${method} ${path} HTTP ${res.status}：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      err.status = res.status;
      err.body = json;
      // 官方语义：Transmission = 请求没到撮合引擎，可原样重发；其余拒绝绝不能重发。
      err.transmission = json?.error?.errorType === 'Transmission' || json?.errorType === 'Transmission';
      err.engineRejected = !err.transmission && res.status !== 408 && res.status !== 502 && res.status !== 503;
      throw err;
    }
    this.lastOkAt = Date.now();
    this._consecutiveErrors = 0;
    if (this.operationalIssue?.title === 'Arcus 连续失败') this.operationalIssue = null;
    return json;
  }

  /** 带退避的重试包装：仅用于"可以安全重发"的读请求与传输层失败。 */
  async _retry(fn, { tries = 3, tag = '' } = {}) {
    let lastErr;
    for (let i = 0; i < tries; i += 1) {
      try { return await fn(); } catch (e) {
        lastErr = e;
        const safe = !e.engineRejected && (e.transient || e.rateLimited || e.status === 408 || e.status >= 500);
        if (!safe) throw e;
        const wait = Math.min(5000, e.retryAfterMs || 400 * 2 ** i);
        logger.warn('ar', `${tag} 重试 ${i + 1}/${tries}：${e.message}（${wait}ms）`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  // ── 市场与行情 ──────────────────────────────────────────────────────────

  async _loadMarkets(force) {
    if (!force && Date.now() - this._marketsAt < MARKETS_TTL_MS && this.markets.size) return;
    const payload = await this._retry(() => this._http('GET', '/v1/markets', { weight: 20 }), { tag: 'markets' });
    const list = parseMarkets(payload);
    if (!list.length) throw new Error('Arcus /v1/markets 返回空列表。');
    this.markets.clear();
    for (const m of list) this.markets.set(m.marketId, m);
    this._marketsAt = Date.now();
    this.dataSource = 'real';
    const def = this._defaultMarket();
    if (def) {
      this._watch.add(def.marketId);
      this.feeRate = (Number(def.makerFeePpm) || 0) / 1e6;
    }
    // 启动即断言：maker 不为 0 时网格单位经济不成立（1 格才 1 美分）。
    // testnet 的费率表是模拟值（150/450ppm），不是真实成本——把它升成
    // operationalIssue 会让测试网长跑永远挂着一条"运营异常"，验收单的
    // "operationalIssue 全程 null" 也就永远不可能通过。测试网只留 warning。
    if (def && def.makerFeePpm > 0) {
      const message = `BTC-USD maker ${def.makerFeePpm}ppm / taker ${def.takerFeePpm}ppm。单格毛利约 $0.01，请重算净利后再启动实盘。`;
      if (this.network === 'testnet') {
        this.feeWarning = { title: 'testnet 模拟费率', message };
        logger.warn('ar', `${message}（testnet 模拟费率，不计入 operationalIssue）`);
      } else {
        this.operationalIssue = { title: 'Arcus maker 费率非零', message };
        logger.warn('ar', message);
      }
    } else {
      this.feeWarning = null;
    }
  }

  _defaultMarket() {
    if (this.marketHint) {
      for (const m of this.markets.values()) {
        if (m.symbol.toUpperCase() === String(this.marketHint).toUpperCase()) return m;
      }
    }
    return [...this.markets.values()].find((m) => m.tradable) || [...this.markets.values()][0] || null;
  }

  _market(marketId) {
    const m = this.markets.get(Number(marketId));
    if (!m) throw new Error(`未知 Arcus 市场 marketId=${marketId}（市场表可能未加载）。`);
    return m;
  }

  async getMarkets() { return [...this.markets.values()]; }

  /** 只返回 24/7 可交易市场（股票类/停牌市场直接剔除，UI 也看不到）。 */
  async getTradableMarkets() { return [...this.markets.values()].filter((m) => m.tradable); }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const m = this._market(marketId);
    const timeframe = timeframeFor(intervalSec);
    try {
      const j = await this._retry(() => this._http('GET', '/v1/candles', {
        // `to` is mandatory (epoch microseconds) and bounds the right edge;
        // `limit` then walks backwards from it.
        query: {
          market: m.symbol,
          timeframe,
          to: String(Date.now() * 1000),
          limit: String(Math.min(1500, Math.max(n, 1))),
        },
        weight: 20,
      }), { tag: 'candles' });
      return parseCandles(j).slice(-n);
    } catch (e) {
      logger.warn('ar', `K 线获取失败：${e.message}`);
      return [];
    }
  }

  async getPrice(marketId) {
    const mId = Number(marketId);
    this._watch.add(mId);
    this._watchTouch.set(mId, Date.now());
    const cached = this._prices.get(mId);
    if (Number.isFinite(cached) && cached > 0) return cached;
    const p = await this._fetchBbo(mId).catch(() => null);
    return p ?? this._market(mId).lastPrice;
  }

  async _fetchBbo(marketId) {
    const { bid, ask } = await this._fetchBook(marketId);
    const mid = (bid + ask) / 2;
    this._setPrice(marketId, mid, { source: 'rest' });
    return mid;
  }

  /** 盘口双边价（平仓下单要打对手价，mid 不够用）。 */
  async _fetchBook(marketId) {
    const m = this._market(marketId);
    const j = await this._http('GET', `/v1/bbo/${encodeURIComponent(m.symbol)}`, { weight: 2, timeoutMs: 8000 });
    const bid = Number(j?.bestBid?.price);
    const ask = Number(j?.bestAsk?.price);
    if (!(bid > 0) || !(ask > 0)) throw new Error(`bbo 解析失败：${JSON.stringify(j).slice(0, 120)}`);
    return { bid, ask };
  }

  _setPrice(marketId, price, { source } = {}) {
    const mId = Number(marketId);
    if (!(price > 0)) return;
    const prev = this._prices.get(mId);
    this._prices.set(mId, price);
    if (source) this.dataSource = 'real';
    // 与上一价差 ≥ 1 个 tick 才推送，避免刷爆 SSE
    const tick = Number(this.markets.get(mId)?.stepPrice) || 0;
    if (!Number.isFinite(prev) || Math.abs(price - prev) >= tick) {
      this.emit('price', { marketId: mId, price });
    }
  }

  async _pollPrices() {
    // 2026-10-25 21:05 实测：WS 半开（socket 还 open、但一个帧都不再进来）时，原来这里
    // 只看 _wsReady 就直接 return，REST 兜底永远不跑，价格冻结 1141 秒、死手把 264 单
    // 全撤，进程却"看起来正常"（HTTP 200、对账照跑）。改成按"最近收帧时间"判活：
    // 30 秒静默就认定半开，强制断开重连并立刻走 REST 兜底。
    const silentMs = this._lastWsMsgAt ? Date.now() - this._lastWsMsgAt : 0;
    if (this._wsReady && silentMs > WS_SILENCE_MS) {
      logger.warn('ar', `WS ${Math.round(silentMs / 1000)}s 未收到任何帧（半开连接），强制重连并切 REST 兜底`);
      this._wsSilenceReconnects = (this._wsSilenceReconnects || 0) + 1;
      try { this._ws?.close(); } catch { /* ignore */ }
      this._wsReady = false;
      this._ws = null;
      this._wsSubscribed.clear();
      if (this._wsTimer) { clearTimeout(this._wsTimer); this._wsTimer = null; }
      this._wsRetryMs = 1000;
      this._connectWs();
    }
    if (this._wsReady) return;                  // WS 正常时不再花 REST 权重
    for (const mId of [...this._watch]) {
      const touched = this._watchTouch.get(mId) || 0;
      if (Date.now() - touched > 10 * 60_000 && this._watch.size > 1) { this._watch.delete(mId); continue; }
      await this._fetchBbo(mId).catch(() => {});
    }
  }

  // ── WebSocket（仅行情；下单/撤单走 REST）────────────────────────────────

  _connectWs() {
    if (this._stopping || this._ws) return;
    let ws;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (e) {
      logger.warn('ar', `WS 连接创建失败：${e.message}`);
      this._scheduleWsRetry();
      return;
    }
    this._ws = ws;
    this._wsOpenedAt = Date.now();
    ws.addEventListener('open', () => {
      this._wsReady = true;
    this._lastWsMsgAt = Date.now();
      this._wsRetryMs = 1000;
      this._wsDegraded = null;
      this._wsSubscribed.clear();
      for (const mId of this._watch) this._wsSubscribe(mId);
      logger.info('ar', `WS 已连接 ${this.wsUrl}`);
      this._wsTimer = setTimeout(() => this._rotateWs(), WS_ROTATE_MS);
    });
    ws.addEventListener('message', (ev) => this._onWsMessage(ev.data));
    ws.addEventListener('error', () => { /* close 事件里统一处理 */ });
    ws.addEventListener('close', () => {
      const wasReady = this._wsReady;
      this._wsReady = false;
      this._ws = null;
      this._wsSubscribed.clear();
      if (this._wsTimer) { clearTimeout(this._wsTimer); this._wsTimer = null; }
      if (wasReady && !this._stopping) logger.warn('ar', 'WS 断开，行情切 REST 轮询并自动重连');
      this._scheduleWsRetry();
    });
  }

  _scheduleWsRetry() {
    if (this._stopping) return;
    const wait = this._wsRetryMs;
    this._wsRetryMs = Math.min(30_000, Math.round(this._wsRetryMs * 1.6));
    setTimeout(() => this._connectWs(), wait).unref?.();
  }

  _rotateWs() {
    // 连接寿命 24h：提前主动换一条，避免服务端到点硬断在关键时刻。
    if (this._ws) {
      logger.info('ar', 'WS 预防性轮换');
      try { this._ws.close(); } catch { /* ignore */ }
    }
  }

  _clearWs() {
    if (this._wsTimer) { clearTimeout(this._wsTimer); this._wsTimer = null; }
    const ws = this._ws;
    this._ws = null;
    this._wsReady = false;
    this._wsSubscribed.clear();
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
  }

  _wsSubscribe(marketId) {
    const m = this.markets.get(Number(marketId));
    if (!m || !this._ws || this._ws.readyState !== 1) return;
    // Arcus multiplexes channels on one socket: `channel` names the feed and
    // `id` names the market (ticker). It is NOT `bbo.BTC-USD`.
    const key = `bbo:${m.symbol}`;
    if (this._wsSubscribed.has(key)) return;
    this._wsSubscribed.add(key);
    this._wsSend({ type: 'subscribe', channel: 'bbo', id: m.symbol });
  }

  _wsSend(obj) {
    try { this._ws?.send(JSON.stringify(obj)); } catch (e) { logger.warn('ar', `WS 发送失败：${e.message}`); }
  }

  _onWsMessage(data) {
    this._lastWsMsgAt = Date.now();             // 任何一帧都算活着（含 error/degraded），用于半开判定
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
    if (msg?.type === 'error') {
      const text = msg.error?.message || msg.message || JSON.stringify(msg.error || msg);
      logger.warn('ar', `WS 错误：${text}`);
      return;
    }
    if (msg?.type === 'degraded') {
      this._wsDegraded = { reason: msg.reason, at: Date.now() };
      logger.warn('ar', `WS 降级（${msg.reason || 'unknown'}），等待快照`);
      return;
    }
    const contents = msg?.contents ?? msg?.data ?? null;
    if (!contents) return;
    if (msg.type !== 'subscribed' && msg.type !== 'channel_data') return;
    this._wsDegraded = null;
    const channel = String(msg.channel || '');
    // `id` carries the market ticker for bbo; fall back to whatever the payload says.
    const symbol = channel === 'bbo' || channel.startsWith('bbo.')
      ? String(msg.id || contents.marketDisplayName || contents.market || '')
      : String(contents.marketDisplayName || contents.market || '');
    const m = [...this.markets.values()].find((x) => x.symbol === symbol);
    if (!m) return;
    const bid = Number(contents.bestBid?.price ?? contents.bid?.price ?? contents.bid);
    const ask = Number(contents.bestAsk?.price ?? contents.ask?.price ?? contents.ask);
    if (bid > 0 && ask > 0) this._setPrice(m.marketId, (bid + ask) / 2, { source: 'ws' });
  }

  // ── 成交真值（REST 游标 + 去重）────────────────────────────────────────

  /**
   * /v1/fills 的 from/to 是微秒且按 createdAt 降序。
   * 游标只推进到"实际入账的最新一条"，并回退 3 秒防边界漏单；重复由 _fillsSeen 去重。
   * —— 与 TrackA 资金费水位的教训同源：水位不能用 now，只能用已入账的最后一条。
   */
  async _pollFills() {
    const from = Math.max(0, Math.floor((this._fillsFromMs - FILLS_OVERLAP_MS) * 1000));
    const rows = await this._fetchFillRows(from);
    // 心跳先打，再判空：空轮直接 return 会让 lastFillPollAgeMs 在平静期永远是 null，
    // 巡检分不清"这段时间没有成交"和"轮询循环已经死了"——验收单第 2 项直接失效。
    this._lastFillPollAt = Date.now();
    const priming = !this._fillsPrimed;
    this._fillsPrimed = true;
    if (!rows.length) return;
    let newest = this._fillsFromMs;
    const fresh = [];
    for (const row of rows) {
      const f = this._mapFill(row);
      if (!f) continue;
      const key = fillKey(f);
      if (this._fillsSeen.has(key)) continue;
      this._fillsSeen.add(key);
      // 首次轮询里早于本进程启动的成交：只记水位、不下发，避免把重启前
      // 的历史成交当成"未跟踪订单"报警（bot 用持仓对账，不依赖补历史成交）。
      if (priming && f.createdAt < this._startedAt - 1000) {
        if (f.createdAt > newest) newest = f.createdAt;
        continue;
      }
      fresh.push(f);
      if (f.createdAt > newest) newest = f.createdAt;
    }
    if (this._fillsSeen.size > FILLS_SEEN_MAX) {
      const drop = [...this._fillsSeen].slice(0, this._fillsSeen.size - FILLS_SEEN_MAX + 1000);
      for (const k of drop) this._fillsSeen.delete(k);
    }
    if (newest > this._fillsFromMs) this._fillsFromMs = newest;
    // 由旧到新推送，保证 bot 的补单顺序正确
    fresh.sort((a, b) => a.createdAt - b.createdAt);
    for (const f of fresh) {
      const t = this._tracked.get(String(f.orderId));
      if (t) {
        f.levelIndex = t.levelIndex;
        this._tracked.delete(String(f.orderId));
      } else {
        f.levelIndex = null;
        // 测试网会打出 1e-8 量级的碎单成交（远小于最小下单量 0.0001），它们既不可能
        // 来自策略（单笔都 ≥ minOrderSize），也不影响任何格位。按名义额设阈值：
        // 低于 1 USDC 的直接降级成 info，不把 health 钉死在 error 上。
        const notional = Math.abs(Number(f.sizeBase) || 0) * (Number(f.price) || 0);
        if (isDustFill(f)) {
          logger.info('ar', `忽略碎单成交（名义 ${notional.toFixed(6)} USDC）：${f.orderId} ${f.side} ${f.sizeBase} @ ${f.price}`);
          this.emit('fill', f);
          continue;
        }
        logger.warn('ar', `未跟踪订单的成交（可能来自网页手动下单）：${f.orderId} ${f.side} ${f.sizeBase} @ ${f.price}`);
        this.operationalIssue = {
          title: 'Arcus 出现未跟踪成交',
          message: `订单 ${f.orderId} 在本地无记录，可能是网页/其它客户端手动下单。请核对该笔是否应计入网格。`,
        };
        this._untrackedAt = Date.now();
      }
      this.emit('fill', f);
    }
  }

  /**
   * 拉 from 之后的全部成交，必要时往回翻页。
   * `/v1/fills` 单页上限 200 且按时间**降序**返回：停机一晚上再续跑时，积压的可能
   * 有几百笔，只取第一页会把最老那批永久空过去（游标随即被推到最新，再也回不去）。
   * 这里用 `to` 不断收窄上界往回翻，直到某页不满 200 条。
   */
  async _fetchFillRows(from) {
    const collected = [];
    let to = 0;                              // 0 = 不限上界
    for (let page = 0; page < FILLS_MAX_PAGES; page += 1) {
      const query = {
        address: this.address, accountIndex: String(this.accountIndex),
        from: String(from), limit: String(FILLS_PAGE_LIMIT),
      };
      if (to) query.to = String(to);
      const j = await this._retry(() => this._http('GET', '/v1/fills', { query, weight: 20 }), { tag: 'fills' });
      const rows = Array.isArray(j) ? j : (j?.fills || j?.data || []);
      if (!rows.length) break;
      collected.push(...rows);
      if (rows.length < FILLS_PAGE_LIMIT) break;
      const oldest = rows.reduce((min, r) => {
        const t = rawFillTs(r);
        return t > 0 && t < min ? t : min;
      }, Infinity);
      if (!Number.isFinite(oldest)) break;
      const nextTo = oldest - 1;             // 闭区间，减 1 避免重复取到同一条
      if (nextTo <= from) break;             // 已经翻到游标底
      if (to && nextTo >= to) break;         // 没推进（服务端忽略 to）→ 防死循环
      to = nextTo;
    }
    return collected;
  }

  _mapFill(row) {
    const orderId = row.orderId ?? row.order_id ?? row.id;
    if (!orderId) return null;
    const price = Number(row.price ?? row.fillPrice ?? 0);
    // 成交行可能用 size（标准）也可能只给 filledSize；remainingSize 在成交后通常是 0，
    // 绝不能当成交数量用，否则整笔成交会被判成 0 而丢弃。
    const size = Number(row.size ?? row.filledSize ?? row.quantity ?? row.qty ?? 0);
    if (!(price > 0) || !(size > 0)) return null;
    const rawSide = String(row.side ?? row.orderSide ?? '').toUpperCase();
    const side = rawSide === 'BUY' || rawSide === '0' ? 'buy'
      : (rawSide === 'SELL' || rawSide === '1' ? 'sell'
        : (Number(row.size) < 0 ? 'sell' : 'buy'));
    const closing = row.reduceOnly === true || row.reduce_only === true;
    return {
      orderId: String(orderId),
      clientOrderId: row.clientId ?? row.clientOrderId ?? null,
      marketId: Number(row.marketId ?? row.market_id ?? 0),
      side,
      price,
      sizeBase: Math.abs(size),
      reduceOnly: closing,
      role: String(row.role ?? row.liquidity ?? ''),
      fee: Number(row.fee ?? 0),
      createdAt: normalizeEpochMs(row.createdAt ?? row.time ?? row.timestamp),
      // 原始时间戳（µs）保留给幂等键：毫秒版会把同毫秒的两笔部分成交判成同一笔。
      rawTs: rawFillTs(row),
      raw: row,
    };
  }

  // ── 账户与持仓 ──────────────────────────────────────────────────────────

  async _refreshAccount() {
    const [acct, pos] = await Promise.all([
      this._retry(() => this._http('GET', '/v1/account', {
        query: { address: this.address, accountIndex: String(this.accountIndex) }, weight: 2,
      }), { tag: 'account' }).catch((e) => {
        // 新账户未入金时官方返回 404 "no activity yet"，不是故障
        if (e.status === 404) return null;
        throw e;
      }),
      this._retry(() => this._http('GET', '/v1/positions', {
        query: { address: this.address, accountIndex: String(this.accountIndex) }, weight: 2,
      }), { tag: 'positions' }).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
    ]);

    if (acct) {
      const a = parseAccount(acct);
      if (a.equity != null) this.equity = a.equity;
      if (a.balance != null) this.balance = a.balance;
      if (Number.isFinite(Number(acct?.realizedPnl))) this.realizedPnl = Number(acct.realizedPnl);
      this.dataSource = 'real';
    }
    if (pos) {
      const rows = parsePositions(pos);
      this._pos.clear();
      for (const p of rows) if (p.marketId) this._pos.set(p.marketId, p);
    }
  }

  /**
   * 同步读持仓缓存。
   * bot.js 里 `const pos = this.ex.getPosition?.(marketId)` 是**同步调用**
   * （止损、破界离场、面板都靠它）：这里若返回 Promise，`pos.sizeBase` 恒为
   * undefined → 硬止损永远不触发、面板持仓恒空。缓存由 ACCOUNT_POLL_MS(5s)
   * 的账户轮询维护，时效足够。
   */
  getPosition(marketId) {
    return this._pos.get(Number(marketId)) || null;
  }

  /** 需要"此刻一定是最新"的场景（平仓、人工核对）用这个。 */
  async getPositionFresh(marketId) {
    await this._refreshAccount().catch(() => {});
    return this.getPosition(marketId);
  }

  // ── 交易写入 ────────────────────────────────────────────────────────────

  async setLeverage(marketId, x) {
    const m = this._market(marketId);
    const lev = Math.max(1, Math.min(Math.round(Number(x) || 1), m.maxLeverage));
    const body = { address: this.address, accountIndex: this.accountIndex, marketId: Number(marketId), leverage: lev };
    const ts = this._nowNs();
    const headers = this._signScheme2('setLeverage', body, ts);
    const j = await this._http('POST', '/v1/setLeverage', { body, headers, weight: 125 });
    return j;
  }

  /**
   * 挂限价单。默认 ALO（post-only）：
   *   - maker 0 ppm，taker 22.5bps；一次吃单等于抹掉 3.7 格利润。
   *   - 全 ALO 批量跳过 50ms taker speed bump。
   * reduce-only 平仓腿同样用 ALO（官方已允许 reduceOnly 不配 IOC）。
   */
  async placeLimitOrder(o) {
    const mId = Number(o.marketId);
    const m = this._market(mId);
    if (!m.tradable) throw new Error(`市场 ${m.symbol} 不可用：${m.untradableReason}`);

    const px = roundToUnit(o.price, m.stepPrice);
    const qty = roundToUnit(o.sizeBase, m.stepSize);
    if (qty.units <= 0n) throw new Error(`下单数量 ${o.sizeBase} 小于步长 ${m.stepSize}。`);
    const notional = Number(px.text) * Number(qty.text);
    if (m.minOrderNotional && notional < m.minOrderNotional * 0.999) {
      throw new Error(`名义额 $${notional.toFixed(4)} 低于最小下单额 $${m.minOrderNotional}。`);
    }

    const ts = this._nowNs();
    const tif = o.postOnly === false ? TIF_IOC : TIF_ALO;
    const goodTilUs = BigInt(Date.now() + GOOD_TIL_MS) * 1000n;   // µs
    const clientId = o.clientOrderId ? String(o.clientOrderId) : '';
    const sideInt = o.side === 'buy' ? SIDE_BUY : SIDE_SELL;

    const payload = this._payload1({
      ad: this.address, ai: this.accountIndex,
      ...(clientId ? { c: clientId } : {}),
      ct: ts, g: goodTilUs * 1000n, m: mId, op: OP_PLACE,
      p: px.units, q: qty.units, r: o.reduceOnly ? 1 : 0, s: sideInt, t: tif, v: 1,
    });
    const headers = this._headers(payload, ts);

    const body = {
      address: this.address, accountIndex: this.accountIndex, marketId: mId,
      orderSide: o.side === 'buy' ? 'BUY' : 'SELL', orderType: 'LIMIT',
      quantity: qty.text, price: px.text, timeInForce: tif === TIF_ALO ? 'ALO' : 'IOC',
      reduceOnly: !!o.reduceOnly, goodTilTime: String(goodTilUs), timestamp: String(ts),
      ...(clientId ? { clientId } : {}),
    };

    let j;
    try {
      j = await this._http('POST', `/v1/placeOrder?address=${this.address}`, { body, headers, timeoutMs: 20_000 });
    } catch (e) {
      if (e.transmission) throw Object.assign(new Error(`${e.message}（传输层未达引擎，可安全重发）`), { transmission: true });
      throw e;
    }
    const orderId = j?.orderId ? String(j.orderId) : (j?.result?.orderId ? String(j.result.orderId) : null);
    if (!orderId) throw new Error(`下单未返回 orderId：${JSON.stringify(j).slice(0, 160)}`);
    this._tracked.set(orderId, {
      marketId: mId, levelIndex: o.levelIndex, side: o.side, price: Number(px.text),
      sizeBase: Number(qty.text), reduceOnly: !!o.reduceOnly, placedAt: Date.now(), seen: false,
      clientOrderId: clientId || null,
    });
    this._watch.add(mId);
    return { orderId, status: j?.status || 'ACK', clientOrderId: clientId || null };
  }

  async cancelOrder(marketId, orderId) {
    const mId = Number(marketId);
    const ts = this._nowNs();
    const payload = this._payload1({
      ad: this.address, ai: this.accountIndex, ct: ts, id: String(orderId), m: mId, op: OP_CANCEL, v: 1,
    });
    const body = { address: this.address, accountIndex: this.accountIndex, marketId: mId, orderId: String(orderId), timestamp: String(ts) };
    try {
      const j = await this._http('POST', `/v1/cancelOrder?address=${this.address}`, {
        body, headers: this._headers(payload, ts), timeoutMs: 15_000,
      });
      return j;
    } catch (e) {
      // 已消失/已成交的撤单不算失败：下一轮对账会确认
      if (e.status === 404 || /not found|already/i.test(e.message)) {
        logger.warn('ar', `撤单目标不存在（视为已成交/已撤）：${orderId}`);
        return { status: 'GONE' };
      }
      throw e;
    }
  }

  /** 批量撤单：每个元素单独签名，共享一个 X-Timestamp；头里的 X-Signature 放任意一张。 */
  async cancelOrders(marketId, orderIds = []) {
    const mId = Number(marketId);
    const ids = orderIds.map(String).filter(Boolean);
    if (!ids.length) return 0;
    let canceled = 0;
    for (let i = 0; i < ids.length; i += CANCEL_BATCH) {
      const chunk = ids.slice(i, i + CANCEL_BATCH);
      const ts = this._nowNs();
      const cancels = chunk.map((id) => {
        const payload = this._payload1({
          ad: this.address, ai: this.accountIndex, ct: ts, id, m: mId, op: OP_CANCEL, v: 1,
        });
        return {
          address: this.address, accountIndex: this.accountIndex, marketId: mId,
          orderId: id, timestamp: String(ts), signature: signMessage(this._key, payload),
        };
      });
      const headers = { ...this._headers(cancels[0].signature, ts) };
      try {
        await this._http('POST', `/v1/batchCancelOrders?address=${this.address}`, {
          body: { cancels }, headers, timeoutMs: 25_000,
        });
        canceled += chunk.length;
      } catch (e) {
        logger.warn('ar', `批量撤单失败（${chunk.length} 张，回退逐张）：${e.message}`);
        for (const id of chunk) {
          try { await this.cancelOrder(mId, id); canceled += 1; } catch { /* 留待对账 */ }
        }
      }
    }
    // 批量撤单是 202 ACK：接口确认"已转发"，不等于引擎已撤。必须轮询消失再
    // 回报，否则调用方（bot 的 _cancelAllConfirmed）会以为撤完，接着在旧单
    // 之上重铺，形成同档双单。轮询用 400ms/1.2s 两次，权重 20×2 可接受。
    if (canceled > 0) {
      const want = new Set(ids.map(String));
      for (const wait of [400, 1200]) {
        await new Promise((r) => setTimeout(r, wait));
        let still;
        try { still = await this.fetchOpenOrders(mId); } catch { return canceled; }
        const left = still.filter((o) => want.has(String(o.orderId))).length;
        canceled = ids.length - left;
        if (left === 0) break;
      }
    }
    return canceled;
  }

  /** 契约 cancelAll：按市场过滤后批量撤，绝不动别的市场的单。 */
  async cancelAll(marketId) {
    const mId = Number(marketId);
    const open = await this.fetchOpenOrders(mId).catch(() => []);
    const ids = open.filter((o) => !mId || Number(o.marketId) === mId).map((o) => o.orderId);
    if (!ids.length) return { canceled: 0 };
    const canceled = await this.cancelOrders(mId, ids);
    return { canceled };
  }

  /**
   * 账户级全撤：只给 panic / stop 用。
   * 交易所固定扣 cancel 池 100 权重（本地 weight 记 0，因为它不吃 IP 桶），
   * 给 marketId 时改走批量撤，避免误伤其它市场也省池子。
   */
  async cancelAllAccount({ marketId } = {}) {
    if (marketId != null) return this.cancelAll(marketId);
    const body = { address: this.address, accountIndex: this.accountIndex, marketId: null };
    const ts = this._nowNs();
    const headers = this._signScheme2('cancelAllOrders', body, ts);
    await this._http('POST', '/v1/cancelAllOrders', { body, headers, weight: 0, timeoutMs: 20_000 });
    return { canceled: 'all' };
  }

  async fetchOpenOrders(marketId) {
    const m = this._market(marketId);
    const j = await this._retry(() => this._http('GET', '/v1/openOrders', {
      query: { address: this.address, accountIndex: String(this.accountIndex), market: m.symbol, status: 'OPEN' },
      weight: 20,
    }), { tag: 'openOrders' });
    // 解析整包：`/v1/openOrders` 回的是 { orders: [...] } 信封。逐行喂给
    // parseOpenOrder 会因「行对象里没有 orders 键」被误判为空包，导致
    // 127 张在簿单被读成 0 张（D1 探针抓到的假「ACK 后不可见」）。
    let parsed;
    try { parsed = parseOpenOrders(j); } catch (e) { logger.warn('ar', e.message); parsed = []; }
    const out = [];
    for (const o of parsed) {
      // 只认本市场（服务端已过滤，客户端再兜一层）
      if (o.marketId && Number(o.marketId) !== Number(marketId)) continue;
      const t = this._tracked.get(o.orderId);
      if (t) t.seen = true;
      out.push({ ...o, marketId: Number(marketId) });
    }
    return out;
  }

  /**
   * 契约 adoptOrder：bot 对账时把"交易所上还在、本地丢了跟踪"的单接回来。
   * 不重新下单，只补本地 _tracked，使后续 fills 归集与撤单能落到这一档。
   */
  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    const oid = String(orderId);
    if (!oid) return false;
    this._tracked.set(oid, {
      marketId: Number(marketId),
      levelIndex,
      side: side === 'buy' ? 'buy' : 'sell',
      price: Number(price),
      sizeBase: Number(sizeBase),
      placedAt: Date.now(),
      seen: true,
      adopted: true,
      clientOrderId: null,
    });
    this._watch.add(Number(marketId));
    return true;
  }

  /** 市价平仓：IOC 限价（官方要求 MARKET 必须配 IOC，且价差不得超 mark ±10%）。 */
  async closePosition(marketId) {
    const mId = Number(marketId);
    // 平仓前必须现读账户：缓存可能是冷的（init 那次刷新失败就一直是空的），
    // 拿 null 直接 return true 会让调用方以为平掉了，实际是把仓位裸着留在那里。
    await this._refreshAccount();
    const pos = this._pos.get(mId) || null;
    if (!pos || !pos.sizeBase) return true;
    const m = this._market(mId);
    const size = Math.abs(pos.sizeBase);
    const side = pos.sizeBase > 0 ? 'sell' : 'buy';
    // 参考价必须是盘口对手价：测试网盘口能宽到 6%（71k 挂单 / 81.5k 标记），
    // 用 mid±2% 的 IOC 根本碰不到对手价，只会白撤两轮然后报"未完成"。
    let book = null;
    try { book = await this._fetchBook(mId); } catch { /* 退化到缓存 mid */ }
    for (const slip of [0.002, 0.01, 0.03]) {
      const ref = (side === 'sell' ? book?.bid : book?.ask)
        || this._prices.get(mId) || m.lastPrice || pos.entryPrice;
      const raw = side === 'sell' ? ref * (1 - slip) : ref * (1 + slip);
      const px = roundToUnit(raw, m.stepPrice);
      const qty = roundToUnit(size, m.stepSize);
      const ts = this._nowNs();
      const goodTilUs = BigInt(Date.now() + GOOD_TIL_MS) * 1000n;
      const payload = this._payload1({
        ad: this.address, ai: this.accountIndex, ct: ts, g: goodTilUs * 1000n, m: mId, op: OP_PLACE,
        p: px.units, q: qty.units, r: 1, s: side === 'buy' ? SIDE_BUY : SIDE_SELL, t: TIF_IOC, v: 1,
      });
      const body = {
        address: this.address, accountIndex: this.accountIndex, marketId: mId,
        orderSide: side === 'buy' ? 'BUY' : 'SELL', orderType: 'LIMIT', quantity: qty.text, price: px.text,
        timeInForce: 'IOC', reduceOnly: true, goodTilTime: String(goodTilUs), timestamp: String(ts),
      };
      await this._http('POST', `/v1/placeOrder?address=${this.address}`, {
        body, headers: this._headers(payload, ts), timeoutMs: 20_000,
      }).catch((e) => { logger.warn('ar', `平仓下单失败：${e.message}`); });
      await new Promise((r) => setTimeout(r, 1500));
      await this._refreshAccount().catch(() => {});
      const after = this._pos.get(mId) || null;
      if (!after || Math.abs(after.sizeBase) < Number(m.stepSize)) return true;
    }
    throw new Error('Arcus 平仓未完成（三轮 IOC 后仍有持仓），请人工介入。');
  }

  // ── 死手开关（Arcus 无断线撤单，必须自己兜底）──────────────────────────

  _startDms() {
    if (this._timers.dms) clearInterval(this._timers.dms);
    this._armDms().catch((e) => logger.warn('ar', `死手开关武装失败：${e.message}`));
    this._timers.dms = setInterval(() => {
      this._dmsTick().catch((e) => logger.warn('ar', `死手开关续期失败：${e.message}`));
    }, DMS_REFRESH_MS);
  }

  /**
   * 每轮续期前先判断上一轮 deadline 是否已经过去了：过去了说明我们这段时间
   * 没续上（进程卡死 / 网络断 / GC 停顿），交易所已按约把挂单全部撤掉。
   * 这件事消耗官方每日 10 次配额，且此刻梯子是裸的 —— 必须计数并升级成
   * operationalIssue，不能只留在日志里。配额耗尽后重启的进程将失去自动撤单保护。
   */
  async _dmsTick() {
    const now = Date.now();
    if (this._dmsDeadlineMs && now > this._dmsDeadlineMs + DMS_TRIGGER_GRACE_MS) {
      this._dmsTriggers.push(this._dmsDeadlineMs);
      this._pruneDmsWindow();
      logger.error('ar', `死手开关已触发：deadline 过后仍未续期，全部挂单已被交易所撤销（今日第 ${this._dmsTriggers.length}/${DMS_TRIGGER_QUOTA} 次）`);
      if (this._dmsTriggers.length >= DMS_TRIGGER_QUOTA) {
        this.operationalIssue = {
          title: '死手开关配额耗尽',
          message: `24 小时内已触发 ${this._dmsTriggers.length} 次自动撤单（上限 ${DMS_TRIGGER_QUOTA}）。配额用尽后进程再崩，挂单将无人兜底 —— 先查明崩溃原因，别急着重启。`,
        };
      }
      // 已计入配额，清零避免下一轮把同一次触发再数一遍。
      this._dmsDeadlineMs = 0;
    }
    // 不能先清零再续期：续期失败时交易所侧的旧 deadline 还在走表，本地归零就
    // 永远识别不到那次真触发（配额少算一类）。成功时 _armDms 自己覆盖，失败时
    // 保留旧值让下一轮 tick 补判。
    //
    // 2026-10-24 12:47 实测：网络劣化时单次续期可能被底层重试拖住好几分钟，
    // 期间没有任何"续期失败"日志，deadline 静默过期、交易所把 132 单全撤。
    // 这里给续期加 20 秒硬上限，卡住就进 catch，让下一轮 tick 重新发起。
    try {
      await Promise.race([
        this._armDms(),
        new Promise((_, rej) => {
          const t = setTimeout(() => rej(new Error('死手续期超时（20s）')), 20_000);
          t.unref?.();
        }),
      ]);
      this._dmsFailStreak = 0;
      this._dmsLastOkAt = Date.now();
      this._dmsQuickRetries = 0;
    } catch (e) {
      this._dmsFailStreak = (this._dmsFailStreak || 0) + 1;
      const left = this._dmsDeadlineMs ? this._dmsDeadlineMs - Date.now() : null;
      // 连续失败且剩余不足 60 秒 = 马上要被交易所撤单，必须升级成告警（不能只写日志）。
      if (this._dmsFailStreak >= 2 && left != null && left < 60_000) {
        logger.error('ar', `死手续期连续失败 ${this._dmsFailStreak} 次，剩余 ${Math.round(left / 1000)}s，超时将被交易所撤光挂单：${e.message}`);
      }
      // 2026-10-25 13:33 实测：单次失败后要等满 20~30 秒才重试，网络抖动叠加上超时就把
      // 4 分钟 deadline 磨光，交易所把挂单全撤。失败即快速重试（3 秒），最多连追 5 次。
      this._dmsQuickRetries = (this._dmsQuickRetries || 0) + 1;
      if (this._dmsQuickRetries <= 5 && !this._stopping) {
        if (this._dmsRetryTimer) clearTimeout(this._dmsRetryTimer);
        this._dmsRetryTimer = setTimeout(() => {
          this._dmsRetryTimer = null;
          this._dmsTick().catch(() => {});
        }, 3_000);
        this._dmsRetryTimer.unref?.();
      }
      throw e;
    }
  }

  _pruneDmsWindow() {
    const floor = Date.now() - DMS_QUOTA_WINDOW_MS;
    this._dmsArms = this._dmsArms.filter((t) => t >= floor);
    this._dmsTriggers = this._dmsTriggers.filter((t) => t >= floor);
  }

  /**
   * deadline 4 分钟、每 60s 续期。进程若死，最迟 4 分钟后交易所自动撤掉全部挂单。
   * 注意：自动触发每日上限 10 次（官方配额），反复崩溃会耗尽——这本身就是告警信号。
   */
  async _armDms(marketId = null) {
    const deadlineMs = Date.now() + DMS_DEADLINE_MS;
    const body = {
      address: this.address, accountIndex: this.accountIndex,
      // 官方示例为 unquoted number；µs 时间戳（~1.79e15）远小于 2^53，用 Number 不会丢精度。
      // 签的是 canonical JSON(body)，用字符串会被服务端按 number 序列化后校验失败。
      time: deadlineMs * 1000,
      ...(marketId != null ? { marketId } : {}),
    };
    const ts = this._nowNs();
    const headers = this._signScheme2('scheduleCancel', body, ts);
    try {
      await this._http('POST', '/v1/scheduleCancel', { body, headers, weight: 0, timeoutMs: 10_000 });
    } catch (e) {
      if (/quota|limit|exceed|daily/i.test(e.message || '')) {
        this._dmsQuotaRejectedAt = Date.now();
        this.operationalIssue = {
          title: '死手开关被拒',
          message: `交易所拒绝续期（疑似配额用尽）：${e.message}。挂单已无自动撤单保护，请立刻人工介入。`,
        };
      }
      throw e;
    }
    this._dmsArmedAt = Date.now();
    this._dmsDeadlineMs = deadlineMs;
    this._dmsArms.push(this._dmsArmedAt);
    this._pruneDmsWindow();
    return true;
  }

  async disarmDms() {
    const body = { address: this.address, accountIndex: this.accountIndex };
    const ts = this._nowNs();
    const headers = this._signScheme2('scheduleCancel', body, ts);
    await this._http('POST', '/v1/scheduleCancel', { body, headers, weight: 0, timeoutMs: 10_000 });
    this._dmsDeadlineMs = 0;
    return true;
  }

  // ── 签名 ────────────────────────────────────────────────────────────────

  /** Scheme 1：类型化载荷（键固定排序，整数字段，无 timestamp/action 前缀）。 */
  _payload1(fields) {
    const o = {};
    if (fields.ad) o.ad = String(fields.ad).toLowerCase();
    if (fields.ai !== undefined) o.ai = Number(fields.ai);
    if (fields.c) o.c = String(fields.c);
    if (fields.ct !== undefined) o.ct = BigInt(fields.ct);
    if (fields.g !== undefined) o.g = BigInt(fields.g);
    if (fields.id) o.id = String(fields.id);
    if (fields.m !== undefined) o.m = Number(fields.m);
    o.op = Number(fields.op);
    if (fields.p !== undefined) o.p = BigInt(fields.p);
    if (fields.q !== undefined) o.q = BigInt(fields.q);
    if (fields.r !== undefined) o.r = Number(fields.r);
    if (fields.s !== undefined) o.s = Number(fields.s);
    if (fields.t !== undefined) o.t = Number(fields.t);
    o.v = Number(fields.v || 1);
    return canonicalJson(o);
  }

  _headers(payload, ts, explicitSignature) {
    return {
      'X-API-Key': this._apiKeyHex,
      'X-Timestamp': String(ts),
      'X-Signature': explicitSignature || signMessage(this._key, payload),
    };
  }

  /** Scheme 2：timestamp + action + canonical body。 */
  _signScheme2(action, body, ts) {
    const payload = `${ts}${action}${canonicalJson(body)}`;
    return this._headers(payload, ts);
  }

  // ── 供 bot 使用的展示字段 ───────────────────────────────────────────────

  get displayFeeRate() { return this.feeRate; }

  /** 健康快照（供 /api 面板与 AI 哨兵）。 */
  health() {
    const now = Date.now();
    // 未跟踪成交告警自愈：碎单/历史噪声不该让 health 永远红（旧版一旦置上就再也不清）。
    if (this.operationalIssue?.title === 'Arcus 出现未跟踪成交'
      && this._untrackedAt && now - this._untrackedAt > UNTRACKED_TTL_MS) {
      logger.info('ar', '未跟踪成交告警已静默超过 30 分钟，自动清除');
      this.operationalIssue = null;
    }
    return {
      mode: this.mode,
      network: this.network,
      apiUrl: this.apiUrl,
      wsReady: this._wsReady,
      wsDegraded: this._wsDegraded?.reason || null,
      lastOkAgeMs: this.lastOkAt ? now - this.lastOkAt : null,
      lastFillPollAgeMs: this._lastFillPollAt ? now - this._lastFillPollAt : null,
      clockSkewMs: this.clockSkewMs,
      dmsDeadlineInMs: this._dmsDeadlineMs ? this._dmsDeadlineMs - now : null,
      // 死手开关的健康面：续期次数（不耗配额）与已触发次数（吃每日 10 次配额）。
      // 触发次数到顶 = 下一次崩溃就没有自动撤单兜底了，属于运营级告警。
      dms: {
        arms24h: this._dmsArms.length,
        triggers24h: this._dmsTriggers.length,
        triggerQuota: DMS_TRIGGER_QUOTA,
        quotaExhausted: this._dmsTriggers.length >= DMS_TRIGGER_QUOTA,
        lastQuotaRejectionAt: this._dmsQuotaRejectedAt || null,
        overdueMs: this._dmsDeadlineMs ? Math.max(0, now - this._dmsDeadlineMs) : 0,
      },
      trackedOrders: this._tracked.size,
      feeRate: this.feeRate,
      operationalIssue: this.operationalIssue,
    };
  }
}
