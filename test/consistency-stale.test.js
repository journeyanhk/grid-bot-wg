// test/consistency-stale.test.js —— 「拿时间当状态」的两个入口
//
// 背景（2026-11-02 第三观察窗 21 分钟误熔断，2026-11-06 review 定案）：
//   ① _guardConsistency 原来用「成交后 10 秒内跳过比对」判断交易所仓位缓存是否追上。
//      这是拿「经过了 N 秒」赌「状态已经就绪」——和 10-25 那次 watchdog 误杀同源。
//      正确判据是适配器记录的 positionsFetchedAt 是否已追平最后一笔成交。
//   ② 跳过还被记成 ok:true，即「没查明」冒充「一致」。应改为 stale 态：
//      禁开仓、不计 unknown streak、持续追不上才熔断。
//   ③ 同源的 `_auditOrphanReduceOnly` 用缓存持仓决定撤腿——缓存读到 0 而实际有仓时
//      会撤掉正在保护仓位的减仓腿。撤单/熔断的判断一律不许只信缓存。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot } from '../src/bot.js';
import { evaluateRisk, STATES } from '../src/guard.js';

const MB = 1_000_000;

function mkBot({ posSize = 0, fetchedAt = 0, lastFillAt = 0, ledger = 0 } = {}) {
  const bot = Object.create(GridBot.prototype);
  bot.running = true;
  bot.config = { marketId: 1, sizeBase: 0.0001, displayName: 'BTC-USD' };
  bot.active = new Map();
  bot.ex = {
    getPosition: () => (posSize == null ? null : { sizeBase: posSize }),
    positionsFetchedAt: fetchedAt,
  };
  bot._lastFillAtMs = lastFillAt;
  bot.posLedger = { value: ledger };
  bot._untrackedFills = [];
  return bot;
}

test('成交后缓存时间戳落后：返回 stale，绝不冒充一致', () => {
  const now = Date.now();
  const bot = mkBot({ posSize: 0.0002, fetchedAt: now - 6_000, lastFillAt: now - 1_000, ledger: 0.0003 });
  const r = bot._guardConsistency();
  assert.equal(r.status, 'stale', '缓存没追上就是 stale');
  assert.equal(r.ok, false, 'stale 不是 ok —— 这正是原来最危险的地方');
  assert.match(r.issues[0], /落后最后成交/);
});

test('缓存已追平最后一笔成交：照常比对，且能抓出真实不一致', () => {
  const now = Date.now();
  const bot = mkBot({ posSize: 0.0002, fetchedAt: now, lastFillAt: now - 8_000, ledger: 0.0003 });
  const r = bot._guardConsistency();
  assert.equal(r.status, 'mismatch', '缓存追上后差 1 格必须判不一致');
  assert.match(r.issues[0], /仓位不一致/);
});

test('缓存追平且账本一致：ok', () => {
  const now = Date.now();
  const bot = mkBot({ posSize: 0.0002, fetchedAt: now, lastFillAt: now - 8_000, ledger: 0.0002 });
  const r = bot._guardConsistency();
  assert.equal(r.status, 'ok');
  assert.equal(r.ok, true);
});

test('单次 stale → DEFENSIVE 且禁开仓，但不熔断', () => {
  const r = evaluateRisk({
    consistency: { ok: false, status: 'stale', issues: ['交易所仓位缓存落后最后成交 3.0s'] },
    consistencyStaleStreak: 1,
    price: 78000, lower: 72000, upper: 84000,
    positionBase: 0.0002, inventoryBase: 0.0002, maxInventoryBase: 0.0008,
    equity: 150, startBalance: 150, fills: [], now: Date.now(),
  }, {});
  assert.equal(r.state, STATES.DEFENSIVE, '缓存滞后只该降级，不该熔断');
  assert.equal(r.blockOpening, true, '账本不可验证时不许加风险');
  assert.equal(r.haltReason, null);
});

test('stale 连续 12 轮（≈60s 仍追不上）→ HALTED', () => {
  const r = evaluateRisk({
    consistency: { ok: false, status: 'stale', issues: ['交易所仓位缓存落后最后成交 61.0s'] },
    consistencyStaleStreak: 12,
    price: 78000, lower: 72000, upper: 84000,
    positionBase: 0.0002, inventoryBase: 0.0002, maxInventoryBase: 0.0008,
    equity: 150, startBalance: 150, fills: [], now: Date.now(),
  }, {});
  assert.equal(r.state, STATES.HALTED, '缓存真的坏了才熔断');
  assert.match(r.haltReason, /仓位缓存连续 12 轮/);
});

test('unknown（查不明）仍按原规则：连续 2 轮即熔断', () => {
  const r = evaluateRisk({
    consistency: { ok: false, status: 'unknown', issues: ['读取仓位失败：boom'] },
    consistencyUnknownStreak: 2,
    price: 78000, lower: 72000, upper: 84000,
    positionBase: 0, inventoryBase: 0, maxInventoryBase: 0.0008,
    equity: 150, startBalance: 150, fills: [], now: Date.now(),
  }, {});
  assert.equal(r.state, STATES.HALTED);
  assert.match(r.haltReason, /一致性检查连续 2 次失败/);
});

test('撤腿前必须现读持仓：缓存说 0、实际有仓时一张腿都不许撤', async () => {
  const bot = mkBot({ posSize: 0 });            // 缓存：空仓
  bot.ex.getPositionFresh = async () => ({ sizeBase: 0.0004 });   // 现读：真的有仓
  bot.active = new Map([
    ['s1', { side: 'sell', reduceOnly: true, recovery: true, price: 75587.3 }],
  ]);
  const canceled = [];
  bot.ex.cancelOrder = async (_m, id) => { canceled.push(id); };
  bot._alert = () => {};
  bot._changed = () => {};

  await bot._auditOrphanReduceOnly();
  await bot._auditOrphanReduceOnly();
  assert.deepEqual(canceled, [], '缓存滞后时撤腿等于让仓位裸奔');
  assert.equal(bot.active.size, 1);
});

test('现读持仓失败：本轮不动手（宁可少做）', async () => {
  const bot = mkBot({ posSize: 0 });
  bot.ex.getPositionFresh = async () => { throw new Error('429'); };
  bot.active = new Map([
    ['s1', { side: 'sell', reduceOnly: true, recovery: true, price: 75587.3 }],
  ]);
  const canceled = [];
  bot.ex.cancelOrder = async (_m, id) => { canceled.push(id); };
  bot._alert = () => {};
  bot._changed = () => {};

  await bot._auditOrphanReduceOnly();
  await bot._auditOrphanReduceOnly();
  assert.deepEqual(canceled, [], '读不到真实持仓就没有撤腿的依据');
});
