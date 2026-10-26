// 容量与快照差分：平台杠杆上升不得放大仓位。
import { strict as assert } from 'node:assert';
import { computeCapacity, ProprShadow } from '../src/exchange/pr/shadow.js';
import { ProprClient } from '../src/exchange/pr/client.js';
import { ProprStaleError } from '../src/exchange/pr/errors.js';

{
  // 平台报 5x，但容量按 1x 算 → 不允许静默扩张
  const c = computeCapacity({ available: 3083.73, leverage: 5, maxInvUsd: 1500, capacityLeverage: 1 });
  assert.equal(c.capacityLeverage, 1);
  assert.equal(c.maxOpenNotional, 1500);
  assert.equal(c.cappedBy, 'config');
  assert.equal(c.leverageWarn, true);
}

{
  // 可用余额不足时以账户为上限
  const c = computeCapacity({ available: 1000, leverage: 1, maxInvUsd: 1500 });
  assert.equal(c.maxOpenNotional, 800);
  assert.equal(c.cappedBy, 'account');
}

{
  // 杠杆字段缺失按 1x；可用余额 0 → 容量 0
  assert.equal(computeCapacity({ available: 500, leverage: null, maxInvUsd: 1500 }).maxOpenNotional, 400);
  assert.equal(computeCapacity({ available: 0, leverage: 1, maxInvUsd: 1500 }).maxOpenNotional, 0);
  assert.throws(() => computeCapacity({ available: 100, leverage: 1, maxInvUsd: 0 }), /PR_MAX_INV_USD/);
}

{
  // 差分：新增/消失挂单、仓位变化、成交数
  const mk = (o) => ({
    at: 1000, account: { equity: 5000, balance: 5000 },
    positions: { long: { size: o.long ?? 0 }, short: { size: o.short ?? 0 } },
    orders: (o.ids || []).map((id) => ({ orderId: id })), newTrades: o.trades ?? [],
  });
  const d = ProprShadow.diff(mk({ ids: ['a', 'b'], long: 0.004 }), mk({ ids: ['b', 'c'], long: 0.008, trades: [1] }));
  assert.deepEqual(d.ordersAdded, ['c']);
  assert.deepEqual(d.ordersRemoved, ['a']);
  assert.equal(d.longDelta, 0.004);
  assert.equal(d.newTrades, 1);
  assert.equal(ProprShadow.diff(null, mk({})), null);
}

{
  // 只读断言：writeAttemptCount 非 0 必须抛
  const client = new ProprClient({ apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
  const sh = new ProprShadow({ client, accountId: 'urn:prp-account:x' });
  assert.ok(sh.assertNoWrites());
  try { client.placeLimitOrder(); } catch { /* expected */ }
  assert.throws(() => sh.assertNoWrites(), /写尝试/);
}

{
  // 过期快照：超过 staleMs 抛 ProprStaleError
  const sh = new ProprShadow({ client: {}, accountId: 'x', staleMs: 1000 });
  assert.throws(() => sh.assertFresh({ at: Date.now() - 5000 }), ProprStaleError);
  assert.ok(sh.assertFresh({ at: Date.now() }));
  assert.throws(() => sh.assertFresh(null), ProprStaleError);
}

console.log('✓ propr-shadow.test.js 全部通过');