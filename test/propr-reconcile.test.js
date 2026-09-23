// Propr 对账与恢复测试：撤单复核、全平、重启不重复补单、intent 对账。
import { strict as assert } from 'node:assert';
import { ProprExchange } from '../src/exchange/propr/propr.js';

const ACCOUNT = 'acc-1234567890';
const state = {
  orders: [], positions: [], trades: [],
  cancelMode: 'ok', cancelCalls: 0, seq: 0, lastRecords: [],
};
const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeOrder(record) {
  state.seq += 1;
  return {
    ...record, orderId: `urn:prp-order:${state.seq}`, status: 'open', cumulativeQuantity: '0',
    createdAt: '2026-09-23T02:00:00.000Z', updatedAt: '2026-09-23T02:00:00.000Z',
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  const q = new URL(u).searchParams;
  const body = opts.body ? JSON.parse(opts.body) : null;

  if (u.startsWith('https://api.hyperliquid.xyz/info')) {
    if (body?.type === 'allMids') return jsonResponse({ BTC: '90000' });
    if (body?.type === 'candleSnapshot') return jsonResponse([]);
  }
  if (u.includes('/health/services')) return jsonResponse({ core: 'OK' });
  if (u.includes('/health')) return jsonResponse({ status: 'OK' });
  if (u.includes('/users/me')) return jsonResponse({ userId: 'urn:prp-user:u1' });
  if (u.includes('/challenge-attempts/a1')) return jsonResponse({
    attemptId: 'a1', accountId: ACCOUNT, status: 'active', phases: [],
    account: { balance: '5000', marginBalance: '5000', availableBalance: '5000', highWaterMark: '5000', totalUnrealizedPnl: '0', currency: 'USDC' },
  });
  if (u.includes('/challenge-attempts')) return jsonResponse({ data: [{ attemptId: 'a1', accountId: ACCOUNT, status: 'active' }] });
  if (u.includes('/margin-config/')) return jsonResponse({ configId: 'c1', asset: 'BTC', leverage: '1', marginMode: 'cross' });
  if (u.includes('/leverage-limits/effective')) return jsonResponse({ defaults: { crypto: 2 }, overrides: { BTC: 10 } });

  if (method === 'POST' && /\/orders\/[^/]+\/cancel$/.test(u)) {
    state.cancelCalls += 1;
    const id = decodeURIComponent(u.split('/orders/')[1].split('/cancel')[0]);
    if (state.cancelMode === 'ok') {
      const row = state.orders.find((o) => o.orderId === id);
      if (row) row.status = 'cancelled';
      return jsonResponse({ orderId: id, status: 'cancelled' });
    }
    return jsonResponse({ message: 'already done' }, 400); // 400：官方吞并为"已成交/已撤"
  }
  if (method === 'POST' && u.includes('/orders')) {
    const rows = body.orders.map(makeOrder);
    state.lastRecords = body.orders;
    state.orders.push(...rows);
    // 模拟市价 reduceOnly+closePosition 成交：清空持仓
    if (body.orders.some((o) => o.closePosition && o.reduceOnly)) state.positions = [];
    return jsonResponse({ data: rows });
  }
  if (u.includes('/positions')) return jsonResponse({ data: state.positions });
  if (u.includes('/orders')) {
    let rows = state.orders;
    if (q.get('orderId')) rows = rows.filter((o) => o.orderId === q.get('orderId'));
    if (q.get('status')) rows = rows.filter((o) => o.status === q.get('status'));
    const limit = Number(q.get('limit') ?? 20);
    const offset = Number(q.get('offset') ?? 0);
    return jsonResponse({ data: rows.slice(offset, offset + limit) });
  }
  if (u.includes('/trades')) {
    const limit = Number(q.get('limit') ?? 20);
    const offset = Number(q.get('offset') ?? 0);
    return jsonResponse({ data: state.trades.slice(offset, offset + limit) });
  }
  throw new Error(`unexpected fetch: ${u}`);
};

const cfg = { mode: 'sim-write', apiKey: 'pk_live_test', accountId: ACCOUNT, base: 'BTC', apiUrl: 'https://api.propr.xyz/v1', timeoutMs: 5000, orderPollMs: 60000 };

function tradeRow(tradeId, orderId) {
  return {
    tradeId, orderId, base: 'BTC', side: 'buy', positionSide: 'long', type: 'open',
    quantity: '0.001', price: '90000', fee: '0.0135', feeRate: '0.00015', realizedPnl: '0',
    positionSizeBefore: '0', executedAt: '2026-09-23T02:05:00.000Z', createdAt: '2026-09-23T02:05:00.000Z',
  };
}

async function freshExchange() {
  state.orders = []; state.positions = []; state.trades = [];
  state.cancelMode = 'ok'; state.cancelCalls = 0; state.seq = 0;
  const ex = new ProprExchange(cfg);
  await ex.init();
  return ex;
}

async function main() {
  {
    // 撤单复核：cancel 返回 400（官方吞并），但订单真实状态为 filled → 视为已完成
    const ex = await freshExchange();
    state.orders.push({ orderId: 'o-filled', intentId: 'i1', base: 'BTC', side: 'buy', positionSide: 'long', quantity: '0.001', price: '90000', reduceOnly: false, closePosition: false, status: 'filled', cumulativeQuantity: '0.001', createdAt: '2026-09-23T02:00:00.000Z', updatedAt: '2026-09-23T02:00:00.000Z' });
    state.cancelMode = 'swallow400';
    assert.equal(await ex.cancelOrder('BTC', 'o-filled'), true, '已成交订单撤单复核应返回 true');
    ex.stop();
  }

  {
    // 撤单复核：两次撤单后订单仍 open → 返回 false
    const ex = await freshExchange();
    state.orders.push({ orderId: 'o-stuck', intentId: 'i2', base: 'BTC', side: 'buy', positionSide: 'long', quantity: '0.001', price: '90000', reduceOnly: false, closePosition: false, status: 'open', cumulativeQuantity: '0', createdAt: '2026-09-23T02:00:00.000Z', updatedAt: '2026-09-23T02:00:00.000Z' });
    state.cancelMode = 'swallow400';
    assert.equal(await ex.cancelOrder('BTC', 'o-stuck'), false, '订单仍活动必须返回 false');
    assert.equal(state.cancelCalls, 2, '必须重试一次撤单');
    ex.stop();
  }

  {
    // cancelAll：正常全部撤掉 → true
    const ex = await freshExchange();
    await ex.placeLimitOrders([
      { marketId: 'BTC', side: 'buy', price: 80000, sizeBase: 0.001, levelIndex: 1 },
      { marketId: 'BTC', side: 'sell', price: 100000, sizeBase: 0.001, levelIndex: 2 },
    ]);
    assert.equal(await ex.cancelAll(), true);
    assert.equal(ex.getOpenOrders().length, 0);
    ex.stop();
  }

  {
    // cancelAll：撤单无效导致残留 → false
    const ex = await freshExchange();
    await ex.placeLimitOrder({ marketId: 'BTC', side: 'buy', price: 80000, sizeBase: 0.001, levelIndex: 1 });
    state.cancelMode = 'swallow400'; // 订单永远保持 open
    assert.equal(await ex.cancelAll(), false, '有残留挂单必须返回 false');
    ex.stop();
  }

  {
    // closePosition：多仓 → 市价 reduceOnly+closePosition 平仓并复核至空
    const ex = await freshExchange();
    state.positions = [{ positionId: 'p1', base: 'BTC', positionSide: 'long', quantity: '0.001', entryPrice: '86000', markPrice: '90000', unrealizedPnl: '4', leverage: '1', marginMode: 'cross' }];
    assert.equal(await ex.closePosition(), true);
    assert.equal(state.positions.length, 0);
    const closeRecord = state.lastRecords[0];
    assert.equal(closeRecord.side, 'sell', '多仓必须用 sell 平');
    assert.equal(closeRecord.type, 'market');
    assert.equal(closeRecord.reduceOnly, true);
    assert.equal(closeRecord.closePosition, true);
    ex.stop();
  }

  {
    // 重启不重复补单：seed 历史成交不发 fill；仅新成交发一次
    state.trades = [tradeRow('t-old', 'o-old')];
    const ex1 = new ProprExchange(cfg);
    const fills1 = [];
    ex1.on('fill', (f) => fills1.push(f));
    await ex1.init();
    assert.equal(fills1.length, 0, '启动时历史成交不得补发');
    state.trades = [tradeRow('t-old', 'o-old'), tradeRow('t-new', 'o-new')];
    await ex1._refreshTrades();
    assert.equal(fills1.length, 1, '仅新成交补发一次');
    assert.equal(fills1[0].orderId, 'o-new');
    ex1.stop();

    // 模拟进程重启：新实例 seed 同样的历史（含 t-new）→ 仍不得重复补发
    const ex2 = new ProprExchange(cfg);
    const fills2 = [];
    ex2.on('fill', (f) => fills2.push(f));
    await ex2.init();
    await ex2._refreshTrades();
    assert.equal(fills2.length, 0, '重启后不得重复补单');
    ex2.stop();
  }

  {
    // reconcileOrders：本地 intent 与交易所挂单按 intentId 对齐；未知订单进入 unmatched
    const ex = await freshExchange();
    const res = await ex.placeLimitOrder({ marketId: 'BTC', side: 'buy', price: 80000, sizeBase: 0.001, levelIndex: 1 });
    state.orders.push({ orderId: 'o-foreign', intentId: 'not-ours', base: 'BTC', side: 'sell', positionSide: 'short', quantity: '0.001', price: '100000', reduceOnly: false, closePosition: false, status: 'open', cumulativeQuantity: '0', createdAt: '2026-09-23T02:00:00.000Z', updatedAt: '2026-09-23T02:00:00.000Z' });
    const rec = await ex.reconcileOrders();
    assert.equal(rec.open.length, 2);
    assert.equal(rec.unmatched.length, 1);
    assert.equal(rec.unmatched[0].orderId, 'o-foreign');
    assert.ok(ex.getIntents().some((i) => i.orderId === res.orderId && i.state === 'open'));
    ex.stop();
  }
}

main()
  .then(() => console.log('propr-reconcile.test.js 全部通过'))
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => { globalThis.fetch = realFetch; });
