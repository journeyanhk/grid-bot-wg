// Propr 只读适配器测试：启动校验链、市场/精度、分页、活动状态完整性、成交全量、
// 权益新鲜度、成交事件去重、安全错误事件与写路径门。网络全部用 fetch 桩替换。
import { strict as assert } from 'node:assert';
import { ProprExchange } from '../src/exchange/propr/propr.js';

const ACCOUNT = 'acc-1234567890';
const state = { orders: [], trades: [], positions: [], failApi: false, failAttempt: false };
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
  if (state.failAttempt && u.includes('/challenge-attempts/a1')) {
    return jsonResponse({ message: 'equity down' }, 500);
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
    const ex3 = new ProprExchange(cfg);
    await ex3.init();
    await ex3._poll(); // 先成功一轮，置位 lastApiOkAt
    const apiBefore = ex3.lastApiOkAt;
    assert.ok(apiBefore > 0, '成功轮询后 lastApiOkAt 必须置位');

    state.failApi = true;
    await new Promise((r) => setTimeout(r, 5));
    await ex3._pollPrice(); // 行情仍成功
    await ex3._poll();      // Propr API 全失败
    assert.ok(ex3.lastPriceOkAt > 0, '行情成功必须推进 lastPriceOkAt');
    assert.equal(ex3.lastApiOkAt, apiBefore, 'Propr API 失败不得推进 lastApiOkAt（看门狗不得误判健康）');
    assert.equal(ex3.getPublicInfo().lastApiOkAt, apiBefore, 'getPublicInfo 必须暴露 lastApiOkAt');
    state.failApi = false;
    ex3.stop();
  }

  {
    // Review9：故障退避 + 错误聚合 + 恢复对账（不刷日志、不丢对账）
    const ex2 = new ProprExchange(cfg);
    await ex2.init();
    await ex2._poll(); // 健康一轮
    assert.equal(ex2._apiFailStreak, 0);
    assert.equal(ex2.getPublicInfo().apiStatus, 'healthy');

    const errs = [];
    ex2.on('error', (e) => errs.push(e));
    state.failApi = true;
    await ex2._poll(); // 第 1 次失败：不额外退避（仍按 3s 节奏重试）
    assert.equal(ex2._apiFailStreak, 1, '失败计数累计');
    assert.equal(errs.length, 1, '首次失败立即发一条事件');
    await ex2._poll(); // 第 2 次失败：触发退避
    assert.equal(ex2._apiFailStreak, 2);
    assert.ok(ex2._nextApiPollAt > Date.now(), '连续失败必须退避（避免 3s 轮询刷屏）');

    const nextAt = ex2._nextApiPollAt;
    await ex2._poll(); // 退避期内
    assert.equal(ex2._apiFailStreak, 2, '退避期内不得再次请求/累计失败');
    assert.equal(ex2._nextApiPollAt, nextAt, '退避时刻不变');
    assert.equal(errs.length, 1, '聚合窗口内不重复发事件');

    state.failApi = false;
    ex2._nextApiPollAt = 0; // 手动放行退避（测试不等 60s）
    await ex2._poll();
    assert.equal(ex2._apiFailStreak, 0, '恢复后失败计数清零');
    assert.equal(ex2.getPublicInfo().apiStatus, 'degraded', '恢复后 5 分钟观察窗内为 degraded');
    assert.ok(ex2.lastApiOkAt > 0, '恢复后 API 新鲜度置位');
    ex2._lastFailAt = 0; // 观察窗结束
    assert.equal(ex2.getPublicInfo().apiStatus, 'healthy');

    ex2.ordersSnapshotStale = true;
    assert.equal(ex2.getPublicInfo().apiStatus, 'stale', '快照不完整必须标记 stale（禁止开仓）');
    ex2.ordersSnapshotStale = false;
    ex2.stop();
  }

  {
    // Review9-1 P1：权益刷新失败不得被吞掉——必须标 stale、计失败、且不推进 lastApiOkAt
    // （否则风控会拿旧权益当"新鲜"继续算日损，看门狗也看不出权益 API 已失联）
    const ex4 = new ProprExchange(cfg);
    await ex4.init();
    await ex4._poll();
    const apiBefore = ex4.lastApiOkAt;
    assert.equal(ex4.getPublicInfo().apiStatus, 'healthy');

    state.failAttempt = true; // 仅 getChallengeAttempt 失败，其余读取正常
    await new Promise((r) => setTimeout(r, 5));
    await ex4._poll();
    assert.equal(ex4.equityStale, true, '权益失败必须标 stale（风控将 LOCKED）');
    assert.equal(ex4.lastApiOkAt, apiBefore, '权益失败不得推进 lastApiOkAt');
    assert.equal(ex4._apiFailStreak, 1, '权益失败必须计入失败计数（进入退避）');
    assert.equal(ex4.getPublicInfo().apiStatus, 'stale');

    state.failAttempt = false;
    ex4._nextApiPollAt = 0;
    await ex4._poll();
    assert.equal(ex4.equityStale, false, '恢复后权益新鲜');
    assert.equal(ex4._apiFailStreak, 0);
    assert.ok(ex4.lastApiOkAt > apiBefore, '恢复后 API 新鲜度推进');
    ex4.stop();
  }
}

main()
  .then(() => console.log('propr.test.js 全部通过'))
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => { globalThis.fetch = realFetch; });
