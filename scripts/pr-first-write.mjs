#!/usr/bin/env node
// Propr 第一笔真实写入的 8 步流程（附件 F）。默认 dry-run，必须显式 --execute。
//
//   1 检查 long=0 / short=0 / open=0
//   2 发一张极远价 GTX 限价单（默认低于现价 20%）
//   3 确认进入 open
//   4 相同 intentId 重发一次
//   5 确认最终只有一张订单
//   6 撤单
//   7 连续两次读取确认订单消失
//   8 再次确认 long=0 / short=0
//
// 只允许 Free Trial：PR_MODE=sim-write、PR_ALLOW_CHALLENGE≠YES、accountId 精确命中。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProprClient, ulid } from '../src/exchange/pr/client.js';
import { ProprWriter } from '../src/exchange/pr/write.js';
import { splitPositions, openOrders } from '../src/exchange/pr/mapper.js';
import { evaluateWriteGate, computeRiskState } from '../src/exchange/pr/risk.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const OFFSET = Number((args.find((a) => a.startsWith('--offset=')) || '').split('=')[1] || 0.2);
const QTY = Number((args.find((a) => a.startsWith('--qty=')) || '').split('=')[1] || 0.001);

function loadEnv() {
  const f = path.join(root, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    const v = m[2].trim();
    const q = v.match(/^"([^"]*)"|^'([^']*)'/);
    process.env[m[1]] = q ? (q[1] ?? q[2]) : v.replace(/\s+#.*$/, '').trim();
  }
}
loadEnv();

const step = (n, msg) => console.log(`[${n}/8] ${msg}`);
const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(2); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mode = (process.env.PR_MODE || '').toLowerCase();
  if (mode !== 'sim-write') fail(`需要 PR_MODE=sim-write（当前 ${mode || '未设置'}）`);
  if ((process.env.PR_ALLOW_CHALLENGE || 'NO').toUpperCase() === 'YES') fail('PR_ALLOW_CHALLENGE=YES，拒绝执行');
  const accountId = process.env.PR_ACCOUNT_ID || '';
  if (!accountId) fail('缺少 PR_ACCOUNT_ID');

  const client = new ProprClient({
    apiKey: process.env.PR_API_KEY || '',
    baseUrl: process.env.PR_BASE_URL,
    allowWrites: EXECUTE,
  });
  const writer = new ProprWriter({ client, accountId, asset: process.env.PR_SYMBOL || 'BTC', paceMs: 150 });

  // attempt 校验：必须精确命中且 active
  const attempts = (await client.getAttempts({ limit: 50 })).data ?? [];
  const norm = (x) => String(x).replace(/^urn:prp-account:/, '');
  const hit = attempts.filter((a) => norm(a.accountId) === norm(accountId));
  if (hit.length !== 1) fail(`PR_ACCOUNT_ID 命中 ${hit.length} 个 attempt`);
  if (String(hit[0].status).toLowerCase() !== 'active') fail(`attempt 状态 ${hit[0].status}`);
  console.log(`目标: ${hit[0].attemptId}  account=${accountId}  mode=${mode}  execute=${EXECUTE}`);

  // 1) 前置状态
  const pos = await client.getPositions(accountId);
  const ord = await client.getOrders(accountId, { status: 'open' });
  const { long, short, dualSide } = splitPositions(pos.rows);
  const open = openOrders(ord.rows);
  step(1, `long=${long?.size ?? 0} short=${short?.size ?? 0} dualSide=${dualSide} openOrders=${open.length}`);
  if (dualSide) fail('双边持仓：先人工处理');
  if ((long?.size ?? 0) > 0 || (short?.size ?? 0) > 0) fail('已有持仓，拒绝铺测试单');
  if (open.length > 0) fail('已有挂单，先撤干净');

  const acct = await client.getAccount(accountId);
  const a = acct.data ?? acct;
  const gate = evaluateWriteGate({
    mode, allowLive: (process.env.PR_ALLOW_LIVE || 'NO').toUpperCase() === 'YES',
    attemptStatus: hit[0].status, accountAgeMs: 0,
    positions: { dualSide }, risk: computeRiskState({ equity: a.marginBalance, balance: a.balance, dayStartBalance: a.balance, startBalance: Number(process.env.PR_START_BALANCE || 5000) }),
    notional: 0, maxOpenNotional: Number(process.env.PR_MAX_INV_USD || 1500), newNotional: 0,
  });
  if (!gate.allowOpen) fail(`写门拒绝: ${gate.reasons.join('; ')}`);

  const mid = await fetchMid();
  const price = roundTick(mid * (1 - OFFSET));
  const intentId = ulid();
  console.log(`\n计划: BUY ${QTY} BTC @ ${price}（现价 ${mid}，-${(OFFSET * 100).toFixed(0)}%）GTX intentId=${intentId}`);
  if (!EXECUTE) {
    console.log('\n(dry-run) 未发送任何写请求。确认无误后加 --execute 重跑。');
    return;
  }

  // 2) 下单
  const order = await writer.placeLimitOrder({ side: 'buy', positionSide: 'long', qty: QTY, price, timeInForce: 'GTX', intentId });
  step(2, `已下单 ${order.orderId}`);

  // 3) 确认 open
  await sleep(1200);
  let openNow = await fetchOpen(client, accountId);
  if (!openNow.some((o) => o.orderId === order.orderId)) fail('订单未进入 open');
  step(3, `确认 open（${openNow.length} 张）`);

  // 4) 同 intentId 重发
  const again = await writer.placeLimitOrder({ side: 'buy', positionSide: 'long', qty: QTY, price, timeInForce: 'GTX', intentId }).catch((e) => ({ error: e }));
  step(4, again?.orderId ? `重发返回同一张 ${again.orderId}` : `重发报错（已对账处理）: ${again?.error?.message || '—'}`);

  // 5) 只能有一张
  await sleep(1200);
  openNow = await fetchOpen(client, accountId);
  const same = openNow.filter((o) => Number(o.price) === Number(price));
  if (same.length !== 1) fail(`同价订单 ${same.length} 张（应为 1）`);
  step(5, `同价订单 1 张 ✅`);

  // 6) 撤单
  await writer.cancelOrder(order.orderId);
  step(6, '已发撤单');

  // 7) 两次确认消失
  for (let i = 0; i < 2; i++) {
    await sleep(1200);
    openNow = await fetchOpen(client, accountId);
    if (openNow.some((o) => o.orderId === order.orderId)) fail(`第 ${i + 1} 次确认仍存在`);
    step(7, `第 ${i + 1} 次确认已消失`);
  }

  // 8) 仓位复核
  const pos2 = await client.getPositions(accountId);
  const p2 = splitPositions(pos2.rows);
  if ((p2.long?.size ?? 0) > 0 || (p2.short?.size ?? 0) > 0) fail('出现持仓，需人工检查');
  step(8, `long=0 short=0 ✅  写请求总数=${client.writeAttemptCount}`);
  console.log('\n✅ 第一笔写入流程通过，可以铺 6 张网格。');
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });

async function fetchOpen(client, accountId) {
  const res = await client.getOrders(accountId, { status: 'open' });
  return openOrders(res.rows);
}

async function fetchMid() {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  });
  const d = await res.json();
  const px = Number(d.BTC);
  if (!px) throw new Error('拿不到 BTC 现价');
  return px;
}

function roundTick(px) {
  return Math.round(px * 2) / 2;   // BTC 最小变动 0.5
}