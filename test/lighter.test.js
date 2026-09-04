import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { GridBot } from '../src/bot.js';
import { LighterExchange } from '../src/exchange/lr/lighter.js';
import { LighterSignerBridge } from '../src/exchange/lr/signer.js';
import {
  makeClientOrderIndex, parseCandles, parseMarkets,
  RHC_CHAIN_ID, RHC_MAX_CLIENT_ORDER_INDEX,
} from '../src/exchange/lr/market.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function marketPayload() {
  return {
    code: 200,
    order_book_details: [
      { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', supported_size_decimals: 5, supported_price_decimals: 1, min_base_amount: '0.0001', min_quote_amount: '1', min_initial_margin_fraction: 200, last_trade_price: 65000, maker_fee: '0.0001', taker_fee: '0.0004', open_interest: 100 },
      { symbol: 'ETH', market_id: 0, market_type: 'perp', status: 'active', supported_size_decimals: 4, supported_price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '1', min_initial_margin_fraction: 400, last_trade_price: 3000, maker_fee: '0.0001', taker_fee: '0.0004', open_interest: 50 },
      { symbol: 'OLD', market_id: 7, market_type: 'perp', status: 'inactive', supported_size_decimals: 2, supported_price_decimals: 2 },
      { symbol: 'SPOT', market_id: 2048, market_type: 'spot', status: 'active', supported_size_decimals: 4, supported_price_decimals: 2 },
    ],
  };
}

{
  const markets = parseMarkets(marketPayload());
  assert.deepEqual(markets.map((m) => m.displayName), ['BTC-USD', 'ETH-USD']);
  assert.equal(markets[0].stepSize, 0.00001);
  assert.equal(markets[0].stepPrice, 0.1);
  assert.equal(markets[0].maxLeverage, 50);
}

{
  const seconds = 1_786_680_000;
  const milliseconds = seconds * 1000;
  const candles = parseCandles({ c: [
    { t: seconds, o: 1, h: 2, l: 0.5, c: 1.5 },
    { t: milliseconds + 1000, o: 2, h: 3, l: 1, c: 2.5 },
  ] });
  assert.deepEqual(candles.map((c) => c.time), [milliseconds, milliseconds + 1000]);
  assert.equal(new Date(candles[0].time).getUTCFullYear(), 2026);
}

{
  const ids = Array.from({ length: 100 }, (_, index) => makeClientOrderIndex(index));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => Number.isSafeInteger(id) && id >= 0 && id <= RHC_MAX_CLIENT_ORDER_INDEX));
}

{
  const ex = new LighterExchange({
    accountIndex: 12,
    apiKeyIndex: 4,
    apiPrivateKey: 'test-only',
    signer: { start: async () => true, stop: async () => true, request: async () => ({}) },
  });
  ex._get = async () => ({
    code: 200,
    total: 1,
    accounts: [{
      index: 12,
      available_balance: '490.25',
      collateral: '500',
      total_asset_value: '503.75',
      positions: [{
        market_id: 1,
        sign: -1,
        position: '0.002',
        avg_entry_price: '65000',
        unrealized_pnl: '3.75',
        realized_pnl: '1.25',
        liquidation_price: '78000',
        initial_margin_fraction: '3333',
        margin_mode: 0,
      }],
    }],
  });
  await ex._refreshAccount();
  assert.equal(ex.balance, 490.25);
  assert.equal(ex.equity, 503.75);
  assert.deepEqual(ex.getPosition(1), {
    sizeBase: -0.002,
    entryPrice: 65000,
    unrealizedPnl: 3.75,
    realizedPnl: 1.25,
    liquidationPrice: 78000,
    leverage: 3,
    marginMode: 'cross',
  });
  assert.equal(ex.realizedPnl, null, 'an open position row is not authoritative account realised PnL');
}

{
  const ex = new LighterExchange({
    accountIndex: 12,
    apiKeyIndex: 4,
    apiPrivateKey: 'test-only',
    signer: { start: async () => true, stop: async () => true, request: async () => ({}) },
  });
  ex._accountUnrealizedPnl = -1.25;
  ex._authorization = async () => 'test-auth';
  ex._get = async (path, headers) => {
    assert.match(path, /^\/api\/v1\/pnl\?/);
    assert.match(path, /ignore_transfers=false/);
    assert.equal(headers.authorization, 'test-auth');
    return {
      code: 200,
      pnl: [
        { timestamp: 100, trade_pnl: 7.5, inflow: 500, outflow: 0 },
        { timestamp: 200, trade_pnl: 8.8, inflow: 500, outflow: 0 },
      ],
    };
  };
  assert.equal(await ex._refreshPnl(true), true);
  assert.equal(ex.accountTotalPnl, 8.8);
  assert.equal(ex.realizedPnl, 10.05, 'realised = transfer-adjusted total - current unrealised');

  ex._get = async () => { throw new Error('temporary pnl outage'); };
  assert.equal(await ex._refreshPnl(true), false);
  assert.equal(ex.accountTotalPnl, 8.8, 'a transient failure must preserve the last valid total');
  assert.equal(ex.realizedPnl, 10.05, 'a transient failure must preserve the last valid realised value');
  assert.equal(ex.lastPnlError, 'temporary pnl outage');
}

{
  const calls = [];
  const signer = {
    start: async () => true,
    stop: async () => true,
    request: async (command, payload = {}) => {
      calls.push({ command, payload });
      if (command === 'health') return { profile: 'robinhood', chainId: RHC_CHAIN_ID };
      if (command === 'auth') return { token: 'test-auth', expiresIn: 480 };
      if (command === 'sign_orders') return { transactions: payload.orders.map((o) => ({ txType: 14, txInfo: JSON.stringify(o), txHash: `h-${o.clientOrderIndex}` })) };
      return { txType: 99, txInfo: '{}', txHash: 'h-control' };
    },
  };
  const ex = new LighterExchange({ accountIndex: 12, apiKeyIndex: 4, apiPrivateKey: 'test-only', signer });
  assert.equal(ex.supportsSafeOpeningRetry, true);
  assert.equal(ex.orderBatchSize, 15);
  assert.equal(ex.orderBatchPaceMs, 1500);
  assert.equal(ex.openingRetryBaseMs, 5_000);
  const markets = parseMarkets(marketPayload()); ex.markets = new Map(markets.map((m) => [m.marketId, m]));
  await assert.rejects(() => ex.placeLimitOrders([
    { marketId: 1, side: 'buy', price: 65000, sizeBase: 0.001, levelIndex: 0, clientOrderId: 100 },
  ]), /实盘鉴权和账户快照尚未完整通过/);
  assert.equal(calls.length, 0);
  ex.dataSource = 'real'; ex._tradingReady = true;
  let rejectedIds = new Set();
  ex._confirmAccepted = async () => rejectedIds;

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/nextNonce')) return response({ code: 200, nonce: 77 });
    if (String(url).includes('/sendTxBatch')) return response({ code: 200, tx_hash: ['a', 'b'] });
    if (String(url).includes('/sendTx')) return response({ code: 200, tx_hash: 'a' });
    throw new Error('unexpected URL ' + url);
  };
  try {
    const placed = await ex.placeLimitOrders([
      { marketId: 1, side: 'buy', price: 64999.94, sizeBase: 0.001239, levelIndex: 1, clientOrderId: 101 },
      { marketId: 1, side: 'sell', price: 65100.06, sizeBase: 0.002349, levelIndex: 2, clientOrderId: 102 },
    ]);
    assert.deepEqual(placed.map((x) => x.orderId), ['101', '102']);
    const signed = calls.find((x) => x.command === 'sign_orders').payload.orders;
    assert.deepEqual(signed.map((x) => x.nonce), [77, 78]);
    assert.equal(signed[0].baseAmount, 123);
    assert.equal(signed[0].price, 649999);
    assert.equal(signed[0].orderType, 0);
    assert.equal(signed[0].timeInForce, 1);
    assert.equal(requests.filter((x) => x.url.includes('/sendTxBatch')).length, 1);
    assert.equal(typeof ex.withdraw, 'undefined');
    assert.equal(typeof ex.transfer, 'undefined');
    assert.equal(typeof LighterSignerBridge.prototype.withdraw, 'undefined');
    rejectedIds = new Set(['103']);
    const rejected = await ex.placeLimitOrders([
      { marketId: 1, side: 'buy', price: 64000, sizeBase: 0.001, levelIndex: 3, clientOrderId: 103 },
    ]);
    assert.deepEqual(rejected, [null]);
    assert.equal(ex.getOpenOrders(1).some((o) => o.orderId === '103'), false);
    rejectedIds = new Set();
    await ex.placeLimitOrder({
      marketId: 1,
      side: 'sell',
      price: 61750,
      sizeBase: 0.001,
      levelIndex: -1,
      clientOrderId: 104,
      reduceOnly: true,
      immediate: true,
    });
    const immediate = calls.filter((x) => x.command === 'sign_orders').at(-1).payload.orders[0];
    assert.equal(immediate.orderType, 1);
    assert.equal(immediate.timeInForce, 0);
    assert.equal(immediate.orderExpiry, 0);
    assert.equal(immediate.reduceOnly, true);
    await ex.placeLimitOrder({
      marketId: 1,
      side: 'sell',
      price: 61750,
      sizeBase: 0.001,
      levelIndex: -1,
      clientOrderId: Number.MAX_SAFE_INTEGER,
      reduceOnly: true,
      immediate: true,
    });
    const bounded = calls.filter((x) => x.command === 'sign_orders').at(-1).payload.orders[0].clientOrderIndex;
    assert.ok(bounded >= 0 && bounded <= RHC_MAX_CLIENT_ORDER_INDEX);
    ex._prices.set(1, 65000);
    ex._positions.set(1, { sizeBase: -0.001, entryPrice: 65100 });
    await ex.closePosition(1);
    const closeOrder = calls.filter((x) => x.command === 'sign_orders').at(-1).payload.orders[0];
    assert.ok(closeOrder.clientOrderIndex >= 0 && closeOrder.clientOrderIndex <= RHC_MAX_CLIENT_ORDER_INDEX);
    assert.equal(closeOrder.reduceOnly, true);
    assert.equal(closeOrder.orderType, 1);
    await assert.rejects(() => ex.placeLimitOrders(new Array(16).fill({ marketId: 1 })), /1-15/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const ex = new LighterExchange({
    accountIndex: 12,
    apiKeyIndex: 4,
    apiPrivateKey: 'test-only',
    signer: { start: async () => true, stop: async () => true, request: async () => ({}) },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({ message: 'rate limited' }, 405);
  try {
    await assert.rejects(
      () => ex._postForm('/api/v1/sendTx', { tx_type: 1, tx_info: '{}' }),
      (error) => error.status === 405 && error.rateLimited === true && error.retryAfterMs === 5_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const ex = new LighterExchange({
    accountIndex: 12,
    apiKeyIndex: 4,
    apiPrivateKey: 'test-only',
    signer: { start: async () => true, stop: async () => true, request: async () => ({}) },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({ message: 'slow down' }, 429, '3');
  try {
    await assert.rejects(
      () => ex._postForm('/api/v1/sendTx', { tx_type: 1, tx_info: '{}' }),
      (error) => error.status === 429 && error.rateLimited === true && error.retryAfterMs === 3000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const ex = new LighterExchange({
    accountIndex: 12,
    apiKeyIndex: 4,
    apiPrivateKey: 'test-only',
    signer: { start: async () => true, stop: async () => true, request: async () => ({}) },
  });
  const originalFetch = globalThis.fetch;
  const cause = new Error('Connect Timeout Error'); cause.code = 'UND_ERR_CONNECT_TIMEOUT';
  globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause }); };
  try {
    await assert.rejects(
      () => ex._get('/api/v1/orderBookDetails'),
      (error) => error.code === 'UND_ERR_CONNECT_TIMEOUT'
        && /无法连接 RHC 官方接口 api\.rh\.lighter\.xyz（连接超时）/.test(error.message)
        && /不是 API 密钥错误/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  class RetryExchange extends EventEmitter {
    constructor(realOrders) {
      super();
      this.mode = 'live';
      this.realOrders = realOrders;
      this.fetchCalls = 0;
      this.placeCalls = 0;
      this.supportsSafeOpeningRetry = true;
      this.orderBatchSize = 10;
      this.orderBatchPaceMs = 0;
      this.openingRetryBaseMs = 1;
      this.openingRetryMax = 3;
    }
    async fetchOpenOrders() { this.fetchCalls++; return this.realOrders; }
    adoptOrder(order) { this.adopted = order; }
    async placeLimitOrders(orders) {
      this.placeCalls++;
      return orders.map((o, i) => ({ orderId: `placed-${i}`, price: o.price, sizeBase: o.sizeBase }));
    }
  }

  const makeBot = (ex) => {
    const bot = new GridBot(ex);
    bot.running = true;
    bot.config = { marketId: 1, displayName: 'BTC-USD', mode: 'neutral', sizeBase: 1 };
    bot.grid = { levels: [100], spacing: 10, count: 1 };
    const order = { levelIndex: 0, side: 'buy', price: 100, sizeBase: 1, opening: true };
    const id = bot._beginPlacementProgress('start', [order]);
    bot._finishPlacementPass();
    bot._queueRetry({ ...order, _placementId: id }, new Error('rate limited'));
    bot._retryQueue[0]._nextAt = 0;
    return bot;
  };

  // If either authoritative snapshot contains the level, adopt it and never
  // replay the opening transaction.
  const occupiedEx = new RetryExchange([{ orderId: 'real-1', side: 'buy', price: 100, sizeBase: 1 }]);
  const occupiedBot = makeBot(occupiedEx);
  await occupiedBot._drainRetryQueue();
  assert.equal(occupiedEx.fetchCalls, 2);
  assert.equal(occupiedEx.placeCalls, 0);
  assert.equal(occupiedBot.active.has('real-1'), true);
  assert.equal(occupiedBot.getState().placementProgress.status, 'complete');

  // Only a level absent from both snapshots is submitted again.
  const emptyEx = new RetryExchange([]);
  const emptyBot = makeBot(emptyEx);
  await emptyBot._drainRetryQueue();
  assert.equal(emptyEx.fetchCalls, 2);
  assert.equal(emptyEx.placeCalls, 1);
  assert.equal(emptyBot.active.has('placed-0'), true);
  assert.equal(emptyBot.getState().placementProgress.status, 'complete');
}

{
  class SeedExchange extends EventEmitter {
    constructor() {
      super();
      this.mode = 'live';
      this.balance = 1_000_000;
      this.equity = 1_000_000;
      this.feeRate = 0.0001;
      this.orderBatchSize = 10;
      this.orderBatchPaceMs = 0;
      this.supportsSafeOpeningRetry = true;
      this.open = [];
      this.batchSizes = [];
      this.seq = 0;
    }
    async getMarkets() { return [{ marketId: 1, displayName: 'BTC-USD', minOrderSize: 0.001, maxLeverage: 50, stepSize: 0.001, stepPrice: 0.1 }]; }
    async setLeverage() { return true; }
    async cancelAll() { this.open = []; return true; }
    async fetchOpenOrders() { return this.open.map((o) => ({ ...o })); }
    forgetOrders() {}
    async getPrice() { return 100; }
    start() {}
    stop() {}
    getPosition() { return null; }
    async placeLimitOrders(orders) {
      this.batchSizes.push(orders.length);
      return orders.map((o) => {
        const result = { orderId: `seed-${++this.seq}`, price: o.price, sizeBase: o.sizeBase };
        this.open.push({ ...result, marketId: o.marketId, side: o.side });
        return result;
      });
    }
  }
  const ex = new SeedExchange();
  const bot = new GridBot(ex, { cancelVerifyAttempts: 2, cancelVerifyDelayMs: 0, cancelVerifyStableReads: 2 });
  const state = await bot.start({ marketId: 1, mode: 'neutral', lower: 60, upper: 140, gridCount: 80, sizeBase: 1, leverage: 3 });
  assert.equal(state.running, true);
  assert.equal(state.placementProgress.status, 'complete');
  assert.equal(state.placementProgress.confirmed, state.placementProgress.target);
  assert.equal(state.placementProgress.pending, 0);
  assert.ok(ex.batchSizes.length > 1);
  assert.ok(ex.batchSizes.every((size) => size <= 10));
  await bot.stop({ closePosition: false });
}

{
  class RateLimitedSeedExchange extends EventEmitter {
    constructor() {
      super();
      this.mode = 'live';
      this.orderBatchSize = 2;
      this.orderBatchPaceMs = 0;
      this.openingRetryBaseMs = 1000;
      this.openingRetryMax = 8;
      this.supportsSafeOpeningRetry = true;
      this.calls = 0;
    }
    async placeLimitOrders(orders) {
      this.calls++;
      if (this.calls === 2) {
        const error = new Error('rate limited');
        error.status = 429;
        error.rateLimited = true;
        error.retryAfterMs = 1000;
        throw error;
      }
      return orders.map((order, index) => ({ orderId: `ok-${index}`, price: order.price, sizeBase: order.sizeBase }));
    }
  }
  const ex = new RateLimitedSeedExchange();
  const bot = new GridBot(ex);
  bot.running = true;
  bot.config = { marketId: 1, displayName: 'BTC-USD', mode: 'neutral', sizeBase: 1 };
  bot.grid = { levels: [90, 100, 110, 120, 130, 140], spacing: 10, count: 6 };
  const orders = bot.grid.levels.map((price, levelIndex) => ({ levelIndex, side: 'buy', price, sizeBase: 1, opening: true }));
  const placementId = bot._beginPlacementProgress('start', orders);
  await bot._placeMany(orders.map((order) => ({ ...order, _placementId: placementId })));
  bot._finishPlacementPass();
  assert.equal(ex.calls, 2, 'rate limit must stop later batches from being sent immediately');
  assert.equal(bot._retryQueue.length, 4, 'failed and untouched levels must enter the safe retry queue');
  assert.ok(bot._retryQueue.every((order) => order._nextAt > Date.now()));
}

{
  const worker = fs.readFileSync(path.join(here, '..', 'src', 'exchange', 'lr', 'signer_worker.py'), 'utf8');
  assert.doesNotMatch(worker, /command\s*==\s*["'](?:withdraw|transfer|change_api_key)["']/);
}

{
  const launcher = fs.readFileSync(path.join(here, '..', 'scripts', 'windows-launcher.ps1'), 'utf8');
  // Windows PowerShell 5.1 strips embedded double quotes in a native
  // executable's arguments.  The portable-Python and SDK probes must remain
  // quote-free, otherwise every clean Windows install is falsely rejected.
  const pythonProbe = launcher.match(/\$probeCode = 'import struct,sys;([^']+)'/);
  const sdkProbe = launcher.match(/\$probeCode = 'import importlib\.metadata as m;([^']+)'/);
  assert.ok(pythonProbe, 'launcher includes a portable Python probe');
  assert.ok(sdkProbe, 'launcher includes an installed lighter-sdk probe');
  assert.doesNotMatch(pythonProbe[1], /["']/);
  assert.doesNotMatch(sdkProbe[1], /["']/);
  assert.match(launcher, /\[switch\]\$ForcePortableRuntime/);
  assert.match(launcher, /if \(-not \$ForcePortableRuntime\) \{\s*\$systemNode/);
  assert.match(launcher, /if \(\$ForcePortableRuntime\) \{\s*\$forcedPortable/);
}

console.log('lighter tests passed');

function response(data, status = 200, retryAfter = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => String(name).toLowerCase() === 'retry-after' ? retryAfter : null },
    text: async () => JSON.stringify(data),
  };
}

await (async () => {
  const ex = new LighterExchange({ accountIndex: 12, apiKeyIndex: 4, apiPrivateKey: 'test-only',
    signer: { start: async () => true, stop: async () => true, request: async () => ({}) } });
  ex.markets.set(1, { marketId: 1, name: 'BTC-USD', stepSize: 0.0001, stepPrice: 0.1 });
  ex._tracked.set('o-x', {
    orderId: 'o-x', marketId: 1, levelIndex: 5, side: 'sell', price: 81000, sizeBase: 0.0002,
    reduceOnly: false, placedAt: Date.now() - 120_000, seen: true,
    _crossedUp: true, _crossedDown: false, goneFirstAt: null,
  });
  ex._fetchActiveOrders = async () => [];
  ex._fetchInactiveOrders = async () => [];
  let fill = null;
  ex.on('fill', (f) => { fill = f; });
  await ex._refreshOrders();
  assert.ok(fill, '穿越后应推定成交并 emit fill');
  assert.equal(fill.sizeBase, 0.0002);
  assert.equal(fill.price, 81000);
  assert.ok(!ex._tracked.has('o-x'), '成交后删除跟踪');
  assert.ok(ex.crossInferredFills >= 1, '穿越计数 +1');
})();

await (async () => {
  // P1 重现清零：订单在活跃快照重现后 goneFirstAt 归零，二次消失重新计时
  const ex = new LighterExchange({ accountIndex: 12, apiKeyIndex: 4, apiPrivateKey: 'test-only',
    signer: { start: async () => true, stop: async () => true, request: async () => ({}) } });
  ex.markets.set(1, { marketId: 1, name: 'BTC-USD', stepSize: 0.0001, stepPrice: 0.1 });
  const t = { orderId: 'o-r', marketId: 1, levelIndex: 5, side: 'sell', price: 81000, sizeBase: 0.0002,
    reduceOnly: false, placedAt: Date.now() - 200_000, seen: true, goneFirstAt: Date.now() - 120_000,
    _crossedUp: true, _crossedDown: false };
  ex._tracked.set('o-r', t);
  // 活跃快照里能看到它 -> 重现 -> goneFirstAt 清零
  ex._fetchActiveOrders = async () => [{ order_id: 'o-r', status: 'open', price: 81000, side: 'sell', base_amount: 0.0002 }];
  ex._fetchInactiveOrders = async () => [];
  await ex._refreshOrders();
  assert.equal(t.goneFirstAt, 0, '重现后 goneFirstAt 应清零（防快照毛刺残留计时）');
  assert.ok(ex._tracked.has('o-r'), '重现后保留跟踪');
})();

await (async () => {
  // P2 空快照守卫：空快照 + 本地跟踪多 -> 本轮不做 gone 判定（不启动计时/不推定）
  const ex = new LighterExchange({ accountIndex: 12, apiKeyIndex: 4, apiPrivateKey: 'test-only',
    signer: { start: async () => true, stop: async () => true, request: async () => ({}) } });
  ex.markets.set(1, { marketId: 1, name: 'BTC-USD', stepSize: 0.0001, stepPrice: 0.1 });
  const t = { orderId: 'o-e', marketId: 1, levelIndex: 5, side: 'sell', price: 81000, sizeBase: 0.0002,
    reduceOnly: false, placedAt: Date.now() - 120_000, seen: true, goneFirstAt: null,
    _crossedUp: true, _crossedDown: false };
  ex._tracked.set('o-e', t);
  for (let i = 0; i < 12; i++) {
    ex._tracked.set('o-e2-' + i, { orderId: 'o-e2-' + i, marketId: 1, levelIndex: 6 + i, side: 'buy', price: 80900 - i, sizeBase: 0.0002, reduceOnly: false, placedAt: Date.now() - 120_000, seen: true, goneFirstAt: null, _crossedUp: true });
  }
  let fills = 0;
  ex.on('fill', () => { fills++; });
  ex._fetchActiveOrders = async () => [];  // 空快照
  ex._fetchInactiveOrders = async () => []; // 即使 inactive 也空
  await ex._refreshOrders();
  assert.ok(ex._tracked.has('o-e'), '空快照轮不删跟踪');
  assert.equal(fills, 0, '空快照轮不触发推定/成交');
  assert.ok(!t.goneFirstAt, '空快照轮不启动 goneFirstAt 计时');
})();
