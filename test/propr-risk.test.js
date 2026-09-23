// Propr Challenge 风控层测试：纯分级计算（UTC 日切/日损/回撤/优先级）+ 动作编排。
import { strict as assert } from 'node:assert';
import { ProprChallengeRisk, STATUS, utcDayStart, nextUtcDayStart, evaluateRisk } from '../src/risk/propr-challenge.js';

const silent = { info() {}, warn() {}, error() {} };

function mkExchange(over = {}) {
  return {
    dataSource: 'real', balance: 5000, highWaterMark: 5000, startingBalance: 5000,
    attemptStatus: 'active', equitySource: 'propr_account', equityFreshAt: Date.now(),
    isEquityStale: () => false,
    ...over,
  };
}

function mkBot() {
  const pauseOpeningCalls = [];
  const stopCalls = [];
  return {
    pauseOpeningCalls, stopCalls,
    pauseOpening(until, reason) { pauseOpeningCalls.push({ until, reason }); },
    async stop(opts) { stopCalls.push(opts); },
  };
}

{
  // UTC 日切边界：00:00:00Z 与 23:59:59Z 必须落在同一天
  const t0 = Date.UTC(2026, 8, 23, 0, 0, 0);
  const t1 = Date.UTC(2026, 8, 23, 23, 59, 59);
  assert.equal(utcDayStart(t0), t0);
  assert.equal(utcDayStart(t1), t0);
  assert.equal(nextUtcDayStart(t1), t0 + 24 * 3600_000);
  // 本地时间无关：同一时刻不同表示应一致
  assert.equal(utcDayStart(t1), utcDayStart(new Date(t1).getTime()));
}

{
  // 分级计算
  const base = { balance: 5000, startOfDayBalance: 5000, highWaterMark: 5000, internalDailyStopPct: 0.01, internalMaxDrawdownPct: 0.03 };
  assert.equal(evaluateRisk(base).status, STATUS.OK);

  assert.equal(evaluateRisk({ ...base, balance: 5000 * 0.995 }).status, STATUS.WARNING, '日损 0.5% = 内部线一半 → 预警');
  assert.equal(evaluateRisk({ ...base, balance: 5000 * 0.99 }).status, STATUS.REDUCE_ONLY, '日损 1% → 仅减仓');
  assert.equal(evaluateRisk({ ...base, balance: 5000 * 0.97 }).status, STATUS.HALT, '回撤 3% → 停机');

  // 优先级：回撤停机优先于日损减仓（同时触发时取更严）
  const both = evaluateRisk({ ...base, balance: 5000 * 0.96, startOfDayBalance: 5000 });
  assert.equal(both.status, STATUS.HALT);

  // 权益不可用 → LOCKED
  assert.equal(evaluateRisk({ ...base, equityUsable: false }).status, STATUS.LOCKED);
  assert.equal(evaluateRisk({ ...base, highWaterMark: 0 }).status, STATUS.LOCKED);

  // 挑战失效优先级最高
  assert.equal(evaluateRisk({ ...base, attemptStatus: 'failed' }).status, STATUS.BREACHED);
  assert.equal(evaluateRisk({ ...base, equityUsable: false, attemptStatus: 'passed' }).status, STATUS.BREACHED);

  // 百分比符号约定：负数=亏损
  const r = evaluateRisk({ ...base, balance: 4900 });
  assert.ok(r.dailyLossPct < 0 && r.drawdownPct < 0);
}

async function main() {
  {
    const ex = mkExchange();
    const bot = mkBot();
    const alerts = [];
    const risk = new ProprChallengeRisk({
      exchange: ex, bot, logger: silent,
      notifier: { send: (m) => alerts.push(m) },
      cfg: { internalDailyStopPct: 0.01, internalMaxDrawdownPct: 0.03, riskPollMs: 60000 },
    });

    // OK
    await risk.tick();
    assert.equal(risk.getState().status, 'OK');
    assert.equal(ex.riskState.status, 'OK', '状态必须写入 exchange.riskState 供面板');
    assert.equal(bot.pauseOpeningCalls.length, 0);

    // 日损 0.5% → WARNING（只告警不动手）
    ex.balance = 5000 * 0.995;
    await risk.tick();
    assert.equal(risk.getState().status, 'WARNING');
    assert.equal(bot.pauseOpeningCalls.length, 0, '预警不得暂停开仓');
    assert.ok(alerts.some((a) => a.level === 'warn'));

    // 日损 1% → REDUCE_ONLY：暂停开仓至 UTC 日切
    ex.balance = 5000 * 0.99;
    await risk.tick();
    assert.equal(risk.getState().status, 'REDUCE_ONLY');
    assert.equal(bot.pauseOpeningCalls.length, 1);
    assert.ok(bot.pauseOpeningCalls[0].until >= nextUtcDayStart() - 1000, '暂停应到 UTC 日切');

    // 回撤 3% → HALT：撤单+平仓+停机
    ex.balance = 5000 * 0.97;
    await risk.tick();
    assert.equal(risk.getState().status, 'HALT');
    assert.deepEqual(bot.stopCalls.at(-1), { closePosition: true });

    // 使用率必须封顶 100%
    assert.equal(risk.getState().drawdownUsage, 1);

    // 挑战失效 → BREACHED：停机但不平仓（平台账户可能已冻结）
    ex.attemptStatus = 'failed';
    await risk.tick();
    assert.equal(risk.getState().status, 'BREACHED');
    assert.deepEqual(bot.stopCalls.at(-1), { closePosition: false });

    // 权益过期 → LOCKED：暂停开仓但不平仓
    ex.attemptStatus = 'active';
    ex.balance = 5000;
    ex.highWaterMark = 5000;
    ex.isEquityStale = () => true;
    await risk.tick();
    assert.equal(risk.getState().status, 'LOCKED');
    assert.ok(bot.pauseOpeningCalls.length >= 2, 'LOCKED 必须暂停开仓');

    // UTC 日切：日初权益重置为当前权益
    ex.isEquityStale = () => false;
    ex.balance = 4900;
    ex.highWaterMark = 4900; // 同时下调高水位，隔离"回撤预警"干扰，只验证日切
    risk._dayKey = String(utcDayStart() - 24 * 3600_000); // 伪造"昨天"
    await risk.tick();
    assert.equal(risk.startOfDayBalance, 4900, '日切后日初权益必须重置为当前权益');
    assert.equal(risk.getState().status, 'OK', '重置后日损/回撤均归零 → 恢复正常');

    risk.stop();
  }

  {
    // 未连接/离线：tick 直接返回，不产生动作
    const ex = mkExchange({ dataSource: null });
    const bot = mkBot();
    const risk = new ProprChallengeRisk({ exchange: ex, bot, logger: silent, cfg: { riskPollMs: 60000 } });
    assert.equal(await risk.tick(), null);
    assert.equal(bot.stopCalls.length, 0);
    risk.stop();
  }
}

main().then(() => console.log('propr-risk.test.js 全部通过')).catch((err) => { console.error(err); process.exit(1); });
