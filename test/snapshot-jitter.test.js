// 空快照抖动检测器单测（Review14）：滑动窗口空快照率、阈值边界、最小轮次、
// 恢复清除、窗口过期；以及 EX 适配器轮询级集成（复现"0 秒连击 ×1306 次"事故签名）。
import assert from 'node:assert/strict';
import { createSnapshotJitterWatcher, JITTER_DEFAULTS } from '../src/exchange/snapshot-jitter.js';
import { ExtendedExchange } from '../src/exchange/ex/extended.js';

let passed = 0, failed = 0;
const T = [];
const test = (name, fn) => T.push([name, fn]);
const SILENT = { info() {}, warn() {}, error() {} };

function mkWatcher({ now = () => 0, onIssue = null, onRecover = null } = {}) {
  return createSnapshotJitterWatcher({ tag: 't', label: 'T', logger: SILENT, now, onIssue, onRecover });
}

test('阈值边界：>30% 判抖动（含边界口径）；<10 轮不判', () => {
  const w = mkWatcher();
  // 9 轮：8 空 1 满 = 88.9% 但轮次不足 -> 不判
  for (let i = 0; i < 8; i++) w.record([], 12);
  w.record([{ id: 1 }], 12);
  assert.equal(w.state().jittering, false, '少于 minRounds 不判');
  // 第 10 轮：加 1 空 -> 9/10 = 90% -> 判
  const s = w.record([], 12);
  assert.equal(s.jittering, true);
  assert.equal(s.emptyRatePct, 90);
});

test('恰好 30% 不判（口径为 >30），31% 判', () => {
  // 10 轮 3 空 = 30% -> 不判
  const w1 = mkWatcher();
  const seq1 = [true, true, true, false, false, false, false, false, false, false];
  for (const empty of seq1) w1.record(empty ? [] : [{ id: 1 }], 12);
  assert.equal(w1.state().emptyRatePct, 30);
  assert.equal(w1.state().jittering, false, '恰好 30% 不判');
  // 10 轮 4 空 = 40% -> 判
  const w2 = mkWatcher();
  const seq2 = [true, true, true, true, false, false, false, false, false, false];
  for (const empty of seq2) w2.record(empty ? [] : [{ id: 1 }], 12);
  assert.equal(w2.state().jittering, true);
});

test('事故签名复现：空/满交替 12 轮 -> 判定抖动（连击时长逻辑失明的场景）', () => {
  const issues = [], recovers = [];
  const w = mkWatcher({ onIssue: (s) => issues.push(s), onRecover: (s) => recovers.push(s) });
  for (let i = 0; i < 12; i++) w.record(i % 2 === 0 ? [] : [{ id: 1 }], 12);
  assert.equal(issues.length, 1, '交替抖动应触发一次 issue（仅一次，不重复刷）');
  assert.ok(issues[0].emptyRatePct > 30);
  assert.equal(w.issueActive, true);
  assert.equal(recovers.length, 0);
});

test('恢复：好快照占多数后率回落 -> onRecover 且解除', () => {
  const issues = [], recovers = [];
  const w = mkWatcher({ onIssue: (s) => issues.push(s), onRecover: (s) => recovers.push(s) });
  for (let i = 0; i < 12; i++) w.record(i % 2 === 0 ? [] : [{ id: 1 }], 12); // 6/12=50% 抖动
  assert.equal(w.issueActive, true);
  for (let i = 0; i < 10; i++) w.record([{ id: 1 }], 12); // 6/22=27.3% < 30%
  assert.equal(w.issueActive, false, '恢复解除');
  assert.equal(recovers.length, 1, '恢复回调一次');
});

test('窗口过期：旧空快照滚出 10 分钟窗口后率归零', () => {
  let t = 0;
  const w = mkWatcher({ now: () => t });
  for (let i = 0; i < 12; i++) { w.record(i % 2 === 0 ? [] : [{ id: 1 }], 12); }
  assert.equal(w.state().jittering, true);
  t = JITTER_DEFAULTS.windowMs + 60_000; // 快进 11 分钟
  const s = w.state();
  assert.equal(s.rounds, 0, '窗口内无事件');
  assert.equal(s.jittering, false, '窗口过期即不再判定');
});

test('取数失败（rows 非数组）与小梯（tracked<10）不计数', () => {
  const w = mkWatcher();
  assert.equal(w.record(null, 12), null, '取数失败不计');
  assert.equal(w.record([], 5), null, '小梯不计');
  assert.equal(w.state().rounds, 0);
});

// ── EX 适配器轮询级集成 ──
test('EX _poll 集成：交替空/满快照 -> 抖动降级态置红并告警；恢复后清除', async () => {
  const ex = new ExtendedExchange({ apiKey: 'x', vault: '1', privateKey: '1', apiUrl: 'https://invalid' });
  ex.markets.set(1, { marketId: 1, name: 'BTC-USD' });
  for (let i = 0; i < 12; i++) {
    ex._tracked.set('o-' + i, { marketId: 1, levelIndex: i, side: 'buy', price: 100 + i, sizeBase: 1, seen: true, goneAttempts: 0, resolving: false, placedAt: Date.now() - 60_000 });
  }
  ex._watch.add(1); // 生产由外部 getPrice 触达；测试直接预置观察市场
  ex._refreshAccount = async () => {};
  const goodRows = [...ex._tracked.keys()].map((id) => ({ id }));
  let cycle = 0, alternate = true;
  ex._get = async (path) => {
    if (path.includes('/user/orders')) { cycle++; return alternate ? (cycle % 2 === 1 ? [] : goodRows) : goodRows; }
    if (path.includes('orderbook')) return { bid: [{ price: '100' }], ask: [{ price: '101' }] };
    if (path.includes('/user/positions')) return [];
    return [];
  };
  const errs = []; ex.on('error', (e) => errs.push(e));

  for (let i = 0; i < 12; i++) await ex._poll();
  assert.equal(ex.operationalIssue?.title, 'Extended 挂单快照高频抖动', '降级态置红');
  assert.ok(errs.some((e) => e.message.includes('高频抖动')), '发出告警');
  assert.ok(ex.snapshotEmptyRatePct() > 30, `空快照率可见（${ex.snapshotEmptyRatePct()}%）`);

  alternate = false; // 恢复
  for (let i = 0; i < 10; i++) await ex._poll();
  assert.equal(ex.operationalIssue, null, '恢复后清除');
  assert.ok(ex.snapshotEmptyRatePct() <= 30, `恢复后率回落（${ex.snapshotEmptyRatePct()}%）`);
});

(async () => {
  for (const [name, fn] of T) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
