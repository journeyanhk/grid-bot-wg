// Hyperliquid (HL) adapter tests: market parsing, isolated position fields and
// userFillsByTime incremental confirmation.  Network calls are stubbed with a
// fake signer and mocked fetch, mirroring test/lighter.test.js.
import { strict as assert } from 'node:assert';
import { parseMarkets, parseCandles, toExchangeInteger, roundToSignificantDigits } from '../src/exchange/hl/market.js';
import { HyperliquidExchange } from '../src/exchange/hl/hyperliquid.js';

const mkSigner = () => ({ start: async () => true, stop: async () => true, request: async () => ({}) });
const mkEx = () => new HyperliquidExchange({
  accountAddress: '0xabc', agentPrivateKey: 'test-only',
  signer: mkSigner(),
});
const ANTH = { marketId: 0, name: 'io:ANTH', symbol: 'ANTH', displayName: 'io:ANTH', sizeDecimals: 3, priceDecimals: 3, maxLeverage: 6, onlyIsolated: true, minOrderNotional: 10, minOrderSize: 0.001, stepSize: 0.001, stepPrice: 0.001, makerFee: 0.00015, takerFee: 0.00045 };

{
  // 市场解析：metaAndAssetCtxs 返回数组 [meta, assetCtxs]，只保留 io dex 市场
  const data = [
    { universe: [
      { name: 'io:ANTH', szDecimals: 3, maxLeverage: 6, onlyIsolated: true, openInterest: 18.4e6 },
      { name: 'io:SNDK', szDecimals: 4, maxLeverage: 10, onlyIsolated: true, openInterest: 5.9e6 },
      { name: 'BTC', szDecimals: 5, onlyIsolated: false, openInterest: 1e9 },
    ] },
    [
      { markPx: '1994.5' }, { markPx: '1783.2' }, { markPx: '97000' },
    ],
  ];
  const rows = parseMarkets(data);
  assert.equal(rows.length, 2, '只保留 io dex 市场');
  assert.equal(rows[0].name, 'io:ANTH');
  assert.equal(rows[0].symbol, 'ANTH');
  assert.equal(rows[0].stepSize, 0.001);
  assert.equal(rows[0].stepPrice, 0.001, 'HL 价格小数位 = 6 - szDecimals = 3');
  assert.equal(rows[0].maxLeverage, 6, 'io:ANTH 最大杠杆 6x（来自 universe）');
  assert.equal(rows[0].onlyIsolated, true, 'io 系强制逐仓');
  assert.equal(rows[0].minOrderNotional, 10, '最小名义 $10');
  assert.equal(rows[0].makerFee, 0.00015, '基础 maker 费率 0.015%');
  assert.equal(rows[1].name, 'io:SNDK');
  assert.equal(rows[1].maxLeverage, 10, 'io:SNDK 最大杠杆 10x');
  assert.equal(rows[1].stepPrice, 0.01, 'SNDK szDecimals=4 -> priceDecimals=2');
}

{
  // K 线解析（candleSnapshot 直接返回数组，t 为 ms）
  const candles = parseCandles([
    { t: 1725000000000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
    { t: 1725003600000, o: '100.5', h: '102', l: '100', c: '101', v: '12' },
  ]);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].time, 1725000000000);
  assert.equal(candles[1].close, 101);
}

{
  // 精度转换与 5 位有效数字报价约束
  assert.equal(toExchangeInteger(0.005, 3, 'down'), 5);
  assert.equal(toExchangeInteger(1994.55, 1, 'nearest'), 19946);
  assert.equal(roundToSignificantDigits(1994.56, 5), 1994.6, '报价 5 位有效数字取整');
  assert.equal(roundToSignificantDigits(0.00123456, 5), 0.0012346);
}

{
  // 逐仓字段解析：强平价/杠杆/保证金模式从 isolated position 读取
  const ex = mkEx();
  ex.markets.set(0, ANTH);
  ex._postInfo = async (payload) => {
    if (payload.type === 'clearinghouseState') {
      return { marginSummary: { accountValue: '150.5', totalMarginUsed: '37.2' }, assetPositions: [{ position: { coin: 'io:ANTH', szi: '0.005', entryPx: '1990', unrealizedPnl: '0.02', realizedPnl: '0.1', liquidationPx: '1700', leverage: { value: 3 }, marginMode: 'isolated' } }] };
    }
    if (payload.type === 'userFillsByTime') return [];
    if (payload.type === 'frontendOpenOrders') return [];
    if (payload.type === 'metaAndAssetCtxs') return [{ universe: [] }, []];
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
  // userFillsByTime 增量：按 oid 匹配本地跟踪订单 emit fill；游标推进
  const ex = mkEx();
  ex.markets.set(0, ANTH);
  ex._tracked.set('12345', { orderId: '12345', marketId: 0, levelIndex: 5, side: 'sell', price: 2000, sizeBase: 0.005, reduceOnly: false, placedAt: Date.now(), seen: true });
  let fill = null;
  ex.on('fill', (f) => { fill = f; });
  let calls = 0;
  ex._postInfo = async (payload) => {
    calls++;
    if (payload.type === 'userFillsByTime') {
      if (calls === 1) {
        return [{ coin: 'io:ANTH', oid: 12345, side: 'A', px: '2000', sz: '0.005', tid: 999, pnl: '0.05', time: 1725000000000 }, { coin: 'io:ANTH', oid: 99999, side: 'A', px: '2001', sz: '0.005', tid: 1000, pnl: '0.01', time: 1725000001000 }];
      }
      // 第二次调用：游标已推进（startTime > 最后一条 time），返回空
      assert.ok(payload.startTime > 1725000001000, '增量游标应推进');
      return [];
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
  // 重复拉取不重复 emit（游标推进 + 去重）
  fill = null;
  await ex._refreshFills();
  assert.ok(!fill, '游标推进后不重复 emit');
}

{
  // _filledSeen 环形上限：超出 5000 时裁剪（经 _refreshFills 触发）
  const ex = mkEx();
  ex.markets.set(0, ANTH);
  for (let i = 0; i < 5000; i++) ex._filledSeen.add('k' + i);
  // 模拟新成交触发 add + 裁剪
  ex._postInfo = async (payload) => {
    if (payload.type === 'userFillsByTime') {
      return [{ coin: 'io:ANTH', oid: 12345, side: 'B', px: '2000', sz: '0.005', tid: 5001, pnl: '0', time: Date.now() }];
    }
    return [];
  };
  await ex._refreshFills();
  assert.ok(ex._filledSeen.size <= 5000, '环形裁剪生效');
}

{
  // 空快照守卫：空活跃快照 + 本地跟踪多 -> 不做 gone 判定
  const ex = mkEx();
  ex.markets.set(0, ANTH);
  for (let i = 0; i < 12; i++) {
    ex._tracked.set('o-' + i, { orderId: 'o-' + i, marketId: 0, levelIndex: i, side: 'sell', price: 2000 + i, sizeBase: 0.005, reduceOnly: false, placedAt: Date.now() - 120_000, seen: true, goneFirstAt: null });
  }
  ex._postInfo = async () => [];
  await ex._refreshOrders();
  for (let i = 0; i < 12; i++) {
    assert.ok(ex._tracked.has('o-' + i), '空快照轮不删跟踪');
  }
}

{
  // review20 ①：cloid 生成必须是 HL 合规 16 字节 hex（0x + 32 hex）
  const ex = mkEx();
  ex.markets.set(0, ANTH);
  const prepared = ex._prepareOrder({ marketId: 0, side: 'sell', price: 2000, sizeBase: 0.005, levelIndex: 1 });
  assert.ok(/^0x[0-9a-f]{32}$/.test(prepared.clientOrderId), 'cloid 必须是 0x + 32 位 hex');
  // 外部传入非法格式被归一化
  const p2 = ex._prepareOrder({ marketId: 0, side: 'sell', price: 2000, sizeBase: 0.005, levelIndex: 1, clientOrderId: 'gabc123' });
  assert.ok(/^0x[0-9a-f]{32}$/.test(p2.clientOrderId), '非法 cloid 被归一化');
  // 外部传入合规格式保留
  const good = '0x' + 'ab'.repeat(16);
  const p3 = ex._prepareOrder({ marketId: 0, side: 'sell', price: 2000, sizeBase: 0.005, levelIndex: 1, clientOrderId: good });
  assert.equal(p3.clientOrderId, good, '合规 cloid 保留');
}

{
  // review20 ③：cloid 成交匹配（oid 不符但 cloid 匹配也能确认成交）
  const ex = mkEx();
  ex.markets.set(0, ANTH);
  const cloid = '0x' + 'cd'.repeat(16);
  ex._tracked.set('77777', { orderId: '77777', marketId: 0, levelIndex: 5, side: 'buy', price: 2000, sizeBase: 0.005, reduceOnly: false, placedAt: Date.now(), seen: true, clientOrderId: cloid });
  let fill = null;
  ex.on('fill', (f) => { fill = f; });
  ex._postInfo = async (payload) => {
    if (payload.type === 'userFillsByTime') {
      return [{ coin: 'io:ANTH', oid: 12345, cloid, side: 'B', px: '2000', sz: '0.005', tid: 6001, pnl: '0', time: Date.now() }];
    }
    return [];
  };
  await ex._refreshFills();
  assert.ok(fill, 'cloid 匹配应确认成交');
  assert.equal(fill.orderId, '77777');
}

{
  // review20 ②：cancelAll 走 bulk_cancel，请求结构为 {coin, oid:int} 字典列表
  const ex = mkEx();
  ex.markets.set(0, ANTH);
  ex._tradingReady = true; ex.dataSource = 'real';
  ex._fetchActiveOrders = async () => [
    { orderId: '111', marketId: 0, side: 'sell', price: 2000, sizeBase: 0.005, status: 'open' },
    { orderId: '222', marketId: 0, side: 'buy', price: 1900, sizeBase: 0.005, status: 'open' },
  ];
  let bulkReq = null;
  ex.signer = { start: async () => true, stop: async () => true, request: async (cmd, payload) => { if (cmd === 'bulk_cancel') bulkReq = payload; return { status: [{ ok: true }, { ok: true }] }; } };
  await ex.cancelAll(0);
  assert.ok(bulkReq, '应走 bulk_cancel');
  assert.deepEqual(bulkReq, { coin: 'io:ANTH', oids: [111, 222] }, 'oids 应为数字数组（worker 内转 {coin,oid} 字典）');
}

{
  // review4：价格走 allMids 轻端点（~2 权重）替代 metaAndAssetCtxs
  const ex = mkEx();
  ex.markets.set(0, ANTH);
  let called = null;
  ex._postInfo = async (payload) => {
    called = payload;
    if (payload.type === 'allMids') return { 'io:ANTH': '2001.5', 'io:SNDK': '1790.0' };
    return [];
  };
  await ex._refreshPrices();
  assert.equal(called.type, 'allMids', '价格应走 allMids');
  assert.equal(called.dex, 'io', 'allMids 带 dex');
  assert.equal(ex._prices.get(0), 2001.5, '价格已更新');
}

{
  // review4：分级节拍——_poll 不重复拉重端点（5s 内只走价格节拍）
  const ex = mkEx();
  ex.markets.set(0, ANTH);
  const calls = [];
  ex._postInfo = async (payload) => {
    calls.push(payload.type);
    if (payload.type === 'metaAndAssetCtxs') return [{ universe: [{ name: 'io:ANTH', szDecimals: 3, maxLeverage: 6, onlyIsolated: true }] }, [{ markPx: '2000' }]];
    if (payload.type === 'allMids') return { 'io:ANTH': '2001.5' };
    return [];
  };
  ex.markets = new Map();
  // 模拟首次轮询后立刻二次轮询（间隔 < 5s）：只应触发价格节拍
  await ex._poll();
  ex.markets.set(0, ANTH);
  calls.length = 0;
  ex._lastPriceAt = Date.now(); // 假装价格刚拉过
  await ex._poll();
  assert.ok(!calls.includes('clearinghouseState'), '5s 内不得重复拉账户端点');
  assert.ok(!calls.includes('frontendOpenOrders'), '5s 内不得重复拉挂单端点');
  assert.ok(!calls.includes('metaAndAssetCtxs'), '60s 内不得重复拉市场元数据');
}

console.log('hl tests passed');