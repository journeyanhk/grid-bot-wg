// test/consistency-unknown.test.js —— 「未识别成交」必须只增不拦：判据要与账本挂钩
//
// 2026-11-10 18:42 → 11-11 12:00 主网停摆 17 小时，原因不是有人没批恢复，而是
// 三条恢复路径全被一条记录堵死：未识别成交计数器只增不减（还进快照），而
// guard.checkConsistency 无条件把它报成问题。于是：
//   clear-halt → 抛「要求空仓」；new-epoch → 只清 guard 不清数组 → 下周期再熔；
//   重启 → 从快照恢复那条记录 → 照样熔断。
//
// 判据修正：只有「有未识别成交 **且** 账本与交易所不一致」才是风险。
// applyFill 是无条件执行的，仓位数才是唯一真相。
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkConsistency } from '../src/guard.js';

const base = (over = {}) => ({
  positionBase: 0.003,
  localPositionBase: 0.003,
  exchangeOrderCount: 0,
  localOrderCount: 0,
  ...over,
});

test('有未识别成交但账本与交易所一致 → 不报问题（不许再堵住恢复路径）', () => {
  const r = checkConsistency(base({ unknownFills: 1 }));
  assert.equal(r.ok, true, `账本 0.003 == 交易所 0.003，不该熔断：${r.issues.join('; ')}`);
  assert.equal(r.status, 'ok');
});

test('有未识别成交且账本差 0.0002 → 必须报，且原因写明「账本不一致」', () => {
  const r = checkConsistency(base({ unknownFills: 1, localPositionBase: 0.0028 }));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((s) => s.includes('未识别成交') && s.includes('账本不一致')), r.issues.join('; '));
});

test('仓位未知时 fail-closed：无法核实不等于没问题', () => {
  const r = checkConsistency(base({ unknownFills: 2, positionBase: undefined }));
  assert.equal(r.ok, false, '拿不到交易所仓位时不能放行');
});

test('没有未识别成交时，这条判据完全不发言（不误伤正常对账）', () => {
  assert.equal(checkConsistency(base({ unknownFills: 0 })).ok, true);
  assert.equal(checkConsistency(base()).ok, true);
});