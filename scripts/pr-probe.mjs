#!/usr/bin/env node
// M0 只读探针：把 Propr 账户的真实字段摊开，落 .runtime/pr-probe/。
//
//   node scripts/pr-probe.mjs            # 只读 GET（+ 可选 WS 监听）
//   PR_WS_SNIFF=1 node scripts/pr-probe.mjs   # 额外监听 WS 30 秒
//
// 安全边界：**只发 GET**。没有任何下单/撤单/改杠杆代码，也不读私钥。
// 输出会遮掉 key；原始 JSON 落在 .runtime/pr-probe/（已 gitignore）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = path.join(root, '.runtime', 'pr-probe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// ── .env 读取（不覆盖已有环境变量，和 src/config.js 同规则）──────────────
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

const BASE = (process.env.PR_BASE_URL || 'https://api.propr.xyz/v1').replace(/\/$/, '');
const WS_URL = process.env.PR_WS_URL || 'wss://api.propr.xyz/ws';
const fileKey = process.env.PR_API_KEY_FILE
  ? fs.readFileSync(path.resolve(root, process.env.PR_API_KEY_FILE), 'utf8').trim()
  : '';
const KEY = fileKey || (process.env.PR_API_KEY || '').trim();
const ACCOUNT_ID = (process.env.PR_ACCOUNT_ID || '').trim();

fs.mkdirSync(OUTDIR, { recursive: true });
const saved = [];
function save(name, data) {
  const f = path.join(OUTDIR, `${name}-${stamp}.json`);
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  saved.push(path.relative(root, f));
}

async function api(p, { auth = true } = {}) {
  const url = BASE + p;
  const headers = { Accept: 'application/json' };
  if (auth && KEY) headers['X-API-Key'] = KEY;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text.slice(0, 400); }
    return { ok: res.ok, status: res.status, body, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, body: { message: e.message }, ms: Date.now() - t0 };
  }
}

const num = (x) => (x == null || x === '' ? null : Number(x));
const money = (x) => (x == null || !Number.isFinite(Number(x)) ? '—' : Number(x).toFixed(4));

async function paged(p, maxPages = 5, limit = 100) {
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const r = await api(`${p}${p.includes('?') ? '&' : '?'}limit=${limit}&offset=${page * limit}`);
    if (!r.ok) return { rows, error: r };
    const data = r.body?.data ?? (Array.isArray(r.body) ? r.body : []);
    rows.push(...data);
    if (data.length < limit) return { rows, complete: true };
  }
  return { rows, complete: false };
}

function hr(t) { console.log(`\n${'─'.repeat(64)}\n${t}\n${'─'.repeat(64)}`); }

const report = { at: new Date().toISOString(), base: BASE, steps: {} };

(async () => {
  hr(`Propr M0 只读探针  ${new Date().toISOString()}`);
  console.log(`base=${BASE}  key=${KEY ? KEY.slice(0, 8) + '…' + KEY.slice(-4) : '(未配置)'}`);

  // 1) 健康检查（无鉴权）
  const health = await api('/health', { auth: false });
  const services = await api('/health/services', { auth: false });
  console.log(`health: ${health.status} ${JSON.stringify(health.body)}`);
  console.log(`services: ${services.status} ${JSON.stringify(services.body)}`);
  save('health', { health, services });
  report.steps.health = { status: health.status, services: services.body };

  if (!KEY) {
    console.log('\n未配置 PR_API_KEY / PR_API_KEY_FILE —— 到此为止（只做了无鉴权探针）。');
    console.log('把 key 写进 .env（PR_API_KEY=）或用 PR_API_KEY_FILE 指向 600 的文件后重跑。');
    process.exit(0);
  }

  // 2) 我是谁
  const me = await api('/users/me');
  console.log(`\nGET /users/me  -> ${me.status} ${me.ok ? JSON.stringify(me.body).slice(0, 300) : JSON.stringify(me.body)}`);
  save('users-me', me.body);
  report.steps.me = { status: me.status, body: me.body };

  // 3) challenge attempts
  const attempts = await api('/challenge-attempts?limit=50');
  const arows = attempts.body?.data ?? [];
  console.log(`\nGET /challenge-attempts -> ${attempts.status}, ${arows.length} 条`);
  for (const a of arows) {
    console.log(`  · ${a.attemptId ?? a.id}  status=${a.status}  phase=${a.phase ?? '-'}  ` +
      `accountId=${a.accountId ?? '-'}  pnl=${a.totalPnl ?? a.pnl ?? '-'}  dd=${a.maxDrawdown ?? '-'}`);
  }
  save('attempts', attempts.body);
  const active = arows.find((a) => String(a.status).toLowerCase() === 'active');
  const accountId = ACCOUNT_ID || active?.accountId || arows[0]?.accountId || '';
  console.log(`accountId 使用: ${accountId || '(无)'}  ${ACCOUNT_ID ? '[来自 .env]' : '[来自 active attempt]'}`);
  report.steps.attempts = { status: attempts.status, count: arows.length, accountId };

  if (!accountId) {
    console.log('\n没有 accountId，后续账户接口跳过。');
    process.exit(0);
  }
  const A = `/accounts/${accountId}`;   // URN 用原样，冒号在 path 段合法

  // 4) 账户状态（未文档化；这是唯一的 REST 权益来源）
  const acct = await api(A);
  hr(`GET ${A}   -> ${acct.status}`);
  if (acct.ok) {
    const b = acct.body?.data ?? acct.body;
    const keys = Object.keys(b || {});
    console.log(`字段(${keys.length}): ${keys.join(', ')}`);
    for (const k of ['balance', 'equity', 'marginBalance', 'availableBalance', 'totalUnrealizedPnl',
      'highWaterMark', 'crossPositionMargin', 'totalMaintenanceMargin', 'totalInitialMargin']) {
      if (b && k in b) console.log(`  ${k.padEnd(22)} ${b[k]}`);
    }
  } else {
    console.log(`失败 ${acct.status}: ${JSON.stringify(acct.body)}  ← 端点可能不存在/未开放`);
  }
  save('account', { status: acct.status, body: acct.body });
  report.steps.account = { status: acct.status, body: acct.body };

  // 5) 持仓
  const pos = await paged(`${A}/positions`, 3, 100);
  const live = (pos.rows || []).filter((p) => Number(p.quantity) !== 0);
  hr(`GET ${A}/positions -> ${live.length} 个非零仓位（原始 ${pos.rows?.length ?? 0}）`);
  for (const p of live) {
    console.log(`  · ${p.asset} ${p.positionSide} qty=${p.quantity} entry=${p.entryPrice} ` +
      `mark=${p.markPrice} liq=${p.liquidationPrice} lev=${p.leverage} ${p.marginMode} ` +
      `uPnl=${p.unrealizedPnl} margin=${p.marginUsed}`);
  }
  const sides = [...new Set(live.map((p) => p.positionSide))];
  if (sides.length > 1) console.log('  ⚠ 同时存在 long 与 short —— 确认双边持仓行为');
  save('positions', pos.rows ?? pos.error?.body);
  report.steps.positions = { count: live.length, sides, sample: live.slice(0, 3) };

  // 6) 挂单
  const orders = await paged(`${A}/orders?status=open`, 5, 100);
  hr(`GET ${A}/orders?status=open -> ${orders.rows?.length ?? 0} 张`);
  const bySide = {};
  for (const o of orders.rows || []) {
    bySide[`${o.side}/${o.positionSide}`] = (bySide[`${o.side}/${o.positionSide}`] || 0) + 1;
  }
  console.log(`  分布: ${JSON.stringify(bySide)}  分页完整=${orders.complete}`);
  for (const o of (orders.rows || []).slice(0, 8)) {
    console.log(`  · ${o.asset} ${o.side}/${o.positionSide} ${o.type} ${o.quantity}@${o.price ?? o.triggerPrice} ` +
      `ro=${o.reduceOnly} status=${o.status} id=${o.orderId}`);
  }
  save('orders-open', orders.rows ?? orders.error?.body);
  report.steps.orders = { count: orders.rows?.length ?? 0, bySide, complete: orders.complete };

  // 7) 成交（费率校准的关键）
  const trades = await paged(`${A}/trades`, 5, 100);
  const trows = trades.rows || [];
  hr(`GET ${A}/trades -> ${trows.length} 笔`);
  const feeRates = {};
  const liq = {};
  let feeSum = 0, pnlSum = 0, notional = 0;
  for (const t of trows) {
    feeRates[t.feeRate] = (feeRates[t.feeRate] || 0) + 1;
    liq[t.liquidityType] = (liq[t.liquidityType] || 0) + 1;
    feeSum += num(t.fee) || 0;
    pnlSum += num(t.realizedPnl) || 0;
    notional += num(t.quoteQuantity) || 0;
  }
  console.log(`  feeRate 分布: ${JSON.stringify(feeRates)}   ← 决定网格保本间距`);
  console.log(`  liquidity: ${JSON.stringify(liq)}`);
  console.log(`  Σfee=${money(feeSum)}  ΣrealizedPnl=${money(pnlSum)}  Σ名义=${money(notional)}`);
  if (trows.length) {
    const t0 = trows[0];
    console.log(`  样本: ${t0.asset} ${t0.type} ${t0.side} qty=${t0.quantity} px=${t0.price} ` +
      `fee=${t0.fee} rate=${t0.feeRate} pnl=${t0.realizedPnl} at=${t0.executedAt}`);
  }

  // 8) 账本校准：balance ≈ 初始 + ΣrealizedPnl − Σfee ?
  const b = acct.ok ? (acct.body?.data ?? acct.body) : null;
  if (b) {
    const bal = num(b.balance);
    const start = num(process.env.PR_START_BALANCE) || num(process.env.PR_ACCOUNT_SIZE) || 5000;
    if (bal != null) {
      const implied1 = start + pnlSum - feeSum;
      const implied2 = start + pnlSum;
      console.log(`\n  账本校准: balance=${money(bal)}  初始=${money(start)}`);
      console.log(`    start + Σpnl − Σfee = ${money(implied1)}   差 ${money(bal - implied1)}`);
      console.log(`    start + Σpnl        = ${money(implied2)}   差 ${money(bal - implied2)}`);
      console.log(`    → 差值更小的那个，说明 realizedPnl ${Math.abs(bal - implied1) < Math.abs(bal - implied2) ? '不含' : '含'}手续费（成交可能未翻页完全）`);
      report.steps.ledger = { balance: bal, implied1, implied2 };
    }
  }
  save('trades', trows);
  report.steps.trades = { count: trows.length, feeRates, liq, feeSum, pnlSum, complete: trades.complete };

  // 9) 杠杆与市场
  const mc = await api(`${A}/margin-config/BTC`);
  const ll = await api('/leverage-limits/effective', { auth: false });
  hr(`margin-config/BTC -> ${mc.status}   leverage-limits -> ${ll.status}`);
  console.log(`  margin-config: ${JSON.stringify(mc.body?.data ?? mc.body).slice(0, 300)}`);
  console.log(`  limits: ${JSON.stringify(ll.body).slice(0, 300)}`);
  save('margin-config', mc.body);
  save('leverage-limits', ll.body);
  report.steps.margin = { marginConfig: mc.body, limits: ll.body };

  // 10) 可选 WS 监听
  if (process.env.PR_WS_SNIFF === '1') {
    hr(`WS ${WS_URL} 监听 30s`);
    try {
      const { WebSocket } = await import('undici');
      const events = [];
      const ws = new WebSocket(WS_URL, { headers: { 'X-API-Key': KEY } });
      const done = new Promise((resolve) => {
        const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 30_000);
        ws.addEventListener('open', () => console.log('  connected'));
        ws.addEventListener('message', (ev) => {
          const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString();
          try {
            const m = JSON.parse(raw);
            events.push(m);
            if (events.length <= 8) console.log(`  ${m.type} ${JSON.stringify(m.data ?? {}).slice(0, 160)}`);
          } catch { /* ignore */ }
        });
        ws.addEventListener('error', (e) => console.log(`  error: ${e.message || e}`));
        ws.addEventListener('close', () => { clearTimeout(timer); resolve(); });
      });
      await done;
      save('ws-events', events);
      console.log(`  收到 ${events.length} 条，类型: ${JSON.stringify([...new Set(events.map((e) => e.type))])}`);
      report.steps.ws = { count: events.length, types: [...new Set(events.map((e) => e.type))] };
    } catch (e) {
      console.log(`  WS 失败: ${e.message}`);
    }
  }

  save('report', report);
  hr('完成');
  console.log(`原始 JSON: ${saved.length} 个文件 → .runtime/pr-probe/`);
  console.log('把上面这段输出整段贴回来即可（key 已遮罩，不含敏感信息）。');
})().catch((e) => {
  console.error('探针异常:', e);
  process.exit(1);
});