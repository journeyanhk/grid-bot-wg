// 影子持久化（阶段1）：独立数据文件（不触碰 .state.json）+ 日报文案 + 决断门评估。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SHADOW_FILE = path.join(ROOT, '.strategy-shadow.json');

/** 读影子数据（不存在/损坏返回 null）。 */
export function loadShadowData(file = SHADOW_FILE) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

/** 原子写影子数据。 */
export function saveShadowData(data, file = SHADOW_FILE) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** 决断门阈值（文档2 验收门槛 A + Review 数据质量要求）。 */
export const GATE_CRITERIA = Object.freeze({
  minDays: 7, minTrades: 30,
  pfBaseline: 1.30, pfConservative: 1.10,
  maxDrawdownPct: 6, retDdRatio: 0.7, maxDailyLossPct: 1,
  minCoveragePct: 99, maxGapMs: 15 * 60_000, minFundingCompletenessPct: 99,
});

/** 基差样本统计（P2-2）：有符号 + 分布。samples: [{signedBps}] */
export function summarizeBasis(samples) {
  const list = (samples || []).map((x) => Number(x?.signedBps)).filter((x) => Number.isFinite(x));
  if (!list.length) return { samples: 0, meanSignedBps: null, meanAbsBps: null, p50AbsBps: null, p95AbsBps: null, maxAbsBps: null, lastSignedBps: null, hlPremiumRatio: null };
  const abs = list.map(Math.abs).sort((a, b) => a - b);
  const meanSigned = list.reduce((a, b) => a + b, 0) / list.length;
  const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
  const pct = (p) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))];
  return {
    samples: list.length,
    meanSignedBps: Number(meanSigned.toFixed(2)),
    meanAbsBps: Number(meanAbs.toFixed(2)),
    p50AbsBps: Number(pct(0.5).toFixed(2)),
    p95AbsBps: Number(pct(0.95).toFixed(2)),
    maxAbsBps: Number(abs[abs.length - 1].toFixed(2)),
    lastSignedBps: Number(list[list.length - 1].toFixed(2)),
    hlPremiumRatio: Number((list.filter((x) => x > 0).length / list.length).toFixed(2)),
  };
}

/** 从交易序列计算统计（PF 按 netPnl 情景口径，更保守；mtm 纳入未平仓浮盈亏——Review P0-3）。 */
export function computeStats(trades, equity, scenarioId = 'baseline', { mtm = null } = {}) {
  const list = [...(trades || [])].sort((a, b) => a.closedAt - b.closedAt);
  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, net = 0;
  let peak = 0, cum = 0, maxDd = 0;
  const byDay = new Map();
  for (const t of list) {
    const pnl = Number(t.netPnl?.[scenarioId] ?? t.grossPnl ?? 0);
    net += pnl;
    if (pnl > 0) { wins++; grossProfit += pnl; } else if (pnl < 0) { losses++; grossLoss += -pnl; }
    cum += pnl;
    if (cum > peak) peak = cum;
    maxDd = Math.max(maxDd, peak - cum);
    const day = new Date(t.closedAt).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + pnl);
  }
  // 未平仓 MTM（浮动盈亏 - 预估退出成本 - 累计资金费）：计入净值/回撤/当日盈亏
  let openMtmPnl = null;
  if (mtm && Number.isFinite(mtm.mtmUsd)) {
    openMtmPnl = mtm.mtmUsd;
    net += openMtmPnl;
    cum += openMtmPnl;
    if (cum > peak) peak = cum;
    maxDd = Math.max(maxDd, peak - cum);
    const day = new Date().toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + openMtmPnl);
  }
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const maxDailyLoss = byDay.size ? Math.min(0, ...byDay.values()) : 0;
  const ddPct = equity > 0 ? (maxDd / equity) * 100 : 0;
  const retDd = maxDd > 0 ? net / maxDd : (net > 0 ? Infinity : 0);
  return {
    trades: list.length, wins, losses,
    pf: Number.isFinite(pf) ? Number(pf.toFixed(2)) : pf,
    net: Number(net.toFixed(2)),
    grossProfit: Number(grossProfit.toFixed(2)), grossLoss: Number(grossLoss.toFixed(2)),
    maxDrawdown: Number(maxDd.toFixed(2)), maxDrawdownPct: Number(ddPct.toFixed(2)),
    retDdRatio: Number.isFinite(retDd) ? Number(retDd.toFixed(2)) : retDd,
    maxDailyLoss: Number(maxDailyLoss.toFixed(2)),
    maxDailyLossPct: equity > 0 ? Number(((maxDailyLoss / equity) * 100).toFixed(2)) : 0,
    openMtmPnl: openMtmPnl != null ? Number(openMtmPnl.toFixed(2)) : null,
  };
}

/** 资金费率数据完整度（按持仓时间加权；缺数据不得当 0——Review P0-1）。 */
export function fundingCompleteness(trades, openMtm = null) {
  let holding = 0, missing = 0;
  for (const t of trades || []) {
    holding += Number(t.holdingMs) || 0;
    missing += Number(t.fundingMissingMs) || 0;
  }
  if (openMtm && Number.isFinite(openMtm.holdingMs)) {
    holding += openMtm.holdingMs;
    missing += Number(openMtm.fundingMissingMs) || 0;
  }
  if (!(holding > 0)) return { holdingMs: 0, missingMs: 0, pct: 100 };
  return { holdingMs: holding, missingMs: missing, pct: Number((Math.max(0, 1 - missing / holding) * 100).toFixed(2)) };
}

/**
 * 决断门评估（以 r2fast 为决断对象）。
 * @param {Object} recorderData recorder.exportData()
 * @param {Object} o
 * @param {number} o.equity
 * @param {Object} [o.coverage] { effectiveDays, coveragePct, maxGapMs }（Review P0-4：有效数据而非墙上时间）
 * @param {Object} [o.mtm] r2fast 未平仓 mark-to-market（Review P0-3：浮盈亏纳入回撤）
 */
export function evaluateGate(recorderData, { equity = 10_000, coverage = null, mtm = null } = {}) {
  const trades = recorderData?.perConfig?.r2fast?.trades || [];
  const base = computeStats(trades, equity, 'baseline', { mtm });
  const cons = computeStats(trades, equity, 'conservative', { mtm });
  const sides = new Set(trades.map((t) => t.side));
  const unprotected = !!(recorderData?.perConfig?.r2fast?.position && !recorderData.perConfig.r2fast.position.stopPrice);
  const effDays = Number(coverage?.effectiveDays) || 0;
  const covPct = Number.isFinite(coverage?.coveragePct) ? coverage.coveragePct : 0;
  const maxGapMs = Number.isFinite(coverage?.maxGapMs) ? coverage.maxGapMs : Infinity;
  const funding = fundingCompleteness(trades, mtm);
  const checks = [
    { name: `有效数据天数 ≥ ${GATE_CRITERIA.minDays}`, ok: effDays >= GATE_CRITERIA.minDays, value: Number(effDays.toFixed(1)) },
    { name: `数据覆盖率 ≥ ${GATE_CRITERIA.minCoveragePct}%`, ok: covPct >= GATE_CRITERIA.minCoveragePct, value: covPct },
    { name: `最大连续缺口 ≤ ${GATE_CRITERIA.maxGapMs / 60_000} 分钟`, ok: maxGapMs <= GATE_CRITERIA.maxGapMs, value: Number.isFinite(maxGapMs) ? Math.round(maxGapMs / 60_000) : '∞' },
    { name: `完整交易 ≥ ${GATE_CRITERIA.minTrades}`, ok: base.trades >= GATE_CRITERIA.minTrades, value: base.trades },
    { name: `基准 PF ≥ ${GATE_CRITERIA.pfBaseline}`, ok: base.pf >= GATE_CRITERIA.pfBaseline, value: base.pf },
    { name: `保守 PF ≥ ${GATE_CRITERIA.pfConservative}`, ok: cons.pf >= GATE_CRITERIA.pfConservative, value: cons.pf },
    { name: '净收益 > 0（含未平仓 MTM）', ok: base.net > 0, value: base.net },
    { name: `最大回撤 ≤ ${GATE_CRITERIA.maxDrawdownPct}%（含 MTM）`, ok: base.maxDrawdownPct <= GATE_CRITERIA.maxDrawdownPct, value: base.maxDrawdownPct },
    { name: `收益/回撤 > ${GATE_CRITERIA.retDdRatio}`, ok: base.retDdRatio > GATE_CRITERIA.retDdRatio, value: base.retDdRatio },
    { name: `单日亏损 ≤ ${GATE_CRITERIA.maxDailyLossPct}%（含 MTM）`, ok: Math.abs(base.maxDailyLossPct) <= GATE_CRITERIA.maxDailyLossPct, value: base.maxDailyLossPct },
    { name: '长短方向均有样本', ok: sides.has('long') && sides.has('short'), value: [...sides].join('/') || '无' },
    { name: '无未保护虚拟仓位', ok: !unprotected, value: unprotected ? '有' : '无' },
    { name: `资金费率数据完整度 ≥ ${GATE_CRITERIA.minFundingCompletenessPct}%`, ok: funding.pct >= GATE_CRITERIA.minFundingCompletenessPct, value: funding.pct },
  ];
  return { pass: checks.every((c) => c.ok), days: Number(effDays.toFixed(1)), coverage, funding, checks, baseline: base, conservative: cons };
}

/** 日报文案（Telegram/Webhook 友好，紧凑）。 */
export function composeDailyReport({ recorderData, gate, runner = {} } = {}) {
  const lines = [];
  lines.push(`【策略影子日报】${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  const per = recorderData?.perConfig || {};
  for (const id of ['r2fast', 'balanced', 'strict']) {
    const cfg = per[id];
    if (!cfg) continue;
    const mtm = runner.mtm?.[id] || null;
    const base = computeStats(cfg.trades, runner.equity || 10_000, 'baseline', { mtm });
    lines.push(`· ${id}: 交易 ${base.trades} · PF ${base.pf} · 净 ${base.net}U · DD ${base.maxDrawdownPct}%${base.openMtmPnl != null ? ` · 浮动 ${base.openMtmPnl}U` : ''}`);
  }
  if (gate) {
    const passed = gate.checks.filter((c) => c.ok).length;
    lines.push(`决断门进度 ${passed}/${gate.checks.length}（有效 ${gate.days} 天）${gate.pass ? ' ✅已达标' : ''}`);
    const failing = gate.checks.filter((c) => !c.ok).slice(0, 3);
    for (const f of failing) lines.push(`  ✗ ${f.name}（当前 ${f.value}）`);
    if (gate.coverage) lines.push(`覆盖率 ${gate.coverage.coveragePct}% · 缺口峰值 ${Math.round((gate.coverage.maxGapMs || 0) / 60_000)} 分钟 · 资金完整度 ${gate.funding?.pct}%`);
  }
  if (runner.binance && runner.binance.samples > 0) {
    lines.push(`HL/Binance 基差 均值 ${runner.binance.meanSignedBps}bps · |P95| ${runner.binance.p95AbsBps}bps · HL溢价占比 ${runner.binance.hlPremiumRatio}（样本 ${runner.binance.samples}）`);
  }
  if (runner.bookObserved?.samples > 0) {
    lines.push(`盘口观测滑点 均值 ${runner.bookObserved.meanEntryBps}bps（样本 ${runner.bookObserved.samples}，仅诊断不进气净）`);
  }
  return lines.join('\n');
}
