// Paper 账本：long/short 两本账、reduceOnly、双边持仓、手续费。
import { strict as assert } from 'node:assert';
import { ProprPaper } from '../src/exchange/pr/paper.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

{
  // 买单成交 → 多仓；按 maker 计费
  const p = new ProprPaper({ startBalance: 5000 });
  const { orderId } = p.placeLimitOrder({ side: 'buy', price: 79000, sizeBase: 0.004, positionSide: 'long' });
  assert.ok(orderId);
  const fills = p.onPrice(78999);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].feeRate, 0.00015);
  near(fills[0].fee, 79000 * 0.004 * 0.00015);
  assert.equal(p.getPositions().length, 1);
  assert.equal(p.getPositions()[0].side, 'long');
  near(p.getPositions()[0].size, 0.004);
  near(p.equity(79000), 5000 - fills[0].fee);
  near(p.equity(79500), 5000 - fills[0].fee + 0.004 * 500);
}

{
  // 平仓腿必须 reduceOnly；减到 0 后 realized 正确
  const p = new ProprPaper({ startBalance: 5000 });
  p.placeLimitOrder({ side: 'buy', price: 79000, sizeBase: 0.004, positionSide: 'long' });
  const [open] = p.onPrice(78999);
  p.placeLimitOrder({ side: 'sell', price: 79600, sizeBase: 0.004, positionSide: 'long', reduceOnly: true });
  const [close] = p.onPrice(79601);
  near(close.realizedPnl, 600 * 0.004);
  assert.equal(p.getPositions().length, 0);
  const expected = 5000 - open.fee - close.fee + 2.4;
  near(p.equity(79600), expected);
}

{
  // 无仓可减 → 拒单（code 13056）
  const p = new ProprPaper({ startBalance: 5000 });
  const err = (() => { try { p.placeLimitOrder({ side: 'sell', price: 80000, sizeBase: 0.004, positionSide: 'long', reduceOnly: true }); return null; } catch (e) { return e; } })();
  assert.ok(err);
  assert.equal(err.code, 13056);
  assert.equal(err.benign, true);
}

{
  // 非 reduceOnly 的反向单会开出第二个仓位 —— 这就是 Propr 的双边陷阱
  const p = new ProprPaper({ startBalance: 5000 });
  p.placeLimitOrder({ side: 'buy', price: 79000, sizeBase: 0.004, positionSide: 'long' });
  p.onPrice(78999);
  p.placeLimitOrder({ side: 'sell', price: 81000, sizeBase: 0.004, positionSide: 'short' }); // reduceOnly=false
  p.onPrice(81001);
  assert.equal(p.dualSide, true);
  assert.equal(p.getPositions().length, 2);
  // 净敞口 0，两边各自浮盈；代价是两倍手续费与两份额度
  const fees = 0.004 * 79000 * 0.00015 + 0.004 * 81000 * 0.00015;
  near(p.equity(80000), 5000 - fees + 0.004 * 1000 + 0.004 * 1000);
}

{
  // 同一侧加仓按加权均价合并
  const p = new ProprPaper({ startBalance: 5000 });
  p.placeLimitOrder({ side: 'buy', price: 79000, sizeBase: 0.002, positionSide: 'long' });
  p.onPrice(78999);
  p.placeLimitOrder({ side: 'buy', price: 78000, sizeBase: 0.002, positionSide: 'long' });
  p.onPrice(77999);
  const pos = p.getPositions()[0];
  near(pos.size, 0.004);
  near(pos.entryPrice, 78500);
  near(p.equity(78500), 5000 - 0.002 * 79000 * 0.00015 - 0.002 * 78000 * 0.00015);
}

{
  // 未触及价格的挂单不成交
  const p = new ProprPaper({ startBalance: 5000 });
  p.placeLimitOrder({ side: 'buy', price: 79000, sizeBase: 0.004, positionSide: 'long' });
  assert.equal(p.onPrice(79000.5).length, 0);
  assert.equal(p.onPrice(79000).length, 1);
}

console.log('✓ propr-paper.test.js 全部通过');