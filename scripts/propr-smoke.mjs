#!/usr/bin/env node
// Propr sim-write 分步冒烟（任务 9.2）：按「只读 → 远价单 → 单笔成交 → 断线恢复 →（可选）小网格」
// 逐级验证真实写路径。每步带断言，任一步失败即中止并清理。
//
// 用法：
//   node scripts/propr-smoke.mjs readonly                 # 只读连接校验（无写请求）
//   node scripts/propr-smoke.mjs all --allow-write        # readonly + far-order + fill + reconnect
//   node scripts/propr-smoke.mjs far-order --allow-write
//   node scripts/propr-smoke.mjs fill --allow-write
//   node scripts/propr-smoke.mjs reconnect --allow-write
//   node scripts/propr-smoke.mjs grid --allow-write       # 4 格小网格完整周期（会真实下单/平仓）
//   可选：--qty=0.001
//
// 安全护栏：
//  1) 除 readonly 外必须显式 --allow-write；
//  2) 账户已有 BTC 持仓/挂单时，写步骤直接拒绝（绝不触碰你的仓位）；
//  3) 只操作本脚本创建的订单/仓位，finally 清理并复核；
//  4) 全流程输出经脱敏（accountId 仅前 4+后 4）。
import { getConfig } from '../src/config.js';
import { createExchange } from '../src/exchange/propr/index.js';
import { GridBot } from '../src/bot.js';
import { maskAccountId } from '../src/redact.js';

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) || 'readonly';
const allowWrite = argv.includes('--allow-write');
const QTY = String(argv.find((a) => a.startsWith('--qty='))?.slice('--qty='.length) || '0.001');
const VALID = ['readonly', 'far-order', 'fill', 'reconnect', 'grid', 'all'];
const WRITE_STEPS = ['far-order', 'fill', 'reconnect', 'grid'];

const cfg = { ...getConfig().propr, mode: 'sim-write', orderPollMs: 2000 };
const created = { orderIds: new Set(), openedPosition: false };
let ex = null;

const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`);
  log(`   ✓ ${msg}`);
}

function stepTitle(n, name) { log(`\n── [${n}] ${name} ──`); }

async function waitFor(fn, { timeoutMs = 25000, intervalMs = 1000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}

/** 账户基线快照：写步骤前必须为空（避免触碰既有仓位/挂单）。 */
async function snapshotAccount() {
  const orders = await ex.getAllOrders({ base: ex.base, status: 'open' });
  const positions = (await ex.getAllPositions({ base: ex.base, status: 'open' })).filter((p) => Number(p.quantity) > 0);
  return { orders, positions };
}

async function assertCleanAccount() {
  const { orders, positions } = await snapshotAccount();
  if (orders.length || positions.length) {
    throw new Error(`账户已有 ${orders.length} 个挂单 / ${positions.length} 个持仓，写步骤拒绝执行（请先人工清理，避免误动你的仓位）`);
  }
  log('   ✓ 账户基线干净（无挂单/无持仓）');
}

async function cleanup() {
  if (!ex) return;
  for (const id of created.orderIds) {
    try { await ex.cancelOrder(ex.base, id); } catch { /* 已成交/已撤 */ }
  }
  created.orderIds.clear();
  if (created.openedPosition) {
    try { await ex.closePosition(); } catch { /* 下面复核 */ }
  }
  const { orders, positions } = await snapshotAccount().catch(() => ({ orders: [], positions: [] }));
  if (orders.length || positions.length) {
    console.error(`\n[警告] 仍有残留：挂单 ${orders.length} 个 / 持仓 ${positions.length} 个，请人工复核。`);
    process.exitCode = 1;
  }
}

// ── 步骤 ────────────────────────────────────────────────────────────────────

async function stepReadonly() {
  stepTitle(1, 'readonly：只读连接与账户契约');
  ok(ex.dataSource === 'real', 'dataSource=real（真实 API 连接）');
  ok(ex.accountId === cfg.accountId, `账户绑定正确（${maskAccountId(ex.accountId)}）`);
  ok(ex.attemptStatus === 'active', `挑战状态 active（实际 ${ex.attemptStatus}）`);
  ok(ex.equitySource === 'propr_account', '权益来源 = propr_account（权威字段）');
  ok(Number.isFinite(ex.equity) && ex.equity > 0, `权益可用 ${ex.equity}`);
  ok(!ex.isEquityStale(), '权益新鲜（未过期）');
  ok(ex.positionMode === 'net', '持仓模式 net');

  const markets = await ex.getMarkets();
  const m = markets[0];
  ok(m && m.marketId === ex.base, `市场 ${ex.base} 可读`);
  ok(m.stepSize > 0 && m.stepPrice > 0, `精度 stepSize=${m.stepSize} / stepPrice=${m.stepPrice}`);
  ok(m.minOrderNotional > 0, `最小名义 $${m.minOrderNotional}`);
  ok(Number(m.maxLeverage) >= 1, `最大杠杆 ${m.maxLeverage}x`);

  const price = await ex.getPrice();
  ok(Number.isFinite(price) && price > 0, `行情可用（${price}）`);
  ok(ex.lastApiOkAt > 0, 'lastApiOkAt 已置位（API 健康）');

  const { orders, positions } = await snapshotAccount();
  log(`   基线：挂单 ${orders.length} / 持仓 ${positions.length} · 余额 ${ex.balance} · 高水位 ${ex.highWaterMark} · 可用 ${ex.availableBalance}`);
}

async function stepFarOrder() {
  stepTitle(2, 'far-order：远价限价单 → 查询 → 撤单复核');
  await assertCleanAccount();
  const price = await ex.getPrice();
  // 价格带：Propr 会拒「离市价过远」的限价单（实测 code 13107；0.5× 可接受、2× 被拒）。
  // 冒烟用 ±10%（足够远不会成交，又在价格带内）。
  const buyPrice = Number((price * 0.9).toFixed(1));
  const sellPrice = Number((price * 1.1).toFixed(1));

  const placed = await ex.placeLimitOrder({ marketId: ex.base, side: 'buy', positionSide: 'long', price: buyPrice, sizeBase: Number(QTY), reduceOnly: false, levelIndex: 1 });
  created.orderIds.add(placed.orderId);
  ok(/^urn:prp-order:/.test(placed.orderId), `下单成功 ${placed.orderId}`);
  ok(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(placed.clientOrderId), `自有 intentId 已保留（${placed.clientOrderId}）`);

  const rec = await ex.reconcileOrders();
  ok(rec.open.some((o) => o.orderId === placed.orderId), 'reconcile 能对账到该挂单');
  ok(rec.unmatched.length === 0, `无未匹配订单（实际 ${rec.unmatched.length}）`);
  ok(ex.getIntents().some((i) => i.orderId === placed.orderId && i.state === 'open'), 'intent 日志已回填为 open');

  const dup = (await ex.getAllOrders({ base: ex.base, status: 'open' })).filter((o) => o.intentId === placed.clientOrderId);
  ok(dup.length === 1, `同 intentId 仅 1 单（实际 ${dup.length}）`);

  const cancelled = await ex.cancelOrder(ex.base, placed.orderId);
  ok(cancelled === true, '撤单权威复核通过');
  created.orderIds.delete(placed.orderId);
  const after = (await ex.getAllOrders({ base: ex.base, status: 'open' })).filter((o) => o.intentId === placed.clientOrderId);
  ok(after.length === 0, '撤单后无残留（终态确认）');

  // 顺带验证远价卖单可撤（双向路径）
  const placedSell = await ex.placeLimitOrder({ marketId: ex.base, side: 'sell', positionSide: 'short', price: sellPrice, sizeBase: Number(QTY), reduceOnly: false, levelIndex: 2 });
  created.orderIds.add(placedSell.orderId);
  ok(await ex.cancelOrder(ex.base, placedSell.orderId) === true, '卖方向远价单同样可下可撤');
  created.orderIds.delete(placedSell.orderId);
}

async function stepFill() {
  stepTitle(3, 'fill：最小可成交单 → 成交确认 → reduce-only 平仓');
  await assertCleanAccount();
  const price = await ex.getPrice();
  const marketablePrice = Number((price * 1.002).toFixed(1)); // 高于现价的限价买单 → 立即成交（taker）

  const fills = [];
  const onFill = (f) => fills.push(f);
  ex.on('fill', onFill);
  const placed = await ex.placeLimitOrder({ marketId: ex.base, side: 'buy', positionSide: 'long', price: marketablePrice, sizeBase: Number(QTY), reduceOnly: false, levelIndex: 3 });
  created.orderIds.add(placed.orderId);
  created.openedPosition = true;
  log(`   已下可成交买单 ${QTY} @ ${marketablePrice}（intentId ${placed.clientOrderId}）`);

  const fill = await waitFor(() => fills.find((f) => String(f.orderId) === String(placed.orderId)), { label: '订单成交', timeoutMs: 30000 });
  ok(Number(fill.sizeBase) > 0, `收到成交事件：${fill.side} ${fill.sizeBase} @ ${fill.price}`);
  ok(Number(fill.sizeBase) <= Number(QTY) + 1e-12, `成交数量不超过下单量（实际 ${fill.sizeBase} ≤ ${QTY}）`);

  const pos = await waitFor(() => ex.getPosition(), { label: '持仓出现', timeoutMs: 20000 });
  ok(Number(pos.sizeBase) > 0, `净仓方向正确（多 ${pos.sizeBase}）`);

  const trades = await ex.getTrades({ limit: 20 });
  const mine = trades.filter((t) => String(t.orderId) === String(placed.orderId));
  ok(mine.length >= 1, `成交记录可查（${mine.length} 笔）`);
  const tradedQty = mine.reduce((s, t) => s + Number(t.sizeBase), 0);
  ok(Math.abs(tradedQty - Number(fill.sizeBase)) < 1e-9, `fill 数量 = 实际成交量（${tradedQty}）`);

  const closed = await ex.closePosition();
  ok(closed === true, 'reduce-only 全平返回成功');
  created.openedPosition = false;
  await waitFor(() => !ex.getPosition(), { label: '持仓归零', timeoutMs: 25000 });
  ok(!ex.getPosition(), '平仓后净仓为 0');
  ex.off('fill', onFill);
}

async function stepReconnect() {
  stepTitle(4, 'reconnect：断线重连与成交补偿（不重复）');
  await assertCleanAccount();
  const seenBefore = (await ex.getTrades({ limit: 50 })).map((t) => t.tradeId).sort();
  const fills = [];
  const onFill = (f) => fills.push(f);
  ex.on('fill', onFill);

  await ex.reconnect();
  ok(ex.dataSource === 'real', '重连后 dataSource=real');
  ok(ex.lastApiOkAt > 0, '重连后 lastApiOkAt 已置位');
  ok(!ex.isTradingLocked(), '重连未导致交易锁定');

  await sleep(3000);
  const seenAfter = (await ex.getTrades({ limit: 50 })).map((t) => t.tradeId).sort();
  const newTrades = seenAfter.filter((id) => !seenBefore.includes(id));
  ok(fills.length === newTrades.length, `断线期间成交补偿次数 = 新成交数（补偿 ${fills.length} / 新成交 ${newTrades.length}）`);
  ok(new Set(fills.map((f) => f.orderId)).size === fills.length, '补偿无重复订单');
  ex.off('fill', onFill);

  const { orders, positions } = await snapshotAccount();
  ok(orders.length === 0 && positions.length === 0, '重连后账户仍干净（无残留挂单/持仓）');
}

async function stepGrid() {
  stepTitle(5, 'grid：4 格小网格完整周期（真实下单/平仓）');
  await assertCleanAccount();
  const price = await ex.getPrice();
  const lower = Number((price * 0.99).toFixed(1));
  const upper = Number((price * 1.01).toFixed(1));
  const bot = new GridBot(ex, { onAlert: (a) => log(`   [bot] ${a.message}`) });
  const gridCfg = {
    marketId: ex.base, mode: 'neutral', lower, upper, gridCount: 4, sizeBase: Number(QTY),
    leverage: 1, outOfRangeAction: 'close', dynamic: { enabled: false },
  };
  log(`   启动：${lower} ~ ${upper}，4 格，每格 ${QTY} BTC，1x，越界 close`);
  await bot.start(gridCfg);
  await sleep(8000);
  const st = bot.getState();
  ok(st.running, '网格运行中');
  ok(st.openOrders >= 1 && st.openOrders <= 4, `已铺挂单 ${st.openOrders}（≤4 格）`);
  log(`   运行状态：挂单 ${st.openOrders} · 交易所确认 ${st.exchangeOpenOrders} · 最新价 ${st.lastPrice}`);

  await bot.stop({ closePosition: true });
  await sleep(5000);
  const st2 = bot.getState();
  ok(!st2.running, '停止完成');
  ok(st2.openOrders === 0, '停止后本地挂单清空');
  const { orders, positions } = await snapshotAccount();
  ok(orders.length === 0, `交易所无残留挂单（实际 ${orders.length}）`);
  ok(positions.length === 0, `无残留持仓（实际 ${positions.length}）`);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const STEPS = {
  readonly: stepReadonly,
  'far-order': stepFarOrder,
  fill: stepFill,
  reconnect: stepReconnect,
  grid: stepGrid,
};

async function main() {
  if (!VALID.includes(cmd)) throw new Error(`未知步骤 ${cmd}，允许值：${VALID.join('|')}`);
  if (cmd !== 'readonly' && !allowWrite) {
    throw new Error(`步骤 ${cmd} 会向 Propr 发送写请求，必须显式加 --allow-write`);
  }
  if (cmd !== 'readonly' && cfg.mode !== 'sim-write') {
    throw new Error(`冒烟脚本固定以 sim-write 运行，当前配置 mode=${cfg.mode}`);
  }
  log(`Propr sim-write 冒烟 · 步骤=${cmd} · 数量=${QTY} · 写权限=${allowWrite ? '开启' : '关闭'} · 账户=${maskAccountId(cfg.accountId)}`);

  ex = createExchange(cfg);
  await ex.init(); // 所有步骤都先建立连接（单步运行也成立）
  // `all` 不含 grid（grid 会真实下单并可能成交，需显式指定）
  const plan = cmd === 'all' ? ['readonly', 'far-order', 'fill', 'reconnect'] : [cmd];
  for (const name of plan) {
    await STEPS[name]();
  }
  log('\n✅ 全部步骤通过');
}

main()
  .catch((err) => {
    console.error(`\n❌ 冒烟失败：${err?.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    try { ex?.stop(); } catch { /* ignore */ }
  });
