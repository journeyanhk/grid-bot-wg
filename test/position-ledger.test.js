// test/position-ledger.test.js —— 本地预期仓位账本（P0-2）
import test from 'node:test';
import assert from 'node:assert/strict';
import { PositionLedger, fillKey } from '../src/position-ledger.js';

test('基线 + 成交推进；部分成交只记实际成交量', () => {
  const l = new PositionLedger({});
  l.reset(0);
  assert.equal(l.value, 0);

  // 一张 0.0002 的单分三次成交：0.00008 / 0.00007 / 0.00005
  l.applyFill({ orderId: 'o1', side: 'buy', sizeBase: 0.00008, price: 80000, rawTs: '1000' });
  l.applyFill({ orderId: 'o1', side: 'buy', sizeBase: 0.00007, price: 80000, rawTs: '1001' });
  l.applyFill({ orderId: 'o1', side: 'buy', sizeBase: 0.00005, price: 80000, rawTs: '1002' });
  assert.equal(l.value, 0.0002);
  assert.equal(l.version, 4, 'reset + 3 次成交 = 4 次版本推进');
});

test('重复投递同一条成交不重复记账', () => {
  const l = new PositionLedger({});
  l.reset(0);
  const f = { orderId: 'o2', side: 'sell', sizeBase: 0.0002, price: 81000, rawTs: '2000' };
  assert.equal(l.applyFill(f).applied, true);
  assert.equal(l.value, -0.0002);
  for (let i = 0; i < 5; i++) {
    const r = l.applyFill(f);
    assert.equal(r.applied, false);
    assert.equal(r.duplicate, true);
  }
  assert.equal(l.value, -0.0002, '重复 5 次仍是 -0.0002');
});

test('同毫秒的两笔部分成交不会被当成同一笔（rawTs 微秒区分）', () => {
  const l = new PositionLedger({});
  l.reset(0);
  l.applyFill({ orderId: 'o3', side: 'buy', sizeBase: 0.0001, price: 80000, rawTs: '3000' });
  l.applyFill({ orderId: 'o3', side: 'buy', sizeBase: 0.0001, price: 80000, rawTs: '3001' });
  assert.equal(l.value, 0.0002, '两笔都要记');
});

test('乱序成交不破坏账本（先卖后买，净额正确）', () => {
  const l = new PositionLedger({});
  l.reset(0.001);
  l.applyFill({ orderId: 'a', side: 'sell', sizeBase: 0.0004, price: 81000, rawTs: '4001' });
  l.applyFill({ orderId: 'b', side: 'buy', sizeBase: 0.0001, price: 80000, rawTs: '4000' });  // 更早
  l.applyFill({ orderId: 'c', side: 'sell', sizeBase: 0.0003, price: 81500, rawTs: '4002' });
  assert.equal(l.value, 0.0004);  // 0.001 - 0.0004 + 0.0001 - 0.0003
});

test('重启后从持久化账本继续，幂等键仍在', () => {
  const l = new PositionLedger({});
  l.reset(0);
  const f = { orderId: 'p1', side: 'buy', sizeBase: 0.0003, price: 80000, rawTs: '5000' };
  l.applyFill(f);
  assert.equal(l.value, 0.0003);

  const restored = new PositionLedger(JSON.parse(JSON.stringify(l.toJSON())));
  assert.equal(restored.value, 0.0003, '重启后账本值不变');
  const dup = restored.applyFill(f);
  assert.equal(dup.duplicate, true, '重启后仍能识别重复成交');
  assert.equal(restored.value, 0.0003);

  restored.applyFill({ orderId: 'p2', side: 'sell', sizeBase: 0.0001, price: 81000, rawTs: '5001' });
  assert.equal(restored.value, 0.0002, '继续累加正确');
});

test('reset 重锚基线但不复活已记录的成交', () => {
  const l = new PositionLedger({});
  l.reset(0);
  const f = { orderId: 'r1', side: 'buy', sizeBase: 0.0005, price: 80000, rawTs: '6000' };
  l.applyFill(f);
  assert.equal(l.value, 0.0005);

  l.reset(0.002);   // 人工重锚到交易所真值
  assert.equal(l.value, 0.002);
  assert.equal(l.resetCount, 2);

  const dup = l.applyFill(f);
  assert.equal(dup.duplicate, true, '重锚后旧成交仍不会重复记账');
  assert.equal(l.value, 0.002);
});

test('diff 给出交易所真值与本地预期之差', () => {
  const l = new PositionLedger({});
  l.reset(0);
  l.applyFill({ orderId: 'd1', side: 'buy', sizeBase: 0.0002, price: 80000, rawTs: '7000' });
  assert.equal(l.diff(0.0002), 0);
  assert.equal(l.diff(0.0005), 0.0003);
  assert.equal(l.diff(0), -0.0002);
});

test('浮点累加不产生 1e-17 级脏值', () => {
  const l = new PositionLedger({});
  l.reset(0);
  for (let i = 0; i < 7; i++) {
    l.applyFill({ orderId: `f${i}`, side: 'buy', sizeBase: 0.0001, price: 80000, rawTs: String(8000 + i) });
  }
  assert.equal(l.value, 0.0007, '7 × 0.0001 必须精确等于 0.0007');
});

test('fillKey 对不同维度敏感', () => {
  const base = { orderId: 'x', side: 'buy', sizeBase: 0.0001, price: 100, rawTs: '1' };
  assert.notEqual(fillKey(base), fillKey({ ...base, side: 'sell' }));
  assert.notEqual(fillKey(base), fillKey({ ...base, rawTs: '2' }));
  assert.notEqual(fillKey(base), fillKey({ ...base, price: 101 }));
  assert.equal(fillKey(base), fillKey({ ...base }));
});