// Propr Challenge 风控层测试：纯分级计算（UTC 日切/日损/回撤/优先级/权益口径）+ 动作编排与失败可见性。
import { strict as assert } from 'node:assert';
import { ProprChallengeRisk, STATUS, utcDayStart, nextUtcDayStart, evaluateRisk } from '../src/risk/propr-challenge.js';

const silent = { info() {}, warn() {}, error() {} };

function mkExchange(over = {}) {
  return {
    dataSource: 'real', balance: 5000, equity: 5000, highWaterMark: 5000, startingBalance: 5000,
    attemptStatus: 'active', equitySource: 'propr_account', equityFreshAt: Date.now(),
    isEquityStale: () => false,
    ...over,
  };
}

function mkBot() {
  const pauseOpeningCalls = [];
  const resumeOpeningCalls = [];
  const stopCalls = [];
  let failStopTimes = 0;
  return {
    pauseOpeningCalls, resumeOpeningCalls, stopCalls,
    failStopFor(n) { failStopTimes = n; },
    pauseOpening(until, reason) { pauseOpeningCalls.push({ until, reason }); },
    resumeOpening(reason) { resumeOpeningCalls.push({ reason }); },
    async stop(opts) {
      if (failStopTimes > 0) { failStopTimes -= 1; throw new Error('stop 失败（模拟）'); }
      stopCalls.push(opts);
    },
  };
}

{
  // UTC 日切边界：00:00:00Z 与 23:59:59Z 必须落在同一天
  const t0 = Date.UTC(2026, 8, 23, 0, 0, 0);
  const t1 = Date.UTC(2026, 8, 23, 23, 59, 59);
  assert.equal(utcDayStart(t0), t0);
  assert.equal(utcDayStart(t1), t0);
  assert.equal(nextUtcDayStart(t1), t0 + 24 * 3600_000);
}

{
  // 分级计算（权益口径）
  const base = { equity: 5000, startOfDayEquity: 5000, highWaterMark: 5000, internalDailyStopPct: 0.01, internalMaxDrawdownPct: 0.03 };
  assert.equal(evaluateRisk(base).status, STATUS.OK);

  assert.equal(evaluateRisk({ ...base, equity: 5000 * 0.995 }).status, STATUS.WARNING, '日损 0.5% = 内部线一半 → 预警');
  assert.equal(evaluateRisk({ ...base, equity: 5000 * 0.99 }).status, STATUS.REDUCE_ONLY, '日损 1% → 仅减仓');
  assert.equal(evaluateRisk({ ...base, equity: 5000 * 0.97 }).status, STATUS.HALT, '回撤 3% → 停机');

  // 未实现亏损（balance 不变但 equity 下降）必须触发风控
  assert.equal(
    evaluateRisk({ ...base, equity: 4900 }).status,
    STATUS.REDUCE_ONLY,
    'balance 5000 / equity 4900（未实现亏损）→ 日损 2% 必须触发仅减仓',
  );

  // 优先级：回撤停机优先于日损减仓
  assert.equal(evaluateRisk({ ...base, equity: 5000 * 0.96 }).status, STATUS.HALT);

  // 权益不可用 → LOCKED
  assert.equal(evaluateRisk({ ...base, equityUsable: false }).status, STATUS.LOCKED);
  assert.equal(evaluateRisk({ ...base, highWaterMark: 0 }).status, STATUS.LOCKED);

  // 挑战失效优先级最高
  assert.equal(evaluateRisk({ ...base, attemptStatus: 'failed' }).status, STATUS.BREACHED);
  assert.equal(evaluateRisk({ ...base, equityUsable: false, attemptStatus: 'passed' }).status, STATUS.BREACHED);

  const r = evaluateRisk({ ...base, equity: 4900 });
  assert.ok(r.dailyLossPct < 0 && r.drawdownPct < 0, '百分比约定：负数=亏损');
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
    assert.equal(ex.riskState.status, 'OK', '状态必须写入 exchange.riskState 供适配器硬拦截');
    assert.equal(bot.pauseOpeningCalls.length, 0);
    assert.equal(risk.getState().currentEquity, 5000);
    assert.equal(risk.getState().startOfDayEquity, 5000);

    // 未实现亏损：balance 不变、equity 下降 → 日损 2% → REDUCE_ONLY
    ex.equity = 4900;
    await risk.tick();
    assert.equal(risk.getState().status, 'REDUCE_ONLY', '风控必须随权益（含未实现盈亏）下降触发');
    assert.equal(bot.pauseOpeningCalls.length, 1);
    assert.ok(bot.pauseOpeningCalls[0].until >= nextUtcDayStart() - 1000, '暂停应到 UTC 日切');

    // 恢复 → OK：必须显式解除风控暂停（避免残留到 24h/日切）
    ex.equity = 5000;
    await risk.tick();
    assert.equal(risk.getState().status, 'OK');
    assert.equal(bot.resumeOpeningCalls.length, 1, 'LOCKED/REDUCE_ONLY 恢复必须解除暂停');
    assert.equal(bot.resumeOpeningCalls[0].reason, 'Propr 风控恢复正常');

    // 回撤 3% → HALT：撤单+平仓+停机
    ex.equity = 5000 * 0.97;
    await risk.tick();
    assert.equal(risk.getState().status, 'HALT');
    assert.deepEqual(bot.stopCalls.at(-1), { closePosition: true });
    assert.equal(risk.getState().drawdownUsage, 1, '使用率必须封顶 100%');

    // 动作失败不静默：stop 抛错 → actionError + critical 通知；下一轮重试成功后清除
    ex.equity = 5000;
    await risk.tick(); // 回 OK
    assert.equal(risk.actionError, null);
    const stopBefore = bot.stopCalls.length;
    bot.failStopFor(1);
    ex.equity = 5000 * 0.97;
    await risk.tick();
    assert.ok(risk.actionError, '动作失败必须记录 actionError');
    assert.ok(alerts.some((a) => a.key === 'propr:risk:action-failed' && a.level === 'critical'), '动作失败必须 critical 通知');
    assert.equal(ex.riskState.actionError, risk.actionError, 'actionError 必须透出到面板');
    assert.equal(bot.stopCalls.length, stopBefore, '失败时不得记为成功');
    await risk.tick(); // 重试成功
    assert.equal(risk.actionError, null, '重试成功后必须清除 actionError');
    assert.equal(bot.stopCalls.length, stopBefore + 1, '重试成功后应记录一次停机');

    // 挑战失效 → BREACHED：停机但不平仓
    ex.equity = 5000;
    ex.attemptStatus = 'failed';
    await risk.tick();
    assert.equal(risk.getState().status, 'BREACHED');
    assert.deepEqual(bot.stopCalls.at(-1), { closePosition: false });

    // 权益过期 → LOCKED
    ex.attemptStatus = 'active';
    ex.isEquityStale = () => true;
    await risk.tick();
    assert.equal(risk.getState().status, 'LOCKED');

    // UTC 日切：日初权益重置为当前权益
    ex.isEquityStale = () => false;
    ex.equity = 4900;
    ex.highWaterMark = 4900;
    risk._dayKey = String(utcDayStart() - 24 * 3600_000);
    await risk.tick();
    assert.equal(risk.startOfDayEquity, 4900, '日切后日初权益必须重置为当前权益');
    assert.equal(risk.getState().status, 'OK', '重置后日损/回撤归零 → 恢复正常');

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
