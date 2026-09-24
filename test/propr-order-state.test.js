// Propr 写路径状态机测试：超时/网络/13084 一律先按 intentId 对账，绝不重复创建；
// 明确 400 视为未创建；对账不到即锁定交易；批量必须与输入等长。
import { strict as assert } from 'node:assert';
import { ProprExchange } from '../src/exchange/propr/propr.js';
import { UnknownOrderStateError } from '../src/exchange/propr/errors.js';
import { ProprAPIError } from '../src/exchange/propr/propr-sdk.js';

const ACCOUNT = 'acc-1234567890';
const state = {
  orders: [], positions: [],
  createBehavior: 'ok', createCalls: 0, seq: 0, lastRecords: [],
};
const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeOrder(record) {
  state.seq += 1;
  return {
    ...record, orderId: `urn:prp-order:${state.seq}`, status: 'open',
    cumulativeQuantity: '0', exchangeOrderId: null,
    createdAt: '2026-09-23T02:00:00.000Z', updatedAt: '2026-09-23T02:00:00.000Z',
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  const q = new URL(u).searchParams;
  const body = opts.body ? JSON.parse(opts.body) : null;

  if (u.startsWith('https://api.hyperliquid.xyz/info')) {
    if (body?.type === 'allMids') return jsonResponse({ BTC: '90000' });
    if (body?.type === 'candleSnapshot') return jsonResponse([]);
  }
  if (u.includes('/health/services')) return jsonResponse({ core: 'OK' });
  if (u.includes('/health')) return jsonResponse({ status: 'OK' });
  if (u.includes('/users/me')) return jsonResponse({ userId: 'urn:prp-user:u1' });
  if (u.includes('/challenge-attempts/a1')) return jsonResponse({
    attemptId: 'a1', accountId: ACCOUNT, status: 'active', phases: [],
    account: { balance: '5000', marginBalance: '5000', availableBalance: '5000', highWaterMark: '5000', totalUnrealizedPnl: '0', currency: 'USDC' },
  });
  if (u.includes('/challenge-attempts')) return jsonResponse({ data: [{ attemptId: 'a1', accountId: ACCOUNT, status: 'active' }] });
  if (u.includes('/margin-config/')) return jsonResponse({ configId: 'c1', asset: 'BTC', leverage: method === 'PUT' ? String(body.leverage) : '1', marginMode: 'cross' });
  if (u.includes('/leverage-limits/effective')) return jsonResponse({ defaults: { crypto: 2 }, overrides: { BTC: 10 } });

  if (method === 'POST' && /\/orders\/[^/]+\/cancel$/.test(u)) {
    return jsonResponse({ message: 'already done' }, 400); // 官方语义：400=已成交/已撤
  }
  if (method === 'POST' && u.includes('/orders')) {
    state.createCalls += 1;
    state.lastRecords = body.orders;
    const behavior = state.createBehavior;
    if (behavior === 'timeout') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    if (behavior === 'badrequest') throw new ProprAPIError(400, 13001, 'invalid quantity');
    if (behavior === 'idem') throw new ProprAPIError(500, 13084, 'order_saga_idempotency_check_failed');
    const rows = body.orders.map(makeOrder);
    if (behavior === 'timeout_created') { state.orders.push(...rows); throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }
    if (behavior === 'idem_created') { state.orders.push(...rows); throw new ProprAPIError(500, 13084, 'order_saga_idempotency_check_failed'); }
    state.orders.push(...rows);
    return jsonResponse({ data: rows });
  }
  if (u.includes('/positions')) return jsonResponse({ data: state.positions });
  if (u.includes('/orders')) {
    let rows = state.orders;
    if (q.get('orderId')) rows = rows.filter((o) => o.orderId === q.get('orderId'));
    if (q.get('status')) rows = rows.filter((o) => o.status === q.get('status'));
    const limit = Number(q.get('limit') ?? 20);
    const offset = Number(q.get('offset') ?? 0);
    return jsonResponse({ data: rows.slice(offset, offset + limit) });
  }
  if (u.includes('/trades')) return jsonResponse({ data: [] });
  throw new Error(`unexpected fetch: ${u}`);
};

const cfg = { mode: 'sim-write', apiKey: 'pk_live_test', accountId: ACCOUNT, base: 'BTC', apiUrl: 'https://api.propr.xyz/v1', timeoutMs: 5000, orderPollMs: 60000 };
const ORDER = { marketId: 'BTC', side: 'buy', price: 90000, sizeBase: 0.001, reduceOnly: false, levelIndex: 3 };

async function freshExchange() {
  state.orders = []; state.positions = []; state.createBehavior = 'ok'; state.createCalls = 0; state.seq = 0;
  const ex = new ProprExchange(cfg);
  await ex.init();
  return ex;
}

async function main() {
  {
    // 正常下单：返回 orderId，clientOrderId 为自有 ULID，进入本地挂单表
    const ex = await freshExchange();
    const res = await ex.placeLimitOrder(ORDER);
    assert.ok(res.orderId.startsWith('urn:prp-order:'));
    assert.match(res.clientOrderId, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'clientOrderId 必须是 ULID');
    assert.equal(ex.getOpenOrders().length, 1);
    assert.equal(ex.getOpenOrders()[0].levelIndex, 3);
    assert.equal(state.createCalls, 1);
    ex.stop();
  }

  {
    // 超时但订单已创建：必须按 intentId 对账返回既有订单，且不重复创建
    const ex = await freshExchange();
    state.createBehavior = 'timeout_created';
    const res = await ex.placeLimitOrder(ORDER);
    assert.equal(res.reconciled, true);
    assert.equal(state.createCalls, 1, '超时后绝不能再次创建');
    assert.equal(ex.isTradingLocked(), false, '对账成功不应锁定');
    ex.stop();
  }

  {
    // 超时且对账不到：锁定 + UnknownOrderStateError，后续开仓被拒
    const ex = await freshExchange();
    state.createBehavior = 'timeout';
    await assert.rejects(() => ex.placeLimitOrder(ORDER), UnknownOrderStateError);
    assert.equal(ex.isTradingLocked(), true);
    await assert.rejects(() => ex.placeLimitOrder(ORDER), /已锁定/);
    assert.equal(state.createCalls, 1, '锁定时不得再发创建请求');
    // 锁定期间降风险操作仍允许（撤单/平仓不被 _assertCanOpen 拦截）
    await ex.cancelAll();
    ex.stop();
  }

  {
    // 13084 幂等冲突 + 订单已存在：对账返回既有订单，不锁定
    const ex = await freshExchange();
    state.createBehavior = 'idem_created';
    const res = await ex.placeLimitOrder(ORDER);
    assert.equal(res.reconciled, true);
    assert.equal(ex.isTradingLocked(), false);
    ex.stop();
  }

  {
    // 13084 且对账不到：未知态锁定
    const ex = await freshExchange();
    state.createBehavior = 'idem';
    await assert.rejects(() => ex.placeLimitOrder(ORDER), UnknownOrderStateError);
    assert.equal(ex.isTradingLocked(), true);
    ex.stop();
  }

  {
    // 明确 400 参数错误：视为未创建，抛原错且不锁定、不留 intent
    const ex = await freshExchange();
    state.createBehavior = 'badrequest';
    await assert.rejects(() => ex.placeLimitOrder(ORDER), /invalid quantity/);
    assert.equal(ex.isTradingLocked(), false, '明确参数错误不应锁定');
    assert.equal(ex.getIntents().length, 0, '参数错误应清除 intent');
    ex.stop();
  }

  {
    // 批量铺单：Propr 限制「一次请求只允许 1 笔开仓单」（13066）→ 适配器必须串行逐笔发请求
    const ex = await freshExchange();
    const batch = [ORDER, { ...ORDER, side: 'sell', price: 100000, levelIndex: 4 }, { ...ORDER, price: 80000, levelIndex: 5 }];
    const results = await ex.placeLimitOrders(batch);
    assert.equal(results.length, batch.length, '结果必须与输入等长');
    assert.equal(new Set(results.map((r) => r.clientOrderId)).size, 3, '每笔 intentId 独立');
    assert.equal(state.createCalls, 3, '必须逐笔一次请求（不得使用批量接口）');
    ex.stop();
  }

  {
    // 批量中的单笔超时但实际已创建 → 该笔按 intentId 对账补齐，整体仍等长返回且不锁定
    const ex = await freshExchange();
    state.createBehavior = 'ok';
    const origFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if ((opts.method || 'GET') === 'POST' && u.includes('/orders') && !u.includes('/cancel')) {
        n += 1;
        const body = JSON.parse(opts.body);
        const rows = body.orders.map(makeOrder);
        state.orders.push(...rows);
        if (n === 2) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); // 第 2 笔响应丢失
        return jsonResponse({ data: rows });
      }
      return origFetch(url, opts);
    };
    const results = await ex.placeLimitOrders([ORDER, { ...ORDER, levelIndex: 4 }]);
    globalThis.fetch = origFetch;
    assert.equal(results.length, 2);
    assert.ok(results[0].orderId && results[1].orderId, '响应丢失的那笔须按 intentId 对账补齐');
    assert.equal(ex.isTradingLocked(), false, '对账成功不应锁定');
    ex.stop();
  }

  {
    // 部分成交：fetchOpenOrders 必须保留 partially_filled 与已成交量
    const ex = await freshExchange();
    const res = await ex.placeLimitOrder(ORDER);
    const row = state.orders.find((o) => o.orderId === res.orderId);
    row.status = 'partially_filled';
    row.cumulativeQuantity = '0.0004';
    const open = await ex.fetchOpenOrders();
    const view = open.find((o) => o.orderId === res.orderId);
    assert.equal(view.status, 'partially_filled');
    assert.equal(view.filledBase, 0.0004);
    ex.stop();
  }

  {
    // setLeverage：正常设置；超过市场上限必须拒绝
    const ex = await freshExchange();
    assert.equal(await ex.setLeverage('BTC', 2), true);
    assert.equal(ex.market.leverage, 2);
    await assert.rejects(() => ex.setLeverage('BTC', 99), /超过/);
    ex.stop();
  }

  {
    // Review6 P0：风控状态必须形成下单硬拦截（bot 未运行/手动 /start 也无法绕过）
    const ex = await freshExchange();
    ex.riskGateEnabled = true; // 模拟风控层已接管（sim-write/challenge）
    const opening = { marketId: 'BTC', side: 'buy', price: 80000, sizeBase: 0.001, reduceOnly: false };
    const closing = { marketId: 'BTC', side: 'sell', price: 100000, sizeBase: 0.001, reduceOnly: true };

    for (const status of ['REDUCE_ONLY', 'HALT', 'LOCKED', 'BREACHED']) {
      ex.riskState = { status };
      await assert.rejects(() => ex.placeLimitOrder(opening), /风控状态/, `${status} 必须拒绝开仓`);
      await assert.rejects(() => ex.placeLimitOrders([opening]), /风控状态/, `${status} 必须拒绝批量开仓`);
      const res = await ex.placeLimitOrder(closing);
      assert.ok(res.orderId, `${status} 下 reduce-only 降风险操作必须放行`);
    }

    // setLeverage 受风控状态限制（仅 OK/WARNING 允许）
    ex.riskState = { status: 'REDUCE_ONLY' };
    await assert.rejects(() => ex.setLeverage('BTC', 1), /风控状态/);

    // WARNING 允许开仓；风控未启用（riskGateEnabled=false，如 paper/shadow）也允许
    ex.riskState = { status: 'WARNING' };
    assert.ok((await ex.placeLimitOrder(opening)).orderId);
    ex.riskGateEnabled = false;
    ex.riskState = null;
    assert.ok((await ex.placeLimitOrder(opening)).orderId);
    ex.stop();
  }

  {
    // Review6-1 P0：风控门 fail closed —— 已启用但状态未评估（null）必须拒绝开仓，绝不因"还没评估"放行
    const ex = await freshExchange();
    const opening = { marketId: 'BTC', side: 'buy', price: 80000, sizeBase: 0.001, reduceOnly: false };
    ex.riskGateEnabled = true;
    ex.riskState = null;
    await assert.rejects(() => ex.placeLimitOrder(opening), /未评估|风控状态/);
    await assert.rejects(() => ex.placeLimitOrders([opening]), /未评估|风控状态/);

    // 未启用风控门（paper/shadow）→ 放行
    ex.riskGateEnabled = false;
    assert.ok((await ex.placeLimitOrder(opening)).orderId);

    // 已启用 + OK → 放行
    ex.riskGateEnabled = true;
    ex.riskState = { status: 'OK' };
    assert.ok((await ex.placeLimitOrder(opening)).orderId);
    ex.stop();
  }

  {
    // Review6-1：tradingLocked（未知订单态）下 reduce-only 降风险操作必须放行，开仓仍拒绝
    const ex = await freshExchange();
    const opening = { marketId: 'BTC', side: 'buy', price: 80000, sizeBase: 0.001, reduceOnly: false };
    const closing = { marketId: 'BTC', side: 'sell', price: 100000, sizeBase: 0.001, reduceOnly: true };
    ex.tradingLocked = true;
    ex.lockReason = '测试锁定';
    await assert.rejects(() => ex.placeLimitOrder(opening), /已锁定/);
    const res = await ex.placeLimitOrder(closing);
    assert.ok(res.orderId, '锁定期间 reduce-only 必须放行');
    const batch = await ex.placeLimitOrders([closing]);
    assert.equal(batch.length, 1, '全 reduce-only 批量必须放行');
    ex.stop();
  }

  {
    // intentId 必须是 ULID：GridBot 传的是纯数字 clientOrderId（bot.js:895），不能直接当 intentId
    // （Propr 服务端校验 ULID，否则框架 400）→ 适配器须自生成 ULID 并保留原值留档
    const ex = await freshExchange();
    const numericId = 1790239336924; // 与 bot.js:895 同量级（13 位，安全整数）
    const res = await ex.placeLimitOrder({ ...ORDER, clientOrderId: numericId });
    assert.match(res.clientOrderId, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'intentId 必须是 ULID 字符串');
    const intent = ex.getIntents().find((i) => i.intentId === res.clientOrderId);
    assert.equal(intent.clientRef, numericId, '原 clientOrderId 必须留档（clientRef）');

    // 调用方给合法 ULID 时沿用（幂等键可控，供探针/冒烟使用）
    const fixed = '01M399KX3A8KJNACAQZBSY983K';
    const res2 = await ex.placeLimitOrder({ ...ORDER, clientOrderId: fixed, price: 81000 });
    assert.equal(res2.clientOrderId, fixed, '合法 ULID 应沿用');
    ex.stop();
  }
}

main()
  .then(() => console.log('propr-order-state.test.js 全部通过'))
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => { globalThis.fetch = realFetch; });
