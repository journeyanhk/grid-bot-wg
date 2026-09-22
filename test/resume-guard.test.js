// 续跑看门狗单测（Review22 / 9·21）：接管缺失态防护三件套。
// 覆盖：离线不计时/退避梯度、重连后 resume 优先、兜底条件（≥3 次 + ≥10 分钟）、
// 只撤单不动仓位、重复告警节流、撤单失败重试、外部解除静默。
import assert from 'node:assert/strict';
import { createResumeGuard, tryResumeBot } from '../src/resume-guard.js';

const SILENT = { info() {}, warn() {}, error() {} };

function makeEnv({ connected = false, resumeFail = false, cleanerFail = false } = {}) {
  let t = 1_000_000_000;
  const env = {
    now: () => t,
    advance: (ms) => { t += ms; },
    snap: { running: true, config: { displayName: 'BTC-USD', marketId: 1 } },
    notifier: { sends: [], send(o) { this.sends.push(o); return true; } },
    bot: {
      running: false, issue: null, alerts: [],
      resumeCalls: 0, cleanerCalls: 0, closeCalls: 0,
      setOperationalIssue(i) { this.issue = i; },
      _alert(m) { this.alerts.push(m); },
      async resume() { this.resumeCalls++; if (resumeFail) throw new Error('resume boom'); this.running = true; },
      async recoverStrayOrders() { this.cleanerCalls++; if (cleanerFail) throw new Error('clean boom'); },
      async closePosition() { this.closeCalls++; },
    },
    exchange: {
      dataSource: connected ? 'real' : null,
      reconnectCalls: 0, reconnectFail: !connected,
      async reconnect() { this.reconnectCalls++; if (this.reconnectFail) throw new Error('connect boom'); this.dataSource = 'real'; },
      async getMarkets() { return [{ marketId: 7, displayName: 'BTC-USD', name: 'BTC-USD' }]; },
    },
  };
  env.guard = createResumeGuard({
    bots: { de: env.bot }, exchanges: { de: env.exchange },
    loadSnapshot: () => env.snap, notifier: env.notifier, logger: SILENT, now: env.now,
  });
  return env;
}

let passed = 0, failed = 0;
const T = [];
const test = (name, fn) => T.push([name, fn]);

test('交易所离线不计时：20 分钟只重连不撤单，且按 1/2/5/15 分退避', async () => {
  const env = makeEnv({ connected: false });
  for (let i = 0; i < 21; i++) { await env.guard.tick(); env.advance(60_000); }
  assert.equal(env.bot.cleanerCalls, 0, '交易所不在线时反正撤不了：不得计时/撤单');
  assert.equal(env.bot.resumeCalls, 0, '未连接不得尝试续跑');
  // 尝试点：0s、60s、180s、480s（下一次 1380s > 20 分钟窗口）
  assert.equal(env.exchange.reconnectCalls, 4, '重连按 1/2/5/15 分退避');
  assert.ok(env.bot.issue && env.bot.issue.message.includes('重连中（第 4 次'), '卡片显示重连中（第 N 次）');
  assert.ok(env.notifier.sends.length >= 1, '应推送告警');
  assert.ok(env.notifier.sends[0].message.includes('[接管缺失]'), '告警带接管缺失标记');
  assert.equal(env.notifier.sends[0].key, 'resume-guard:de', '稳定去重 key');
  assert.equal(env.notifier.sends[0].cooldownMs, 30 * 60_000, '重复推送节奏由总线按 30 分钟节流');
});

test('重连成功后 resume 优先：接管成功即解除，绝不撤单', async () => {
  const env = makeEnv({ connected: false });
  env.exchange.reconnectFail = false; // 首次重连即成功
  await env.guard.tick();
  assert.equal(env.exchange.reconnectCalls, 1);
  assert.equal(env.bot.resumeCalls, 1, '连接成功同轮补续跑');
  assert.equal(env.bot.cleanerCalls, 0, '接管成功绝不撤单');
  assert.equal(env.bot.issue, null, '解除后清空卡片告警');
  assert.equal(env.guard.pending.size, 0, '状态机清空');
  assert.equal(env.snap.config.marketId, 7, '按市场名重解析 marketId');
  assert.ok(env.bot.alerts.some((m) => m.includes('已自动补续跑')), '留下成功日志');
});

test('兜底条件：已连接且接管失败，≥3 次尝试且满 10 分钟才撤单（此前不动）', async () => {
  const env = makeEnv({ connected: true, resumeFail: true });
  // t=0 起每 60s 一次；t=540s 时已完成 10 次尝试但仅 9 分钟
  for (let i = 0; i < 10; i++) { await env.guard.tick(); env.advance(60_000); }
  assert.equal(env.bot.cleanerCalls, 0, '未满 10 分钟不撤单（接管严格优先）');
  assert.ok(env.bot.issue && env.bot.issue.message.includes('自动撤单兜底'), '卡片预告兜底规则');
  await env.guard.tick(); // t=600s：满 10 分钟
  assert.equal(env.bot.cleanerCalls, 1, '满 10 分钟且 ≥3 次 -> 撤单');
  assert.equal(env.bot.closeCalls, 0, '永不动仓位');
  assert.equal(env.guard.pending.size, 0, '撤单后解除状态机');
  assert.equal(env.bot.issue, null);
  assert.ok(env.bot.alerts.some((m) => m.includes('仅撤单、仓位未动')), '告警写明只撤单');
});

test('仓位零接触：撤单路径只调 recoverStrayOrders（确认链路在 bot 内），不调 closePosition', async () => {
  const env = makeEnv({ connected: true, resumeFail: true });
  env.advance(0);
  for (let i = 0; i < 12; i++) { await env.guard.tick(); env.advance(60_000); }
  assert.equal(env.bot.cleanerCalls, 1);
  assert.equal(env.bot.closeCalls, 0, '看门狗不得平仓');
});

test('撤单失败：保留接管缺失态并在 5 分钟后重试', async () => {
  const env = makeEnv({ connected: true, resumeFail: true, cleanerFail: true });
  for (let i = 0; i < 11; i++) { await env.guard.tick(); env.advance(60_000); }
  assert.equal(env.bot.cleanerCalls, 1, '首次兜底撤单');
  await env.guard.tick(); env.advance(60_000);
  assert.equal(env.bot.cleanerCalls, 1, '5 分钟内不重复撤单');
  env.advance(5 * 60_000);
  await env.guard.tick();
  assert.equal(env.bot.cleanerCalls, 2, '5 分钟后重试');
  assert.ok(env.guard.pending.has('de'), '撤单未成功期间保持告警态');
});

test('外部解除静默：bot 已运行/快照不再运行 -> 直接清状态不冒功', async () => {
  const env = makeEnv({ connected: true, resumeFail: true });
  await env.guard.tick();
  assert.ok(env.guard.pending.has('de'));
  env.bot.running = true; // 例如用户手动点“重连交易所”成功
  await env.guard.tick();
  assert.equal(env.guard.pending.size, 0);
  assert.equal(env.bot.issue, null);
  assert.equal(env.bot.alerts.length, 0, '外部解除不产生看门狗冒功告警');

  const env2 = makeEnv({ connected: true, resumeFail: true });
  await env2.guard.tick();
  env2.snap = { running: false };
  await env2.guard.tick();
  assert.equal(env2.guard.pending.size, 0, '快照转非运行同样解除');
});

test('重复告警节流：同一 key 由通知总线按 30 分钟冷却窗抑制', async () => {
  const { notifier } = await import('../src/notify.js');
  const orig = notifier.send.bind(notifier);
  const results = [];
  notifier.send = (o) => { const r = orig(o); results.push(r); return r; };
  try {
    const env = makeEnv({ connected: false });
    // 直接用真实总线替换 mock，验证节流链路
    const guard = createResumeGuard({
      bots: { de: env.bot }, exchanges: { de: env.exchange },
      loadSnapshot: () => env.snap, notifier, logger: SILENT, now: env.now,
    });
    await guard.tick();
    await guard.tick();
    assert.equal(results[0], true, '首次告警放行推送');
    assert.equal(results[1], false, '冷却窗内重复被抑制（30 分钟节奏）');
  } finally {
    notifier.send = orig;
  }
});

test('tryResumeBot：市场名缺失时保留原 marketId 仍尝试接管', async () => {
  const calls = [];
  const bot = { async resume(snap) { calls.push(snap.config.marketId); } };
  const exchange = { async getMarkets() { return []; } };
  const snap = { config: { displayName: 'GHOST-USD', marketId: 42 } };
  await tryResumeBot(bot, exchange, snap, 'de', SILENT);
  assert.deepEqual(calls, [42]);
});

(async () => {
  for (const [name, fn] of T) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e?.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
