// Propr 四模式工厂与启动护栏测试（Review1 P0 + Review2 扩展）。
// 关键：护栏必须在真实创建入口 createExchange() 生效；shadow 模式写请求数必须恒为 0。
import { strict as assert } from 'node:assert';
import { createExchange } from '../src/exchange/propr/index.js';
import { createReadOnlyClient } from '../src/exchange/propr/shadow.js';
import { ProprReadOnlyError } from '../src/exchange/propr/errors.js';
import { getConfig } from '../src/config.js';

async function main() {
  {
    // paper：返回可用的本地适配器（无 Key），并验证基础撮合契约
    const ex = createExchange({ mode: 'paper', startBalance: 5000, feeRate: 0.0005 });
    assert.equal(ex.mode, 'paper');
    assert.equal(ex.dataSource, 'synthetic');

    const markets = await ex.getMarkets();
    assert.equal(markets.length, 1);
    assert.equal(markets[0].marketId, 'BTC');
    assert.equal(markets[0].positionMode, 'net');

    const { orderId } = await ex.placeLimitOrder({ marketId: 'BTC', side: 'buy', price: 90000, sizeBase: 0.001, reduceOnly: false, levelIndex: 1 });
    const open = await ex.fetchOpenOrders('BTC');
    assert.equal(open.length, 1);
    assert.equal(open[0].orderId, orderId);
    assert.equal(open[0].side, 'buy');

    await ex.cancelAll('BTC');
    assert.equal((await ex.fetchOpenOrders('BTC')).length, 0);
    ex.stop();
  }

  {
    // shadow：返回只读真实账户 + 本地撮合的 ShadowExchange（构造阶段不联网）
    const ex = createExchange({ mode: 'shadow', apiKey: 'pk_live_x', accountId: 'a-1234567890' });
    assert.equal(ex.mode, 'shadow');
    assert.equal(ex.constructor.name, 'ShadowExchange');
    assert.equal(ex.dataSource, null, '未 init 前 dataSource 为 null');
  }

  {
    // sim-write / challenge：护栏通过后返回真实适配器；写路径在 Review 3 前显式拒绝
    const ex = createExchange({ mode: 'sim-write', apiKey: 'pk_live_x', accountId: 'a-1234567890', allowChallenge: false });
    assert.equal(ex.mode, 'sim-write');
    assert.equal(ex.positionMode, 'net');
    assert.equal(ex.constructor.name, 'ProprExchange');
    await assert.rejects(() => ex.placeLimitOrder({}), /Review 3/);
  }

  {
    // createReadOnlyClient：读方法透传，写方法一律抛错且不产生任何调用（shadow 写请求数=0）
    const calls = [];
    const fake = {
      accountId: 'acc',
      health: async () => ({ status: 'OK' }),
      getPositions: async () => [],
      getChallengeAttempt: async () => ({ account: {} }),
      createOrder: async () => calls.push('createOrder'),
      createOrders: async () => calls.push('createOrders'),
      cancelOrder: async () => calls.push('cancelOrder'),
      cancelAllOrders: async () => calls.push('cancelAllOrders'),
      setLeverage: async () => calls.push('setLeverage'),
      updateMarginConfig: async () => calls.push('updateMarginConfig'),
      marketBuy: async () => calls.push('marketBuy'),
      marketSell: async () => calls.push('marketSell'),
      limitBuy: async () => calls.push('limitBuy'),
      limitSell: async () => calls.push('limitSell'),
      closePosition: async () => calls.push('closePosition'),
    };
    const ro = createReadOnlyClient(fake);
    assert.deepEqual(await ro.health(), { status: 'OK' });
    assert.deepEqual(await ro.getPositions(), []);
    assert.equal(ro.accountId, 'acc');
    assert.throws(() => ro.createOrder({}), ProprReadOnlyError);
    assert.throws(() => ro.createOrders([]), ProprReadOnlyError);
    assert.throws(() => ro.cancelOrder('x'), ProprReadOnlyError);
    assert.throws(() => ro.cancelAllOrders('BTC'), ProprReadOnlyError);
    assert.throws(() => ro.setLeverage('BTC', 1), ProprReadOnlyError);
    assert.throws(() => ro.updateMarginConfig('c', 'BTC', 1), ProprReadOnlyError);
    assert.throws(() => ro.marketBuy('BTC', '0.001'), ProprReadOnlyError);
    assert.throws(() => ro.limitSell('BTC', '0.001', '100000'), ProprReadOnlyError);
    assert.throws(() => ro.closePosition('BTC'), ProprReadOnlyError);
    assert.equal(calls.length, 0, 'shadow 写请求数必须为 0');
  }

  {
    // challenge 缺 PR_ALLOW_CHALLENGE：真实入口必须拒绝创建
    assert.throws(
      () => createExchange({ mode: 'challenge', apiKey: 'pk_live_x', accountId: 'a-1234567890', allowChallenge: false }),
      /PR_ALLOW_CHALLENGE=YES/,
    );
  }

  {
    // shadow 缺 Key / 缺 accountId：真实入口必须拒绝
    assert.throws(() => createExchange({ mode: 'shadow', accountId: 'a-1234567890' }), /PROPR_API_KEY/);
    assert.throws(() => createExchange({ mode: 'shadow', apiKey: 'pk_live_x' }), /PROPR_ACCOUNT_ID/);
  }

  {
    // 白名单不命中：真实入口必须拒绝
    assert.throws(
      () => createExchange({ mode: 'sim-write', apiKey: 'pk_live_x', accountId: 'a-1234567890', allowedAccountIds: ['other'] }),
      /白名单/,
    );
  }

  {
    // 非法 PR_MODE 必须 fail closed（不得静默降级为 paper）
    const prev = process.env.PR_MODE;
    process.env.PR_MODE = 'sim_writ';
    try {
      assert.throws(() => getConfig(), /非法 PR_MODE=sim_writ/);
    } finally {
      if (prev === undefined) delete process.env.PR_MODE; else process.env.PR_MODE = prev;
    }
  }
}

main().then(() => console.log('propr-modes.test.js 全部通过')).catch((err) => { console.error(err); process.exit(1); });
