// VA 核账单测：FIFO 重建、_dynLog 回填、动态汇总、异常判定、报告组装、编排。
import { strict as assert } from 'node:assert';
import {
  fifoRealized, backfillDynLog, summarizeDynamic, detectAnomalies,
  buildReport, formatReportText, runVaAudit, tsMs, round2,
} from '../src/audit.js';

const HOUR = 3600_000;
const now = Date.now();

// ── ① FIFO 毛实现盈亏 ───────────────────────────────────────────────────────
{
  // 多头一进一出：买1@100 卖1@110 → +10
  let r = fifoRealized([{ side: 'buy', price: 100, qty: 1, ts: 1 }, { side: 'sell', price: 110, qty: 1, ts: 2 }]);
  assert.equal(r.realized, 10); assert.equal(r.openQty, 0); assert.equal(r.notional, 210);

  // 空头一进一出：卖1@100 买1@90 → +10
  r = fifoRealized([{ side: 'sell', price: 100, qty: 1, ts: 1 }, { side: 'buy', price: 90, qty: 1, ts: 2 }]);
  assert.equal(r.realized, 10); assert.equal(r.openQty, 0);

  // 部分平仓：买2@100 卖1@110 → +10，仍持多 1
  r = fifoRealized([{ side: 'buy', price: 100, qty: 2, ts: 1 }, { side: 'sell', price: 110, qty: 1, ts: 2 }]);
  assert.equal(r.realized, 10); assert.equal(r.openQty, 1); assert.equal(r.closedQty, 1);

  // 反手：买1@100 卖2@110 → 平多1(+10) 再开空1@110
  r = fifoRealized([{ side: 'buy', price: 100, qty: 1, ts: 1 }, { side: 'sell', price: 110, qty: 2, ts: 2 }]);
  assert.equal(r.realized, 10); assert.equal(r.openQty, -1);

  // 乱序输入按 ts 排序后计算（结果与顺序无关）
  r = fifoRealized([{ side: 'sell', price: 110, qty: 1, ts: 2 }, { side: 'buy', price: 100, qty: 1, ts: 1 }]);
  assert.equal(r.realized, 10);

  // 脏数据（0 量 / 非数价）跳过，不炸
  r = fifoRealized([{ side: 'buy', price: 100, qty: 0, ts: 1 }, { side: 'sell', price: 'x', qty: 1, ts: 2 }]);
  assert.equal(r.realized, 0); assert.equal(r.openQty, 0);
}

// tsMs：ISO / 秒 / 毫秒 / 空
assert.ok(tsMs('2026-09-15T00:00:00Z') > 1e12);
assert.equal(tsMs(1_700_000_000), 1_700_000_000_000, '秒级补齐到毫秒');
assert.equal(tsMs(1_700_000_000_000), 1_700_000_000_000);
assert.equal(tsMs(null), 0);

// ── ② _dynLog 回填 ─────────────────────────────────────────────────────────
{
  const dynLog = [
    { t: now - 73 * HOUR, branch: 'A', shadow: false, before: { gridProfit: 5, completedRungs: 2 }, pnlAfter: null, rungsAfter: null },
    { t: now - 49 * HOUR, branch: 'B', shadow: false, before: { gridProfit: 8, completedRungs: 3 }, pnlAfter: null, rungsAfter: null },
    { t: now - 50 * HOUR, branch: 'A', shadow: true, before: { gridProfit: 1, completedRungs: 0 }, pnlAfter: null, rungsAfter: null }, // A 未满 72h
    { t: now - 99 * HOUR, branch: 'A', shadow: false, before: { gridProfit: 0, completedRungs: 0 }, pnlAfter: 3, rungsAfter: 1 },        // 已回填
  ];
  const filled = backfillDynLog(dynLog, { now, gridProfitNow: 20, completedRungsNow: 10 });
  assert.equal(filled, 2, '只有成熟且未回填的两条被回填');
  assert.equal(dynLog[0].pnlAfter, 15); assert.equal(dynLog[0].rungsAfter, 8);
  assert.equal(dynLog[1].pnlAfter, 12); assert.equal(dynLog[1].rungsAfter, 7);
  assert.equal(dynLog[2].pnlAfter, null, 'A 分支未满 72h 不回填');
  assert.equal(dynLog[3].pnlAfter, 3, '已回填的不动');
}

// ── ③ 动态汇总 ─────────────────────────────────────────────────────────────
{
  const dynLog = [
    { branch: 'A', shadow: true, pnlAfter: 4, rungsAfter: 2 },
    { branch: 'A', shadow: false, pnlAfter: -1, rungsAfter: 1 },
    { branch: 'B', shadow: false, pnlAfter: null },  // 待回填
    { branch: 'B', shadow: true, pnlAfter: 6, rungsAfter: 3 },
  ];
  const s = summarizeDynamic(dynLog, { inventory: 2, calm: 1 });
  assert.equal(s.total, 4); assert.equal(s.shadow, 2); assert.equal(s.live, 2); assert.equal(s.pending, 1);
  assert.equal(s.A.count, 2); assert.equal(s.A.filled, 2); assert.equal(s.A.netPnl, 3); assert.equal(s.A.rungs, 3);
  assert.equal(s.B.count, 2); assert.equal(s.B.filled, 1); assert.equal(s.B.netPnl, 6);
  assert.equal(s.gateBlocked.inventory, 2); assert.equal(s.gateBlocked.calm, 1); assert.equal(s.gateBlocked.cooldown, 0);
}

// ── ④ 异常判定 ─────────────────────────────────────────────────────────────
{
  const base = { counters: { rejectedOrders: 0, droppedLevels: 0, lateFills: 0 } };
  // 空洞新增 → critical
  let rep = { counters: { rejectedOrders: 0, droppedLevels: 2, lateFills: 0 }, dynamic: { A: { netPnl: 0, filled: 0 }, B: { netPnl: 0, filled: 0 }, live: 0 }, pnl: { fifoRealized: 0, exchangeRpnl: null } };
  assert.equal(detectAnomalies(rep, base).level, 'critical');
  // 拒单激增 → warn
  rep = { counters: { rejectedOrders: 6, droppedLevels: 0, lateFills: 0 }, dynamic: { A: { netPnl: 0, filled: 0 }, B: { netPnl: 0, filled: 0 }, live: 0 }, pnl: { fifoRealized: 0, exchangeRpnl: null } };
  assert.equal(detectAnomalies(rep, base).level, 'warn');
  // 实盘动态净格利为负 → warn
  rep = { counters: { rejectedOrders: 0, droppedLevels: 0, lateFills: 0 }, dynamic: { A: { netPnl: -2, filled: 1 }, B: { netPnl: 0, filled: 0 }, live: 1 }, pnl: { fifoRealized: 0, exchangeRpnl: null } };
  assert.equal(detectAnomalies(rep, base).level, 'warn');
  // rpnl 背离 → warn
  rep = { counters: { rejectedOrders: 0, droppedLevels: 0, lateFills: 0 }, dynamic: { A: { netPnl: 0, filled: 0 }, B: { netPnl: 0, filled: 0 }, live: 0 }, pnl: { fifoRealized: 10, exchangeRpnl: 2 } };
  assert.equal(detectAnomalies(rep, base).level, 'warn');
  // 干净 → info
  rep = { counters: { rejectedOrders: 0, droppedLevels: 0, lateFills: 0 }, dynamic: { A: { netPnl: 3, filled: 1 }, B: { netPnl: 0, filled: 0 }, live: 1 }, pnl: { fifoRealized: 5, exchangeRpnl: 5 } };
  assert.equal(detectAnomalies(rep, base).level, 'info');
  assert.equal(detectAnomalies(rep, base).reasons.length, 0);
}

// ── ⑤ 报告组装 + 文案 ───────────────────────────────────────────────────────
{
  const trades = [{ side: 'buy', price: 100, qty: 1, ts: now - 2 * HOUR }, { side: 'sell', price: 110, qty: 1, ts: now - HOUR }];
  const rep = buildReport({
    trades, position: { realizedPnl: 9.8, cumFunding: -0.3 },
    counters: { rejectedOrders: 3, droppedLevels: 0, lateFills: 1 },
    dynLog: [{ branch: 'A', shadow: false, pnlAfter: 4, rungsAfter: 2 }],
    gateBlocked: { inventory: 1 }, feeRate: 0.0001, windowMs: 24 * HOUR, now,
    baseline: { counters: { rejectedOrders: 1, droppedLevels: 0, lateFills: 0 } },
  });
  assert.equal(rep.pnl.fifoRealized, 10);
  assert.equal(rep.pnl.estFees, round2(210 * 0.0001));
  assert.equal(rep.pnl.netEst, round2(10 - 210 * 0.0001));
  assert.equal(rep.pnl.exchangeRpnl, 9.8);
  assert.equal(rep.pnl.cumFunding, -0.3);
  assert.equal(rep.delta.rejectedOrders, 2, '较基线拒单 +2');
  assert.equal(rep.trades, 2);
  assert.equal(rep.anomalies.level, 'info', 'rpnl 与 FIFO 接近、无空洞 → info');
  assert.ok(formatReportText(rep).includes('VA 核账'));
}

// ── ⑥ 编排 runVaAudit：回填 + 报告（用注入的假所/假 bot，不碰网络）──────────
{
  const dynLog = [{ t: now - 80 * HOUR, branch: 'A', shadow: false, before: { gridProfit: 2, completedRungs: 1 }, pnlAfter: null, rungsAfter: null }];
  const bot = { config: { marketId: 1 }, stats: { gridProfit: 12, completedRungs: 6 }, _dynLog: dynLog, _dynGateBlocked: { inventory: 0, calm: 0, cooldown: 0 } };
  const exchange = {
    mode: 'live', feeRate: 0.0001, rejectedOrders: 0, droppedLevels: 0, lateFills: 0,
    getPosition: () => ({ realizedPnl: 10, cumFunding: 0 }),
    async fetchTradesWindow() { return [{ side: 'buy', price: 100, qty: 1, ts: now - 3 * HOUR }, { side: 'sell', price: 110, qty: 1, ts: now - 2 * HOUR }]; },
  };
  const rep = await runVaAudit({ bot, exchange, source: 'va', persistKey: 'va-audit-test' });
  assert.equal(rep.backfilled, 1, '成熟动作被回填');
  assert.equal(dynLog[0].pnlAfter, 10, 'pnlAfter = 12 - 2');
  assert.equal(dynLog[0].rungsAfter, 5, 'rungsAfter = 6 - 1');
  assert.equal(rep.pnl.fifoRealized, 10);
  assert.equal(rep.trades, 2);
}

console.log('✓ audit.test.js 全部通过');
