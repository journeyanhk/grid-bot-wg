// Arcus adapter unit tests: signing payloads (Scheme 1/2), exact tick/quantum
// conversion, market gating, and response parsers.
// Run with: npm test
import assert from 'node:assert/strict';
import { ArcusExchange, isDustFill } from '../src/exchange/ar/arcus.js';
import { createExchange } from '../src/exchange/ar/index.js';
import {
  apiKeyFromPrivate, cancelPayload, canonicalJson, fromQuantums, fromTicks,
  placePayload, privateKeyFromHex, readKeyFile, roundToUnit, scheme2Message,
  signMessage, snapPrice, toQuantums, toTicks, verifyMessage, OP, SIDE, TIF,
} from '../src/exchange/ar/signer.js';
import {
  assertGridTradable, assertMakerFree, normalizeBase, normalizeWs,
  parseAccount, parseFills, parseMarkets, parseOpenOrder, parseOpenOrders, parsePositions, timeframeFor,
} from '../src/exchange/ar/market.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
}

// RFC 8032 §7.1 TEST 1 — the canonical Ed25519 vector.
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const ADDR = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';

console.log('ar/signer.js — keys');

test('privateKeyFromHex wraps a raw 32-byte seed in PKCS#8', () => {
  const key = privateKeyFromHex(SEED);
  assert.equal(apiKeyFromPrivate(key), PUB);
});

test('privateKeyFromHex tolerates 0x prefix, whitespace and PEM', () => {
  assert.equal(apiKeyFromPrivate(privateKeyFromHex('0x' + SEED)), PUB);
  assert.equal(apiKeyFromPrivate(privateKeyFromHex('  ' + SEED + '\n')), PUB);
});

test('privateKeyFromHex rejects wrong lengths', () => {
  assert.throws(() => privateKeyFromHex('deadbeef'), /64/);
  assert.throws(() => privateKeyFromHex(''), /64/);
});

test('readKeyFile accepts a hex file and a PEM file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-key-'));
  const hexFile = join(dir, 'k.hex');
  writeFileSync(hexFile, SEED + '\n');
  assert.equal(apiKeyFromPrivate(readKeyFile(hexFile)), PUB);
  // PEM produced by `openssl genpkey -algorithm ed25519` for the same seed.
  const pemFile = join(dir, 'k.pem');
  writeFileSync(pemFile, [
    '-----BEGIN PRIVATE KEY-----',
    Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(SEED, 'hex'),
    ]).toString('base64').replace(/(.{1,64})/g, '$1\n').trimEnd(),
    '-----END PRIVATE KEY-----', '',
  ].join('\n'));
  assert.equal(apiKeyFromPrivate(readKeyFile(pemFile)), PUB);
});

test('signMessage is deterministic and verifies', () => {
  const key = privateKeyFromHex(SEED);
  const a = signMessage(key, 'hello arcus');
  const b = signMessage(key, 'hello arcus');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{128}$/);
  assert.equal(verifyMessage(key, 'hello arcus', a), true);
  assert.equal(verifyMessage(key, 'hello arcus!', a), false);
});

console.log('ar/signer.js — Scheme 1 payloads');

test('canonicalJson sorts keys and drops undefined', () => {
  assert.equal(canonicalJson({ b: 2, a: 1, c: undefined }), '{"a":1,"b":2}');
});

test('placePayload matches the documented byte layout (no clientId)', () => {
  const payload = placePayload({
    address: ADDR, accountIndex: 0, timestampNs: 1792648166733095274n,
    goodTilNs: 1795648166733095000n, marketId: 1,
    priceTicks: 826707, quantums: 20000, reduceOnly: false, side: SIDE.BUY, tif: TIF.ALO,
  });
  assert.equal(payload,
    '{"ad":"0xabcdef0123456789abcdef0123456789abcdef01","ai":0,'
    + '"ct":1792648166733095274,"g":1795648166733095000,"m":1,"op":1,'
    + '"p":826707,"q":20000,"r":0,"s":0,"t":3,"v":1}');
});

test('placePayload puts an optional clientId right after ai, verbatim', () => {
  const payload = placePayload({
    address: ADDR, accountIndex: 2, clientId: 'ArC-42', timestampNs: 1n,
    goodTilNs: 2n, marketId: 1, priceTicks: 1, quantums: 1, reduceOnly: true, side: SIDE.SELL,
  });
  assert.equal(payload,
    '{"ad":"0xabcdef0123456789abcdef0123456789abcdef01","ai":2,"c":"ArC-42",'
    + '"ct":1,"g":2,"m":1,"op":1,"p":1,"q":1,"r":1,"s":1,"t":3,"v":1}');
});

test('cancelPayload needs exactly one of orderId / clientId', () => {
  assert.throws(() => cancelPayload({ address: ADDR, timestampNs: 1n, marketId: 1 }), /之一/);
  assert.throws(() => cancelPayload({
    address: ADDR, timestampNs: 1n, marketId: 1, orderId: 'o', clientId: 'c',
  }), /之一/);
  assert.equal(cancelPayload({ address: ADDR, timestampNs: 7n, marketId: 1, orderId: 'ord-1' }),
    '{"ad":"0xabcdef0123456789abcdef0123456789abcdef01","ai":0,"ct":7,'
    + '"id":"ord-1","m":1,"op":2,"v":1}');
});

test('scheme2Message is timestamp + action + canonical body', () => {
  assert.equal(scheme2Message(5n, 'setLeverage', { marketId: 1, leverage: 10 }),
    '5setLeverage{"leverage":10,"marketId":1}');
  assert.equal(scheme2Message(5n, 'cancelAllOrders'), '5cancelAllOrders');
});

console.log('ar/signer.js — exact unit conversion');

test('roundToUnit returns integer units and the matching decimal string', () => {
  const price = roundToUnit(82670.7, '0.1');
  assert.equal(price.units, 826707n);
  assert.equal(price.text, '82670.7');
  const size = roundToUnit(0.0002, '0.00000001');
  assert.equal(size.units, 20000n);
  assert.equal(size.text, '0.0002');
});

test('roundToUnit snaps a mid-tick grid price instead of throwing', () => {
  const r = roundToUnit(82670.74, '0.1');
  assert.equal(r.units, 826707n);
  assert.equal(r.text, '82670.7');
});

test('toTicks/toQuantums still reject non-exact values', () => {
  assert.throws(() => toTicks(82670.75, '0.1'), /精度|multiple/);
  assert.equal(toTicks('82670.7', '0.1'), 826707);
  assert.equal(toQuantums('0.0002', '0.00000001'), 20000);
  assert.equal(fromQuantums(20000n, '0.00000001'), '0.0002');
  assert.equal(fromTicks(826707n, '0.1'), '82670.7');
  assert.equal(snapPrice(82670.74, '0.1'), '82670.7');
});

test('sub-cent precision survives (BTC step 1e-8, price tick 0.1)', () => {
  const r = roundToUnit('0.00012345', '0.00000001');
  assert.equal(r.units, 12345n);
  assert.equal(r.text, '0.00012345');
});

console.log('ar/market.js — market gating');

const BTC = {
  marketDisplayName: 'BTC-USD', marketId: 1, status: 'ONLINE', baseAsset: 'BTC', quoteAsset: 'USD',
  tickSize: '0.1', stepSize: '0.00000001', minOrderNotional: '5', minOrderSize: '0.0001',
  maxOrderSize: '10000', markPrice: '82673.4', initialMarginFraction: '0.025',
  regularTradingHours: null, category: 'CRYPTO',
  baseMakerFeePpm: 0, baseTakerFeePpm: 225, effectiveMakerFeePpm: 0, effectiveTakerFeePpm: 225,
};
const STOCK = {
  ...BTC, marketId: 42, marketDisplayName: 'TSLA-USD', baseAsset: 'TSLA', category: 'EQUITIES',
  regularTradingHours: { startSecondsOfDay: 14400, endSecondsOfDay: 72000, timezone: 'America/New_York' },
};

test('parseMarkets maps tick/step, fee and leverage', () => {
  const [btc] = parseMarkets({ markets: [BTC] });
  assert.equal(btc.marketId, 1);
  assert.equal(btc.stepPrice, 0.1);
  assert.equal(btc.stepSize, 1e-8);
  assert.equal(btc.maxLeverage, 40);          // IMF 2.5% → 40x
  assert.equal(btc.makerFeePpm, 0);
  assert.equal(btc.takerFeePpm, 225);
  assert.equal(btc.hasTradingHours, false);
});

test('parseMarkets rejects a non-array payload', () => {
  assert.throws(() => parseMarkets({ nope: true }), /数组/);
});

test('assertGridTradable accepts a 24/7 CRYPTO market', () => {
  const [btc] = parseMarkets({ markets: [BTC] });
  assert.equal(assertGridTradable(btc), true);
});

test('assertGridTradable refuses markets with trading hours', () => {
  const [stock] = parseMarkets({ markets: [STOCK] });
  assert.throws(() => assertGridTradable(stock), /交易时段/);
});

test('assertGridTradable refuses a non-CRYPTO market without hours', () => {
  const [stock] = parseMarkets({ markets: [{ ...STOCK, regularTradingHours: null }] });
  assert.throws(() => assertGridTradable(stock), /类别/);
});

test('assertMakerFree fails fast once the beta ends', () => {
  const [btc] = parseMarkets({ markets: [BTC] });
  assert.equal(assertMakerFree(btc), true);
  const [paid] = parseMarkets({ markets: [{ ...BTC, effectiveMakerFeePpm: 10 }] });
  assert.throws(() => assertMakerFree(paid), /maker fee 10 ppm/);
  assert.equal(assertMakerFree(paid, 200), true, '上限放宽后 10 ppm 应放行');
});

console.log('ar/market.js — endpoints and parsers');

test('normalizeBase / normalizeWs', () => {
  assert.equal(normalizeBase('', 'mainnet'), 'https://api.arcus.xyz');
  assert.equal(normalizeBase('https://api.testnet.arcus.xyz/', 'mainnet'), 'https://api.testnet.arcus.xyz');
  assert.equal(normalizeWs(undefined, 'https://api.testnet.arcus.xyz'), 'wss://api.testnet.arcus.xyz/v1/ws');
  assert.equal(normalizeWs('wss://api.arcus.xyz', ''), 'wss://api.arcus.xyz/v1/ws');
  assert.equal(normalizeWs('wss://api.arcus.xyz/v1/ws', ''), 'wss://api.arcus.xyz/v1/ws');
  assert.equal(normalizeWs('wss://host/custom', ''), 'wss://host/custom');
});

test('timeframeFor covers the intervals the dashboard asks for', () => {
  assert.equal(timeframeFor(60), '1m');
  assert.equal(timeframeFor(3600), '1h');
  assert.equal(timeframeFor(86400), '1d');
});

test('parseOpenOrders / parseFills read engine integers as numbers', () => {
  const orders = parseOpenOrders({ orders: [{
    orderId: 'o1', clientId: 'c1', marketId: 1, side: 'BUY', price: '82670.7',
    quantity: '0.0002', reduceOnly: false,
  }] });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].side, 'buy');
  assert.equal(orders[0].price, 82670.7);
  assert.equal(orders[0].sizeBase, 0.0002);

  const fills = parseFills({ fills: [
    { orderId: 'o2', marketId: 1, side: 'SELL', price: '82700', size: '0.0002', createdAt: 1792648000000000, fee: '0' },
    { orderId: 'o1', marketId: 1, side: 'BUY', price: '82600', size: '0.0001', createdAt: 1792647000000000, fee: '0' },
  ] });
  assert.equal(fills.length, 2);
  assert.equal(fills[0].orderId, 'o1');                 // oldest first
  assert.equal(fills[1].createdAt, 1792648000000);      // µs → ms
  assert.equal(fills[1].side, 'sell');
});

test('parsePositions signs the short side', () => {
  const [short] = parsePositions({ positions: [{
    marketId: 1, side: 'SHORT', size: '0.0012', entryPrice: '83000', unrealizedPnl: '-1.5',
  }] });
  assert.equal(short.sizeBase, -0.0012);
  assert.equal(short.entryPrice, 83000);
});

test('parseAccount picks equity / free collateral', () => {
  const a = parseAccount({ equity: '398.5', freeCollateral: '120.4', marginUsed: '278.1' });
  assert.equal(a.equity, 398.5);
  assert.equal(a.freeCollateral, 120.4);
});

test('parseFills tolerates a bare array', () => {
  assert.equal(parseFills([]).length, 0);
  assert.equal(OP.PLACE, 1);
});

test('parseOpenOrders reads the envelope AND bare rows', () => {
  const row = {
    orderId: 'abc', marketId: 1, side: 'BUY', price: '79000.5',
    originalSize: '0.0002', remainingSize: '0.0002', filledSize: '0',
  };
  // 信封形态（/v1/openOrders 的真实回包）
  const env = parseOpenOrders({ orders: [row] });
  assert.equal(env.length, 1);
  assert.equal(env[0].orderId, 'abc');
  assert.equal(env[0].side, 'buy');
  assert.equal(env[0].sizeBase, 0.0002);   // remainingSize 优先
  // 裸行形态：适配器逐行调用时的入参
  const one = parseOpenOrder(row);
  assert.equal(one?.orderId, 'abc');
  assert.equal(one?.price, 79000.5);
  // 空包与无 orderId 的垃圾行都返回 null，不抛
  assert.equal(parseOpenOrder({ orders: [] }), null);
  assert.equal(parseOpenOrder({}), null);
});

test('fills 回补：满页时用 to 往回翻，老成交不会被游标跳过', async () => {
  const ex = Object.create(ArcusExchange.prototype);
  ex.address = `0x${'a'.repeat(40)}`;
  ex.accountIndex = 0;
  const page = (n, start) => Array.from({ length: n }, (_, i) => ({
    orderId: `o${start + i}`, marketId: 1, side: 'BUY', price: '80000',
    size: '0.001', fee: '0', createdAt: start + i,
  }));
  const calls = [];
  ex._http = async (m, path, { query }) => {
    calls.push(query);
    if (!query.to) return page(200, 5000);          // 最新一页（满）
    if (Number(query.to) > 4600) return page(200, 4400); // 再往前一页（满）
    return page(137, 4200);                          // 最后一页不满
  };
  ex._retry = async (fn) => fn();
  const rows = await ex._fetchFillRows(1000);
  assert.equal(rows.length, 537);
  assert.equal(calls.length, 3);
  assert.ok(Number(calls[1].to) < 5000, '第二页必须收窄上界');
});

test('同一毫秒内的两笔部分成交不会被幂等键吞掉', async () => {
  const ex = Object.create(ArcusExchange.prototype);
  Object.assign(ex, {
    address: `0x${'b'.repeat(40)}`, accountIndex: 0,
    _fillsSeen: new Set(), _fillsFromMs: 0, _tracked: new Map(), _lastFillPollAt: 0,
  });
  const got = [];
  ex.emit = (ev, f) => { if (ev === 'fill') got.push(f); };
  const base = 1_760_000_000_000_000;    // µs
  ex._fetchFillRows = async () => ([
    { orderId: 'x1', marketId: 1, side: 'BUY', price: '80000', size: '0.001', fee: '0', createdAt: base + 100 },
    { orderId: 'x1', marketId: 1, side: 'BUY', price: '80000', size: '0.001', fee: '0', createdAt: base + 900 },
  ]);
  await ex._pollFills();
  assert.equal(got.length, 2, '两笔都要落地');
  await ex._pollFills();                  // 同一批再来一次：去重仍生效
  assert.equal(got.length, 2);
});

test('死手开关触发会计数并升级成 operationalIssue', async () => {
  const ex = Object.create(ArcusExchange.prototype);
  Object.assign(ex, { _dmsArms: [], _dmsTriggers: [], _dmsQuotaRejectedAt: 0, operationalIssue: null });
  ex._armDms = async () => true;
  ex._dmsDeadlineMs = Date.now() - 60_000;   // 上一轮已经过期
  await ex._dmsTick();
  assert.equal(ex._dmsTriggers.length, 1);
  assert.equal(ex._dmsDeadlineMs, 0);
  for (let i = 0; i < 9; i += 1) {
    ex._dmsDeadlineMs = Date.now() - 60_000;
    await ex._dmsTick();
  }
  assert.equal(ex._dmsTriggers.length, 10);
  assert.match(ex.operationalIssue?.title || '', /配额/);
});

test('createExchange 把 config 的 signingKey 映射成适配器认的 keyHex（live 缺钥回归）', () => {
  const seed = 'd'.repeat(64);
  const ex = createExchange({
    mode: 'live', network: 'testnet', address: `0x${'c'.repeat(40)}`,
    signingKey: seed, accountIndex: 1, marketHint: 'BTC-USD',
  });
  assert.equal(ex.keyHex, seed, 'server 传 signingKey，适配器必须认');
  assert.equal(ex.accountIndex, 1, '子账户索引要透传');
  assert.equal(ex.mode, 'live');
  assert.equal(ex.network, 'testnet');
});

test('parsePositions 认 "按 marketId 键的对象" 与 averageEntryPrice', async () => {
  const { parsePositions, parseAccount } = await import('../src/exchange/ar/market.js');
  // 真实回包形状（testnet 抓的）：positions 是对象，不是数组
  const payload = { positions: { 1: {
    marketId: 1, side: 'SHORT', size: '-0.0058', averageEntryPrice: '72722.2',
    markPx: '81521', unrealizedPnl: '-51.03', marginUsed: '47.286124', leverage: '10',
  } }, total: 1 };
  const rows = parsePositions(payload);
  assert.equal(rows.length, 1, '对象形态必须能解析出仓位');
  assert.equal(rows[0].marketId, 1);
  assert.equal(rows[0].sizeBase, -0.0058);
  assert.equal(rows[0].entryPrice, 72722.2, 'averageEntryPrice 要映射成 entryPrice');
  assert.equal(rows[0].markPrice, 81521);

  const acct = parseAccount({
    accountIndex: 1, netQuoteBalance: '1000', equity: '981.7',
    freeCollateral: '981.7', netDeposits: '1000', positions: {},
  });
  assert.equal(acct.balance, 1000, 'balance 取 netQuoteBalance，否则恒为 null');
  assert.equal(acct.equity, 981.7);
});

test('DMS 续期失败时保留旧 deadline，且同一次触发只计一次', async () => {
  const ex = Object.create(ArcusExchange.prototype);
  ex._dmsTriggers = [];
  ex._dmsArms = [];
  ex.operationalIssue = null;
  // deadline 已过期 20s（grace 15s）→ 应判为"已触发"
  ex._dmsDeadlineMs = Date.now() - 20_000;
  let fail = true;
  ex._armDms = async () => {
    if (fail) throw new Error('network down');
    ex._dmsArms.push(Date.now());
    ex._dmsDeadlineMs = Date.now() + 60_000;
    return true;
  };

  await ex._dmsTick().catch(() => {});
  assert.equal(ex._dmsTriggers.length, 1, '过期未续期必须计一次触发（不能被清零后漏判）');

  await ex._dmsTick().catch(() => {});
  assert.equal(ex._dmsTriggers.length, 1, '同一次触发不能重复计数');

  fail = false;
  await ex._dmsTick().catch(() => {});
  assert.ok(ex._dmsDeadlineMs > Date.now(), '续期成功后 deadline 应回到未来');

  // 续期失败但尚未过期的场景：旧 deadline 必须原样保留，供下一轮补判
  const future = Date.now() + 30_000;
  ex._dmsDeadlineMs = future;
  fail = true;
  await ex._dmsTick().catch(() => {});
  assert.equal(ex._dmsDeadlineMs, future, '续期失败不得把 deadline 清零');
});

test('testnet 模拟费率只进 warning，不污染 operationalIssue', async () => {
  // 字段名照抄 /v1/markets 真实回包：费率是 effectiveXxxFeePpm，状态必须是 ONLINE
  const markets = { markets: [{
    marketId: 1, marketDisplayName: 'BTC-USD', symbol: 'BTC-USD',
    effectiveMakerFeePpm: 150, effectiveTakerFeePpm: 450,
    tickSize: '0.1', stepSize: '0.00000001', minOrderNotional: '5',
    maxLeverage: 40, status: 'ONLINE',
  }] };
  // 上限内（150 ≤ 200）都不是运营异常：mainnet 的真实费率是已知成本，净利红线已扣过
  const expectations = [['testnet', false], ['mainnet', false]];
  for (const [network, shouldFlag] of expectations) {
    const ex = new ArcusExchange({ address: '0x' + '1'.repeat(40), keyHex: 'aa'.repeat(32), network });
    ex._http = async () => markets;
    await ex._loadMarkets(true);
    assert.equal(!!ex.operationalIssue, shouldFlag, `${network} 的 operationalIssue 判定`);
    assert.ok(ex.feeWarning, `${network} 要留 warning 供巡检查看`);
  }
  // 超出 maker 上限（250 > 200）才升成运营异常
  const over = new ArcusExchange({ address: '0x' + '1'.repeat(40), keyHex: 'aa'.repeat(32), network: 'mainnet' });
  over._http = async () => ({ markets: [{ ...markets.markets[0], effectiveMakerFeePpm: 250 }] });
  await over._loadMarkets(true);
  assert.match(over.operationalIssue?.title || '', /超上限/);
});

test('空轮成交轮询也要打心跳（否则游标年龄永远是 null）', async () => {
  const ex = new ArcusExchange({ address: '0x' + '1'.repeat(40), keyHex: 'aa'.repeat(32), network: 'testnet' });
  ex._fetchFillRows = async () => [];
  assert.equal(ex._lastFillPollAt, 0, '初始应为 0');
  await ex._pollFills();
  assert.ok(ex._lastFillPollAt > 0, '没有新成交也要更新心跳时间');
  assert.equal(ex._fillsPrimed, true, '空轮同样算完成首轮对齐');
});

test('签名时间戳严格递增：同毫秒连发不会撞 ct（ef9349d 回归）', () => {
  const ex = new ArcusExchange({ address: '0x' + '1'.repeat(40), keyHex: 'aa'.repeat(32), network: 'testnet' });
  const stamps = [ex._nowNs(), ex._nowNs(), ex._nowNs(), ex._nowNs()];
  for (let i = 1; i < stamps.length; i += 1) {
    assert.ok(stamps[i] > stamps[i - 1], `第 ${i} 个 ct 必须大于前一个：${stamps[i - 1]} -> ${stamps[i]}`);
  }
  // 直接验证 +1ns 分支：把上一枚 ct 推到远未来，下一次必须只前进 1ns
  ex._lastSigNs = 2000000000000000000n;
  assert.equal(ex._nowNs(), 2000000000000000001n, '落后于上一枚 ct 时必须 +1ns 而不是回退');
});


test('isDustFill: 测试网碎单按名义额过滤，正常成交不误杀', () => {
  assert.equal(isDustFill({ sizeBase: 3e-8, price: 82000 }), true, '3e-8 BTC ≈ 0.0025 USDC 属碎单');
  assert.equal(isDustFill({ sizeBase: 0.0002, price: 82000 }), false, '0.0002 BTC ≈ 16.4 USDC 是正常单');
  assert.equal(isDustFill({ sizeBase: 0.00001, price: 82000 }), true, '0.82 USDC 仍低于阈值');
});

// WS 半开：30 秒没有任何帧必须强断重连并切 REST 兜底（2026-10-25 价格冻结 1141s 回归）
test('WS 静默超过阈值时强制断开并走 REST 兜底', () => {
  const ex = new ArcusExchange({ address: '0x' + '1'.repeat(40), keyHex: 'aa'.repeat(32), network: 'testnet' });
  let closed = 0, reconnects = 0;
  ex._wsReady = true;
  ex._ws = { close() { closed += 1; } };
  ex._lastWsMsgAt = Date.now() - 45_000;
  ex._connectWs = () => { reconnects += 1; };
  ex._fetchBbo = async () => null;   // 兜底请求本身不在这里断言（要走 microtask）
  ex._pollPrices().catch(() => {});
  assert.equal(closed, 1, '应关闭半开连接');
  assert.equal(reconnects, 1, '应触发重连');
  assert.equal(ex._wsReady, false, '标记为未就绪');
  assert.equal(ex._wsSilenceReconnects, 1, '计数一次半开重连');

  ex._wsReady = true; ex._ws = { close() { closed += 1; } }; ex._lastWsMsgAt = Date.now();
  ex._pollPrices().catch(() => {});
  assert.equal(closed, 1, '有新鲜帧时不得断开');
});


test('主网 maker 费率闸门：150 ppm 在默认 200 上限内放行，250 ppm 拒启动', () => {
  const mk = (ppm) => ({ displayName: 'BTC-USD', makerFeePpm: ppm, takerFeePpm: 450 });
  assert.equal(assertMakerFree(mk(0)), true, '免手续费仍放行');
  assert.throws(() => assertMakerFree(mk(150)), /maker fee 150 ppm/, '默认上限为 0 时 150 ppm 必须拒绝（旧行为）');
  assert.equal(assertMakerFree(mk(150), 200), true, '上限 200 ppm 时主网 150 ppm 应放行');
  assert.throws(() => assertMakerFree(mk(250), 200), /exceeds limit 200 ppm/, '超上限必须拒绝');
  assert.equal(assertMakerFree({ displayName: 'X', makerFeePpm: null }, 200), true, '费率未知时放行，由适配器告警');
});

test('单格净利红线默认值：主网 0.01，testnet 0（避免历史窄间距在重启时被拒）', () => {
  const live = createExchange({ mode: 'live', network: 'mainnet', address: `0x${'a'.repeat(40)}`, signingKey: 'ab'.repeat(32) });
  assert.equal(live.minGridNetUsd, 0.01, '主网必须默认 0.01 红线');
  assert.equal(live.maxMakerFeePpm, 200);
  const hinted = createExchange({ mode: 'live', network: 'mainnet', address: `0x${'a'.repeat(40)}`, signingKey: 'ab'.repeat(32), market: 'BTC-USD' });
  assert.equal(hinted.marketHint, 'BTC-USD', 'AR_MARKET 必须透传成 marketHint（主网 75 个市场不能靠默认挑）');
  const tn = createExchange({ mode: 'live', network: 'testnet', address: `0x${'a'.repeat(40)}`, signingKey: 'ab'.repeat(32) });
  assert.equal(tn.minGridNetUsd, 0, 'testnet 默认不拦');
  const paper = createExchange({ mode: 'paper' });
  assert.equal(paper.minGridNetUsd, 0, 'paper 默认不拦');
});

test('createExchange 透传 maxMakerFeePpm（默认 200）', () => {
  const ex = createExchange({ mode: 'paper' });
  assert.equal(ex.maxMakerFeePpm, 200, '未配置时应回落到 200 ppm');
  const ex2 = createExchange({ mode: 'paper', maxMakerFeePpm: 50 });
  assert.equal(ex2.maxMakerFeePpm, 50, '显式配置必须透传');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
test('HTTP 200 但 status=REJECTED 必须当失败，不许写进 _tracked（幽灵单源头）', async () => {
  const mk = () => {
    const ex = new ArcusExchange({ address: '0x' + '1'.repeat(40), keyHex: 'aa'.repeat(32), network: 'testnet' });
    ex._key = privateKeyFromHex('aa'.repeat(32)); // 真实 init() 才派生私钥，测试里直接注入
    return ex;
  };
  const markets = { markets: [{
    marketId: 1, marketDisplayName: 'BTC-USD', symbol: 'BTC-USD',
    effectiveMakerFeePpm: 150, effectiveTakerFeePpm: 450,
    tickSize: '0.1', stepSize: '0.00000001', minOrderNotional: '5',
    maxLeverage: 40, status: 'ONLINE',
  }] };
  const args = { marketId: 1, side: 'sell', price: 80000, sizeBase: 0.0002, reduceOnly: true, postOnly: false, levelIndex: 0 };

  // 真机实测：空仓/错误方向的 reduceOnly 单，Arcus 回 HTTP 200 + status=REJECTED
  const ex = mk();
  ex._http = async (m, path) => (path.includes('placeOrder')
    ? { orderId: 'rej-1', status: 'REJECTED', clientOrderId: 'c1' } : markets);
  await ex._loadMarkets(true);
  let err = null;
  try { await ex.placeLimitOrder(args); } catch (e) { err = e; }
  assert.ok(err, '被拒的单必须抛错');
  assert.equal(err.rejected, true, `错误要带 rejected 标记供上层分流，实际抛出：${err.message}`);
  assert.equal(ex._tracked.size, 0, '被拒的单不能进 _tracked，否则变幽灵单');

  // 对照组：正常 ACK 必须进 _tracked
  const ex2 = mk();
  ex2._http = async (m, path) => (path.includes('placeOrder') ? { orderId: 'ok-1', status: 'ACK' } : markets);
  await ex2._loadMarkets(true);
  const r = await ex2.placeLimitOrder(args);
  assert.equal(r.orderId, 'ok-1');
  assert.equal(ex2._tracked.size, 1, '正常单必须进 _tracked');

  // IOC 立即成交返回 FILLED，是合法返回，不能误判成拒绝
  const ex3 = mk();
  ex3._http = async (m, path) => (path.includes('placeOrder') ? { orderId: 'fill-1', status: 'FILLED' } : markets);
  await ex3._loadMarkets(true);
  const r3 = await ex3.placeLimitOrder(args);
  assert.equal(r3.status, 'FILLED', 'FILLED 要原样透出');
  assert.equal(ex3._tracked.size, 1);

  // CANCELED 与 REJECTED 同等对待：订单没在簿上，就不能记成"已挂出"
  const ex4 = mk();
  ex4._http = async (m, path) => (path.includes('placeOrder') ? { orderId: 'cx-1', status: 'CANCELED' } : markets);
  await ex4._loadMarkets(true);
  let err4 = null;
  try { await ex4.placeLimitOrder(args); } catch (e) { err4 = e; }
  assert.ok(err4 && err4.rejected === true, 'CANCELED 也必须当失败');
  assert.equal(ex4._tracked.size, 0, 'CANCELED 不许进台账');
});
