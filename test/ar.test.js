// Arcus adapter unit tests: signing payloads (Scheme 1/2), exact tick/quantum
// conversion, market gating, and response parsers.
// Run with: npm test
import assert from 'node:assert/strict';
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
  assert.throws(() => assertMakerFree(paid), /maker 费/);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);