// Decibel 第 1+2 层修复测试：撤单重试（cancelAll/cancelOrder）、幽灵单清理、
// 回收阶梯撤单跳过幽灵单（防链上 reject 累积）。
// 运行: node test/decibel-safety.test.js（npm test 会串联执行）
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DecibelExchange } from '../src/exchange/de/decibel.js';
import { GridBot } from '../src/bot.js';

let passed = 0, failed = 0;

const T = [];
const test = (name, fn) => T.push([name, fn]);

function makeDe(cancelOrderImpl) {
  const ex = new DecibelExchange({ network: 'mainnet', cancelRetryMs: 1 });
  ex.on('error', () => {}); // 测试中 error 事件必须有监听
  ex.markets.set(1, { marketId: 1, name: 'BTC-USD', addr: '0x1' });
  ex.subaccount = '0xsub';
  ex.write = { cancelOrder: cancelOrderImpl };
  ex._openOrders = async () => [
    { order_id: 'o1', market: '0x1', is_tpsl: false },
    { order_id: 'o2', market: '0x1', is_tpsl: false },
  ];
  return ex;
}

test('cancelAll：单笔撤单失败重试成功（2 次失败后成功），返回 true', async () => {
  let calls = 0;
  const ex = makeDe(async () => {
    calls++;
    if (calls <= 2) throw new Error('chain busy');
    return {};
  });
  const ok = await ex.cancelAll(1);
  assert.equal(ok, true);
  assert.equal(calls, 4, 'o1 前 2 次失败后第 3 次成功，o2 首试即成功，共 4 次调用');
});

test('cancelAll：重试 3 次仍失败 -> 报错返回 false（不静默）', async () => {
  let calls = 0;
  const errors = [];
  const ex = makeDe(async () => { calls++; throw new Error('chain busy'); });
  ex.on('error', (e) => errors.push(e));
  const ok = await ex.cancelAll(1);
  assert.equal(ok, false);
  assert.equal(calls, 6, '两单各重试 3 次共 6 次');
  assert.equal(errors.length, 3, '每单失败 emit 一次 + cancelAll 聚合错误再 emit 一次');
});

test('cancelOrder：单笔撤单失败重试后成功', async () => {
  let calls = 0;
  const ex = makeDe(async () => {
    calls++;
    if (calls === 1) throw new Error('chain busy');
    return {};
  });
  const r = await ex.cancelOrder(1, 'o1');
  assert.equal(r, true);
  assert.equal(calls, 2);
});

test('_resolveGone：幽灵单 3 轮未确认即清理（不视为成交、不补单）', async () => {
  const ex = makeDe(async () => { throw new Error('n/a'); });
  ex._tracked.set('ghost-1', { marketId: 1, levelIndex: 2, side: 'buy', price: 100, sizeBase: 1, seen: false, placedAt: Date.now(), goneAttempts: 0, resolving: false });
  // 不在 open orders、history 也查不到（一直 unknown）
  ex.read = { userOrderHistory: { getByAddr: async () => ({ items: [] }) } };
  const fills = [];
  ex.on('fill', (f) => fills.push(f));
  ex._poll = async () => {}; // 不跑真实轮询
  // 直接驱动 _resolveGone 三轮
  const t = ex._tracked.get('ghost-1');
  for (let i = 0; i < 3; i++) {
    t.goneAttempts = i;
    await ex._resolveGone('ghost-1', t);
    if (i < 2) assert.ok(ex._tracked.has('ghost-1'), '前两轮保留');
  }
  assert.ok(!ex._tracked.has('ghost-1'), '第三轮清理');
  assert.equal(fills.length, 0, '不视为成交');
});

test('回收阶梯撤单：只对交易所真实挂单发撤单（幽灵单跳过）', async () => {
  // 最小 MockExchange（复用与 bot.test 一致的接口）
  const ex = new (class extends EventEmitter {
    constructor() {
      super();
      this.orders = new Map();
      this.mode = 'paper';
      this.dataSource = 'real';
      this.feeRate = 0;
      this._seq = 1;
      this.supportsSafeOpeningRetry = undefined;
    }
    async fetchOpenOrders() {
      return [...this.orders.values()].map((o) => ({ orderId: o.orderId, price: o.price, side: o.side }));
    }
    async cancelOrder(marketId, orderId) {
      this.cancelled = this.cancelled || [];
      this.cancelled.push(String(orderId));
      this.orders.delete(String(orderId));
      return true;
    }
    async cancelAll() { return true; }
    forgetOrder(orderId) { this.orders.delete(String(orderId)); }
    adoptOrder() {}
  })();
  const bot = new GridBot(ex, { cancelVerifyDelayMs: 1, cancelVerifyAttempts: 4 });
  bot.running = true;
  bot.recovery = true;
  bot.config = {
    marketId: 1, displayName: 'TEST', mode: 'recovery',
    lower: null, upper: null, gridCount: null, sizeBase: 1, leverage: 2,
    outOfRangeAction: 'recover', spacing: 10,
  };
  // 真实在簿的回收单
  const realId = String(ex._seq++);
  ex.orders.set(realId, { orderId: realId, marketId: 1, price: 90, side: 'sell' });
  // 幽灵回收单（交易所簿里不存在）
  bot.active.set('phantom-1', { levelIndex: 2, side: 'buy', price: 100, sizeBase: 1, recovery: true, opening: false, placedAt: Date.now() });
  bot.active.set(realId, { levelIndex: 1, side: 'sell', price: 90, sizeBase: 1, recovery: true, opening: false, placedAt: Date.now() });
  await bot._cancelRecoveryLadder();
  assert.deepEqual(ex.cancelled, [realId], '只对真实挂单发撤单（幽灵单跳过）');
  assert.equal(bot.active.size, 0, '跟踪清理完成');
  assert.ok(bot.alerts.some((a) => a.message.includes('跳过 1 个交易所已不存在的挂单')), '提示跳过了幽灵单');
});

(async () => {
  for (const [name, fn] of T) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
