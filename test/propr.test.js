// Propr 只读适配器测试：启动校验链、市场/精度、分页、活动状态完整性、成交全量、
// 权益新鲜度、成交事件去重、安全错误事件与写路径门。网络全部用 fetch 桩替换。
import { strict as assert } from 'node:assert';
import { ProprExchange } from '../src/exchange/propr/propr.js';

const ACCOUNT = 'acc-1234567890';
const state = { orders: [], trades: [], positions: [], failApi: false };
const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function query(url) {
  const q = new URL(url).searchParams;
  return { limit: Number(q.get('limit') ?? 20), offset: Number(q.get('offset') ?? 0), status: q.get('status') || null };
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
  if (state.failApi && (u.includes('/positions') || u.includes('/orders') || u.includes('/trades') || u.includes('/challenge-attempts/a1'))) {
    return jsonResponse({ message: 'propr api down' }, 500);
  }
  if (u.includes('/health/services')) return jsonResponse({ core: 'OK' });
  if (u.includes('/health')) return jsonResponse({ status: 'OK' });
  if (u.includes('/users/me')) return jsonResponse({ userId: 'urn:prp-user:u1' });
  if (u.includes('/challenge-attempts/a1')) return jsonResponse(attemptBody());
  if (u.includes('/challenge-attempts')) return jsonResponse({ data: [{ attemptId: 'a1', accountId: ACCOUNT, status: 'active' }] });
  if (u.includes('/margin-config/')) return jsonResponse({ configId: 'c1', asset: 'BTC', leverage: '1', marginMode: 'cross' });
  if (u.includes('/leverage-limits/effective')) return jsonResponse({ defaults: { crypto: 2 }, overrides: { BTC: 10 } });
  if ((opts.method || 'GET') === 'POST' && u.includes('/orders')) {
    const body = JSON.parse(opts.body);
    const rows = body.orders.map((o, i) => ({
      ...o, orderId: `urn:prp-order:p${i + 1}`, status: 'open', cumulativeQuantity: '0',
      createdAt: '2026-09-23T02:00:00.000Z', updatedAt: '2026-09-23T02:00:00.000Z',
    }));
    state.orders.push(...rows);
    return jsonResponse({ data: rows });
  }
  if (u.includes('/positions')) { const { limit, offset } = query(u); return jsonResponse({ data: state.positions.slice(offset, offset + limit) }); }
  if (u.includes('/orders')) {
    const { limit, offset, status } = query(u);
    const rows = status ? state.orders.filter((o) => o.status === status) : state.orders;
    return jsonResponse({ data: rows.slice(offset, offset + limit) });
  }
  if (u.includes('/trades')) { const { limit, offset } = query(u); return jsonResponse({ data: state.trades.slice(offset, offset + limit) }); }
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
  assert.equal(markets[0].marketId, 'BTC');
  assert.equal(markets[0].stepSize, 0.00001);
  assert.equal(markets[0].stepPrice, 0.1);
  assert.equal(markets[0].maxLeverage, 10);
  assert.equal(markets[0].positionMode, 'net');
  assert.equal(ex.feeRate, 0.00015, '未配置 PR_FEE_RATE 时必须用实测 maker 费率');

  // 行情与 K 线
  assert.equal(await ex.getPrice(), 90000);
  assert.equal((await ex.getCandles('BTC', 3600, 10))[0].close, 1.5);

  // 权益权威字段 + 新鲜度
  assert.equal(ex.balance, 5000);
  assert.equal(ex.equity, 4999.7);
  assert.equal(ex.highWaterMark, 5000);
  assert.equal(ex.equitySource, 'propr_account');
  assert.equal(ex.isEquityStale(), false);

  // 空仓 → null；多仓 → 带符号净仓
  assert.equal(ex.getPosition(), null);
  state.positions = [{ positionId: 'p1', base: 'BTC', positionSide: 'long', quantity: '0.002', entryPrice: '86000', markPrice: '86500', unrealizedPnl: '1.0', leverage: '1', marginMode: 'cross' }];
  await ex._refreshPositions();
  assert.equal(ex.getPosition().sizeBase, 0.002);
  state.positions = [];

  // 分页：101 条必须全量取回（默认 limit 20 会漏）
  state.orders = Array.from({ length: 101 }, (_, i) => orderRow(`p${i}`, 'open'));
  assert.equal((await ex.getAllOrders({ base: 'BTC', status: 'open' })).length, 101);

  // 活动挂单必须包含 pending/open/partially_filled，排除终态（Review2 P1）
  state.orders = [
    orderRow('o-pending', 'pending'),
    orderRow('o-open', 'open'),
    orderRow('o-partial', 'partially_filled'),
    orderRow('o-filled', 'filled'),
    orderRow('o-cancelled', 'cancelled'),
  ];
  await ex._refreshOpenOrders();
  assert.deepEqual(ex.getOpenOrders().map((o) => o.orderId).sort(), ['o-open', 'o-partial', 'o-pending']);
  ex.adoptOrder({ orderId: 'o-open', levelIndex: 5, side: 'buy', price: 90000, sizeBase: 0.001 });
  assert.equal(ex.getOpenOrders().find((o) => o.orderId === 'o-open').levelIndex, 5);
  assert.equal(ex.getOpenOrders().find((o) => o.orderId === 'o-open').clientOrderId, 'intent-o-open', 'adoptOrder 不得丢掉 intentId');

  // 成交全量：单轮 150 条（超过默认 50）必须全部发出，且不重复（Review2 P1）
  state.trades = Array.from({ length: 150 }, (_, i) => tradeRow(`t${i}`, `o${i}`));
  const fills = [];
  ex.on('fill', (f) => fills.push(f));
  await ex._refreshTrades();
  assert.equal(fills.length, 150, '超过 50 条的成交必须全量拉取');
  await ex._refreshTrades();
  assert.equal(fills.length, 150, '同一成交不得重复发单');

  // getTrades 返回内部统一视图（Review2 P2）
  const views = await ex.getTrades({ limit: 5 });
  assert.ok(Array.isArray(views) && views.length > 0);
  assert.ok('sizeBase' in views[0] && 'executedAt' in views[0]);
  assert.ok(!('quantity' in views[0]), '内部视图不应保留原始 quantity 字段');
  const raw = await ex.getRawTrades({ limit: 5 });
  assert.ok('quantity' in raw[0], 'getRawTrades 保留原始口径');

  // 错误事件统一安全包装（Review2 P1）
  const errs = [];
  ex.on('error', (e) => errs.push(e));
  ex._emitError(new Error('boom pk_live_SECRET'));
  assert.equal(errs.length, 1);
  assert.ok(!errs[0].message.includes('pk_live_SECRET'), '错误事件必须脱敏');
  assert.equal(errs[0].kind, 'network');

  // 写路径已可用（Review 3）：本地精度强制 + 自有 intentId；不再有 "Review 3 未实现" 门
  await assert.rejects(
    () => ex.placeLimitOrder({ marketId: 'BTC', side: 'buy', price: 90000, sizeBase: 0.0001 }),
    /名义价值/,
    '低于最小名义必须本地拒绝（服务端不校验）',
  );
  state.orders = [];
  await ex._refreshOpenOrders();
  const placed = await ex.placeLimitOrder({ marketId: 'BTC', side: 'buy', price: 80000, sizeBase: 0.001, levelIndex: 2 });
  assert.match(placed.clientOrderId, /^[0-9A-HJKMNP-TV-Z]{26}$/, '下单必须携带自有 ULID intentId');
  assert.equal(ex.getOpenOrders().length, 1);
  assert.equal(ex.getOpenOrders()[0].levelIndex, 2);

  ex.stop();

  // 严格账户绑定：不匹配的 accountId 必须拒绝启动（禁止回退 active[0]）
  const bad = new ProprExchange({ ...cfg, accountId: 'other-account' });
  await assert.rejects(() => bad.init(), /不在 active attempts/);
  bad.stop();

  {
    // P1：行情（HL 公开 API）正常但 Propr API 全挂 → 新鲜度必须分离，
    // 否则 server 看门狗会被行情成功误判为"Propr 健康"。
    const ex2 = new ProprExchange(cfg);
    await ex2.init();
    await ex2._poll(); // 先成功一轮，置位 lastApiOkAt
    const apiBefore = ex2.lastApiOkAt;
    assert.ok(apiBefore > 0, '成功轮询后 lastApiOkAt 必须置位');

    state.failApi = true;
    await new Promise((r) => setTimeout(r, 5));
    await ex2._pollPrice(); // 行情仍成功
    await ex2._poll();      // Propr API 全失败
    assert.ok(ex2.lastPriceOkAt > 0, '行情成功必须推进 lastPriceOkAt');
    assert.equal(ex2.lastApiOkAt, apiBefore, 'Propr API 失败不得推进 lastApiOkAt（看门狗不得误判健康）');
    assert.ok(ex2.getPublicInfo().lastApiOkAt === apiBefore, 'getPublicInfo 必须暴露 lastApiOkAt');
    state.failApi = false;
    ex2.stop();
  }
}

main()
  .then(() => console.log('propr.test.js 全部通过'))
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => { globalThis.fetch = realFetch; });
