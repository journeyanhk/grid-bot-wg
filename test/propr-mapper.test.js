// Propr 映射层与市场精度工具测试（纯函数，无网络）。
import { strict as assert } from 'node:assert';
import {
  mapProprOrder, mapProprPosition, mapProprTrade, mapProprMargin, mapProprError,
  netPositionFromViews, toInternalStatus, fromInternalStatus, isLiveStatus,
} from '../src/exchange/propr/mapper.js';
import {
  buildMarket, roundQty, roundPrice, assertOrderPrecision, toStepSize,
  PROPR_MAKER_FEE, PROPR_TAKER_FEE,
} from '../src/exchange/propr/market.js';
import { ProprAPIError } from '../src/exchange/propr/propr-sdk.js';

const RAW_ORDER = {
  orderId: 'urn:prp-order:1', intentId: '01ABC', orderGroupId: null, exchangeOrderId: null,
  exchange: 'hyperliquid', productType: 'perp', asset: 'BTC', base: 'BTC', quote: 'USDC',
  type: 'limit', side: 'buy', positionSide: 'long', timeInForce: 'GTC',
  quantity: '0.001', price: '43242.3', reduceOnly: false, closePosition: false,
  cumulativeQuantity: '0.0004', cumulativeQuote: '17.3', averageFillPrice: '43250.5',
  status: 'partially_filled', createdAt: '2026-09-23T02:19:00.887Z', updatedAt: '2026-09-23T02:19:05.000Z',
};

{
  // 订单映射：intentId→clientOrderId、positionSide 保真、状态机、ISO→epoch ms
  const o = mapProprOrder(RAW_ORDER, { levelIndex: 7 });
  assert.equal(o.orderId, 'urn:prp-order:1');
  assert.equal(o.clientOrderId, '01ABC', 'intentId 必须映射为幂等键 clientOrderId');
  assert.equal(o.marketId, 'BTC');
  assert.equal(o.side, 'buy');
  assert.equal(o.positionSide, 'long', 'positionSide 必须保真');
  assert.equal(o.price, 43242.3);
  assert.equal(o.sizeBase, 0.001);
  assert.equal(o.filledBase, 0.0004);
  assert.equal(o.averageFillPrice, 43250.5);
  assert.equal(o.status, 'partially_filled');
  assert.equal(o.internalStatus, 'partially_filled');
  assert.equal(o.levelIndex, 7);
  assert.equal(o.createdAt, Date.parse('2026-09-23T02:19:00.887Z'));
  assert.equal(o.reduceOnly, false);
}

{
  // 状态映射双向
  assert.equal(toInternalStatus('pending'), 'submitted');
  assert.equal(toInternalStatus('open'), 'open');
  assert.equal(toInternalStatus('weird'), 'unknown');
  assert.equal(fromInternalStatus('submitted'), 'pending');
  assert.equal(isLiveStatus('partially_filled'), true);
  assert.equal(isLiveStatus('filled'), false);
}

{
  // 持仓/成交映射
  const p = mapProprPosition({ positionId: 'p1', base: 'BTC', positionSide: 'long', quantity: '0.002', entryPrice: '86000', markPrice: '86500', unrealizedPnl: '1.0', leverage: '1', marginMode: 'cross' });
  assert.equal(p.sizeBase, 0.002);
  assert.equal(p.entryPrice, 86000);
  assert.equal(p.unrealizedPnl, 1);

  const t = mapProprTrade({ tradeId: 't1', orderId: 'o1', base: 'BTC', side: 'sell', positionSide: 'long', type: 'reduce', quantity: '0.001', price: '86555', fee: '0.03895', feeRate: '0.00045', realizedPnl: '-0.001', positionSizeBefore: '0.002', executedAt: '2026-09-23T02:47:00.000Z' });
  assert.equal(t.type, 'reduce');
  assert.equal(t.fee, 0.03895);
  assert.equal(t.positionSizeBefore, 0.002);
  assert.equal(t.executedAt, Date.parse('2026-09-23T02:47:00.000Z'));

  const m = mapProprMargin({ configId: 'c1', asset: 'BTC', leverage: '1', marginMode: 'cross' });
  assert.equal(m.leverage, 1);
  assert.equal(m.marketId, 'BTC');
}

{
  // 净仓聚合（Propr 为 net，通常一条；两条时做净额）
  assert.equal(netPositionFromViews([]), null);
  const longOnly = netPositionFromViews([{ positionId: 'p', marketId: 'BTC', positionSide: 'long', sizeBase: 0.002, entryPrice: 86000, unrealizedPnl: 1 }]);
  assert.equal(longOnly.sizeBase, 0.002);
  assert.equal(longOnly.positionSide, 'long');
  const shortOnly = netPositionFromViews([{ positionId: 'p', marketId: 'BTC', positionSide: 'short', sizeBase: 0.001, entryPrice: 87000, unrealizedPnl: -0.5 }]);
  assert.equal(shortOnly.sizeBase, -0.001, '空仓必须返回负的带符号净仓');
  assert.equal(shortOnly.positionSide, 'short');
  const both = netPositionFromViews([
    { positionId: 'l', marketId: 'BTC', positionSide: 'long', sizeBase: 0.002, entryPrice: 86000, unrealizedPnl: 1 },
    { positionId: 's', marketId: 'BTC', positionSide: 'short', sizeBase: 0.001, entryPrice: 87000, unrealizedPnl: -0.5 },
  ]);
  assert.equal(both.sizeBase, 0.001);
  assert.equal(both.unrealizedPnl, 0.5);
}

{
  // 错误映射：分类 + 可重试 + 脱敏
  const idem = mapProprError(new ProprAPIError(500, 13084, 'order_saga_idempotency_check_failed'));
  assert.equal(idem.kind, 'idempotency_conflict');
  assert.equal(idem.retryable, false);
  assert.equal(mapProprError(new ProprAPIError(429, null, 'slow down')).retryable, true);
  assert.ok(!mapProprError(new Error('bad pk_live_SECRET')).message.includes('pk_live_SECRET'));
}

{
  // 市场对象：HL BTC 保守精度 + net 持仓模式 + 费率
  const market = buildMarket({
    base: 'BTC', quote: 'USDC',
    marginConfig: { configId: 'c1', asset: 'BTC', leverage: '1', marginMode: 'cross' },
    leverageLimits: { defaults: { crypto: 2 }, overrides: { BTC: 10 } },
    markPrice: 90000,
  });
  assert.equal(market.marketId, 'BTC');
  assert.equal(market.stepSize, 0.00001);
  assert.equal(market.stepPrice, 0.1);
  assert.equal(market.sizeDecimals, 5);
  assert.equal(market.priceDecimals, 1);
  assert.equal(market.minOrderNotional, 10);
  assert.equal(market.maxLeverage, 10);
  assert.equal(market.makerFee, PROPR_MAKER_FEE);
  assert.equal(market.takerFee, PROPR_TAKER_FEE);
  assert.equal(market.positionMode, 'net');
  assert.equal(toStepSize(5), 0.00001);

  // 无 override 时回退 defaults.crypto
  const ethLike = buildMarket({ base: 'FOO', leverageLimits: { defaults: { crypto: 2 }, overrides: {} } });
  assert.equal(ethLike.maxLeverage, 2);
}

{
  // 取整：数量向下、价格就近
  const market = buildMarket({});
  assert.equal(roundQty(0.0012349, market), 0.00123);
  assert.equal(roundPrice(43242.349, market), 43242.3);
  assert.equal(roundPrice(43242.36, market), 43242.4);
}

{
  // 精度/最小名义本地校验（服务端不校验，必须本地拦截）
  const market = buildMarket({});
  assert.deepEqual(assertOrderPrecision({ price: 90000, sizeBase: 0.001 }, market), { ok: true, notional: 90 });
  assert.throws(() => assertOrderPrecision({ price: 90000, sizeBase: 0.0001 }, market), /名义价值 9.00 低于下限 10/);
  assert.throws(() => assertOrderPrecision({ price: 90000.05, sizeBase: 0.001 }, market), /不符合步长/);
  assert.throws(() => assertOrderPrecision({ price: 90000, sizeBase: 0.000015 }, market), /不符合步长/);
  assert.throws(() => assertOrderPrecision({ price: 90000, sizeBase: 0 }, market), /数量非法/);
}

console.log('propr-mapper.test.js 全部通过');
