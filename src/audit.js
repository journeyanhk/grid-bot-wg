// VA 核账（对账）—— 仅 Variational，一日一次。
//
// 目的：给「动态网格是否值得毕业」和「无人值守是否在悄悄亏」提供可评审的数据。
// 三条主线：
//   1) 用 /api/trades 拉【全窗】(≥96h) 成交，FIFO 重建实现盈亏，并给每一笔【平仓】
//      打上成交时刻 realizedAt；报告只汇总 realizedAt 落在核账窗口内的部分——这样
//      窗口开头带入的旧库存不会被当成"新开的反向仓"。Omni 零手续费、点差已含在
//      成交价里，故 realized 即净额，不再另扣 feeRate（那是重复计费）。
//   2) 笔数核对：bot 自上次核账以来的成交计数增量 (stats.buys+sells) vs 交易所同
//      窗口 trades 数。不等 = 幻影单/漏确认的硬信号（比仓位级 rpnl 背离可靠）。
//   3) 计数器盘点 + 回填 _dynLog（漂移 A 满 72h、破界重启 B 满 48h）。
//
// 设计原则：纯函数可单测（FIFO / 回填 / 汇总 / 异常判定 / 文案），编排层只做取数与落盘。
import { notifier } from './notify.js';
import { loadSnapshot, saveSnapshot } from './persist.js';
import { logger } from './log.js';

const HOUR = 3600_000;
const MATURE_A_MS = 72 * HOUR;   // 漂移重心：3 日后回填
const MATURE_B_MS = 48 * HOUR;   // 破界重启：2 日后回填
const FETCH_MIN_MS = 96 * HOUR;  // 成交至少拉 96h，给 FIFO 带入窗口前的开仓
const AUDIT_KEY = 'va-audit';    // 计数器/锚点基线独立落在 .state.json 的这个键下

export function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }

/** 把 created_at（ISO 串或 epoch 毫秒/秒）统一成毫秒。无法解析→0。 */
export function tsMs(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000; // 秒级补齐
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
}

/**
 * FIFO 逐笔重建实现盈亏（Omni 点差已含价内，此即净额）。
 * trades: [{ side:'buy'|'sell', price, qty, ts }]，内部按 ts 升序。
 * 返回 { realized, closes:[{ts,pnl}], openQty, notional }：
 *   realized  全部平仓的合计盈亏；closes 每一次平仓事件（打成交时刻 ts，供窗口过滤）；
 *   openQty   剩余净持仓（多正空负）；notional 成交名义额之和（点差参考）。
 */
export function fifoRealized(trades) {
  const lots = [];            // 每档 { qty>0, price, dir:+1 多 / -1 空 }
  let realized = 0, notional = 0;
  const closes = [];
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
      const pnl = lot.dir === 1 ? (price - lot.price) * m : (lot.price - price) * m;
      realized += pnl;
      closes.push({ ts: t.ts, pnl });      // 平仓事件按【平仓成交时刻】计入窗口
      lot.qty -= m; qty -= m;
      if (lot.qty <= 1e-12) lots.shift();
    }
    if (qty > 1e-12) lots.push({ qty, price, dir });
  }
  const openQty = lots.reduce((s, l) => s + l.dir * l.qty, 0);
  return { realized: round2(realized), closes, openQty: round2(openQty), notional: round2(notional) };
}

/** 汇总 realizedAt 落在 [sinceMs, ∞) 的平仓盈亏。 */
export function realizedSince(closes, sinceMs) {
  let sum = 0;
  for (const c of closes || []) if (tsMs(c.ts) >= sinceMs) sum += Number(c.pnl) || 0;
  return round2(sum);
}

/**
 * 回填 _dynLog：就地把已成熟、未回填的动作补上 pnlAfter / rungsAfter。
 * pnlAfter = 当前累计 gridProfit − 动作时 before.gridProfit（≈动作后到今天的格利）
 * realizedAtAction 暂不回填（需在 before 里预留 realized 快照），保持原值。
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
  const bump = (lv) => { if (lv === 'critical' || (lv === 'warn' && level === 'info')) level = lv; };

  // 档位空洞新增 → critical（可能有档位无单）
  const dropNow = report.counters.droppedLevels;
  const dropBase = baseline?.counters?.droppedLevels ?? dropNow;
  if (dropNow > dropBase) { bump('critical'); reasons.push(`档位空洞新增 ${dropNow - dropBase}（累计 ${dropNow}），可能有档位无单，建议核对并重启补齐`); }

  // 拒单激增 → warn
  const rejNow = report.counters.rejectedOrders;
  const rejBase = baseline?.counters?.rejectedOrders ?? rejNow;
  if (rejNow - rejBase >= 5) { bump('warn'); reasons.push(`下单被拒新增 ${rejNow - rejBase} 笔，检查保证金/杠杆/50 单上限`); }

  // 笔数核对：bot 成交计数增量 vs 交易所同窗口 trades 数 → 幻影/漏确认硬信号
  if (report.reconcile) {
    const { botFills, exchangeTrades } = report.reconcile;
    if (botFills !== exchangeTrades) {
      bump('warn');
      reasons.push(`成交笔数不一致：bot 记 ${botFills} 笔 / 交易所窗口 ${exchangeTrades} 笔（差 ${botFills - exchangeTrades}），疑似幻影单或漏确认，请核对成交流水`);
    }
  }

  // 实盘（非影子）动态动作若已回填且净格利为负 → 提示评审
  const liveNet = report.dynamic.A.netPnl + report.dynamic.B.netPnl;
  const liveFilled = report.dynamic.A.filled + report.dynamic.B.filled;
  if (report.dynamic.live > 0 && liveFilled > 0 && liveNet < 0) {
    bump('warn');
    reasons.push(`动态网格已回填动作净格利为负（${liveNet}），重定收益未覆盖成本，建议评审是否收紧门槛`);
  }

  // 成交拉取被 500 笔/合约上限截断 → 数据不全，提醒但不升级严重度
  if (report.truncated) { bump('warn'); reasons.push('成交拉取触及 500 笔/合约上限，本次数据可能不全（高波动日），实现盈亏偏保守'); }

  return { level, reasons };
}

/** 人类可读的核账摘要（进日志 + 通知）。 */
export function formatReportText(report) {
  const p = report.pnl, c = report.counters, d = report.dynamic, r = report.reconcile;
  const lines = [
    `📊 VA 核账 · 近 ${report.windowH}h（窗口成交 ${report.trades} 笔${report.truncated ? '，已截断' : ''}）`,
    `实现盈亏(FIFO,含点差) ${p.realized}｜名义额 ${p.notional}｜净持仓 ${p.openQty}` +
      (p.cumFunding != null ? `｜持仓资金费(累计,平仓即归零) ${p.cumFunding}` : ''),
    `笔数核对：bot ${r ? r.botFills : '—'} / 交易所 ${r ? r.exchangeTrades : '—'}` +
      (r ? (r.match ? ' ✓' : ` ✗ 差${r.botFills - r.exchangeTrades}`) : '（首次无基线）'),
    `计数器：拒单 ${c.rejectedOrders} / 空洞 ${c.droppedLevels} / 迟到 ${c.lateFills}` +
      (report.delta ? `（较上次 +${report.delta.rejectedOrders}/+${report.delta.droppedLevels}/+${report.delta.lateFills}）` : ''),
    `动态网格：动作 ${d.total}（影子 ${d.shadow}/实盘 ${d.live}，待回填 ${d.pending}）` +
      `｜A漂移 净格利 ${d.A.netPnl}(${d.A.filled}) B重启 净格利 ${d.B.netPnl}(${d.B.filled})` +
      `｜门拦截 库存${d.gateBlocked.inventory}/平静${d.gateBlocked.calm}/冷却${d.gateBlocked.cooldown}`,
  ];
  if (report.anomalies.reasons.length) lines.push('⚠️ ' + report.anomalies.reasons.join('；'));
  return lines.join('\n');
}

/**
 * 组装核账报告（纯函数）。所有取数结果作为入参传入。
 * @param {object} a
 *   allTrades[]（≥96h，供 FIFO 带入开仓），windowSinceMs（realized 汇总起点，
 *   通常 = 上次核账 at），position|null, counters{...}, botFills（当前 buys+sells），
 *   dynLog[], gateBlocked, now, baseline, truncated
 */
export function buildReport(a) {
  const { allTrades = [], windowSinceMs, position = null, counters = {}, botFills = 0,
    dynLog = [], gateBlocked = {}, now = Date.now(), baseline = null, truncated = false } = a;
  const since = Number.isFinite(windowSinceMs) ? windowSinceMs : now - 24 * HOUR;
  const fifo = fifoRealized(allTrades);
  const winTrades = allTrades.filter((t) => tsMs(t.ts) >= since);
  const notional = round2(winTrades.reduce((s, t) => s + (Number(t.price) || 0) * Math.abs(Number(t.qty) || 0), 0));
  const dynamic = summarizeDynamic(dynLog, gateBlocked);
  const cn = {
    rejectedOrders: Number(counters.rejectedOrders) || 0,
    droppedLevels: Number(counters.droppedLevels) || 0,
    lateFills: Number(counters.lateFills) || 0,
  };
  // 笔数核对仅在有基线（能算增量）时给出，避免首次运行误报。
  let reconcile = null;
  if (baseline && Number.isFinite(baseline.fills)) {
    const bf = Math.max(0, Number(botFills) - Number(baseline.fills));
    reconcile = { botFills: bf, exchangeTrades: winTrades.length, match: bf === winTrades.length };
  }

  const report = {
    at: now,
    windowH: Math.round((now - since) / HOUR),
    trades: winTrades.length,
    truncated: !!truncated,
    pnl: {
      realized: realizedSince(fifo.closes, since),
      notional,
      openQty: fifo.openQty,
      cumFunding: position && Number.isFinite(Number(position.cumFunding)) ? round2(Number(position.cumFunding)) : null,
    },
    reconcile,
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
 * 编排：拉数 → 回填 _dynLog（落盘）→ 组装报告 → 通知 → 更新基线/锚点。
 * @param {object} o { bot, exchange, source='va', now, persistKey }
 * @returns {Promise<object>} report
 */
export async function runVaAudit({ bot, exchange, source = 'va', now = Date.now(), persistKey } = {}) {
  const baseKey = persistKey || AUDIT_KEY;
  const baseline = loadSnapshot(baseKey);
  // 窗口起点锚定到上次核账时刻（让计数增量与成交窗口用同一段时间）；首次缺省 24h。
  const windowSinceMs = Number.isFinite(baseline?.at) ? baseline.at : now - 24 * HOUR;
  // 成交至少拉 96h（覆盖 FIFO 带入 + A 分支 72h 回填窗口），并确保覆盖窗口起点。
  const fetchSince = Math.min(windowSinceMs, now - FETCH_MIN_MS);

  let allTrades = [], truncated = false;
  try {
    const res = await exchange.fetchTradesWindow?.(fetchSince);
    allTrades = Array.isArray(res) ? res : (res?.trades || []);
    truncated = !!res?.truncated;
  } catch (e) { logger.warn(source, `核账拉取成交失败：${e?.message || e}`); }

  const position = exchange.getPosition?.(bot?.config?.marketId) || null;
  const counters = {
    rejectedOrders: exchange.rejectedOrders,
    droppedLevels: exchange.droppedLevels,
    lateFills: exchange.lateFills,
  };
  const stats = bot?.stats || {};
  const botFills = (Number(stats.buys) || 0) + (Number(stats.sells) || 0);

  // 回填 _dynLog 并落盘（就地改 bot._dynLog）
  let filled = 0;
  if (Array.isArray(bot?._dynLog)) {
    filled = backfillDynLog(bot._dynLog, { now, gridProfitNow: stats.gridProfit, completedRungsNow: stats.completedRungs });
    if (filled > 0 && typeof bot.snapshot === 'function') {
      try { saveSnapshot(source, bot.snapshot()); } catch (e) { logger.warn(source, `回填后落盘失败：${e?.message || e}`); }
    }
  }

  const report = buildReport({
    allTrades, windowSinceMs, position, counters, botFills,
    dynLog: bot?._dynLog || [], gateBlocked: bot?._dynGateBlocked || {},
    now, baseline, truncated,
  });
  report.backfilled = filled;

  // 通知：无异常→info（仅面板/日志），有异常→warn/critical（推手机）。
  const text = formatReportText(report);
  logger.info(source, text.replace(/\n/g, ' ｜ '));
  notifier.send({ source, level: report.anomalies.level, key: source + ':audit-daily',
    title: 'VA 核账', message: text, cooldownMs: 12 * HOUR });

  // 更新基线：下次的窗口起点(at)、计数增量基准(counters)、笔数核对锚点(fills)。
  saveSnapshot(baseKey, { at: now, counters: report.counters, fills: botFills });
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
