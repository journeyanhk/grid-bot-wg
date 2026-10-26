// 风控状态与写门：只拦开仓，不拦降风险。
import { strict as assert } from 'node:assert';
import { computeRiskState, evaluateWriteGate, DEFAULT_LIMITS } from '../src/exchange/pr/risk.js';

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

console.log('✓ propr-risk.test.js 全部通过');