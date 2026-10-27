// 适配器：模式硬拒绝、paper 基本契约、shadow 写不可达。
import { strict as assert } from 'node:assert';
import { ProprExchange } from '../src/exchange/pr/propr.js';
import { ProprReadOnlyError } from '../src/exchange/pr/errors.js';

{
  // challenge / live 必须在构造时就被拒绝
  for (const mode of ['live', 'challenge', 'CHALLENGE']) {
    assert.throws(() => new ProprExchange({ mode }), /拒绝/, mode);
  }
}

{
  // paper：无需密钥即可 init；下单进本地账本；不修改杠杆
  const ex = new ProprExchange({ mode: 'paper', startBalance: 5000 });
  await ex.init();
  const markets = await ex.getMarkets();
  assert.equal(markets.length, 1);
  assert.equal(markets[0].symbol, 'BTC');
  const r = await ex.placeLimitOrder({ side: 'buy', price: 78000, sizeBase: 0.001, positionSide: 'long', reduceOnly: false, levelIndex: 1 });
  assert.ok(r.orderId);
  assert.equal(ex.getOpenOrders().length, 1);
  assert.equal(ex.getPositions().long, null);
  const err = await new Promise((resolve) => { ex.once('error', resolve); ex.setLeverage(0, 2); });
  assert.match(err.message, /不修改杠杆/);
  ex.stop();
}

{
  // paper：非 reduceOnly 的反向单会开出第二侧 → dualSide=true
  const ex = new ProprExchange({ mode: 'paper' });
  await ex.init();
  ex._paper.placeLimitOrder({ side: 'buy', price: 79000, sizeBase: 0.001, positionSide: 'long' });
  ex._paper.onPrice(78999);
  ex._paper.placeLimitOrder({ side: 'sell', price: 81000, sizeBase: 0.001, positionSide: 'short' });
  ex._paper.onPrice(81001);
  const p = ex.getPositions();
  assert.equal(p.dualSide, true);
  assert.equal(p.long.size, 0.001);
  assert.equal(p.short.size, 0.001);
  assert.equal(ex.getPosition().dualSide, true);
  assert.equal(ex.getPosition().side, 'long', 'getPosition 返回其中一侧，不合并');
  ex.stop();
}

{
  // shadow：写路径直接拒绝
  const ex = new ProprExchange({ mode: 'shadow' });
  await assert.rejects(() => ex.placeLimitOrder({ side: 'buy', price: 1, sizeBase: 0.001, positionSide: 'long' }), ProprReadOnlyError);
  await assert.rejects(() => ex.cancelAll(), ProprReadOnlyError);
  await assert.rejects(() => ex.closePosition(), ProprReadOnlyError);
}

console.log('✓ propr-adapter.test.js 全部通过');