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
  assert.equal(await ex.setLeverage(0, 2), null, '杠杆调用应返回 null（不支持），不告警');
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

{
  // paired：对腿只在"有反向仓"时才 reduceOnly；未配置 paired 时不参与决策
  const ex = new ProprExchange({ mode: 'paper', gridSidePolicy: 'paired' });
  await ex.init();
  assert.equal(ex.resolveReduceOnly({ side: 'sell' }), false, '空仓时卖单是开仓');
  assert.equal(ex.resolveReduceOnly({ side: 'buy' }), false);
  ex._paper.placeLimitOrder({ side: 'buy', price: 79000, sizeBase: 0.001, positionSide: 'long' });
  ex._paper.onPrice(78999);
  assert.equal(ex.resolveReduceOnly({ side: 'sell' }), true, '有多仓时卖对腿必须减仓');
  assert.equal(ex.resolveReduceOnly({ side: 'buy' }), false);
  ex._paper.placeLimitOrder({ side: 'sell', price: 81000, sizeBase: 0.001, positionSide: 'long', reduceOnly: true });
  ex._paper.onPrice(81001);
  assert.equal(ex.resolveReduceOnly({ side: 'sell' }), false, '平掉后回到开仓');

  const ex2 = new ProprExchange({ mode: 'paper' });
  assert.equal(ex2.resolveReduceOnly({ side: 'sell' }), undefined, '非 paired 模式不参与决策');
  ex.stop(); ex2.stop();
}

{
  // positionSide 推导：bot 不传该字段
  const ex = new ProprExchange({ mode: 'paper' });
  await ex.init();
  await ex.placeLimitOrder({ side: 'buy', price: 78000, sizeBase: 0.001, reduceOnly: false, levelIndex: 0 });
  await ex.placeLimitOrder({ side: 'sell', price: 82000, sizeBase: 0.001, reduceOnly: false, levelIndex: 6 });
  const rows = [...ex._paper.orders.values()];
  assert.deepEqual(rows.map((o) => o.positionSide), ['long', 'short']);
  ex.stop();
}

{
  // sim-write 的线上 payload 必须带 positionSide 与 GTX
  const posted = [];
  const fake = { writeAttemptCount: 0, post: async (route, args, body) => { posted.push(body.orders[0]); return { data: [{ orderId: 'o1' }] }; } };
  const ex = new ProprExchange({ mode: 'sim-write', accountId: 'urn:prp-account:x', apiKey: 'k', timeInForce: 'GTX' });
  ex.client = fake;
  ex.writer = new (await import('../src/exchange/pr/write.js')).ProprWriter({ client: fake, accountId: 'urn:prp-account:x', asset: 'BTC' });
  await ex.placeLimitOrder({ side: 'buy', price: 76000, sizeBase: 0.001, reduceOnly: false, levelIndex: 0 });
  await ex.placeLimitOrder({ side: 'sell', price: 80000, sizeBase: 0.001, reduceOnly: true, levelIndex: 5 });
  assert.equal(posted[0].positionSide, 'long');
  assert.equal(posted[0].timeInForce, 'GTX');
  assert.equal(posted[1].positionSide, 'long', 'reduceOnly 卖单平的是多仓');
  assert.equal(posted[1].reduceOnly, true);
  ex.stop();
}

console.log('✓ propr-adapter.test.js 全部通过');