// Propr 映射：M0 实测过的三个坑 + 下单语义。
import { strict as assert } from 'node:assert';
import {
  parseAccount, parsePosition, livePositions, splitPositions, parseOrder, openOrders,
  parseTrade, feeTier, freshTrades, sumTrades, resolvePositionSide, buildLimitOrder, closeSide,
} from '../src/exchange/pr/mapper.js';

{
  // equity 取 marginBalance，而不是 balance + uPnl（实测两者不等时以 marginBalance 为准）
  const a = parseAccount({ data: { balance: '5011.83361', marginBalance: '5011.83361', totalUnrealizedPnl: '0', availableBalance: '3083.726762', highWaterMark: '5016.002462' } });
  assert.equal(a.equity, 5011.83361);
  assert.equal(a.available, 3083.726762);
  assert.equal(a.highWaterMark, 5016.002462);
  // marginBalance 缺失时退化
  const b = parseAccount({ data: { balance: '100', totalUnrealizedPnl: '-2.5' } });
  assert.equal(b.equity, 97.5);
}

{
  // 平仓残留：quantity 0 / status closed 都要被过滤
  const rows = [
    { positionSide: 'long', quantity: '0', status: 'closed', entryPrice: '80746' },
    { positionSide: 'short', quantity: '0', status: 'open', entryPrice: '80660' },
    { positionSide: 'long', quantity: '0.012', status: 'open', entryPrice: '79000', markPrice: '79743', liquidationPrice: '71000' },
  ];
  assert.equal(livePositions(rows).length, 1);
  const sp = splitPositions(rows);
  assert.equal(sp.long.size, 0.012);
  assert.equal(sp.short, null);
  assert.equal(sp.dualSide, false);
  assert.equal(sp.netSize, 0.012);
}

{
  // 双边持仓必须被识别
  const sp = splitPositions([
    { positionSide: 'long', quantity: '0.012', status: 'open' },
    { positionSide: 'short', quantity: '0.012', status: 'open' },
  ]);
  assert.equal(sp.dualSide, true);
  assert.equal(sp.netSize, 0);
}

{
  // 订单：pending 也算未终结
  const os = openOrders([
    { orderId: 'a', status: 'open', side: 'buy', positionSide: 'long', quantity: '0.004', price: '78000', reduceOnly: false },
    { orderId: 'b', status: 'pending', side: 'sell', positionSide: 'short', quantity: '0.004', price: '81000' },
    { orderId: 'c', status: 'filled', side: 'buy', quantity: '0.004' },
    { orderId: 'd', status: 'cancelled' },
  ]);
  assert.deepEqual(os.map((o) => o.orderId), ['a', 'b']);
  assert.equal(os[0].reduceOnly, false);
  assert.equal(parseOrder({ quantity: '0.004', cumulativeQuantity: '0.001' }).filledQty, 0.001);
}

{
  // feeRate 才是真相：liquidityType 全返回 taker，但 0.00015 是 maker
  assert.equal(feeTier({ feeRate: 0.00015, liquidityType: 'taker' }), 'maker');
  assert.equal(feeTier({ feeRate: 0.00045, liquidityType: 'maker' }), 'taker');
  assert.equal(feeTier({ feeRate: 0.00044999 }), 'taker');
  // feeRate 缺失才退回 liquidityType
  assert.equal(feeTier({ feeRate: null, liquidityType: 'maker' }), 'maker');
}

{
  // 成交去重按 tradeId，不按时间
  const seen = new Set();
  const r1 = freshTrades([{ tradeId: 'a' }, { tradeId: 'b' }], seen);
  assert.equal(r1.fresh.length, 2);
  const r2 = freshTrades([{ tradeId: 'b' }, { tradeId: 'c' }], seen);
  assert.equal(r2.fresh.length, 1);
  assert.equal(r2.duplicates, 1);
  const s = sumTrades([{ fee: '0.1', realizedPnl: '2', quoteQuantity: '100' }, { fee: '0.2', realizedPnl: '-1', quoteQuantity: '50' }]);
  assert.equal(Math.round(s.fees * 100) / 100, 0.3);
  assert.equal(s.realized, 1);
  assert.equal(s.quote, 150);
}

{
  // 下单语义：单边持仓下，开/平必须落到正确的 positionSide
  const flat = { long: null, short: null, dualSide: false };
  assert.equal(resolvePositionSide({ side: 'buy', reduceOnly: false, positions: flat }), 'long');
  assert.equal(resolvePositionSide({ side: 'sell', reduceOnly: false, positions: flat }), 'short');
  assert.equal(resolvePositionSide({ side: 'sell', reduceOnly: true, positions: flat }), null, '无仓可减必须拒单');

  const longOnly = { long: { size: 0.004 }, short: null, dualSide: false };
  assert.equal(resolvePositionSide({ side: 'sell', reduceOnly: true, positions: longOnly }), 'long');
  assert.equal(resolvePositionSide({ side: 'buy', reduceOnly: false, positions: longOnly }), 'long', '加多仓合法');
  assert.equal(resolvePositionSide({ side: 'sell', reduceOnly: false, positions: longOnly }), null, '已有多仓不得开空');
  assert.equal(resolvePositionSide({ side: 'buy', reduceOnly: false, positions: { ...longOnly, long: null } }), 'long');

  assert.equal(resolvePositionSide({ side: 'sell', reduceOnly: false, positions: { long: { size: 0.1 }, short: { size: 0.1 }, dualSide: true } }), null);
  assert.equal(closeSide('long'), 'sell');
  assert.equal(closeSide('short'), 'buy');
}

{
  // payload：qty/price 必须是字符串，且带 intentId
  const p = buildLimitOrder({ accountId: 'urn:prp-account:x', asset: 'BTC', side: 'buy', positionSide: 'long', qty: 0.004, price: 78000.5, intentId: '01ABC' });
  assert.equal(p.quantity, '0.004');
  assert.equal(p.price, '78000.5');
  assert.equal(p.exchange, 'hyperliquid');
  assert.equal(p.productType, 'perp');
  assert.equal(p.timeInForce, 'GTC');
  assert.equal(p.quote, 'USDC');
  assert.equal(p.reduceOnly, false);
  assert.throws(() => buildLimitOrder({ accountId: 'x', asset: 'BTC', side: 'buy', positionSide: 'long', qty: 0, price: 1, intentId: 'i' }), /qty/);
  assert.throws(() => buildLimitOrder({ accountId: 'x', asset: 'BTC', side: 'buy', positionSide: 'long', qty: 1, price: 1 }), /intentId/);
  assert.throws(() => buildLimitOrder({ accountId: 'x', asset: 'BTC', side: 'buy', positionSide: 'neutral', qty: 1, price: 1, intentId: 'i' }), /positionSide/);
}

{
  // 成交字段归一（数量/价格/费用全是字符串）
  const t = parseTrade({ tradeId: 'x', quantity: '0.004', price: '79743.5', fee: '0.0478', feeRate: '0.00015', realizedPnl: '-3.93', quoteQuantity: '318.97' });
  assert.equal(t.qty, 0.004);
  assert.equal(t.price, 79743.5);
  assert.equal(t.fee, 0.0478);
  assert.equal(t.feeRate, 0.00015);
  assert.equal(t.realizedPnl, -3.93);
  assert.equal(t.quoteQty, 318.97);
}

{
  // 负数量/字符串数量要归一
  const p = parsePosition({ positionSide: 'short', quantity: '0.012', entryPrice: '80660.5' });
  assert.equal(p.side, 'short');
  assert.equal(p.size, 0.012);
  assert.equal(p.entryPrice, 80660.5);
}

console.log('✓ propr-mapper.test.js 全部通过');