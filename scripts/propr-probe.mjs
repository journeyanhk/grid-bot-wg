#!/usr/bin/env node
// Propr Day-0 契约探针：只读链 + 可选写链（订单/幂等/持仓），用于冻结 API 契约。
//
// 用法：
//   node scripts/propr-probe.mjs                  # 只读链（默认，无任何写请求）
//   node scripts/propr-probe.mjs order --allow-write
//   node scripts/propr-probe.mjs idempotency --allow-write
//   node scripts/propr-probe.mjs position --allow-write
//   node scripts/propr-probe.mjs all --allow-write
//
// 安全护栏：
//  1) 写链必须显式 --allow-write；只读链绝不调用任何写接口；
//  2) 绝不盲撤单/盲平仓：只处理本探针创建的 orderId 与本探针开出的仓位增量；
//  3) 若账户已有 BTC 持仓/挂单，写链对应方向自动跳过（不触碰用户仓位）；
//  4) 全部输出经脱敏（accountId 仅前 4+后 4；密钥不入日志）。
//
// 依赖：PROPR_API_KEY / PROPR_ACCOUNT_ID 已写入 .env（勿提交仓库）。
// 代理：Node fetch 不自动读取系统代理；若 api.propr.xyz 不可达，可显式指定
//   PR_PROXY=http://127.0.0.1:10808 node scripts/propr-probe.mjs readonly
import { getConfig } from '../src/config.js';
import { createDispatcher } from '../src/proxy.js';
import { ProprClient, ProprAPIError } from '../src/exchange/propr/propr-sdk.js';
import { redactRecord, maskAccountId } from '../src/redact.js';
import { ulid } from 'ulid';

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) || 'readonly';
const allowWrite = argv.includes('--allow-write');
const VALID = ['discover', 'readonly', 'order', 'idempotency', 'position', 'all'];

const cfg = getConfig().propr;
const BASE = cfg.base || 'BTC';
const QUOTE = 'USDC';
const QTY = String(process.env.PR_PROBE_QTY || '0.001');

const createdOrderIds = new Set();
const openedLegs = [];

function log(msg, ctx) {
  const safe = ctx ? JSON.stringify(redactRecord(ctx)) : '';
  console.log(`${msg}${safe ? ' ' + safe : ''}`);
}

function fail(msg) {
  console.error(`[探针失败] ${msg}`);
  process.exitCode = 1;
}

function requireCreds(needAccount = true) {
  if (!cfg.apiKey) throw new Error('缺少 PROPR_API_KEY（写入 .env，勿提交仓库）。');
  if (needAccount && !cfg.accountId) throw new Error('缺少 PROPR_ACCOUNT_ID（显式指定，禁止自动发现）。');
}

// 参考价：Propr 无公开行情端点，用底层交易所 Hyperliquid 的 allMids（公开、免鉴权）
async function fetchBtcMark() {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  });
  if (!res.ok) throw new Error(`HL allMids HTTP ${res.status}`);
  const mids = await res.json();
  const px = Number(mids?.[BASE]);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`无法获取 ${BASE} 标记价（HL allMids）`);
  return px;
}

// 报价取整：BTC 价格小数位按 1 位保守处理（真实精度由探针结果回填 docs/propr-api-contract.md）
function roundPrice(px) {
  return Number(Number(px).toFixed(1));
}

function buildLimitRecord({ side, positionSide, price, asset, intentId, reduceOnly = false }) {
  return {
    accountId: cfg.accountId,
    intentId: intentId ?? ulid(),
    exchange: 'hyperliquid',
    type: 'limit',
    side,
    positionSide,
    productType: 'perp',
    timeInForce: 'GTC',
    asset,
    base: BASE,
    quote: QUOTE,
    quantity: QTY,
    price: String(price),
    reduceOnly,
    closePosition: false,
  };
}

function buildMarketRecord({ side, positionSide, quantity, asset, reduceOnly = false, closePosition = false }) {
  return {
    accountId: cfg.accountId,
    intentId: ulid(),
    exchange: 'hyperliquid',
    type: 'market',
    side,
    positionSide,
    productType: 'perp',
    timeInForce: 'IOC',
    asset,
    base: BASE,
    quote: QUOTE,
    quantity: String(quantity),
    reduceOnly,
    closePosition,
  };
}

async function findOpenByIntent(intentId) {
  const open = await client.getOrders({ base: BASE, status: 'open', limit: 100 });
  return open.filter((o) => o.intentId === intentId);
}

async function cancelTracked() {
  for (const id of createdOrderIds) {
    try { await client.cancelOrder(id); } catch { /* 已成交/已撤由对账复核 */ }
  }
  createdOrderIds.clear();
}

// ── 账户发现（仅认证，不依赖 accountId；用于修正 PROPR_ACCOUNT_ID）──────────

async function probeDiscover() {
  const user = redactRecord(await client.getUser());
  const seen = new Map();
  for (const status of [undefined, 'active', 'passed', 'failed']) {
    try {
      const rows = await client.getChallengeAttempts(status ? { status, limit: 50 } : { limit: 50 });
      for (const r of rows) {
        if (!seen.has(r.attemptId)) seen.set(r.attemptId, { status: r.status, accountId: r.accountId, attemptId: r.attemptId, challengeId: r.challengeId, currentPhaseId: r.currentPhaseId });
      }
    } catch (err) {
      log(`getChallengeAttempts(${status ?? 'all'}) 失败`, { message: err?.message, statusCode: err?.statusCode });
    }
  }
  const attempts = [...seen.values()];
  const configured = cfg.accountId;

  // 完整 accountId 只落本地 runtime 文件（供修正 .env），控制台仅打印掩码
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve(process.cwd(), '.runtime');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'propr-discover.json');
  fs.writeFileSync(file, JSON.stringify({ user, attempts, configured }, null, 2), { mode: 0o600 });

  log('── 账户发现（控制台掩码，完整值已写入 .runtime/propr-discover.json）──');
  console.log(JSON.stringify(redactRecord({
    user,
    configuredAccountId: configured,
    configuredMatchesAny: attempts.some((a) => a.accountId === configured),
    attempts: attempts.map((a) => ({ ...a, accountId: maskAccountId(a.accountId) })),
  }), null, 2));
  log(`完整账户 ID 候选已写入 ${file}（已 gitignore），请据此修正 .env 的 PROPR_ACCOUNT_ID`);
  return attempts;
}

// ── 只读链 ────────────────────────────────────────────────────────────────

async function probeReadonly() {
  const out = {};
  out.health = await client.health();
  out.healthServices = await client.healthServices();
  out.user = redactRecord(await client.getUser());

  const challenges = await client.getChallenges({ limit: 5 });
  out.challenges = challenges.map((c) => redactRecord(c));

  const active = await client.getChallengeAttempts({ status: 'active' });
  out.activeAttempts = active.map((a) => redactRecord(a));

  const attempt = active.find((a) => a.accountId === cfg.accountId) || active[0];
  if (attempt) {
    out.challengeAttempt = redactRecord(await client.getChallengeAttempt(attempt.attemptId));
    out.challengeAttemptPhases = redactRecord(attempt.phases ?? attempt.currentPhase ?? null);
  }

  out.marginConfig = redactRecord(await client.getMarginConfig(BASE));
  out.leverageLimits = await client.getLeverageLimits();
  out.maxLeverage = await client.maxLeverage(BASE);

  const positions = await client.getPositions({ base: BASE, status: 'open' });
  out.positions = positions.map((p) => redactRecord(p));
  out.positionSides = positions.map((p) => p.positionSide);

  const orders = await client.getOrders({ base: BASE, status: 'open', limit: 100 });
  out.openOrders = orders.map((o) => redactRecord(o));

  const trades = await client.getTrades({ base: BASE, limit: 20 });
  out.trades = trades.map((t) => redactRecord(t));

  log('── 只读链结果（脱敏）──');
  console.log(JSON.stringify(out, null, 2));
  log('关键待冻结项:', {
    assetFormatHint: 'order 链将实测 asset=BTC vs BTC/USDC',
    positionSides: out.positionSides,
    maxLeverage: out.maxLeverage,
    equityFieldPresent: Object.keys(out.challengeAttempt || {}).filter((k) => /equity|balance/i.test(k)),
  });
  return out;
}

// ── 写链：订单（远市价限价单 → 校验 → 撤单）────────────────────────────────

async function probeOrder() {
  const mark = await fetchBtcMark();
  const buyPrice = roundPrice(mark * 0.5);
  const sellPrice = roundPrice(mark * 2);

  const baseline = await client.getOrders({ base: BASE, status: 'open', limit: 100 });
  log('写链基线（仅观测，不触碰）:', { openOrders: baseline.length, mark });

  const assetCandidates = [BASE, `${BASE}/${QUOTE}`];
  let assetUsed = null;
  let created = null;
  let lastErr = null;

  for (const asset of assetCandidates) {
    const intentId = ulid();
    try {
      const rows = await client.createOrders([buildLimitRecord({ side: 'buy', positionSide: 'long', price: buyPrice, asset, intentId })]);
      created = rows[0] ?? null;
      assetUsed = asset;
      if (created?.orderId) createdOrderIds.add(created.orderId);
      log(`createOrders 成功（asset=${asset}）`, created);
      break;
    } catch (err) {
      lastErr = err;
      log(`createOrders 失败（asset=${asset}）`, { message: err?.message, statusCode: err?.statusCode, code: err?.code });
    }
  }
  if (!created) throw lastErr ?? new Error('createOrders 全部 asset 口径失败');

  const byIntent = await findOpenByIntent(created.intentId);
  log('按 intentId 回查挂单:', { matched: byIntent.length, side: byIntent[0]?.side, positionSide: byIntent[0]?.positionSide, reduceOnly: byIntent[0]?.reduceOnly, status: byIntent[0]?.status });

  await client.cancelOrder(created.orderId);
  const after = await findOpenByIntent(created.intentId);
  createdOrderIds.delete(created.orderId);
  log('撤单后复查:', { remaining: after.length });

  return { assetUsed, orderId: created.orderId, intentId: created.intentId, side: created.side, positionSide: created.positionSide, status: created.status, cancelled: after.length === 0 };
}

// ── 写链：幂等（同一 intentId 重复提交不得产生重复订单）────────────────────

async function probeIdempotency() {
  const mark = await fetchBtcMark();
  const price = roundPrice(mark * 0.5);
  const intentId = ulid();
  const record = buildLimitRecord({ side: 'buy', positionSide: 'long', price, asset: BASE, intentId });

  const first = await client.createOrders([record]);
  if (first[0]?.orderId) createdOrderIds.add(first[0].orderId);
  log('第 1 次提交:', { orderId: first[0]?.orderId, intentId });

  let second = null;
  let secondErr = null;
  try {
    second = await client.createOrders([{ ...record }]);
    if (second[0]?.orderId) createdOrderIds.add(second[0].orderId);
    log('第 2 次提交（同 intentId）:', { orderId: second[0]?.orderId, intentId });
  } catch (err) {
    secondErr = err;
    log('第 2 次提交被拒（符合幂等预期）:', { message: err?.message, statusCode: err?.statusCode, code: err?.code });
  }

  const matched = await findOpenByIntent(intentId);
  const duplicate = matched.length > 1;
  log('幂等复查:', { matchedOrders: matched.length, duplicate });

  await cancelTracked();
  return {
    intentId,
    firstOrderId: first[0]?.orderId ?? null,
    secondOrderId: second?.[0]?.orderId ?? null,
    secondRejected: !!secondErr,
    matchedOrders: matched.length,
    duplicate,
  };
}

// ── 写链：持仓（判定 hedge/net）──────────────────────────────────────────
// 判定法：基线空仓 → 市价开多 2 份 → 市价开空 1 份（positionSide=short, reduceOnly=false）。
//   hedge → 持仓出现 long 2 + short 1（两腿独立）
//   net   → 持仓只剩 long 1（反向单直接净额对冲）
// 清理：只平当前净额（reduceOnly），不触碰任何非本探针产生的仓位。

function slimPos(p) { return { side: p.positionSide, qty: p.quantity, entry: p.entryPrice, upnl: p.unrealizedPnl }; }

async function probePosition() {
  const before = await client.getPositions({ base: BASE, status: 'open' });
  const beforeLong = before.filter((p) => p.positionSide === 'long').reduce((s, p) => s + Number(p.quantity), 0);
  const beforeShort = before.filter((p) => p.positionSide === 'short').reduce((s, p) => s + Number(p.quantity), 0);
  if (beforeLong || beforeShort) {
    log('基线存在 BTC 持仓，跳过持仓链（不触碰用户仓位）:', { long: beforeLong, short: beforeShort });
    return { skipped: true, baselineLong: beforeLong, baselineShort: beforeShort };
  }

  const qty = Number(QTY);
  const result = { baselineLong: 0, baselineShort: 0, steps: [], verdict: 'unknown' };

  // 1) 市价开多 2 份
  await client.createOrders([buildMarketRecord({ side: 'buy', positionSide: 'long', quantity: qty * 2, asset: BASE })]);
  await sleep(2500);
  const p1 = await client.getPositions({ base: BASE, status: 'open' });
  result.steps.push({ step: 'open_long_2x', positions: p1.map(slimPos) });

  // 2) 反向市价开空 1 份（positionSide=short，reduceOnly=false）
  let shortErr = null;
  try {
    await client.createOrders([buildMarketRecord({ side: 'sell', positionSide: 'short', quantity: qty, asset: BASE })]);
  } catch (err) {
    shortErr = { message: err?.message, statusCode: err?.statusCode, code: err?.code };
  }
  await sleep(2500);
  const p2 = await client.getPositions({ base: BASE, status: 'open' });
  result.steps.push({ step: 'open_short_1x', positions: p2.map(slimPos), error: shortErr });

  const long2 = p2.filter((p) => p.positionSide === 'long').reduce((s, p) => s + Number(p.quantity), 0);
  const short2 = p2.filter((p) => p.positionSide === 'short').reduce((s, p) => s + Number(p.quantity), 0);
  if (long2 > 0 && short2 > 0) result.verdict = 'hedge';
  else if (long2 > 0 && short2 === 0 && long2 < qty * 2) result.verdict = 'net';
  else if (long2 + short2 === 0) result.verdict = 'net';
  else result.verdict = 'unknown';

  // 侧证：最近成交记录里的 positionSide / positionSizeBefore
  const trades = await client.getTrades({ base: BASE, limit: 10 });
  result.recentTrades = trades.map((t) => ({
    side: t.side, positionSide: t.positionSide, type: t.type, qty: t.quantity,
    realizedPnl: t.realizedPnl, positionSizeBefore: t.positionSizeBefore, isLiquidation: t.isLiquidation,
  }));

  // 3) 清理：只平当前净额
  const after = await client.getPositions({ base: BASE, status: 'open' });
  for (const p of after) {
    const closeSide = p.positionSide === 'long' ? 'sell' : 'buy';
    try {
      await client.createOrders([buildMarketRecord({ side: closeSide, positionSide: p.positionSide, quantity: Number(p.quantity), asset: BASE, reduceOnly: true, closePosition: true })]);
      log(`清理平仓（${p.positionSide} ${p.quantity}）完成`);
    } catch (err) {
      log(`清理平仓（${p.positionSide}）失败:`, { message: err?.message, statusCode: err?.statusCode });
    }
  }
  await sleep(2500);
  const final = await client.getPositions({ base: BASE, status: 'open' });
  result.finalPositions = final.map(slimPos);
  if (final.length) console.error(`[警告] 仍有残留仓位: ${JSON.stringify(final.map(slimPos))}，请人工检查`);
  return result;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function maskProxy(url) {
  return String(url).replace(/\/\/([^:@/]+):[^@/]+@/, '//$1:***@');
}

/** 代理支持：Node fetch 默认不走系统代理，配置了 PR_PROXY/GLOBAL_PROXY 时手动挂 dispatcher。 */
async function applyProxy() {
  if (!cfg.proxy) return false;
  const dispatcher = await createDispatcher(cfg.proxy);
  if (!dispatcher) throw new Error(`代理无法初始化: ${maskProxy(cfg.proxy)}`);
  const { setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(dispatcher);
  log(`已启用代理 ${maskProxy(cfg.proxy)}`);
  return true;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

let client;

async function main() {
  if (!VALID.includes(cmd)) throw new Error(`未知命令 ${cmd}，允许值：${VALID.join('|')}`);
  if (!['discover', 'readonly'].includes(cmd) && !allowWrite) {
    throw new Error(`命令 ${cmd} 会向 Propr 发送写请求，必须显式加 --allow-write 才执行。`);
  }
  requireCreds(cmd !== 'discover');
  if (!cfg.allowedAccountIds.length) {
    log('提示: 未配置 PROPR_ALLOWED_ACCOUNT_IDS 白名单（建议在 .env 中加上当前账户）');
  }
  await applyProxy();

  client = new ProprClient({ apiKey: cfg.apiKey, baseUrl: cfg.apiUrl, timeout: cfg.timeoutMs });
  if (cmd === 'discover') {
    await probeDiscover();
    return;
  }
  await client.setup(cfg.accountId);
  log(`已绑定账户 ${maskAccountId(client.accountId)}，模式=${cfg.mode}，命令=${cmd}，写权限=${allowWrite ? '开启' : '关闭'}`);

  const report = {};
  if (cmd === 'readonly' || cmd === 'all') report.readonly = await probeReadonly();
  if (cmd === 'order' || cmd === 'all') report.order = await probeOrder();
  if (cmd === 'idempotency' || cmd === 'all') report.idempotency = await probeIdempotency();
  if (cmd === 'position' || cmd === 'all') report.position = await probePosition();

  log('── 探针汇总（脱敏）──');
  console.log(JSON.stringify(redactRecord(report), null, 2));
}

main()
  .catch((err) => {
    fail(err?.message || String(err));
    if (err instanceof ProprAPIError) console.error(redactRecord({ statusCode: err.statusCode, code: err.code }));
  })
  .finally(async () => {
    try { await cancelTracked(); } catch { /* 清理失败由人工复核 */ }
    if (openedLegs.length) console.error(`[警告] 仍有未平仓位: ${JSON.stringify(openedLegs)}，请人工检查`);
  });
