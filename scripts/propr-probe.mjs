#!/usr/bin/env node
// Propr Day-0/Review2 契约探针：只读链 + 可选写链（订单/幂等/持仓/权益刷新），用于冻结 API 契约。
//
// 用法：
//   node scripts/propr-probe.mjs                     # 只读链（默认，无任何写请求）
//   node scripts/propr-probe.mjs discover            # 仅列出账户（修正 PROPR_ACCOUNT_ID）
//   node scripts/propr-probe.mjs order --allow-write
//   node scripts/propr-probe.mjs idempotency --allow-write
//   node scripts/propr-probe.mjs position --allow-write
//   node scripts/propr-probe.mjs equity --allow-write
//   node scripts/propr-probe.mjs all --allow-write
//
// 安全护栏（Review2 复审强化）：
//  1) 写链必须显式 --allow-write；只读链绝不调用任何写接口；
//  2) 非 discover 命令严格绑定 PROPR_ACCOUNT_ID，绝不回退到 active[0]；
//  3) asset 口径 fallback 仅在明确 400 参数错误时发生；超时/网络/429/5xx 一律先按 intentId 对账，
//     对账不到则报未知订单态并停止创建，绝不换口径重复下单；
//  4) 持仓链 try/finally 清理：以真实 getPositions() 为准循环平至空仓，失败置非零退出码；
//  5) 全部输出经脱敏（accountId 仅前 4+后 4；密钥不入日志）。
//
// 代理：Node fetch 不自动读取系统代理；PR_PROXY/GLOBAL_PROXY 已配置时自动挂 undici dispatcher。
import { getConfig } from '../src/config.js';
import { createDispatcher } from '../src/proxy.js';
import { ProprClient, ProprAPIError } from '../src/exchange/propr/propr-sdk.js';
import { ProprStartupError, isIdempotencyConflict } from '../src/exchange/propr/errors.js';
import { redactRecord, maskAccountId } from '../src/redact.js';
import { ulid } from 'ulid';

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) || 'readonly';
const allowWrite = argv.includes('--allow-write');
const VALID = ['discover', 'readonly', 'order', 'idempotency', 'position', 'precision', 'equity', 'all'];
const WRITE_CMDS = ['order', 'idempotency', 'position', 'precision', 'equity', 'all'];
const ORDER_STATUSES = ['pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'expired'];

const cfg = getConfig().propr;
const BASE = cfg.base || 'BTC';
const QUOTE = 'USDC';
const QTY = String(process.env.PR_PROBE_QTY || '0.001');
const EQUITY_WAITS = (process.env.PR_PROBE_EQUITY_WAITS || '0,10,30,60')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);

const createdOrderIds = new Set();
let client = null;

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

/** 严格绑定配置账户：非 discover 命令绝不回退到 active[0]（Review2 P1）。 */
async function bindConfiguredAccount() {
  const active = await client.getChallengeAttempts({ status: 'active' });
  const attempt = active.find((a) => a.accountId === cfg.accountId);
  if (!attempt) {
    throw new ProprStartupError(
      `指定账户 ${maskAccountId(cfg.accountId)} 不在 active attempts 中（仅 discover 可列出全部账户）`,
    );
  }
  client.accountId = attempt.accountId;
  return attempt;
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

// 报价取整：BTC 价格小数位按 1 位保守处理（真实精度由精度专项探测回填契约文档）
function roundPrice(px) {
  return Number(Number(px).toFixed(1));
}

function buildLimitRecord({ side, positionSide, price, asset, intentId, reduceOnly = false, quantity = QTY }) {
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
    quantity: String(quantity),
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

/** 按 intentId 跨全部状态查订单（不能只查 open：可能处于 pending/partially_filled 或已终态）。 */
async function findOrdersByIntent(intentId) {
  const found = new Map();
  for (const status of ORDER_STATUSES) {
    try {
      const rows = await client.getOrders({ base: BASE, status, limit: 100 });
      for (const r of rows) if (r.intentId === intentId) found.set(r.orderId, r);
    } catch { /* 个别状态不支持时忽略 */ }
  }
  return [...found.values()];
}

/** 仅明确的 400 参数/校验错误才允许换 asset 口径重试（Review2 P0）。 */
function isValidationError(err) {
  return err?.statusCode === 400;
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

  out.challenges = (await client.getChallenges({ limit: 5 })).map((c) => redactRecord(c));

  const attempt = await bindConfiguredAccount();
  out.activeAttempts = (await client.getChallengeAttempts({ status: 'active' })).map((a) => redactRecord(a));
  out.challengeAttempt = redactRecord(await client.getChallengeAttempt(attempt.attemptId));

  // 权益字段在 challengeAttempt.account（不是顶层）；硬断言 balance 可用（Review2 修正）
  const account = out.challengeAttempt?.account || {};
  const equityKeys = ['balance', 'marginBalance', 'availableBalance', 'highWaterMark', 'totalUnrealizedPnl', 'maxWithdrawAmount'];
  out.equityFieldsPresent = equityKeys.filter((k) => Object.hasOwn(account, k));
  out.equity = {
    balance: account.balance, marginBalance: account.marginBalance,
    availableBalance: account.availableBalance, highWaterMark: account.highWaterMark,
    totalUnrealizedPnl: account.totalUnrealizedPnl, currency: account.currency, updatedAt: account.updatedAt,
  };
  if (!Number.isFinite(Number(account.balance))) {
    throw new ProprStartupError('Propr account.balance 不可用（权益字段缺失）');
  }

  out.marginConfig = redactRecord(await client.getMarginConfig(BASE));
  out.leverageLimits = await client.getLeverageLimits();
  out.maxLeverage = await client.maxLeverage(BASE);

  const positions = await client.getPositions({ base: BASE, status: 'open' });
  out.positions = positions.map((p) => redactRecord(p));
  out.positionSides = positions.map((p) => p.positionSide);

  out.openOrders = (await client.getOrders({ base: BASE, status: 'open', limit: 100 })).map((o) => redactRecord(o));
  out.trades = (await client.getTrades({ base: BASE, limit: 20 })).map((t) => redactRecord(t));

  log('── 只读链结果（脱敏）──');
  console.log(JSON.stringify(out, null, 2));
  log('关键待冻结项:', {
    positionSides: out.positionSides,
    maxLeverage: out.maxLeverage,
    equityFieldsPresent: out.equityFieldsPresent,
    equity: out.equity,
  });
  return out;
}

// ── 写链：订单（远市价限价单 → 校验 → 撤单，多重信号复核）────────────────────

async function probeOrder() {
  const mark = await fetchBtcMark();
  const buyPrice = roundPrice(mark * 0.5);
  const baseline = await client.getOrders({ base: BASE, status: 'open', limit: 100 });
  log('写链基线（仅观测，不触碰）:', { openOrders: baseline.length, mark });

  // asset 口径：仅在明确 400 参数错误时尝试下一种；其他错误先对账，绝不重复创建
  let attempt = null;
  for (const asset of [BASE, `${BASE}/${QUOTE}`]) {
    const intentId = ulid();
    try {
      const rows = await client.createOrders([buildLimitRecord({ side: 'buy', positionSide: 'long', price: buyPrice, asset, intentId })]);
      attempt = { asset, intentId, created: rows[0] ?? null };
      if (attempt.created?.orderId) createdOrderIds.add(attempt.created.orderId);
      log(`createOrders 成功（asset=${asset}）`, attempt.created);
      break;
    } catch (err) {
      log(`createOrders 失败（asset=${asset}）`, { message: err?.message, statusCode: err?.statusCode, code: err?.code });
      if (isValidationError(err)) continue; // 仅 400 参数错误允许换口径
      const existing = await findOrdersByIntent(intentId);
      if (existing.length) {
        attempt = { asset, intentId, created: existing[0], reconciled: true };
        createdOrderIds.add(existing[0].orderId);
        log('非 400 失败但按 intentId 对账到既有订单，停止继续创建', existing[0]);
        break;
      }
      throw new Error(`订单状态未知（intentId=${intentId} 未对账到订单），已停止创建，需人工核查`);
    }
  }
  if (!attempt) throw new Error('createOrders 全部 asset 口径均返回 400 参数错误');

  const byIntent = await findOrdersByIntent(attempt.intentId);
  log('按 intentId 跨状态回查:', {
    matched: byIntent.length,
    statuses: byIntent.map((o) => o.status),
    side: byIntent[0]?.side, positionSide: byIntent[0]?.positionSide, reduceOnly: byIntent[0]?.reduceOnly,
  });

  // 撤单并多重复核：cancel 响应 + 跨状态订单 + 成交数
  const cancelResp = await client.cancelOrder(attempt.created.orderId);
  await sleep(1500);
  const afterByIntent = await findOrdersByIntent(attempt.intentId);
  const orderAfter = (await client.getOrders({ orderId: attempt.created.orderId, limit: 5 }))[0] ?? null;
  const trades = await client.getTrades({ orderId: attempt.created.orderId, limit: 5 });
  createdOrderIds.delete(attempt.created.orderId);

  const stillLive = afterByIntent.some((o) => ['pending', 'open', 'partially_filled'].includes(o.status));
  const verified = !stillLive && (orderAfter?.status ?? cancelResp?.status ?? '') === 'cancelled';
  log('撤单复核（多重信号）:', {
    cancelStatus: cancelResp?.status ?? null,
    statusAfter: orderAfter?.status ?? null,
    liveMatches: afterByIntent.filter((o) => ['pending', 'open', 'partially_filled'].includes(o.status)).length,
    trades: trades.length,
    verified,
  });

  return {
    assetUsed: attempt.asset,
    orderId: attempt.created.orderId,
    intentId: attempt.intentId,
    side: attempt.created.side,
    positionSide: attempt.created.positionSide,
    statusAfter: orderAfter?.status ?? null,
    cancelVerified: verified,
  };
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
    log('第 2 次提交被拒（符合幂等预期）:', {
      message: err?.message, statusCode: err?.statusCode, code: err?.code,
      classified: isIdempotencyConflict(err) ? 'idempotency_conflict' : 'other',
    });
  }

  await sleep(1500);
  const matched = await findOrdersByIntent(intentId);
  const live = matched.filter((o) => ['pending', 'open', 'partially_filled'].includes(o.status));
  const duplicate = live.length > 1;
  log('幂等复查（跨状态）:', { matchedOrders: matched.length, liveOrders: live.length, statuses: matched.map((o) => o.status), duplicate });

  await cancelTracked();
  return {
    intentId,
    firstOrderId: first[0]?.orderId ?? null,
    secondOrderId: second?.[0]?.orderId ?? null,
    secondRejected: !!secondErr,
    matchedOrders: matched.length,
    liveOrders: live.length,
    duplicate,
  };
}

// ── 写链：持仓（判定 hedge/net；try/finally 保证清仓）──────────────────────

function slimPos(p) { return { side: p.positionSide, qty: p.quantity, entry: p.entryPrice, upnl: p.unrealizedPnl }; }

/** 以真实持仓为准循环平仓至空（最多 4 轮）；失败置非零退出码并高优先级告警。 */
async function closeProbePositionUntilFlat(maxAttempts = 4) {
  for (let i = 1; i <= maxAttempts; i++) {
    const positions = await client.getPositions({ base: BASE, status: 'open' });
    if (!positions.length) return true;
    for (const p of positions) {
      const closeSide = p.positionSide === 'long' ? 'sell' : 'buy';
      try {
        await client.createOrders([buildMarketRecord({ side: closeSide, positionSide: p.positionSide, quantity: Number(p.quantity), asset: BASE, reduceOnly: true, closePosition: true })]);
        log(`清理平仓（第 ${i} 轮，${p.positionSide} ${p.quantity}）已提交`);
      } catch (err) {
        log(`清理平仓（第 ${i} 轮，${p.positionSide}）失败:`, { message: err?.message, statusCode: err?.statusCode });
      }
    }
    await sleep(2500);
  }
  const left = await client.getPositions({ base: BASE, status: 'open' });
  if (left.length) {
    console.error(`[P0 告警] 探针遗留仓位未清理，请人工处理: ${JSON.stringify(left.map(slimPos))}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

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
  let started = false;

  try {
    started = true;
    // 1) 市价开多 2 份
    await client.createOrders([buildMarketRecord({ side: 'buy', positionSide: 'long', quantity: qty * 2, asset: BASE })]);
    await sleep(2500);
    result.steps.push({ step: 'open_long_2x', positions: (await client.getPositions({ base: BASE, status: 'open' })).map(slimPos) });

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
    else if (long2 + short2 === 0) result.verdict = 'net';
    else if (long2 > 0 && short2 === 0 && long2 < qty * 2) result.verdict = 'net';
    else result.verdict = 'unknown';

    result.recentTrades = (await client.getTrades({ base: BASE, limit: 10 })).map((t) => ({
      side: t.side, positionSide: t.positionSide, type: t.type, qty: t.quantity,
      realizedPnl: t.realizedPnl, positionSizeBefore: t.positionSizeBefore, isLiquidation: t.isLiquidation,
    }));
  } finally {
    if (started) {
      result.cleanupOk = await closeProbePositionUntilFlat();
      result.finalPositions = (await client.getPositions({ base: BASE, status: 'open' })).map(slimPos);
    }
  }
  return result;
}

// ── 写链：精度边界（quantity/price/minNotional，用拒单试探）──────────────────

async function tryLimit({ quantity, price, label, settleMs = 4000 }) {
  const intentId = ulid();
  try {
    const rows = await client.createOrders([buildLimitRecord({ side: 'buy', positionSide: 'long', price, asset: BASE, intentId, quantity })]);
    const o = rows[0] ?? null;
    const out = { label, quantity: String(quantity), price: String(price), ok: true, orderId: o?.orderId ?? null, statusAfterSettle: null, exchangeOrderId: null };
    if (o?.orderId) {
      createdOrderIds.add(o.orderId);
      if (settleMs > 0) {
        await sleep(settleMs);
        const after = (await client.getOrders({ orderId: o.orderId, limit: 5 }))[0] ?? null;
        out.statusAfterSettle = after?.status ?? null;
        out.exchangeOrderId = after?.exchangeOrderId ?? null;
      }
      await client.cancelOrder(o.orderId);
      createdOrderIds.delete(o.orderId);
    }
    return out;
  } catch (err) {
    return { label, quantity: String(quantity), price: String(price), ok: false, statusCode: err?.statusCode, code: err?.code, message: String(err?.message || '').slice(0, 120) };
  }
}

async function probePrecision() {
  const mark = await fetchBtcMark();
  const far = mark * 0.5;
  const result = { mark, quantity: [], price: [], notional: [] };

  // 数量精度：逐步缩小
  for (const q of ['0.001', '0.0001', '0.00001', '0.000001', '0.0000001']) {
    result.quantity.push(await tryLimit({ quantity: q, price: roundPrice(far), label: `qty=${q}` }));
  }

  // 价格小数位：0~5 位（HL 规则：≤5 位有效数字且小数位 ≤ 6-szDecimals）
  for (const d of [0, 1, 2, 3, 4, 5]) {
    result.price.push(await tryLimit({ quantity: '0.001', price: far.toFixed(d), label: `priceDecimals=${d}` }));
  }

  // 最小名义：数量小到名义价值 < $10（观察是否被拒）
  for (const q of ['0.0001', '0.00005', '0.00001']) {
    result.notional.push(await tryLimit({ quantity: q, price: roundPrice(mark), label: `notional≈$${(Number(q) * mark).toFixed(2)}` }));
  }

  log('精度探测汇总:', {
    quantity: result.quantity.map((r) => ({ label: r.label, ok: r.ok, code: r.code, settled: r.statusAfterSettle, exOrder: r.exchangeOrderId ? 'yes' : 'null' })),
    price: result.price.map((r) => ({ label: r.label, ok: r.ok, code: r.code, settled: r.statusAfterSettle, exOrder: r.exchangeOrderId ? 'yes' : 'null' })),
    notional: result.notional.map((r) => ({ label: r.label, ok: r.ok, code: r.code, settled: r.statusAfterSettle, exOrder: r.exchangeOrderId ? 'yes' : 'null' })),
  });
  return result;
}

// ── 写链：权益刷新延迟（Review2 新增：开/持仓/平后 account 字段更新时效）────

async function readAccountEquity(attemptId) {
  const a = (await client.getChallengeAttempt(attemptId)).account || {};
  return {
    balance: a.balance, marginBalance: a.marginBalance, availableBalance: a.availableBalance,
    highWaterMark: a.highWaterMark, totalUnrealizedPnl: a.totalUnrealizedPnl,
    crossUnrealizedPnl: a.crossUnrealizedPnl, updatedAt: a.updatedAt,
  };
}

async function probeEquity() {
  const attempt = await bindConfiguredAccount();
  const qty = Number(QTY);
  const result = { waits: EQUITY_WAITS, samples: [], cleanupOk: null };
  const snap = async (label) => {
    const eq = await readAccountEquity(attempt.attemptId);
    const positions = await client.getPositions({ base: BASE, status: 'open' });
    result.samples.push({ label, at: new Date().toISOString(), equity: eq, positions: positions.map(slimPos) });
    log(`权益采样[${label}]`, eq);
  };

  let started = false;
  try {
    started = true;
    await snap('baseline');
    await client.createOrders([buildMarketRecord({ side: 'buy', positionSide: 'long', quantity: qty, asset: BASE })]);
    for (const w of EQUITY_WAITS) {
      if (w > 0) await sleep(w * 1000);
      await snap(`after_open_+${w}s`);
    }
  } finally {
    if (started) {
      result.cleanupOk = await closeProbePositionUntilFlat();
      for (const w of EQUITY_WAITS.filter((x) => x > 0).slice(0, 2)) {
        await sleep(w * 1000);
        await snap(`after_close_+${w}s`);
      }
    }
  }
  return result;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  if (!VALID.includes(cmd)) throw new Error(`未知命令 ${cmd}，允许值：${VALID.join('|')}`);
  if (WRITE_CMDS.includes(cmd) && !allowWrite) {
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
  await bindConfiguredAccount();
  log(`已绑定账户 ${maskAccountId(client.accountId)}，模式=${cfg.mode}，命令=${cmd}，写权限=${allowWrite ? '开启' : '关闭'}`);

  const report = {};
  if (cmd === 'readonly' || cmd === 'all') report.readonly = await probeReadonly();
  if (cmd === 'order' || cmd === 'all') report.order = await probeOrder();
  if (cmd === 'idempotency' || cmd === 'all') report.idempotency = await probeIdempotency();
  if (cmd === 'position' || cmd === 'all') report.position = await probePosition();
  if (cmd === 'precision' || cmd === 'all') report.precision = await probePrecision();
  if (cmd === 'equity' || cmd === 'all') report.equity = await probeEquity();

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
  });
