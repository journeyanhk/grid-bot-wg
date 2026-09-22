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

/** 决断门阈值（文档2 验收门槛 A）。 */
export const GATE_CRITERIA = Object.freeze({
  minDays: 7, minTrades: 30,
  pfBaseline: 1.30, pfConservative: 1.10,
  maxDrawdownPct: 6, retDdRatio: 0.7, maxDailyLossPct: 1,
});

/** 从交易序列计算统计（PF 按 netPnl 情景口径，更保守）。 */
export function computeStats(trades, equity, scenarioId = 'baseline') {
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
  };
}

/** 决断门评估（以 r2fast 为决断对象）。 */
export function evaluateGate(recorderData, { equity = 10_000, startedAt = null } = {}) {
  const trades = recorderData?.perConfig?.r2fast?.trades || [];
  const days = startedAt ? (Date.now() - startedAt) / 86_400_000 : 0;
  const base = computeStats(trades, equity, 'baseline');
  const cons = computeStats(trades, equity, 'conservative');
  const sides = new Set(trades.map((t) => t.side));
  const unprotected = !!(recorderData?.perConfig?.r2fast?.position && !recorderData.perConfig.r2fast.position.stopPrice);
  const checks = [
    { name: `影子天数 ≥ ${GATE_CRITERIA.minDays}`, ok: days >= GATE_CRITERIA.minDays, value: Number(days.toFixed(1)) },
    { name: `完整交易 ≥ ${GATE_CRITERIA.minTrades}`, ok: base.trades >= GATE_CRITERIA.minTrades, value: base.trades },
    { name: `基准 PF ≥ ${GATE_CRITERIA.pfBaseline}`, ok: base.pf >= GATE_CRITERIA.pfBaseline, value: base.pf },
    { name: `保守 PF ≥ ${GATE_CRITERIA.pfConservative}`, ok: cons.pf >= GATE_CRITERIA.pfConservative, value: cons.pf },
    { name: '净收益 > 0（基准）', ok: base.net > 0, value: base.net },
    { name: `最大回撤 ≤ ${GATE_CRITERIA.maxDrawdownPct}%`, ok: base.maxDrawdownPct <= GATE_CRITERIA.maxDrawdownPct, value: base.maxDrawdownPct },
    { name: `收益/回撤 > ${GATE_CRITERIA.retDdRatio}`, ok: base.retDdRatio > GATE_CRITERIA.retDdRatio, value: base.retDdRatio },
    { name: `单日亏损 ≤ ${GATE_CRITERIA.maxDailyLossPct}%`, ok: Math.abs(base.maxDailyLossPct) <= GATE_CRITERIA.maxDailyLossPct, value: base.maxDailyLossPct },
    { name: '长短方向均有样本', ok: sides.has('long') && sides.has('short'), value: [...sides].join('/') || '无' },
    { name: '无未保护虚拟仓位', ok: !unprotected, value: unprotected ? '有' : '无' },
  ];
  return { pass: checks.every((c) => c.ok), days: Number(days.toFixed(1)), checks, baseline: base, conservative: cons };
}

/** 日报文案（Telegram/Webhook 友好，紧凑）。 */
export function composeDailyReport({ recorderData, gate, runner = {} } = {}) {
  const lines = [];
  lines.push(`【策略影子日报】${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  const per = recorderData?.perConfig || {};
  for (const id of ['r2fast', 'balanced', 'strict']) {
    const cfg = per[id];
    if (!cfg) continue;
    const base = computeStats(cfg.trades, runner.equity || 10_000, 'baseline');
    lines.push(`· ${id}: 交易 ${base.trades} · PF ${base.pf} · 净 ${base.net}U · DD ${base.maxDrawdownPct}%`);
  }
  if (gate) {
    const passed = gate.checks.filter((c) => c.ok).length;
    lines.push(`决断门进度 ${passed}/${gate.checks.length}（${gate.days} 天）${gate.pass ? ' ✅已达标' : ''}`);
    const failing = gate.checks.filter((c) => !c.ok).slice(0, 3);
    for (const f of failing) lines.push(`  ✗ ${f.name}（当前 ${f.value}）`);
  }
  if (runner.binance?.lastDevBps != null) lines.push(`HL/Binance 基差 ${runner.binance.lastDevBps}bps（样本 ${runner.binance.samples || 0}）`);
  return lines.join('\n');
}
