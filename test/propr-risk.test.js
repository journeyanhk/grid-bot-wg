// 风控状态与写门：只拦开仓，不拦降风险。
import { strict as assert } from 'node:assert';
import { computeRiskState, evaluateWriteGate, evaluateDualSide, trendHalt, breakoutAction, DEFAULT_LIMITS } from '../src/exchange/pr/risk.js';

{
  // 正常
  const r = computeRiskState({ equity: 5011.8, balance: 5011.8, dayStartBalance: 5011.8, startBalance: 5000 });
  assert.equal(r.state, 'NORMAL');
  assert.equal(r.allowOpen, true);
  assert.equal(r.dayLoss, 0);
}

{
  // 日亏 60 → THROTTLE；日亏 120 → HALT_NEW
  const t = computeRiskState({ equity: 4951, balance: 5011, dayStartBalance: 5011, startBalance: 5000 });
  assert.equal(t.state, 'THROTTLE');
  assert.equal(t.allowOpen, false);
  const h = computeRiskState({ equity: 4891, balance: 5011, dayStartBalance: 5011, startBalance: 5000 });
  assert.equal(h.state, 'HALT_NEW');
}

{
  // 总回撤触内部线（5000-150=4850）→ CLOSE_ALL
  const c = computeRiskState({ equity: 4849, balance: 4900, dayStartBalance: 4900, startBalance: 5000 });
  assert.equal(c.state, 'CLOSE_ALL');
}

{
  // 距内部总回撤线不足 $25 → HALT_NEW（缓冲）
  const b = computeRiskState({ equity: 4860, balance: 4860, dayStartBalance: 4860, startBalance: 5000 });
  assert.equal(b.state, 'HALT_NEW');
  assert.ok(b.reasons.some((x) => x.includes('距总回撤线')));
}

{
  // 接近日软线（>= soft-10）→ THROTTLE
  const b = computeRiskState({ equity: 4966, balance: 5011, dayStartBalance: 5011, startBalance: 5000 });
  assert.equal(b.state, 'THROTTLE');
  assert.ok(b.reasons.some((x) => x.includes('接近日软线')));
}

{
  // equity 缺失 → UNKNOWN，不许开仓
  const u = computeRiskState({ equity: null });
  assert.equal(u.state, 'UNKNOWN');
  assert.equal(u.allowOpen, false);
}

const good = {
  mode: 'sim-write', allowLive: true, attemptStatus: 'active', accountAgeMs: 3_000,
  positions: { dualSide: false }, risk: { allowOpen: true, state: 'NORMAL' },
  notional: 500, maxOpenNotional: 1500, newNotional: 300,
};

{
  // 全绿 → 放行
  const g = evaluateWriteGate(good);
  assert.equal(g.allowOpen, true);
  assert.deepEqual(g.reasons, []);
}

{
  // 逐项否决
  const cases = [
    [{ mode: 'paper' }, /mode/],
    [{ allowLive: false }, /PR_ALLOW_LIVE/],
    [{ attemptStatus: 'failed' }, /attempt/],
    [{ accountAgeMs: 60_000 }, /过期/],
    [{ positions: { dualSide: true } }, /双边/],
    [{ risk: { allowOpen: false, state: 'THROTTLE' } }, /风控/],
    [{ newNotional: 1200 }, /名义超限/],
  ];
  for (const [patch, re] of cases) {
    const g = evaluateWriteGate({ ...good, ...patch });
    assert.equal(g.allowOpen, false, JSON.stringify(patch));
    assert.ok(g.reasons.some((r) => re.test(r)), `${JSON.stringify(patch)} → ${g.reasons}`);
    assert.equal(g.allowReduce, true, '降风险永远允许');
  }
}

{
  // 边界：刚好等于上限允许
  const g = evaluateWriteGate({ ...good, notional: 1000, newNotional: 500 });
  assert.equal(g.allowOpen, true);
  assert.equal(DEFAULT_LIMITS.staleMs, 45_000);
}

{
  // 没有风控快照 → 不允许开仓
  const g = evaluateWriteGate({ ...good, risk: null });
  assert.equal(g.allowOpen, false);
  assert.ok(g.reasons.some((r) => r.includes('未知')));
}

{
  // gross 库存上限
  const g = evaluateWriteGate({ ...good, inventoryBtc: 0.0055, newQty: 0.001, maxInventoryBtc: 0.006 });
  assert.equal(g.allowOpen, false);
  assert.ok(g.reasons.some((r) => r.includes('库存超限')));
  const ok = evaluateWriteGate({ ...good, inventoryBtc: 0.004, newQty: 0.001, maxInventoryBtc: 0.006 });
  assert.equal(ok.allowOpen, true);
}

{
  // 双边策略：默认 freeze；cap 需要人工 ack，且每侧有上限
  const dual = { long: { size: 0.002 }, short: { size: 0.002 } };
  const f = evaluateDualSide({ positions: dual, policy: 'freeze' });
  assert.equal(f.allowOpen, false);
  assert.equal(f.dual, true);
  const cNoAck = evaluateDualSide({ positions: dual, policy: 'cap', ack: false });
  assert.equal(cNoAck.allowOpen, false);
  const cAck = evaluateDualSide({ positions: dual, policy: 'cap', ack: true, maxPerSide: 0.003 });
  assert.equal(cAck.allowOpen, true);
  const over = evaluateDualSide({ positions: { long: { size: 0.004 }, short: { size: 0.002 } }, policy: 'cap', ack: true, maxPerSide: 0.003 });
  assert.equal(over.allowOpen, false);
  assert.ok(evaluateDualSide({ positions: { long: { size: 0.002 }, short: null }, policy: 'freeze' }).allowOpen);
}

{
  // 趋势过滤与突破处置
  assert.equal(trendHalt({ trend: 'down', strength: 0.8 }).blockSide, 'long');
  assert.equal(trendHalt({ trend: 'up', strength: 0.8 }).blockSide, 'short');
  assert.equal(trendHalt({ trend: 'down', strength: 0.3 }).halt, false);
  assert.equal(breakoutAction({ price: 90, lower: 100, upper: 120 }).side, 'long');
  assert.equal(breakoutAction({ price: 130, lower: 100, upper: 120 }).side, 'short');
  assert.equal(breakoutAction({ price: 110, lower: 100, upper: 120 }).out, false);
}

console.log('✓ propr-risk.test.js 全部通过');