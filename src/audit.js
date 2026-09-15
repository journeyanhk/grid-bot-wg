// VA 核账（对账）—— 仅 Variational，一日一次。
//
// 目的：给「动态网格是否值得毕业」和「无人值守是否在悄悄亏」提供可评审的数据。
// 三条主线：
//   1) 用 /api/trades 拉窗口内成交，FIFO 重建【毛实现盈亏】，配手续费估算得净额；
//      与交易所 rpnl / bot.stats.gridProfit 交叉核对，背离即报警。
//   2) 计数器盘点：rejectedOrders / droppedLevels / lateFills，与昨日基线比出增量。
//   3) 回填 _dynLog：对已成熟（漂移 A 满 72h、破界重启 B 满 48h）且未回填的动作，
//      用当前累计 stats 算出动作后的格利/完成格增量，写回快照——两周评审的唯一数据源。
//
// 设计原则：纯函数可单测（FIFO / 回填 / 异常判定 / 文案），编排层只做取数与落盘。
// 无网络依赖的部分全部导出，server 只调 runVaAudit + 定时器。
import { notifier } from './notify.js';
import { loadSnapshot, saveSnapshot } from './persist.js';
import { logger } from './log.js';

const HOUR = 3600_000;
const MATURE_A_MS = 72 * HOUR;   // 漂移重心：3 日后回填
const MATURE_B_MS = 48 * HOUR;   // 破界重启：2 日后回填
const AUDIT_KEY = 'va-audit';    // 计数器基线独立落在 .state.json 的这个键下

export function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }

/** 把 created_at（ISO 串或 epoch 毫秒/秒）统一成毫秒。无法解析→0。 */
export function tsMs(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000; // 秒级补齐
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
}

/**
 * FIFO 逐笔重建【毛】实现盈亏（不含手续费/资金费）。
 * trades: [{ side:'buy'|'sell', price, qty, ts }]，内部按 ts 升序。
 * 返回 { realized, closedQty, openQty, notional }：
 *   realized  已平仓部分的毛盈亏；closedQty 平掉的基础量；
 *   openQty   剩余净持仓（多正空负）；notional 成交名义额之和（估手续费用）。
 */
export function fifoRealized(trades) {
  const lots = [];            // 每档 { qty>0, price, dir:+1 多 / -1 空 }
  let realized = 0, closedQty = 0, notional = 0;
  const sorted = [...(trades || [])].sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
  for (const t of sorted) {
    const dir = String(t.side).toLowerCase() === 'buy' ? 1 : -1;
    let qty = Math.abs(Number(t.qty) || 0);
    const price = Number(t.price);
    if (!(qty > 0) || !Number.isFinite(price)) continue;
    notional += price * qty;
    // 先用当前成交去平掉方向相反的最老仓位（FIFO）
    while (qty > 1e-12 && lots.length && lots[0].dir === -dir) {
      const lot = lots[0];
      const m = Math.min(qty, lot.qty);
      realized += lot.dir === 1 ? (price - lot.price) * m : (lot.price - price) * m;
      lot.qty -= m; qty -= m; closedQty += m;
      if (lot.qty <= 1e-12) lots.shift();
    }
    if (qty > 1e-12) lots.push({ qty, price, dir });
  }
  const openQty = lots.reduce((s, l) => s + l.dir * l.qty, 0);
  return { realized: round2(realized), closedQty: round2(closedQty), openQty: round2(openQty), notional: round2(notional) };
}

/**
 * 回填 _dynLog：就地把已成熟、未回填的动作补上 pnlAfter / rungsAfter。
 * pnlAfter  = 当前累计 gridProfit − 动作时 before.gridProfit（≈动作后到今天的格利）
 * rungsAfter= 当前累计 completedRungs − 动作时 before.completedRungs
 * realizedAtAction 暂不回填（需在 before 里预留 realized 快照，见评审说明），保持原值。
 * 返回回填的条数。
 */
export function backfillDynLog(dynLog, { now, gridProfitNow, completedRungsNow }) {
  if (!Array.isArray(dynLog)) return 0;
  let filled = 0;
  for (const e of dynLog) {
    if (!e || e.pnlAfter != null) continue;                 // 只回填一次
    const mature = e.branch === 'B' ? MATURE_B_MS : MATURE_A_MS;
    if (now - (Number(e.t) || 0) < mature) continue;        // 未到成熟窗口
    const beforeProfit = e.before?.gridProfit ?? 0;
    const beforeRungs = e.before?.completedRungs ?? 0;
    e.pnlAfter = round2((gridProfitNow ?? 0) - beforeProfit);
    e.rungsAfter = (completedRungsNow ?? 0) - beforeRungs;
    filled++;
  }
  return filled;
}

/** 汇总 _dynLog：按分支统计动作数、已回填净格利、待回填数、影子/实盘占比。 */
export function summarizeDynamic(dynLog, gateBlocked) {
  const out = {
    total: 0, shadow: 0, live: 0, pending: 0,
    A: { count: 0, filled: 0, netPnl: 0, rungs: 0 },
    B: { count: 0, filled: 0, netPnl: 0, rungs: 0 },
    gateBlocked: { inventory: 0, calm: 0, cooldown: 0, ...(gateBlocked || {}) },
  };
  for (const e of dynLog || []) {
    if (!e) continue;
    out.total++;
    if (e.shadow) out.shadow++; else out.live++;
    const b = e.branch === 'B' ? out.B : out.A;
    b.count++;
    if (e.pnlAfter == null) { out.pending++; continue; }
    b.filled++; b.netPnl = round2(b.netPnl + (Number(e.pnlAfter) || 0)); b.rungs += (Number(e.rungsAfter) || 0);
  }
  return out;
}

/** 从异常信号推导本次核账的告警级别与原因（无异常→info 日常，仅面板）。 */
export function detectAnomalies(report, baseline) {
  const reasons = [];
  let level = 'info';
  const dropNow = report.counters.droppedLevels;
  const dropBase = baseline?.counters?.droppedLevels ?? dropNow;
  if (dropNow > dropBase) { level = 'critical'; reasons.push(`档位空洞新增 ${dropNow - dropBase}（累计 ${dropNow}），可能有档位无单，建议核对并重启补齐`); }
  const rejNow = report.counters.rejectedOrders;
  const rejBase = baseline?.counters?.rejectedOrders ?? rejNow;
  if (rejNow - rejBase >= 5) { if (level === 'info') level = 'warn'; reasons.push(`下单被拒新增 ${rejNow - rejBase} 笔，检查保证金/杠杆/50 单上限`); }
  // 实盘（非影子）动态动作若已回填且净格利为负，提示评审
  const liveNet = report.dynamic.A.netPnl + report.dynamic.B.netPnl;
  const liveFilled = report.dynamic.A.filled + report.dynamic.B.filled;
  if (report.dynamic.live > 0 && liveFilled > 0 && liveNet < 0) {
    if (level === 'info') level = 'warn';
    reasons.push(`动态网格已回填动作净格利为负（${liveNet}），重定收益未覆盖成本，建议评审是否收紧门槛`);
  }
  // FIFO 毛实现与交易所 rpnl 背离超过阈值（美元）
  if (report.pnl.exchangeRpnl != null) {
    const diff = Math.abs(report.pnl.fifoRealized - report.pnl.exchangeRpnl);
    if (diff > Math.max(1, Math.abs(report.pnl.exchangeRpnl) * 0.2)) {
      if (level === 'info') level = 'warn';
      reasons.push(`FIFO 毛实现(${report.pnl.fifoRealized}) 与交易所 rpnl(${report.pnl.exchangeRpnl}) 背离 ${round2(diff)}，成交/资金费口径需核对`);
    }
  }
  return { level, reasons };
}

/** 人类可读的核账摘要（进日志 + 通知）。 */
export function formatReportText(report) {
  const p = report.pnl, c = report.counters, d = report.dynamic;
  const lines = [
    `📊 VA 核账 · 近 ${report.windowH}h（${report.trades} 笔成交）`,
    `实现盈亏(FIFO毛) ${p.fifoRealized} | 估手续费 ${p.estFees} | 净≈ ${p.netEst}` +
      (p.exchangeRpnl != null ? ` | 交易所rpnl ${p.exchangeRpnl}` : '') +
      (p.cumFunding != null ? ` | 持仓资金费 ${p.cumFunding}` : ''),
    `计数器：拒单 ${c.rejectedOrders} / 空洞 ${c.droppedLevels} / 迟到 ${c.lateFills}` +
      (report.delta ? `（较昨日 +${report.delta.rejectedOrders}/+${report.delta.droppedLevels}/+${report.delta.lateFills}）` : ''),
    `动态网格：动作 ${d.total}（影子 ${d.shadow}/实盘 ${d.live}，待回填 ${d.pending}）` +
      ` | A漂移 净格利 ${d.A.netPnl}(${d.A.filled}) B重启 净格利 ${d.B.netPnl}(${d.B.filled})` +
      ` | 门拦截 库存${d.gateBlocked.inventory}/平静${d.gateBlocked.calm}/冷却${d.gateBlocked.cooldown}`,
  ];
  if (report.anomalies.reasons.length) lines.push('⚠️ ' + report.anomalies.reasons.join('；'));
  return lines.join('\n');
}

/**
 * 组装核账报告（纯函数，便于单测）。所有取数结果作为入参传入。
 * @param {object} a
 *   trades[], position|null, counters{rejectedOrders,droppedLevels,lateFills},
 *   stats{gridProfit,completedRungs}, dynLog[], gateBlocked, feeRate, windowMs, now, baseline
 */
export function buildReport(a) {
  const { trades = [], position = null, counters = {}, dynLog = [],
    gateBlocked = {}, feeRate = 0.0001, windowMs = 24 * HOUR, now = Date.now(), baseline = null } = a;
  const fifo = fifoRealized(trades);
  const estFees = round2(fifo.notional * feeRate);
  const dynamic = summarizeDynamic(dynLog, gateBlocked);
  const cn = {
    rejectedOrders: Number(counters.rejectedOrders) || 0,
    droppedLevels: Number(counters.droppedLevels) || 0,
    lateFills: Number(counters.lateFills) || 0,
  };
  const report = {
    at: now,
    windowH: Math.round(windowMs / HOUR),
    trades: trades.length,
    pnl: {
      fifoRealized: fifo.realized,
      estFees,
      netEst: round2(fifo.realized - estFees),
      notional: fifo.notional,
      openQty: fifo.openQty,
      exchangeRpnl: position && Number.isFinite(Number(position.realizedPnl)) ? round2(Number(position.realizedPnl)) : null,
      cumFunding: position && Number.isFinite(Number(position.cumFunding)) ? round2(Number(position.cumFunding)) : null,
    },
    counters: cn,
    delta: baseline?.counters ? {
      rejectedOrders: cn.rejectedOrders - (baseline.counters.rejectedOrders || 0),
      droppedLevels: cn.droppedLevels - (baseline.counters.droppedLevels || 0),
      lateFills: cn.lateFills - (baseline.counters.lateFills || 0),
    } : null,
    dynamic,
    anomalies: { level: 'info', reasons: [] },
  };
  report.anomalies = detectAnomalies(report, baseline);
  return report;
}

/**
 * 编排：拉数 → 回填 _dynLog（落盘）→ 组装报告 → 通知 → 更新基线。
 * @param {object} o { bot, exchange, source='va', windowMs, now, persistKey }
 * @returns {Promise<object>} report
 */
export async function runVaAudit({ bot, exchange, source = 'va', windowMs = 24 * HOUR, now = Date.now(), persistKey } = {}) {
  const win = Number(windowMs) > 0 ? Number(windowMs) : 24 * HOUR;
  // _dynLog 回填要覆盖 A 的 72h 窗口，成交窗口取 max(请求窗口, 96h)
  const tradeSince = now - Math.max(win, MATURE_A_MS + 24 * HOUR);
  let trades = [];
  try { trades = await exchange.fetchTradesWindow?.(tradeSince) || []; }
  catch (e) { logger.warn(source, `核账拉取成交失败：${e?.message || e}`); }
  // 只统计请求窗口内的成交（回填另用更长窗口的 stats 增量，不依赖逐笔）
  const winTrades = trades.filter((t) => tsMs(t.ts) >= now - win);

  const position = exchange.getPosition?.(bot?.config?.marketId) || null;
  const counters = {
    rejectedOrders: exchange.rejectedOrders,
    droppedLevels: exchange.droppedLevels,
    lateFills: exchange.lateFills,
  };
  const stats = bot?.stats || {};

  // 回填 _dynLog 并落盘（就地改 bot._dynLog）
  let filled = 0;
  if (Array.isArray(bot?._dynLog)) {
    filled = backfillDynLog(bot._dynLog, { now, gridProfitNow: stats.gridProfit, completedRungsNow: stats.completedRungs });
    if (filled > 0 && typeof bot.snapshot === 'function') {
      try { saveSnapshot(source, bot.snapshot()); } catch (e) { logger.warn(source, `回填后落盘失败：${e?.message || e}`); }
    }
  }

  const baseKey = persistKey || AUDIT_KEY;
  const baseline = loadSnapshot(baseKey);
  const report = buildReport({
    trades: winTrades, position, counters,
    dynLog: bot?._dynLog || [], gateBlocked: bot?._dynGateBlocked || {},
    feeRate: exchange.feeRate, windowMs: win, now, baseline,
  });
  report.backfilled = filled;

  // 通知：无异常→info（仅面板/日志），有异常→warn/critical（推手机）。
  const text = formatReportText(report);
  logger.info(source, text.replace(/\n/g, ' ｜ '));
  notifier.send({ source, level: report.anomalies.level, key: source + ':audit-daily',
    title: 'VA 核账', message: text, cooldownMs: 12 * HOUR });

  // 更新基线（下次算增量用）
  saveSnapshot(baseKey, { at: now, counters: report.counters });
  return report;
}

/**
 * 每日核账调度器。默认每天固定时刻跑一次（含轻抖动避峰）。
 * @returns {{ stop:()=>void, runNow:()=>Promise<object> }}
 */
export function createAuditService({ bot, exchange, source = 'va', hourLocal = 9, minuteLocal = 7, intervalMs = 60_000 }) {
  let lastRunDay = null;
  const tick = async () => {
    try {
      const d = new Date();
      if (d.getHours() < hourLocal || (d.getHours() === hourLocal && d.getMinutes() < minuteLocal)) return;
      const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (lastRunDay === dayKey) return;                 // 今天已跑过
      lastRunDay = dayKey;
      if (exchange?.mode !== 'live') return;             // 仅实盘核账
      await runVaAudit({ bot, exchange, source });
    } catch (e) { logger.error(source, `核账调度异常：${e?.message || e}`); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), runNow: () => runVaAudit({ bot, exchange, source }) };
}
