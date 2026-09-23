// Propr shadow 适配器测试：真实行情驱动、只读账户快照、失败不假报空仓、安全错误事件、写请求恒 0。
import { strict as assert } from 'node:assert';
import { createExchange } from '../src/exchange/propr/index.js';

const ACCOUNT = 'acc-1234567890';
const state = {
  positions: [{ positionId: 'p1', base: 'BTC', positionSide: 'long', quantity: '0.002', entryPrice: '86000', markPrice: '86500', unrealizedPnl: '1.0', leverage: '1', marginMode: 'cross' }],
  failPositions: false,
  failAttempt: false,
};
const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('https://api.hyperliquid.xyz/info')) {
    if (body?.type === 'allMids') return jsonResponse({ BTC: '90000' });
  }
  if (u.includes('/health/services')) return jsonResponse({ core: 'OK' });
  if (u.includes('/health')) return jsonResponse({ status: 'OK' });
  if (u.includes('/challenge-attempts/a1')) {
    if (state.failAttempt) return jsonResponse({ message: 'boom pk_live_SECRET' }, 500);
    return jsonResponse({
      attemptId: 'a1', accountId: ACCOUNT, status: 'active', phases: [],
      account: { balance: '5000', marginBalance: '4999.7', availableBalance: '4913.2', highWaterMark: '5000', totalUnrealizedPnl: '-0.3', currency: 'USDC' },
    });
  }
  if (u.includes('/challenge-attempts')) return jsonResponse({ data: [{ attemptId: 'a1', accountId: ACCOUNT, status: 'active' }] });
  if (u.includes('/margin-config/')) return jsonResponse({ configId: 'c1', asset: 'BTC', leverage: '1', marginMode: 'cross' });
  if (u.includes('/leverage-limits/effective')) return jsonResponse({ defaults: { crypto: 2 }, overrides: { BTC: 10 } });
  if (u.includes('/positions')) {
    if (state.failPositions) return jsonResponse({ message: 'positions down' }, 500);
    return jsonResponse({ data: state.positions });
  }
  throw new Error(`unexpected fetch: ${u}`);
};

async function main() {
  const ex = createExchange({ mode: 'shadow', apiKey: 'pk_live_test', accountId: ACCOUNT, base: 'BTC', apiUrl: 'https://api.propr.xyz/v1', timeoutMs: 5000 });
  await ex.init();
  assert.equal(ex.dataSource, 'real');
  assert.equal(ex.feeRate, 0.00015, '未配置 PR_FEE_RATE 时必须用实测 maker 费率');
  assert.equal((await ex.getMarkets())[0].maxLeverage, 10, 'shadow 市场元数据必须来自真实账户');
  assert.equal((await ex.getMarkets())[0].positionMode, 'net');

  // 只读快照：持仓与权益
  assert.equal(ex.proprNetPosition.sizeBase, 0.002);
  assert.equal(ex.proprPositionStale, false);
  assert.equal(ex.proprEquity.balance, 5000);
  assert.equal(ex.proprAccountStale, false);

  // 本地撮合用真实价格：买单价格高于现价应立即成交（不写 Propr）
  const fills = [];
  ex.on('fill', (f) => fills.push(f));
  await ex.placeLimitOrder({ marketId: 'BTC', side: 'buy', price: 90000, sizeBase: 0.001, reduceOnly: false, levelIndex: 3 });
  ex.prices.set('BTC', 89999); // 触发撮合
  ex.matchTick();
  assert.equal(fills.length, 1);
  assert.equal(fills[0].levelIndex, 3);

  // 持仓读取失败：保留上次快照并标 stale，绝不伪装成空仓（Review2 P1）
  const errs = [];
  ex.on('error', (e) => errs.push(e));
  state.failPositions = true;
  await ex._refreshProprAccount();
  assert.equal(ex.proprPositionStale, true, '持仓读取失败必须标 stale');
  assert.equal(ex.proprPositions.length, 1, '失败时必须保留上次已知持仓');
  assert.equal(ex.proprNetPosition.sizeBase, 0.002, '失败时不得把净仓变成 null（假空仓）');
  assert.ok(ex.proprPositionError);
  assert.ok(!JSON.stringify(errs).includes('pk_live_SECRET'), '错误事件必须脱敏');

  // 权益读取失败：保留上次权益并标 stale
  state.failPositions = false;
  state.failAttempt = true;
  await ex._refreshProprAccount();
  assert.equal(ex.proprAccountStale, true);
  assert.equal(ex.proprEquity.balance, 5000, '失败时必须保留上次权益快照');

  // shadow 的 Propr 客户端写方法必须硬禁止
  assert.throws(() => ex.readClient.createOrders([]), /shadow 模式禁止写操作/);
  assert.throws(() => ex.readClient.cancelOrder('x'), /shadow 模式禁止写操作/);

  ex.stop();
}

main()
  .then(() => console.log('propr-shadow.test.js 全部通过'))
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => { globalThis.fetch = realFetch; });
