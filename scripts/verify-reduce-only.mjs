#!/usr/bin/env node
// scripts/verify-reduce-only.mjs —— P1：Arcus reduce-only 语义验证（**仅 testnet**）
//
// 用法：node scripts/verify-reduce-only.mjs
// 密钥：AR_KEYS，默认 /data/.secrets/arcus-testnet-keys.json
//
// 硬约束（写在代码里，不靠人记）：
//   · 只连 wss/api.testnet.arcus.xyz；任何指向 mainnet 的参数直接抛错退出
//   · 不启动 bot、不加载 .state.json、不碰主网配置
//
// 实验设计（四段）：
//   E1 错误方向：SHORT 仓 + reduceOnly SELL  → 卖会增空，测「下单时是否校验」
//   E2 正确方向：SHORT 仓 + reduceOnly BUY   → 应减仓，测「成交是否只缩不翻」
//   E3 平到零：  reduceOnly BUY 分批清空      → 为 E4 准备 0 仓位
//   E4 关键：    0 仓位 + reduceOnly SELL     → 开空仓？(08:23 那 66 张单的谜底)
//   然后建 LONG +0.0002 → reduceOnly SELL → 应归 0，不出现 -0.0002
import fs from 'node:fs';
import { ArcusExchange } from '../src/exchange/ar/arcus.js';

const KEYS = process.env.AR_KEYS || '/data/.secrets/arcus-testnet-keys.json';
const k = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
const MARKET = 'BTC-USD';
const SMALL = 0.0002;
const TESTNET_API = 'https://api.testnet.arcus.xyz';

// ---- 硬闸门：任何非 testnet 的东西都不许跑 ----
if (k.network && k.network !== 'testnet') throw new Error(`拒绝执行：密钥文件 network=${k.network}，本脚本只允许 testnet`);
if (process.env.AR_NETWORK && process.env.AR_NETWORK !== 'testnet') throw new Error('拒绝执行：AR_NETWORK 不是 testnet');
if (process.env.AR_MODE && process.env.AR_MODE !== 'paper') throw new Error('拒绝执行：AR_MODE 不是 paper');

const log = [];
const rec = (step, verdict, detail, raw) => {
  const row = { step, verdict, detail, raw };
  log.push(row);
  console.log(`\n[${verdict}] ${step}`);
  if (detail) console.log(`      ${detail}`);
  if (raw) console.log(`      raw: ${raw}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 裸读（不签名、不带适配器缓存）：仓位真值只信交易所
async function readPos() {
  const u = `${TESTNET_API}/v1/positions?address=${k.address}&accountIndex=${k.accountIndex}`;
  const j = await (await fetch(u, { signal: AbortSignal.timeout(12000) })).json();
  const p = j.positions || {};
  const row = p['1'] || p[1] || null;
  if (!row || !Number(row.size)) return { size: 0, entry: null, raw: row };
  return { size: Number(row.size), entry: Number(row.averageEntryPrice), uPnl: Number(row.unrealizedPnl), raw: row };
}
async function readOpen() {
  const u = `${TESTNET_API}/v1/openOrders?address=${k.address}&accountIndex=${k.accountIndex}`;
  const j = await (await fetch(u, { signal: AbortSignal.timeout(12000) })).json();
  const rows = j.orders || j.data || [];
  return Array.isArray(rows) ? rows : [];
}
async function readBbo() {
  const u = `${TESTNET_API}/v1/bbo/${MARKET}`;
  const j = await (await fetch(u, { signal: AbortSignal.timeout(12000) })).json();
  // BBO 是嵌套结构：{ bestBid: { price, size }, bestAsk: { price, size } }
  const bid = Number(j?.bestBid?.price);
  const ask = Number(j?.bestAsk?.price);
  if (!(bid > 0) || !(ask > 0)) throw new Error(`bbo 解析失败：${JSON.stringify(j).slice(0, 160)}`);
  return { bid, ask };
}
async function readFills(fromUs) {
  const u = `${TESTNET_API}/v1/fills?address=${k.address}&market=${MARKET}&accountIndex=${k.accountIndex}&from=${fromUs}`;
  const j = await (await fetch(u, { signal: AbortSignal.timeout(12000) })).json();
  const rows = j.fills || j.data || j || [];
  return Array.isArray(rows) ? rows : [];
}

const tick = (p) => Number((Math.round(Number(p) / 0.1) * 0.1).toFixed(1));

const ex = new ArcusExchange({
  network: 'testnet',
  address: k.address,
  keyHex: k.ed25519SeedHex ?? k.ed25519Seed ?? k.seedHex,
  accountIndex: k.accountIndex ?? 0,
  market: MARKET,
  apiUrl: TESTNET_API,
});
ex.on('error', () => {});

// 下单包装：任何返回都记录原始响应摘要
async function order(label, opts) {
  const t0 = Date.now();
  try {
    const r = await ex.placeLimitOrder(opts);
    return { ok: true, ms: Date.now() - t0, orderId: r?.orderId, raw: JSON.stringify(r).slice(0, 400) };
  } catch (e) {
    return {
      ok: false, ms: Date.now() - t0,
      rejected: !!e.rejected,
      status: e.status ?? e.statusCode ?? null,
      code: e.code ?? e.errorCode ?? null,
      msg: String(e.message || e).slice(0, 300),
      body: e.body ? JSON.stringify(e.body).slice(0, 400) : null,
    };
  }
}

console.log(`\n=== P1 reduce-only 语义验证 · TESTNET ONLY ===`);
console.log(`address ${k.address} · accountIndex ${k.accountIndex} · market ${MARKET}\n`);

await ex.init();
const mkt = ex._market(1);
void mkt;
rec('init', 'INFO', `clockSkew ${ex.clockSkewMs}ms · markets ${ex.markets.size} · endpoint ${TESTNET_API}`);

// ---------- 基线 ----------
const pos0 = await readPos();
const open0 = await readOpen();
const bbo0 = await readBbo();
rec('BASE 基线', 'INFO',
  `position ${pos0.size} (entry ${pos0.entry ?? '-'}) · openOrders ${open0.length} · bid ${bbo0.bid} / ask ${bbo0.ask}`,
  JSON.stringify(pos0.raw || {}).slice(0, 240));

const side = pos0.size === 0 ? 'FLAT' : pos0.size > 0 ? 'LONG' : 'SHORT';
const absPos = Math.abs(pos0.size);
const fromUs = Date.now() * 1000 - 600_000_000;
const fillsBefore = (await readFills(fromUs)).length;

// ---------- E1：错误方向（若基线为 SHORT，卖=增空）----------
if (side === 'SHORT') {
  const r = await order('E1', {
    marketId: 1, side: 'sell', price: tick(bbo0.bid * 0.998), sizeBase: SMALL,
    reduceOnly: true, postOnly: false, levelIndex: 0, clientOrderId: 'vro-e1',
  });
  await sleep(700);
  const p1 = await readPos();
  const delta = +(p1.size - pos0.size).toFixed(8);
  if (!r.ok) {
    rec('E1 错误方向 reduceOnly SELL', 'REJECTED',
      `下单被拒 → 证明「下单时即校验」· status=${r.status} code=${r.code}`,
      `${r.msg}${r.body ? ' | ' + r.body : ''}`);
  } else {
    rec('E1 错误方向 reduceOnly SELL', delta < 0 ? 'DANGER' : 'ACCEPTED',
      `订单被接受 orderId=${r.orderId} · 仓位 ${pos0.size} → ${p1.size} (Δ${delta})`,
      r.raw);
  }
} else {
  rec('E1 错误方向 reduceOnly SELL', 'SKIP', `基线非 SHORT（${side}），跳过`);
}

// ---------- E2：正确方向（SHORT 仓 + reduceOnly BUY）----------
let posAfterE2 = await readPos();
if (posAfterE2.size < 0) {
  const bbo = await readBbo();
  const want = Math.min(SMALL, Math.abs(posAfterE2.size));
  const before = posAfterE2.size;
  const r = await order('E2', {
    marketId: 1, side: 'buy', price: tick(bbo.ask * 1.002), sizeBase: want,
    reduceOnly: true, postOnly: false, levelIndex: 0, clientOrderId: 'vro-e2',
  });
  await sleep(900);
  posAfterE2 = await readPos();
  const delta = +(posAfterE2.size - before).toFixed(8);
  const flipped = before < 0 && posAfterE2.size > 0;
  rec('E2 正确方向 reduceOnly BUY', !r.ok ? 'REJECTED' : flipped ? 'DANGER' : delta > 0 ? 'PASS' : 'NO_FILL',
    `orderId=${r.orderId ?? '-'} · 仓位 ${before} → ${posAfterE2.size} (Δ${delta})${flipped ? ' 翻转！' : ''}`,
    r.ok ? r.raw : `${r.msg}${r.body ? ' | ' + r.body : ''}`);
}

// ---------- E3：把剩余仓位清到 0 ----------
let posNow = await readPos();
let rounds = 0;
while (Math.abs(posNow.size) > 0.00009 && rounds < 24) {
  rounds++;
  const bbo = await readBbo();
  const want = Math.min(0.0006, Math.abs(posNow.size));
  const s = posNow.size < 0 ? 'buy' : 'sell';
  const px = s === 'buy' ? tick(bbo.ask * 1.01) : tick(bbo.bid * 0.99);
  await order(`E3-${rounds}`, {
    marketId: 1, side: s, price: px, sizeBase: Number(want.toFixed(8)),
    reduceOnly: true, postOnly: false, levelIndex: 0, clientOrderId: `vro-e3-${rounds}`,
  });
  await sleep(450);
  posNow = await readPos();
}
rec('E3 清仓到零', Math.abs(posNow.size) <= 0.00009 ? 'PASS' : 'PARTIAL',
  `${rounds} 轮 reduceOnly 平仓 · 仓位 ${pos0.size} → ${posNow.size}`);

// ---------- E4：关键实验 —— 0 仓位 + reduceOnly SELL ----------
const posFlat = await readPos();
if (Math.abs(posFlat.size) <= 0.00009) {
  const bbo = await readBbo();
  const r = await order('E4', {
    marketId: 1, side: 'sell', price: tick(bbo.bid * 0.998), sizeBase: SMALL,
    reduceOnly: true, postOnly: false, levelIndex: 0, clientOrderId: 'vro-e4',
  });
  await sleep(900);
  const p = await readPos();
  const nowShort = p.size < -0.00005;
  if (!r.ok) {
    rec('E4 ★ 空仓 + reduceOnly SELL', 'STRICT_PASS',
      `下单即被拒 → 语义在下单时强制 · status=${r.status} code=${r.code}`,
      `${r.msg}${r.body ? ' | ' + r.body : ''}`);
  } else if (nowShort) {
    rec('E4 ★ 空仓 + reduceOnly SELL', 'DANGER',
      `订单成交并开出空仓！仓位 0 → ${p.size} · orderId=${r.orderId}`,
      r.raw);
  } else {
    rec('E4 ★ 空仓 + reduceOnly SELL', 'SOFT_PASS',
      `订单被接受但仓位仍为 ${p.size}（未开仓）· orderId=${r.orderId}`, r.raw);
  }
  // 收掉 E4 可能挂着的单
  const leftE4 = await readOpen();
  for (const o of leftE4) {
    await ex.cancelOrder(1, o.orderId ?? o.order_id).catch(() => {});
  }
  await sleep(400);
} else {
  rec('E4 ★ 空仓 + reduceOnly SELL', 'SKIP', `未能清仓（${posFlat.size}），跳过决定性实验`);
}

// ---------- E5：建 LONG +0.0002 → reduceOnly SELL → 应归 0 ----------
const bbo5 = await readBbo();
const openR = await order('E5-open', {
  marketId: 1, side: 'buy', price: tick(bbo5.ask * 1.01), sizeBase: SMALL,
  reduceOnly: false, postOnly: false, levelIndex: 0, clientOrderId: 'vro-e5o',
});
await sleep(900);
const posLong = await readPos();
rec('E5a 建 LONG', Math.abs(posLong.size) < 0.00005 ? 'FAIL' : 'INFO',
  `orderId=${openR.orderId ?? '-'} · 仓位 → ${posLong.size}`, openR.ok ? openR.raw : openR.msg);

if (posLong.size > 0.00005) {
  const bbo6 = await readBbo();
  const before = posLong.size;
  const r = await order('E5-close', {
    marketId: 1, side: 'sell', price: tick(bbo6.bid * 0.998), sizeBase: Number(before.toFixed(8)),
    reduceOnly: true, postOnly: false, levelIndex: 0, clientOrderId: 'vro-e5c',
  });
  await sleep(900);
  const p = await readPos();
  const flipped = p.size < -0.00005;
  if (!r.ok) {
    rec('E5b reduceOnly SELL 平多', 'REJECTED', `被拒 code=${r.code} · 仓位 ${before} → ${p.size}`, r.msg);
  } else if (flipped) {
    rec('E5b reduceOnly SELL 平多', 'DANGER', `翻转成空仓！${before} → ${p.size}`, r.raw);
  } else {
    rec('E5b reduceOnly SELL 平多', 'PASS',
      `orderId=${r.orderId} · 仓位 ${before} → ${p.size}（${Math.abs(p.size) <= 0.00005 ? '归零 ✓' : '残余'}）`, r.raw);
  }
}

// ---------- 清理 ----------
for (const o of await readOpen()) {
  await ex.cancelOrder(1, o.orderId ?? o.order_id).catch(() => {});
}
await sleep(600);

const finalPos = await readPos();
const finalOpen = await readOpen();
const fillsAfter = await readFills(fromUs);
const newFills = fillsAfter.slice(0, 12).map((f) => ({
  id: f.tradeId ?? f.id, side: f.side, p: f.price, q: f.size ?? f.quantity, fee: f.fee, role: f.role,
}));

rec('FINAL 收尾', Math.abs(finalPos.size) <= 0.00009 && finalOpen.length === 0 ? 'CLEAN' : 'RESIDUAL',
  `position ${finalPos.size} · openOrders ${finalOpen.length} · 本次成交 ${fillsAfter.length - fillsBefore} 笔`,
  JSON.stringify(newFills));

ex.stop?.();

const report = {
  at: new Date().toISOString(), scope: 'testnet-only', address: k.address, accountIndex: k.accountIndex,
  baseline: { position: pos0.size, entry: pos0.entry, openOrders: open0.length, bid: bbo0.bid, ask: bbo0.ask },
  final: { position: finalPos.size, openOrders: finalOpen.length },
  verdicts: log.map(({ step, verdict, detail }) => ({ step, verdict, detail })),
  fills: newFills,
};
fs.writeFileSync('/tmp/reduce-only-report.json', JSON.stringify(report, null, 1));
console.log(`\n报告 → /tmp/reduce-only-report.json\n`);
process.exit(0);