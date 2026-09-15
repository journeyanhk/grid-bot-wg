// VA 核账单测：FIFO 全窗+realizedAt、_dynLog 回填、动态汇总、异常判定、报告组装、编排。
import { strict as assert } from 'node:assert';
import {
  fifoRealized, realizedSince, backfillDynLog, summarizeDynamic, detectAnomalies,
  buildReport, formatReportText, runVaAudit, tsMs,
} from '../src/audit.js';

const HOUR = 3600_000;
const now = Date.now();

// ── ① FIFO：realized + 每笔平仓事件 closes（带 ts）+ 净持仓 ────────────────────
{
  // 多头一进一出：买1@100 卖1@110 → +10，一次平仓事件
  let r = fifoRealized([{ side: 'buy', price: 100, qty: 1, ts: 1 }, { side: 'sell', price: 110, qty: 1, ts: 2 }]);
  assert.equal(r.realized, 10); assert.equal(r.openQty, 0); assert.equal(r.notional, 210);
  assert.equal(r.closes.length, 1); assert.equal(r.closes[0].pnl, 10); assert.equal(r.closes[0].ts, 2);

  // 空头一进一出：卖1@100 买1@90 → +10
  r = fifoRealized([{ side: 'sell', price: 100, qty: 1, ts: 1 }, { side: 'buy', price: 90, qty: 1, ts: 2 }]);
  assert.equal(r.realized, 10); assert.equal(r.openQty, 0);

  // 部分平仓 + 反手
  r = fifoRealized([{ side: 'buy', price: 100, qty: 1, ts: 1 }, { side: 'sell', price: 110, qty: 2, ts: 2 }]);
  assert.equal(r.realized, 10); assert.equal(r.openQty, -1);

  // 乱序输入按 ts 排序
  r = fifoRealized([{ side: 'sell', price: 110, qty: 1, ts: 2 }, { side: 'buy', price: 100, qty: 1, ts: 1 }]);
  assert.equal(r.realized, 10);

  // 关键口径：窗口开头带入的旧库存不被当成新开反向仓。
  // 96h 前买入 1@100，窗口内(近1h)卖出 1@110 → 平仓事件 ts 在窗口内，realizedSince 计入 +10。
  const trades = [{ side: 'buy', price: 100, qty: 1, ts: now - 90 * HOUR }, { side: 'sell', price: 110, qty: 1, ts: now - 0.5 * HOUR }];
  r = fifoRealized(trades);
  assert.equal(r.realized, 10, 'FIFO 全窗把开仓正确配对，而非把卖当新开空');
  assert.equal(realizedSince(r.closes, now - HOUR), 10, '平仓事件落在近1h窗口内 → 计入');
  assert.equal(realizedSince(r.closes, now - 0.1 * HOUR), 0, '窗口更窄(6min)则不计入');
}

// tsMs：ISO / 秒 / 毫秒 / 空
assert.ok(tsMs('2026-09-15T00:00:00Z') > 1e12);
assert.equal(tsMs(1_700_000_000), 1_700_000_000_000, '秒级补齐到毫秒');
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
  assert.equal(filled, 2);
  assert.equal(dynLog[0].pnlAfter, 15); assert.equal(dynLog[0].rungsAfter, 8);
  assert.equal(dynLog[1].pnlAfter, 12); assert.equal(dynLog[1].rungsAfter, 7);
  assert.equal(dynLog[2].pnlAfter, null, 'A 分支未满 72h 不回填');
  assert.equal(dynLog[3].pnlAfter, 3, '已回填的不动');
}

// ── ③ 动态汇总 ─────────────────────────────────────────────────────────────
{
  const s = summarizeDynamic([
    { branch: 'A', shadow: true, pnlAfter: 4, rungsAfter: 2 },
    { branch: 'A', shadow: false, pnlAfter: -1, rungsAfter: 1 },
    { branch: 'B', shadow: false, pnlAfter: null },
    { branch: 'B', shadow: true, pnlAfter: 6, rungsAfter: 3 },
  ], { inventory: 2, calm: 1 });
  assert.equal(s.total, 4); assert.equal(s.shadow, 2); assert.equal(s.live, 2); assert.equal(s.pending, 1);
  assert.equal(s.A.netPnl, 3); assert.equal(s.B.netPnl, 6);
  assert.equal(s.gateBlocked.inventory, 2); assert.equal(s.gateBlocked.cooldown, 0);
}

// ── ④ 异常判定 ─────────────────────────────────────────────────────────────
{
  const base = { counters: { rejectedOrders: 0, droppedLevels: 0, lateFills: 0 }, fills: 0 };
  const clean = { A: { netPnl: 0, filled: 0 }, B: { netPnl: 0, filled: 0 }, live: 0 };
  // 空洞新增 → critical
  assert.equal(detectAnomalies({ counters: { rejectedOrders: 0, droppedLevels: 2, lateFills: 0 }, dynamic: clean, reconcile: null }, base).level, 'critical');
  // 拒单激增 → warn
  assert.equal(detectAnomalies({ counters: { rejectedOrders: 6, droppedLevels: 0, lateFills: 0 }, dynamic: clean, reconcile: null }, base).level, 'warn');
  // 笔数不一致 → warn（取代旧的 rpnl 背离）
  assert.equal(detectAnomalies({ counters: { rejectedOrders: 0, droppedLevels: 0, lateFills: 0 }, dynamic: clean, reconcile: { botFills: 5, exchangeTrades: 3, match: false } }, base).level, 'warn');
  // 实盘动态净格利为负 → warn
  assert.equal(detectAnomalies({ counters: { rejectedOrders: 0, droppedLevels: 0, lateFills: 0 }, dynamic: { A: { netPnl: -2, filled: 1 }, B: { netPnl: 0, filled: 0 }, live: 1 }, reconcile: null }, base).level, 'warn');
  // 截断 → warn note
  assert.equal(detectAnomalies({ counters: { rejectedOrders: 0, droppedLevels: 0, lateFills: 0 }, dynamic: clean, reconcile: null, truncated: true }, base).level, 'warn');
  // 干净 → info
  const ok = detectAnomalies({ counters: { rejectedOrders: 0, droppedLevels: 0, lateFills: 0 }, dynamic: clean, reconcile: { botFills: 3, exchangeTrades: 3, match: true } }, base);
  assert.equal(ok.level, 'info'); assert.equal(ok.reasons.length, 0);
}

// ── ⑤ 报告组装：全窗 FIFO + 窗口锚定 + 笔数核对 + 无手续费重复计费 ─────────────
{
  const allTrades = [
    { side: 'buy', price: 100, qty: 1, ts: now - 90 * HOUR },   // 窗口外开仓（带入 FIFO）
    { side: 'sell', price: 110, qty: 1, ts: now - 2 * HOUR },   // 窗口内平仓 → +10
  ];
  const baseline = { at: now - 24 * HOUR, counters: { rejectedOrders: 1, droppedLevels: 0, lateFills: 0 }, fills: 4 };
  const rep = buildReport({
    allTrades, windowSinceMs: baseline.at, position: { cumFunding: -0.3 },
    counters: { rejectedOrders: 3, droppedLevels: 0, lateFills: 1 }, botFills: 5,
    dynLog: [{ branch: 'A', shadow: false, pnlAfter: 4, rungsAfter: 2 }], gateBlocked: { inventory: 1 },
    now, baseline,
  });
  assert.equal(rep.pnl.realized, 10, '窗口内平仓 +10，含点差即净额');
  assert.equal(rep.pnl.notional, 110, '名义额只统计窗口内成交（1×110）');
  assert.equal('estFees' in rep.pnl, false, '不再有手续费字段（Omni 零费）');
  assert.equal(rep.pnl.cumFunding, -0.3);
  assert.equal(rep.trades, 1, '窗口内成交 1 笔');
  assert.equal(rep.reconcile.botFills, 1, 'bot 笔数增量 = 5 − 4');
  assert.equal(rep.reconcile.exchangeTrades, 1);
  assert.equal(rep.reconcile.match, true);
  assert.equal(rep.delta.rejectedOrders, 2);
  assert.equal(rep.anomalies.level, 'info');
  assert.ok(formatReportText(rep).includes('VA 核账'));

  // 笔数不一致 → warn
  const rep2 = buildReport({ allTrades, windowSinceMs: baseline.at, counters: {}, botFills: 8, now, baseline });
  assert.equal(rep2.reconcile.botFills, 4); assert.equal(rep2.reconcile.exchangeTrades, 1);
  assert.equal(rep2.anomalies.level, 'warn');
}

// ── ⑥ 编排 runVaAudit：回填 + 窗口锚定 + 笔数核对（注入假所/假 bot）───────────
{
  const dynLog = [{ t: now - 80 * HOUR, branch: 'A', shadow: false, before: { gridProfit: 2, completedRungs: 1 }, pnlAfter: null, rungsAfter: null }];
  const bot = { config: { marketId: 1 }, stats: { gridProfit: 12, completedRungs: 6, buys: 3, sells: 3 }, _dynLog: dynLog, _dynGateBlocked: { inventory: 0, calm: 0, cooldown: 0 } };
  const exchange = {
    mode: 'live', feeRate: 0.0001, rejectedOrders: 0, droppedLevels: 0, lateFills: 0,
    getPosition: () => ({ cumFunding: 0 }),
    async fetchTradesWindow() {
      return { trades: [{ side: 'buy', price: 100, qty: 1, ts: now - 3 * HOUR }, { side: 'sell', price: 110, qty: 1, ts: now - 2 * HOUR }], truncated: false };
    },
  };
  const rep = await runVaAudit({ bot, exchange, source: 'va', persistKey: 'va-audit-test', now });
  assert.equal(rep.backfilled, 1);
  assert.equal(dynLog[0].pnlAfter, 10, 'pnlAfter = 12 − 2');
  assert.equal(rep.pnl.realized, 10);
  assert.equal(rep.trades, 2, '首次无基线 → 窗口默认 24h，两笔都在内');
  assert.equal(rep.reconcile, null, '首次无基线不做笔数核对');

  // 第二次：应读到上次写的基线（at/fills），做笔数核对
  const rep2 = await runVaAudit({ bot, exchange, source: 'va', persistKey: 'va-audit-test', now: now + HOUR });
  assert.ok(rep2.reconcile, '第二次有基线 → 出笔数核对');
}

console.log('✓ audit.test.js 全部通过');
