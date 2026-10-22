#!/usr/bin/env node
// scripts/probe-arcus.mjs —— D1 探针：在 testnet 上验证 Arcus 的鉴权/下单/撤单/死手/限流口径。
//
// 用法：AR_KEYS=/data/repos/arcus-testnet/keys.json node scripts/probe-arcus.mjs
//
// 只跑 testnet（throwaway 账户，无真实资金）。输出一张结论表 + report.json。
// 不做：批量下单、真实成交归集（需要保证金；成交真值环由 ar.test.js 的离线回放覆盖）。
import fs from 'node:fs';
import { ArcusExchange } from '../src/exchange/ar/arcus.js';

const KEYS = process.env.AR_KEYS || '/data/repos/arcus-testnet/keys.json';
const k = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
const MARKET = process.env.AR_MARKET || 'BTC-USD';

const out = [];
const rec = (name, ok, detail) => {
  out.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const ms = async (fn) => { const t = Date.now(); try { const v = await fn(); return { v, ms: Date.now() - t }; } catch (e) { return { e, ms: Date.now() - t }; } };

// ACK 之后订单不会立刻出现在 openOrders：REST 只回 202「已转交撮合」。
// 用轮询把「ACK → 可见」的延迟量出来，别把「还没出现」当成「没成交/被拒」。
const waitFor = async (fn, pred, timeoutMs = 3000, stepMs = 100) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (pred(v)) return { v, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { v, waitedMs: Date.now() - t0, timedOut: true };
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

const ex = new ArcusExchange({
  network: 'testnet',
  address: k.address,
  keyHex: k.ed25519SeedHex,
  accountIndex: k.accountIndex ?? 0,
  market: MARKET,
});
ex.on('error', (e) => console.log('  [ex error]', e.message));

console.log(`\n=== Arcus testnet probe · ${k.address} · ${MARKET} ===\n`);

// 1) 连接 + 时钟
const init = await ms(() => ex.init());
if (init.e) { rec('init', false, init.e.message); process.exit(1); }
rec('init', true, `${init.ms}ms · clockSkew ${ex.clockSkewMs}ms · markets ${ex.markets.size}`);

// 2) 市场元数据闸门
const mkt = ex._market(1) || (await ex.getMarkets()).find((m) => m.symbol === MARKET);
rec('market meta', !!mkt, `${mkt.symbol} marketId=${mkt.marketId} tick=${mkt.stepPrice} step=${mkt.stepSize} minNotional=${mkt.minOrderNotional} maxLev=${mkt.maxLeverage} maker/taker ppm=${mkt.makerFeePpm}/${mkt.takerFeePpm}`);
// testnet 的费用表是模拟值（实测 maker 150ppm），只有主网 0ppm 才代表真实成本。
rec('maker fee guard', ex.network === 'testnet' || mkt.makerFeePpm === 0,
  ex.network === 'testnet' ? `testnet 模拟费率 maker=${mkt.makerFeePpm}ppm（主网 0ppm，此处不拦）` : `maker=${mkt.makerFeePpm}ppm`);

// 3) 账户（未入金时应为 404 或 equity=0）
const acct = await ms(() => ex._refreshAccount());
rec('account read', !!acct.v || !!ex.equity, `equity=${ex.equity} balance=${ex.balance} realized=${ex.realizedPnl} (${acct.ms}ms)`);

// 4) setLeverage（Scheme 2 签名）
const lev = await ms(() => ex.setLeverage(mkt.marketId, 10));
rec('setLeverage 10x', !lev.e, lev.e ? lev.e.message : `${lev.ms}ms`);

// 5) 单笔 ALO 挂单（远离中间价，不会成交）
const mid = await ex.getPrice(mkt.marketId);
const px = Number((Math.round((mid * 0.9) / mkt.stepPrice) * mkt.stepPrice).toFixed(8));
const placed = await ms(() => ex.placeLimitOrder({
  marketId: mkt.marketId, side: 'buy', price: px, sizeBase: 0.0002,
  reduceOnly: false, levelIndex: 0, clientOrderId: 'probe-1',
}));
rec('place ALO', !placed.e && placed.v?.orderId, placed.e ? placed.e.message : `orderId=${placed.v.orderId} @${px} (${placed.ms}ms)`);

// 6) openOrders 认账（轮询，量 ACK→可见 的真延迟）
const seen = await waitFor(
  () => ex.fetchOpenOrders(mkt.marketId),
  (rows) => Array.isArray(rows) && rows.some((o) => String(o.orderId) === String(placed.v?.orderId)),
);
rec('openOrders 可见', !seen.timedOut,
  `ACK→可见 ${seen.waitedMs}ms，在簿 ${(seen.v || []).length} 张${seen.timedOut ? '（3s 内未出现）' : ''}`);

// 7) 按 orderId 撤单
if (placed.v?.orderId) {
  const c = await ms(() => ex.cancelOrder(mkt.marketId, placed.v.orderId));
  rec('cancelOrder', !c.e, c.e ? c.e.message : `${c.ms}ms`);
  const gone = await waitFor(
    () => ex.fetchOpenOrders(mkt.marketId),
    (rows) => Array.isArray(rows) && !rows.some((o) => String(o.orderId) === String(placed.v.orderId)),
  );
  rec('撤单生效', !gone.timedOut, `撤单→消失 ${gone.waitedMs}ms${gone.timedOut ? '（3s 内仍在簿）' : ''}`);
}

// 8) 三笔批量铺 + cancelAll 兜底
const many = [];
for (let i = 1; i <= 3; i++) {
  const p = Number((Math.round((mid * (0.9 - i * 0.01)) / mkt.stepPrice) * mkt.stepPrice).toFixed(8));
  const r = await ms(() => ex.placeLimitOrder({ marketId: mkt.marketId, side: 'buy', price: p, sizeBase: 0.0002, levelIndex: i }));
  if (r.v?.orderId) many.push(r.v.orderId);
}
rec('3x place', many.length === 3, many.join(',') || 'none');
const ca = await ms(() => ex.cancelAll(mkt.marketId));
const settled = await waitFor(
  () => ex.fetchOpenOrders(mkt.marketId),
  (rows) => Array.isArray(rows) && rows.length === 0,
  { timeoutMs: 6000 },
);
const after = await ms(() => ex.fetchOpenOrders(mkt.marketId));
const left = (settled?.v ?? after.v ?? []).length;
rec('cancelAll(market)', !ca.e && left === 0, `余 ${left} 张（撤净 ${settled?.waitedMs ?? '-'}ms / 调用 ${ca.ms}ms）`);

// 9) 死手开关 arm / disarm
const arm = await ms(() => ex._armDms(mkt.marketId));
rec('deadman arm', !arm.e, arm.e ? arm.e.message : `deadline +${Math.round((ex._dmsDeadlineMs - Date.now()) / 1000)}s`);
const dis = await ms(() => ex.disarmDms());
rec('deadman disarm', !dis.e, dis.e ? dis.e.message : 'ok');

// 10) 限流池用量
const rl = await ms(() => ex._http('GET', '/v1/rateLimit', { query: { address: k.address, accountIndex: k.accountIndex ?? 0 }, weight: 2 }));
rec('rateLimit', !rl.e, rl.e ? rl.e.message : JSON.stringify(rl.v).slice(0, 200));

// 11) 成交读取（游标可用性）
const fills = await ms(() => ex._http('GET', '/v1/fills', { query: { address: k.address, market: MARKET, from: Date.now() * 1000 - 3_600_000_000, accountIndex: k.accountIndex ?? 0 }, weight: 20 }));
rec('fills(from=µs)', !fills.e, fills.e ? fills.e.message : `rows=${(fills.v?.fills || fills.v || []).length}`);

ex.stop();
const okAll = out.every((r) => r.ok);
console.log(`\n=== ${out.filter((r) => r.ok).length}/${out.length} passed ===\n`);
fs.writeFileSync('/data/repos/arcus-testnet/report.json', JSON.stringify({ at: new Date().toISOString(), network: 'testnet', address: k.address, market: MARKET, rows: out }, null, 1));
process.exit(okAll ? 0 : 2);
