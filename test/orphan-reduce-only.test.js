// test/orphan-reduce-only.test.js —— 空仓时不得留下减仓腿
//
// 背景（2026-10-31 testnet 实测）：reduce-only 的「只减不翻」只在下单那一刻校验。
// 空仓状态滞留 2 张 reduceOnly SELL @75,587.3 / @75,742.2，价格从 70.1k 回升到 75.6k
// 后成交，交易所持仓变成 −0.0002（与两张单均价 75,664.75 完全吻合），触发
// 「仓位不一致」熔断。腿本身早在持仓归零时就该撤掉。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';

function mkBot({ sizeBase = 0.0001, posSize = 0, orders = {} } = {}) {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.config = { marketId: 1, sizeBase };
  bot.active = new Map(Object.entries(orders));
  const canceled = [];
  bot.ex = {
    getPosition: () => (posSize == null ? null : { sizeBase: posSize }),
    cancelOrder: async (_m, id) => { canceled.push(id); },
  };
  bot._alert = () => {};
  bot._changed = () => {};
  bot.canceled = canceled;
  return bot;
}

test('空仓 + 减仓腿：连续两轮确认后撤销，并清出本地台账', async () => {
  const bot = mkBot({
    orders: {
      s1: { side: 'sell', reduceOnly: true, recovery: true, price: 75587.3 },
      s2: { side: 'sell', reduceOnly: true, recovery: true, price: 75742.2 },
    },
  });

  await bot._auditOrphanReduceOnly();
  assert.deepEqual(bot.canceled, [], '第一轮不许动手：持仓接口瞬时空响应不能当证据');
  assert.equal(bot.active.size, 2, '第一轮保留跟踪');

  await bot._auditOrphanReduceOnly();
  assert.deepEqual(bot.canceled.sort(), ['s1', 's2'], '第二轮确认空仓，必须撤掉两张腿');
  assert.equal(bot.active.size, 0, '撤单后清出本地台账');
});

test('有仓位时不撤减仓腿（那是真正要用的止盈/回收腿）', async () => {
  const bot = mkBot({
    posSize: 0.0004,
    orders: { s1: { side: 'sell', reduceOnly: true, recovery: true, price: 75587.3 } },
  });
  await bot._auditOrphanReduceOnly();
  await bot._auditOrphanReduceOnly();
  assert.deepEqual(bot.canceled, [], '有持仓时减仓腿是有效腿，撤了就等于让仓位裸奔');
});

test('持仓是尘埃级反向残留（−0.0002）时不得撤腿', async () => {
  const bot = mkBot({
    posSize: -0.0002,
    orders: { b1: { side: 'buy', reduceOnly: true, recovery: true, price: 75000 } },
  });
  await bot._auditOrphanReduceOnly();
  await bot._auditOrphanReduceOnly();
  assert.deepEqual(bot.canceled, [], '−0.0002 是真实反向仓，撤掉买腿会让空头失去减仓出口');
});