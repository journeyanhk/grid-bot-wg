// Propr 四模式工厂与启动护栏测试（Review1 P0 修复验证）。
// 关键：护栏必须在真实创建入口 createExchange() 生效，而不是只在测试里直接调函数。
import { strict as assert } from 'node:assert';
import { createExchange } from '../src/exchange/propr/index.js';
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
    // 合法配置通过护栏后，才轮到「尚未实现」错误（证明校验顺序在分流之前）
    assert.throws(
      () => createExchange({ mode: 'sim-write', apiKey: 'pk_live_x', accountId: 'a-1234567890', allowChallenge: false }),
      /Review 3/,
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
