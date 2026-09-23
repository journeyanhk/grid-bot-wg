// Propr 只读适配器测试：启动校验链、市场/精度、分页、权益新鲜度、成交事件与写路径门。
// 网络全部用 fetch 桩替换（Propr REST + HL 公开行情），不触达真实 API。
import { strict as assert } from 'node:assert';
import { ProprExchange } from '../src/exchange/propr/propr.js';

const ACCOUNT = 'acc-1234567890';
const state = { orders: [], trades: [], positions: [] };
const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function pageParams(url) {
  const q = new URL(url).searchParams;
  return { limit: Number(q.get('limit') ?? 20), offset: Number(q.get('offset') ?? 0) };
}

function attemptBody() {
  return {
    attemptId: 'a1', accountId: ACCOUNT, status: 'active', phases: [],
    account: {
      balance: '5000', marginBalance: '4999.7', availableBalance: '4913.2',
      highWaterMark: '5000', totalUnrealizedPnl: '-0.3', currency: 'USDC',
    },
  };
}

function orderRow(orderId, status, extra = {}) {
  return {
    orderId, intentId: `intent-${orderId}`, exchange: 'hyperliquid', productType: 'perp',
    asset: 'BTC', base: 'BTC', quote: 'USDC', type: 'limit', side: 'buy', positionSide: 'long',
    timeInForce: 'GTC', quantity: '0.001', price: '90000', reduceOnly: false, closePosition: false,
    cumulativeQuantity: '0', status, createdAt: '2026-09-23T02:00:00.000Z', updatedAt: '2026-09-23T02:00:00.000Z',
    ...extra,
  };
}

function tradeRow(tradeId, orderId) {
  return {
    tradeId, orderId, base: 'BTC', side: 'buy', positionSide: 'long', type: 'open',
    quantity: '0.001', price: '90000', quoteQuantity: '90', fee: '0.0135', feeRate: '0.00015',
    realizedPnl: '0', positionSizeBefore: '0', isLiquidation: false,
    executedAt: '2026-09-23T02:05:00.000Z', createdAt: '2026-09-23T02:05:00.000Z',
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('https://api.hyperliquid.xyz/info')) {
    if (body?.type === 'allMids') return jsonResponse({ BTC: '90000' });
    if (body?.type === 'candleSnapshot') return jsonResponse([{ t: 1725000000000, o: '1', h: '2', l: '0.5', c: '1.5', v: '10' }]);
  }
  if (u.includes('/health/services')) return jsonResponse({ core: 'OK' });
  if (u.includes('/health')) return jsonResponse({ status: 'OK' });
  if (u.includes('/users/me')) return jsonResponse({ userId: 'urn:prp-user:u1' });
  if (u.includes('/challenge-attempts/a1')) return jsonResponse(attemptBody());
  if (u.includes('/challenge-attempts')) return jsonResponse({ data: [{ attemptId: 'a1', accountId: ACCOUNT, status: 'active' }] });
  if (u.includes('/margin-config/')) return jsonResponse({ configId: 'c1', asset: 'BTC', leverage: '1', marginMode: 'cross' });
  if (u.includes('/leverage-limits/effective')) return jsonResponse({ defaults: { crypto: 2 }, overrides: { BTC: 10 } });
  if (u.includes('/positions')) { const { limit, offset } = pageParams(u); return jsonResponse({ data: state.positions.slice(offset, offset + limit) }); }
  if (u.includes('/orders')) { const { limit, offset } = pageParams(u); return jsonResponse({ data: state.orders.slice(offset, offset + limit) }); }
  if (u.includes('/trades')) { const { limit, offset } = pageParams(u); return jsonResponse({ data: state.trades.slice(offset, offset + limit) }); }
  throw new Error(`unexpected fetch: ${u}`);
};

const cfg = {
  mode: 'sim-write', apiKey: 'pk_live_test', accountId: ACCOUNT, base: 'BTC',
  apiUrl: 'https://api.propr.xyz/v1', timeoutMs: 5000, orderPollMs: 60000,
};

async function main() {
  const ex = new ProprExchange(cfg);
  assert.equal(await ex.init(), true);
  assert.equal(ex.dataSource, 'real');

  // 市场与精度（HL BTC 保守值）
  const markets = await ex.getMarkets();
  assert.equal(markets.length, 1);
  assert.equal(markets[0].marketId, 'BTC');
  assert.equal(markets[0].stepSize, 0.00001);
  assert.equal(markets[0].stepPrice, 0.1);
  assert.equal(markets[0].maxLeverage, 10);
  assert.equal(markets[0].positionMode, 'net');
  assert.equal(ex.feeRate, 0.00015, '费率取 maker 0.00015');

  // 行情与 K 线
  assert.equal(await ex.getPrice(), 90000);
  const candles = await ex.getCandles('BTC', 3600, 10);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].close, 1.5);

  // 权益权威字段 + 新鲜度
  assert.equal(ex.balance, 5000);
  assert.equal(ex.equity, 4999.7);
  assert.equal(ex.highWaterMark, 5000);
  assert.equal(ex.availableBalance, 4913.2);
  assert.equal(ex.equitySource, 'propr_account');
  assert.equal(ex.isEquityStale(), false);

  // 空仓 → null；多仓 → 带符号净仓
  assert.equal(ex.getPosition(), null);
  state.positions = [{ positionId: 'p1', base: 'BTC', positionSide: 'long', quantity: '0.002', entryPrice: '86000', markPrice: '86500', unrealizedPnl: '1.0', leverage: '1', marginMode: 'cross' }];
  await ex._refreshPositions();
  const net = ex.getPosition();
  assert.equal(net.sizeBase, 0.002);
  assert.equal(net.positionSide, 'long');
  assert.equal(net.unrealizedPnl, 1);
  state.positions = [];

  // 分页：101 条必须全量取回（默认 limit 20 会漏）
  state.orders = Array.from({ length: 101 }, (_, i) => orderRow(`o${i}`, 'open'));
  const all = await ex.getAllOrders({ base: 'BTC', status: 'open' });
  assert.equal(all.length, 101, '分页必须取全量');

  // fetchOpenOrders 只暴露 open 列表（桩不按状态过滤，这里验证映射与 levelIndex 保留）
  await ex._refreshOpenOrders();
  assert.equal(ex.getOpenOrders().length, 101);
  ex.adoptOrder({ orderId: 'o1', levelIndex: 5, side: 'buy', price: 90000, sizeBase: 0.001 });
  assert.equal(ex.getOpenOrders().find((o) => o.orderId === 'o1').levelIndex, 5);

  // 成交事件：新成交发一次 fill（含 levelIndex），重复轮询不重发
  state.trades = [tradeRow('t1', 'o1')];
  const fills = [];
  ex.on('fill', (f) => fills.push(f));
  await ex._refreshTrades();
  assert.equal(fills.length, 1);
  assert.equal(fills[0].levelIndex, 5);
  assert.equal(fills[0].side, 'buy');
  assert.equal(fills[0].sizeBase, 0.001);
  assert.equal(fills[0].clientOrderId, 'intent-o1');
  await ex._refreshTrades();
  assert.equal(fills.length, 1, '同一成交不得重复发单');

  // 写路径门：Review 3 前必须显式拒绝
  await assert.rejects(() => ex.placeLimitOrder({}), /Review 3/);
  await assert.rejects(() => ex.cancelOrder('o1'), /Review 3/);
  await assert.rejects(() => ex.closePosition(), /Review 3/);
  await assert.rejects(() => ex.setLeverage('BTC', 1), /Review 3/);

  ex.stop();

  // 严格账户绑定：不匹配的 accountId 必须拒绝启动（禁止回退 active[0]）
  const bad = new ProprExchange({ ...cfg, accountId: 'other-account' });
  await assert.rejects(() => bad.init(), /不在 active attempts/);
  bad.stop();
}

main()
  .then(() => console.log('propr.test.js 全部通过'))
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => { globalThis.fetch = realFetch; });
