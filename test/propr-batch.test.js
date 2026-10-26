// 批量下单契约：等长、同序、单项失败不整批抛错。
// 这是 M1 最值钱的一组测试——违约会导致"已成功的单被重复提交"。
import { strict as assert } from 'node:assert';
import { placeBatch, assertBatchShape, toBotResults, summarize } from '../src/exchange/pr/batch.js';
import { ProprApiError, CODES } from '../src/exchange/pr/errors.js';

const chunk = [
  { intentId: 'i1', price: 79000 },
  { intentId: 'i2', price: 79500 },
  { intentId: 'i3', price: 80000 },
];
const ok = (o) => ({ orderId: `urn:prp-order:${o.intentId}`, price: o.price, sizeBase: 0.004 });
const fail = (code, status = 400) => { throw new ProprApiError(status, code, `fail ${code}`); };

{
  // 全成功
  const r = await placeBatch({ orders: chunk, placeOne: async (o) => ok(o) });
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((x) => x.inputIndex), [0, 1, 2]);
  assert.deepEqual(r.map((x) => x.intentId), ['i1', 'i2', 'i3']);
  assert.ok(r.every((x) => x.accepted && x.orderId));
}

{
  // 中间一项失败：不得抛错、长度不变、失败项无 orderId
  const r = await placeBatch({ orders: chunk, placeOne: async (o) => (o.intentId === 'i2' ? fail(CODES.MULTIPLE_ENTRY) : ok(o)) });
  assert.equal(r.length, 3);
  assert.equal(r[1].accepted, false);
  assert.equal(r[1].orderId, undefined);
  assert.equal(r[1].code, CODES.MULTIPLE_ENTRY);
  assert.equal(r[0].accepted, true);
  assert.equal(r[2].accepted, true);
}

{
  // 第一项 / 最后一项失败
  for (const bad of ['i1', 'i3']) {
    const r = await placeBatch({ orders: chunk, placeOne: async (o) => (o.intentId === bad ? fail(13066) : ok(o)) });
    assert.equal(r.length, 3);
    assert.equal(r.find((x) => x.intentId === bad).accepted, false);
    assert.equal(r.filter((x) => x.accepted).length, 2);
  }
}

{
  // 超时（status 0）→ retryable + mayExist：必须先对账再重试
  const r = await placeBatch({
    orders: [chunk[0]],
    placeOne: async () => { throw new ProprApiError(0, null, 'timeout', { retryable: true, mayExist: true }); },
  });
  assert.equal(r[0].accepted, false);
  assert.equal(r[0].retryable, true);
  assert.equal(r[0].mayExist, true);
}

{
  // 13084 幂等冲突 → mayExist，但不是 retryable
  const r = await placeBatch({ orders: [chunk[0]], placeOne: async () => fail(CODES.IDEMPOTENCY_CONFLICT) });
  assert.equal(r[0].mayExist, true);
  assert.equal(r[0].retryable, false);
}

{
  // 部分成功后重试：成功项保留 orderId，失败项可单独重发（intentId 不变）
  const r = await placeBatch({ orders: chunk, placeOne: async (o) => (o.intentId === 'i2' ? fail(13084) : ok(o)) });
  const broken = r.filter((x) => !x.accepted);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].intentId, 'i2');
  const retry = await placeBatch({ orders: [{ intentId: 'i2', price: 79500 }], placeOne: async (o) => ok(o) });
  assert.equal(retry[0].accepted, true);
  assert.equal(retry[0].intentId, 'i2');
}

{
  // 返回乱序 / 长度不足：assertBatchShape 必须拒绝
  assert.throws(() => assertBatchShape([1, 2, 3], [{ inputIndex: 0 }, { inputIndex: 1 }]), /长度/);
  assert.throws(() => assertBatchShape([1, 2], [{ inputIndex: 1 }, { inputIndex: 0 }]), /乱序/);
  assert.ok(assertBatchShape([1, 2], [{ inputIndex: 0 }, {}]));
  assert.throws(() => assertBatchShape([1], 'nope'), /数组/);
}

{
  // 交给 bot 的形态：[{orderId}] 或 null，等长同序
  const items = [
    { inputIndex: 0, accepted: true, orderId: 'o1', price: 1, sizeBase: 2 },
    { inputIndex: 1, accepted: false, code: 13084 },
    { inputIndex: 2, accepted: true, orderId: 'o3' },
  ];
  const bot = toBotResults(items);
  assert.equal(bot.length, 3);
  assert.equal(bot[0].orderId, 'o1');
  assert.equal(bot[1], null);
  assert.equal(bot[2].orderId, 'o3');
  const s = summarize(items);
  assert.equal(s.accepted, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.codes[0], 13084);
}

console.log('✓ propr-batch.test.js 全部通过');