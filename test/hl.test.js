// Hyperliquid (HL) adapter tests: market parsing, isolated position fields and
// userFills cursor handling.  Network calls are stubbed with a fake signer and
// mocked fetch, mirroring test/lighter.test.js.
import { strict as assert } from 'node:assert';
import { parseMarkets, parseCandles, toExchangeInteger } from '../src/exchange/hl/market.js';
import { HyperliquidExchange } from '../src/exchange/hl/hyperliquid.js';

const mkSigner = () => ({ start: async () => true, stop: async () => true, request: async () => ({}) });
const mkEx = () => new HyperliquidExchange({
  accountAddress: '0xabc', agentPrivateKey: 'test-only',
  signer: mkSigner(),
});

{
  // 市场解析：只保留 io dex 市场，HIP-3 资产按名称寻址
  const data = {
    universe: [
      { name: 'io:ANTH', szDecimals: 3, pxDecimals: 1, onlyIsolated: true, openInterest: 18.4e6 },
      { name: 'io:SNDK', szDecimals: 3, pxDecimals: 1, onlyIsolated: true, openInterest: 5.9e6 },
      { name: 'BTC', szDecimals: 5, pxDecimals: 1, onlyIsolated: false, openInterest: 1e9 },
    ],
    assetCtxs: [
      { markPx: '1994.5', maxLeverage: '6' },
      { markPx: '1783.2', maxLeverage: '10' },
      { markPx: '97000', maxLeverage: '50' },
    ],
  };
  const rows = parseMarkets(data);
  assert.equal(rows.length, 2, '只保留 io dex 市场');
  assert.equal(rows[0].name, 'io:ANTH');
  assert.equal(rows[0].symbol, 'ANTH');
  assert.equal(rows[0].stepSize, 0.001);
  assert.equal(rows[0].stepPrice, 0.1);
  assert.equal(rows[0].maxLeverage, 6, 'io:ANTH 最大杠杆 6x');
  assert.equal(rows[0].onlyIsolated, true, 'io 系强制逐仓');
  assert.equal(rows[0].minOrderNotional, 10, '最小名义 $10');
  assert.equal(rows[1].name, 'io:SNDK');
}

{
  // K 线解析（candleSnapshot 返回 ms 时间戳）
  const candles = parseCandles({ candles: [
    { t: 1725000000000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
    { t: 1725003600000, o: '100.5', h: '102', l: '100', c: '101', v: '12' },
  ] });
  assert.equal(candles.length, 2);
  assert.equal(candles[0].time, 1725000000000);
  assert.equal(candles[1].close, 101);
}

{
  // 精度转换
  assert.equal(toExchangeInteger(0.005, 3, 'down'), 5);
  assert.equal(toExchangeInteger(1994.55, 1, 'nearest'), 19946);
}

{
  // 逐仓字段解析：强平价/杠杆/保证金模式从 isolated position 读取
  const ex = mkEx();
  ex.markets.set(0, { marketId: 0, name: 'io:ANTH', symbol: 'ANTH', displayName: 'io:ANTH', sizeDecimals: 3, priceDecimals: 1, maxLeverage: 6, onlyIsolated: true, minOrderNotional: 10, minOrderSize: 0.001, stepSize: 0.001, stepPrice: 0.1 });
  let calls = 0;
  ex._postInfo = async (payload) => {
    calls++;
    if (payload.type === 'clearinghouseState') {
      return { marginSummary: { accountValue: '150.5', totalMarginUsed: '37.2' }, assetPositions: [{ position: { coin: 'io:ANTH', szi: '0.005', entryPx: '1990', unrealizedPnl: '0.02', realizedPnl: '0.1', liquidationPx: '1700', leverage: { value: 3 }, marginMode: 'isolated' } }] };
    }
    if (payload.type === 'userFills') return [];
    if (payload.type === 'frontendOpenOrders') return [];
    if (payload.type === 'metaAndAssetCtxs') return { universe: [], assetCtxs: [] };
    return [];
  };
  await ex._refreshAccount();
  assert.equal(ex.balance, 150.5);
  const pos = ex.getPosition(0);
  assert.ok(pos, '逐仓仓位应存在');
  assert.equal(pos.sizeBase, 0.005);
  assert.equal(pos.entryPrice, 1990);
  assert.equal(pos.liquidationPrice, 1700);
  assert.equal(pos.leverage, 3);
  assert.equal(pos.marginMode, 'isolated', 'HL 强制逐仓');
}

{
  // userFills 游标：成交按 oid 匹配本地跟踪订单并 emit fill
  const ex = mkEx();
  ex.markets.set(0, { marketId: 0, name: 'io:ANTH', symbol: 'ANTH', displayName: 'io:ANTH', sizeDecimals: 3, priceDecimals: 1, maxLeverage: 6, onlyIsolated: true, minOrderNotional: 10, minOrderSize: 0.001, stepSize: 0.001, stepPrice: 0.1 });
  ex._tracked.set('12345', { orderId: '12345', marketId: 0, levelIndex: 5, side: 'sell', price: 2000, sizeBase: 0.005, reduceOnly: false, placedAt: Date.now(), seen: true });
  let fill = null;
  ex.on('fill', (f) => { fill = f; });
  ex._postInfo = async (payload) => {
    if (payload.type === 'userFills') {
      return [{ coin: 'io:ANTH', oid: 12345, side: 'A', px: '2000', sz: '0.005', tid: 999, pnl: '0.05', time: 1725000000000 }, { coin: 'io:ANTH', oid: 99999, side: 'A', px: '2001', sz: '0.005', tid: 1000, pnl: '0.01', time: 1725000001000 }];
    }
    return [];
  };
  await ex._refreshFills();
  assert.ok(fill, 'userFills 应确认成交并 emit fill');
  assert.equal(fill.orderId, '12345');
  assert.equal(fill.price, 2000);
  assert.equal(fill.sizeBase, 0.005);
  assert.ok(!ex._tracked.has('12345'), '成交后删除跟踪');
  assert.ok(Math.abs(ex.realizedPnl - 0.06) < 1e-9, '两条 fill 的 pnl 累加');
  // 重复拉取不重复 emit（去重）
  fill = null;
  await ex._refreshFills();
  assert.ok(!fill, '同一 fill 游标内不重复 emit');
}

{
  // 空快照守卫：空活跃快照 + 本地跟踪多 -> 不做 gone 判定
  const ex = mkEx();
  ex.markets.set(0, { marketId: 0, name: 'io:ANTH', symbol: 'ANTH', displayName: 'io:ANTH', sizeDecimals: 3, priceDecimals: 1, maxLeverage: 6, onlyIsolated: true, minOrderNotional: 10, minOrderSize: 0.001, stepSize: 0.001, stepPrice: 0.1 });
  for (let i = 0; i < 12; i++) {
    ex._tracked.set('o-' + i, { orderId: 'o-' + i, marketId: 0, levelIndex: i, side: 'sell', price: 2000 + i, sizeBase: 0.005, reduceOnly: false, placedAt: Date.now() - 120_000, seen: true, goneFirstAt: null });
  }
  ex._postInfo = async () => [];
  await ex._refreshOrders();
  for (let i = 0; i < 12; i++) {
    assert.ok(ex._tracked.has('o-' + i), '空快照轮不删跟踪');
  }
}

console.log('hl tests passed');