// M2 写路径：全部打在本文件的 mock server 上，绝不接触真实账户。
import { strict as assert } from 'node:assert';
import { ProprClient } from '../src/exchange/pr/client.js';
import { ProprWriter } from '../src/exchange/pr/write.js';
import { ProprReadOnlyError } from '../src/exchange/pr/errors.js';

function mockServer(opts = {}) {
  const state = {
    orders: new Map(),     // orderId -> order
    intents: new Set(),
    positions: opts.positions || [],
    seq: 0,
    calls: [],
    timeouts: new Set(opts.timeouts || []),
    conflicts: new Set(opts.conflicts || []),
    cancel400: new Set(opts.cancel400 || []),
    stuck: new Set(opts.stuck || []),
  };
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ method, path: p });

    if (method === 'GET' && p.endsWith('/orders')) {
      const open = [...state.orders.values()].filter((o) => o.status === 'open');
      return json(200, { data: open });
    }
    if (method === 'GET' && p.endsWith('/positions')) return json(200, { data: state.positions });
    if (method === 'GET' && /\/accounts\/[^/]+$/.test(p)) return json(200, { data: { balance: '5000', marginBalance: '5000', availableBalance: '5000' } });

    if (method === 'POST' && p.endsWith('/orders')) {
      const o = body.orders[0];
      if (state.timeouts.has(o.intentId)) throw new Error('ECONNRESET');
      if (state.conflicts.has(o.intentId) || state.intents.has(o.intentId)) {
        return json(400, { code: 13084, message: 'idempotency conflict' });
      }
      state.intents.add(o.intentId);
      const orderId = `urn:prp-order:${++state.seq}`;
      const row = { orderId, intentId: o.intentId, ...o, status: 'open' };
      state.orders.set(orderId, row);
      return json(201, { data: [row] });
    }
    const cm = p.match(/\/orders\/([^/]+)\/cancel$/);
    if (method === 'POST' && cm) {
      const id = cm[1];
      if (state.cancel400.has(id)) {
        state.orders.get(id).status = 'filled';     // 400 的真实含义：已经终结
        return json(400, { message: 'order cannot be cancelled' });
      }
      if (state.stuck.has(id)) return json(400, { message: 'order cannot be cancelled' });
      if (!state.orders.get(id) || state.orders.get(id).status !== 'open') return json(400, { message: 'order cannot be cancelled' });
      state.orders.get(id).status = 'cancelled';
      return json(201, { data: { orderId: id, status: 'cancelled' } });
    }
    return json(404, { message: `mock 未实现 ${method} ${p}` });
  }
  return { state, fetchImpl };
}

const mk = (srv, allowWrites = true) => new ProprWriter({
  client: new ProprClient({ apiKey: 'k', baseUrl: 'https://mock.local/v1', fetchImpl: srv.fetchImpl, allowWrites }),
  accountId: 'urn:prp-account:test',
  paceMs: 0,
  sleep: async () => {},
});

{
  // 1) 下单成功：payload 语义正确
  const srv = mockServer();
  const w = mk(srv);
  const row = await w.placeLimitOrder({ side: 'buy', positionSide: 'long', qty: 0.004, price: 78000, intentId: 'i1' });
  assert.ok(row.orderId);
  const sent = srv.state.calls.find((c) => c.method === 'POST');
  assert.ok(sent.path.endsWith('/accounts/urn:prp-account:test/orders'));
  const stored = [...srv.state.orders.values()][0];
  assert.equal(stored.quantity, '0.004');
  assert.equal(stored.price, '78000');
  assert.equal(stored.reduceOnly, false);
  assert.equal(stored.positionSide, 'long');
  assert.equal(w.writeAttempts, 1);
}

{
  // 2) 同 intentId 重发 → 13084 → 对账拿回原单，不产生第二张
  const srv = mockServer();
  const w = mk(srv);
  await w.placeLimitOrder({ side: 'buy', positionSide: 'long', qty: 0.004, price: 78000, intentId: 'i1' });
  const again = await w.placeLimitOrder({ side: 'buy', positionSide: 'long', qty: 0.004, price: 78000, intentId: 'i1' });
  assert.ok(again.orderId);
  assert.equal(srv.state.orders.size, 1, '同 intentId 不得产生第二张订单');
  assert.equal(w.writeAttempts, 2);
}

{
  // 3) 超时 → mayExist，但对账找不到 → 抛给上层，不静默成功
  const srv = mockServer({ timeouts: ['i9'] });
  const w = mk(srv);
  const err = await w.placeLimitOrder({ side: 'buy', positionSide: 'long', qty: 0.001, price: 70000, intentId: 'i9' }).catch((e) => e);
  assert.ok(err);
  assert.equal(err.status, 0);
  assert.equal(srv.state.orders.size, 0);
}

{
  // 4) 撤单：201 成功；400（已成交/已撤）→ null，不算错误
  const srv = mockServer();
  const w = mk(srv);
  const row = await w.placeLimitOrder({ side: 'sell', positionSide: 'short', qty: 0.004, price: 82000, intentId: 'i2' });
  const ok = await w.cancelOrder(row.orderId);
  assert.equal(ok.status, 'cancelled');
  const gone = await w.cancelOrder(row.orderId);
  assert.equal(gone, null);
}

{
  // 5) 全撤：一张撤单返回 400 也不能中断，最后必须 remaining=0
  const srv = mockServer();
  const w = mk(srv);
  const a = await w.placeLimitOrder({ side: 'buy', positionSide: 'long', qty: 0.001, price: 78000, intentId: 'a' });
  const b = await w.placeLimitOrder({ side: 'buy', positionSide: 'long', qty: 0.001, price: 78100, intentId: 'b' });
  await w.placeLimitOrder({ side: 'sell', positionSide: 'short', qty: 0.001, price: 82000, intentId: 'c' });
  srv.state.cancel400.add(a.orderId);   // 模拟"已经成交，撤不掉"
  const r = await w.cancelAll({ verifyDelayMs: 0 });
  assert.equal(r.remaining, 0);
  assert.ok(r.cancelled.includes(b.orderId));
}

{
  // 5b) 真的撤不掉（一直 400 且仍显示 open）→ 必须把 remaining 报上来，不能假装成功
  const srv = mockServer();
  const w = mk(srv);
  const a = await w.placeLimitOrder({ side: 'buy', positionSide: 'long', qty: 0.001, price: 78000, intentId: 'a' });
  srv.state.stuck.add(a.orderId);
  const r = await w.cancelAll({ verifyDelayMs: 0, attempts: 2 });
  assert.equal(r.remaining, 1);
}

{
  // 6) 平仓：多空两侧都要平，且 reduceOnly + closePosition
  const srv = mockServer({
    positions: [
      { asset: 'BTC', positionSide: 'long', quantity: '0.004', status: 'open' },
      { asset: 'BTC', positionSide: 'short', quantity: '0.006', status: 'open' },
    ],
  });
  const w = mk(srv);
  const out = await w.closePosition('BTC');
  assert.equal(out.length, 2);
  const posts = srv.state.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  const rows = [...srv.state.orders.values()];
  assert.deepEqual(rows.map((x) => x.side).sort(), ['buy', 'sell']);
  assert.ok(rows.every((x) => x.reduceOnly === true && x.closePosition === true && x.type === 'market'));
}

{
  // 7) 批量：中间一项失败 → 等长同序，失败项无 orderId
  const srv = mockServer({ conflicts: ['b'] });
  const w = mk(srv);
  const { items, bot } = await w.placeLimitOrders([
    { side: 'buy', positionSide: 'long', qty: 0.001, price: 78000, intentId: 'a' },
    { side: 'buy', positionSide: 'long', qty: 0.001, price: 78100, intentId: 'b' },
    { side: 'buy', positionSide: 'long', qty: 0.001, price: 78200, intentId: 'c' },
  ]);
  assert.equal(items.length, 3);
  assert.equal(bot.length, 3);
  assert.equal(items[0].accepted, true);
  assert.equal(items[1].accepted, false);
  assert.equal(items[1].mayExist, true);
  assert.equal(items[2].accepted, true);
  assert.equal(bot[1], null);
}

{
  // 8) shadow：写路径不可达，且计数 +1
  const srv = mockServer();
  const w = mk(srv, false);
  await assert.rejects(() => w.placeLimitOrder({ side: 'buy', positionSide: 'long', qty: 0.001, price: 1, intentId: 'x' }), ProprReadOnlyError);
  assert.equal(w.writeAttempts, 1);
  assert.equal(srv.state.calls.filter((c) => c.method === 'POST').length, 0);
}

console.log('✓ propr-write.test.js 全部通过');