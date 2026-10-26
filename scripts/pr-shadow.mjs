#!/usr/bin/env node
// Propr M1 Shadow：只读盯盘 + 差分 + 验收（不会发任何写请求）。
//
//   node scripts/pr-shadow.mjs                 # 每 5s 一轮，一直跑
//   node scripts/pr-shadow.mjs --rounds 12     # 跑 12 轮后退出
//   node scripts/pr-shadow.mjs --interval 10 --json
//
// 退出码：0 通过；2 出现写尝试；3 快照过期；4 目标账户校验失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPropr, resolveTargetAttempt } from '../src/exchange/pr/index.js';
import { ProprShadow } from '../src/exchange/pr/shadow.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const f = path.join(root, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2].trim();
    const q = v.match(/^"([^"]*)"|^'([^']*)'/);
    process.env[m[1]] = q ? (q[1] ?? q[2]) : v.replace(/\s+#.*$/, '').trim();
  }
}
loadEnv();

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const rounds = Number(arg('--rounds', 0)) || 0;
const intervalMs = Math.max(1, Number(arg('--interval', 5))) * 1000;
const asJson = argv.includes('--json');
const maxInvUsd = Number(process.env.PR_MAX_INV_USD || 1500);
const capacityLeverage = Number(process.env.PR_CAPACITY_LEVERAGE || 1);
const staleMs = Number(process.env.PR_STALE_MS || 45_000);

const logFile = path.join(root, '.runtime', 'pr-shadow.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });

function log(obj) {
  if (asJson) { console.log(JSON.stringify(obj)); return; }
  const t = new Date(obj.at || Date.now()).toISOString().slice(11, 19);
  const a = obj.account || {};
  const p = obj.positions || {};
  console.log(
    `[${t}] #${obj.round} eq=${fmt(a.equity)} bal=${fmt(a.balance)} avail=${fmt(a.available)} ` +
    `L=${fmt(p.long?.size ?? 0)} S=${fmt(p.short?.size ?? 0)} ord=${obj.orders ?? 0} ` +
    `trd+${obj.newTrades ?? 0} dup=${obj.duplicateTrades ?? 0} lat=${obj.latencyMs ?? 0}ms wr=${obj.writeAttemptCount ?? 0} ` +
    `cap=$${obj.capacity ?? 0}${obj.dualSide ? ' ⚠DUAL' : ''}${obj.warn ? ' ' + obj.warn : ''}`,
  );
  fs.appendFileSync(logFile, JSON.stringify(obj) + '\n');
}

function fmt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) >= 1000 ? n.toFixed(2) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

(async () => {
  if ((process.env.PR_MODE || '').toLowerCase() !== 'shadow') {
    console.error(`需要 PR_MODE=shadow（当前 ${process.env.PR_MODE || '未设置'}）`);
    process.exit(4);
  }
  const app = createPropr({
    mode: 'shadow',
    apiKey: process.env.PR_API_KEY,
    apiKeyFile: process.env.PR_API_KEY_FILE,
    accountId: process.env.PR_ACCOUNT_ID,
    baseUrl: process.env.PR_BASE_URL,
    root,
    maxInvUsd,
    capacityLeverage,
    staleMs,
  });
  const { client, shadow } = app;

  let attempt;
  try {
    attempt = await resolveTargetAttempt({ client, accountId: process.env.PR_ACCOUNT_ID });
  } catch (e) {
    console.error(`目标账户校验失败: ${e.message}`);
    process.exit(4);
  }
  console.log(`目标 attempt: ${attempt.attemptId} status=${attempt.status} account=${attempt.accountId} challenge=${attempt.challengeId}`);
  console.log(`容量上限: min($${maxInvUsd}, available × ${capacityLeverage}x × 0.8)  —— 平台杠杆不会放大它`);

  let prev = null;
  let round = 0;
  let failures = 0;
  let lastWarn = null;
  const seenOrderIds = new Set();

  for (;;) {
    round++;
    let snap;
    try {
      snap = await shadow.refresh();
      shadow.assertFresh(snap);
      shadow.assertNoWrites();
    } catch (e) {
      failures++;
      console.error(`[${new Date().toISOString().slice(11, 19)}] 第 ${round} 轮失败: ${e.message}`);
      if (failures >= 5) { console.error('连续失败 5 次，退出'); process.exit(3); }
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    failures = 0;

    const d = ProprShadow.diff(prev, snap);
    const ids = new Set(snap.orders.map((o) => o.orderId));
    for (const id of ids) seenOrderIds.add(id);

    let warn = null;
    if (snap.positions.dualSide) warn = '双边持仓';
    else if (snap.capacity.leverageWarn) warn = `杠杆 ${snap.leverage}x > 3x（容量仍按 ${snap.capacity.capacityLeverage}x 计）`;
    else if (d && (d.ordersAdded.length || d.ordersRemoved.length)) warn = `挂单变动 +${d.ordersAdded.length}/-${d.ordersRemoved.length}`;
    lastWarn = warn;

    log({
      round, at: snap.at, account: snap.account,
      positions: { long: snap.positions.long, short: snap.positions.short },
      orders: snap.orders.length,
      orderIds: [...ids],
      newTrades: snap.newTrades.length,
      duplicateTrades: shadow.stats.duplicateTrades,
      latencyMs: snap.latencyMs,
      writeAttemptCount: snap.writeAttemptCount,
      capacity: snap.capacity.maxOpenNotional,
      leverage: snap.leverage,
      dualSide: snap.positions.dualSide,
      pages: snap.pages,
      diff: d,
      warn,
    });
    prev = snap;

    if (rounds && round >= rounds) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  console.log('\n── 验收 ──');
  const okWrites = client.writeAttemptCount === 0;
  console.log(`写尝试次数: ${client.writeAttemptCount} ${okWrites ? '✅' : '❌'}`);
  console.log(`轮数: ${round}  请求数: ${client.requestCount}  新成交: ${shadow.stats.newTrades}  重复成交: ${shadow.stats.duplicateTrades}`);
  console.log(`见过的不重复 orderId 数: ${seenOrderIds.size}`);
  console.log(`日志: ${path.relative(root, logFile)}`);
  if (lastWarn) console.log(`最后一轮告警: ${lastWarn}`);
  process.exit(okWrites ? 0 : 2);
})().catch((e) => {
  console.error('shadow 异常:', e);
  process.exit(1);
});