// test/guard.test.js —— P3 风控状态机 / 熔断线 / 一致性巡检
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, GUARD_DEFAULTS, evaluateRisk, checkConsistency, canEnterRecovery,
  addSideFor, HaltLedger,
} from '../src/guard.js';

const base = {
  price: 80000, lower: 77000, upper: 83000,
  positionBase: 0, maxInventoryBase: 0.0066,
  equity: 250, startBalance: 250,
  // 刻意不写 outOfRange：默认走价格兜底。
  // bot 传布尔值时以它为准（它带「外侧半格 + 2 拍 + 驻留」三重迟滞）。
  now: 1_000_000,
};

// ---------- 1. 状态机转移 ----------
test('RUNNING：一切正常时不干预', () => {
  const r = evaluateRisk(base);
  assert.equal(r.state, STATES.RUNNING);
  assert.equal(r.blockOpening, false);
  assert.equal(r.blockSide, null);
  assert.equal(r.haltReason, null);
});

test('库存 50% → DEFENSIVE（仅降级，不封锁方向）', () => {
  const r = evaluateRisk({ ...base, positionBase: -0.0033 }); // 0.0033 / 0.0066 = 50%
  assert.equal(r.state, STATES.DEFENSIVE);
  assert.equal(r.blockSide, null, '50% 只降级，不封方向');
  assert.match(r.reasons.join('|'), /防守/);
});

test('库存 75% → DEFENSIVE 且封锁加仓方向', () => {
  const short = evaluateRisk({ ...base, positionBase: -0.005 });
  assert.equal(short.state, STATES.DEFENSIVE);
  assert.equal(short.blockSide, 'sell', '空头加仓方向是 sell');
  const long = evaluateRisk({ ...base, positionBase: 0.005 });
  assert.equal(long.blockSide, 'buy', '多头加仓方向是 buy');
});

test('库存 100% → HALTED', () => {
  const r = evaluateRisk({ ...base, positionBase: -0.0066 });
  assert.equal(r.state, STATES.HALTED);
  assert.match(r.haltReason, /库存触顶/);
});

test('破界 → DEFENSIVE 且停止全部开仓', () => {
  for (const price of [76000, 84000]) {
    const r = evaluateRisk({ ...base, price });
    assert.equal(r.state, STATES.DEFENSIVE, `price=${price}`);
    assert.equal(r.blockOpening, true, `price=${price} 必须封开仓`);
  }
  const flagged = evaluateRisk({ ...base, outOfRange: true });
  assert.equal(flagged.blockOpening, true, '适配器标记破界也要封开仓');
});

test('outOfRange=false 时尊重 bot 的迟滞：贴边价不算破界', () => {
  // 边界外 10 块（半格以内），bot 认为还没确认破界，guard 不能抢先封盘
  const near = evaluateRisk({ ...base, price: 76990, outOfRange: false });
  assert.equal(near.state, STATES.RUNNING, '贴边未确认破界时不应降级');
  assert.equal(near.blockOpening, false);

  // 真正的破界：bot 已确认
  const real = evaluateRisk({ ...base, price: 76000, outOfRange: true });
  assert.equal(real.state, STATES.DEFENSIVE);
  assert.equal(real.blockOpening, true);
});

test('账户 -40 / -60 / -80 三档递进', () => {
  const warn = evaluateRisk({ ...base, equity: 210 });      // 亏损 40，仅预警
  assert.equal(warn.state, STATES.RUNNING, '预警线不改状态');
  assert.match(warn.reasons.join('|'), /预警线/);

  const def = evaluateRisk({ ...base, equity: 190 });       // 亏损 60
  assert.equal(def.state, STATES.DEFENSIVE);

  const halt = evaluateRisk({ ...base, equity: 170 });      // 亏损 80
  assert.equal(halt.state, STATES.HALTED);
  assert.match(halt.haltReason, /账户级熔断/);
});

// ---------- 2. 重启后 HALTED 保持 ----------
test('HALTED 粘滞：带 haltReason 进入评估永远得到 HALTED', () => {
  const r = evaluateRisk({ ...base, haltReason: '账户级熔断：equity 170' });
  assert.equal(r.state, STATES.HALTED);
  assert.equal(r.blockOpening, true);
  // 即便此时各项指标都完全健康，也不许自动恢复
  const healthy = evaluateRisk({ ...base, equity: 260, haltReason: '账户级熔断：equity 170' });
  assert.equal(healthy.state, STATES.HALTED, '健康指标不能抵销已持久化的熔断');
});

test('HaltLedger：startBalance 只锁一次，重启不重置', () => {
  const l = new HaltLedger({});
  assert.equal(l.startBalance, null);
  l.lockStartBalance(250, 1000);
  assert.equal(l.startBalance, 250);
  l.lockStartBalance(180, 2000);            // 亏了钱后重启，不许改写成 180
  assert.equal(l.startBalance, 250, '亏钱重启不能把起点改低');

  const restored = new HaltLedger(JSON.parse(JSON.stringify(l.toJSON())));
  assert.equal(restored.startBalance, 250, '序列化后恢复');
  restored.halt('测试熔断', 3000);
  assert.equal(restored.isHalted, true);
  const again = new HaltLedger(restored.toJSON());
  assert.equal(again.isHalted, true, '重启后仍是熔断态');
  assert.equal(again.haltReason, '测试熔断');
});

test('HaltLedger：首个熔断原因不被后续覆盖，人工清除后归零', () => {
  const l = new HaltLedger({});
  assert.equal(l.halt('第一个原因', 1), true);
  assert.equal(l.halt('第二个原因', 2), false, '粘滞：不许覆盖');
  assert.equal(l.haltReason, '第一个原因');
  assert.equal(l.clearHalt(), '第一个原因');
  assert.equal(l.isHalted, false);
});

// ---------- 3. 一致性巡检 ----------
test('position_delta 触发不一致', () => {
  const r = checkConsistency({ positionBase: -0.002, localPositionBase: -0.001 });
  assert.equal(r.ok, false);
  assert.match(r.issues.join('|'), /仓位不一致/);
  // 容差内
  assert.equal(checkConsistency({ positionBase: 0.0002, localPositionBase: 0.0002 }).ok, true);
});

test('unknown_fill / untracked_fill 触发不一致', () => {
  assert.match(checkConsistency({ unknownFills: 1 }).issues.join('|'), /未识别成交/);
  assert.match(checkConsistency({ untrackedFills: 2 }).issues.join('|'), /未跟踪成交/);
});

test('被拒订单出现在台账 / reduceOnly 误判 / 挂单数不符 都算不一致', () => {
  assert.match(checkConsistency({ rejectedInTracked: 1 }).issues.join('|'), /被拒订单/);
  assert.match(checkConsistency({ reduceOnlyMismatch: 1 }).issues.join('|'), /reduceOnly/);
  assert.match(
    checkConsistency({ exchangeOrderCount: 66, localOrderCount: 60 }).issues.join('|'),
    /挂单数不一致/,
  );
  assert.equal(checkConsistency({ exchangeOrderCount: 66, localOrderCount: 66 }).ok, true);
});

test('一致性异常直接把风控推到 HALTED', () => {
  const r = evaluateRisk({ ...base, consistency: { ok: false, issues: ['仓位不一致：x'] } });
  assert.equal(r.state, STATES.HALTED);
  assert.match(r.haltReason, /账本不一致/);
});

// ---------- 4. 恢复条件 ----------
test('canEnterRecovery：条件全满足才放行，且只给 RECOVERY_PENDING', () => {
  const ok = {
    ...base, positionBase: 0, openOrderCount: 0, outOfRange: false,
    barsClosedAboveLower: 2, consistency: { ok: true, issues: [] },
  };
  assert.equal(canEnterRecovery(ok).ok, true);

  const cases = [
    [{ price: 76000 }, /未回到区间/],
    [{ barsClosedAboveLower: 1 }, /1h K 线/],
    [{ positionBase: 0.002 }, /超过恢复上限/],
    [{ openOrderCount: 3 }, /未撤订单/],
    [{ outOfRange: true }, /破界/],
    [{ consistency: { ok: false, issues: ['x'] } }, /不一致/],
  ];
  for (const [patch, re] of cases) {
    const r = canEnterRecovery({ ...ok, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.missing.join('|'), re, JSON.stringify(patch));
  }
});

// ---------- 5. 重复 / 乱序事件 ----------
test('重复评估幂等：同样的 ctx 反复评估结果一致', () => {
  const ctx = { ...base, positionBase: -0.005, equity: 190 };
  const a = evaluateRisk(ctx);
  const b = evaluateRisk(ctx);
  const c = evaluateRisk(ctx);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('乱序成交：只有窗口内且最新的 N 笔参与偏置判定', () => {
  const now = 10_000_000;
  // 20 笔同向开仓买 + 一些窗口外/过老的干扰
  const fresh = Array.from({ length: 20 }, (_, i) => ({ side: 'buy', opening: true, ts: now - i * 1000 }));
  const stale = Array.from({ length: 30 }, (_, i) => ({ side: 'sell', opening: true, ts: now - 7_200_000 - i }));
  const r = evaluateRisk({ ...base, now, positionBase: 0.004, fills: [...stale, ...fresh] });
  assert.equal(r.state, STATES.DEFENSIVE);
  assert.match(r.reasons.join('|'), /成交偏置/);

  // 同一批成交但库存反向（在减仓），不应触发偏置防守
  const closing = evaluateRisk({ ...base, now, positionBase: 0, fills: fresh });
  assert.doesNotMatch(closing.reasons.join('|'), /成交偏置/);
});

test('addSideFor 方向映射', () => {
  assert.equal(addSideFor(1), 'buy');
  assert.equal(addSideFor(-1), 'sell');
  assert.equal(addSideFor(0), null);
});

test('GUARD_DEFAULTS 三档线单调递增且 $60 只作为持仓止损口径保留', () => {
  assert.ok(GUARD_DEFAULTS.warnLossUsd < GUARD_DEFAULTS.defensiveLossUsd);
  assert.ok(GUARD_DEFAULTS.defensiveLossUsd < GUARD_DEFAULTS.haltLossUsd);
  assert.ok(GUARD_DEFAULTS.inventoryWarnFrac < GUARD_DEFAULTS.inventoryBlockFrac);
  assert.ok(GUARD_DEFAULTS.inventoryBlockFrac < GUARD_DEFAULTS.inventoryHaltFrac);
});