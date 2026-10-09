#!/usr/bin/env node
// 方向策略影子结案报表：读取 .strategy-shadow.json，输出各变体全周期统计 + 决断门进度。
// 用法：
//   node scripts/strategy-shadow-report.mjs [--file path] [--json]
//   npm run strategy:report
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats, evaluateGate } from '../src/strategy/shadow-persistence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const file = fileArg >= 0 && args[fileArg + 1] ? args[fileArg + 1] : path.join(ROOT, '.strategy-shadow.json');
const asJson = args.includes('--json');

if (!fs.existsSync(file)) {
  console.error(`未找到影子数据文件：${file}（请确认影子运行器已启动并写过数据）`);
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const per = raw?.recorder?.perConfig || {};
const coverage = raw?.runner?.coverage
  ? {
      firstBarKey: raw.runner.coverage.firstBarKey,
      lastBarKey: raw.runner.coverage.lastBarKey,
      processedBars: raw.runner.coverage.processedBars,
      missedBars: raw.runner.coverage.missedBars,
      maxGapMs: raw.runner.coverage.maxGapMs,
      coveragePct: (() => {
        const c = raw.runner.coverage;
        const expected = c.firstBarKey != null && c.lastBarKey != null ? Math.round((c.lastBarKey - c.firstBarKey) / 300_000) + 1 : 0;
        return expected > 0 ? Number(Math.min(100, (c.processedBars / expected) * 100).toFixed(2)) : 0;
      })(),
      effectiveDays: Number(((raw.runner.coverage.processedBars * 300_000) / 86_400_000).toFixed(2)),
    }
  : null;
const equity = Number(process.env.STRATEGY_SHADOW_EQUITY || 10_000);

const rows = [];
for (const id of ['r2fast', 'strict', 'balanced', 'r2faster'].filter((x) => per[x])) {
  const cfg = per[id];
  const trades = cfg.trades || [];
  const base = computeStats(trades, equity, 'baseline');
  const cons = computeStats(trades, equity, 'conservative');
  const fee = trades.reduce((a, t) => a + Number(t.costs?.baseline?.feeUsd || 0), 0);
  const slip = trades.reduce((a, t) => a + Number(t.costs?.baseline?.slippageUsd || 0), 0);
  const gross = trades.reduce((a, t) => a + Number(t.grossPnl || 0), 0);
  const holding = trades.length ? trades.reduce((a, t) => a + Number(t.holdingMs || 0), 0) / trades.length / 60_000 : 0;
  const byExit = {};
  const bySide = { long: 0, short: 0 };
  for (const t of trades) {
    byExit[t.exitReason] = (byExit[t.exitReason] || 0) + 1;
    bySide[t.side] = (bySide[t.side] || 0) + 1;
  }
  rows.push({
    id, version: cfg.version || cfg.def?.version || null, trades: base.trades,
    winRate: base.trades ? Number(((base.wins / base.trades) * 100).toFixed(0)) : 0,
    pfBaseline: base.pf, pfConservative: cons.pf,
    netBaseline: base.net, netConservative: cons.net,
    maxDrawdownPct: base.maxDrawdownPct,
    gross: Number(gross.toFixed(2)), fee: Number(fee.toFixed(2)), slip: Number(slip.toFixed(2)),
    feeOverGrossPct: gross !== 0 ? Number(((fee / Math.abs(gross)) * 100).toFixed(0)) : null,
    avgHoldingMin: Number(holding.toFixed(0)),
    bySide, byExit,
    openPosition: cfg.position ? `${cfg.position.side} ${cfg.position.filledSize}@${cfg.position.entryPrice}` : null,
  });
}

const gate = evaluateGate(raw?.recorder || {}, { equity, coverage, mtm: null });

if (asJson) {
  console.log(JSON.stringify({ file, startedAt: raw.startedAt, coverage, variants: rows, gate }, null, 2));
} else {
  console.log(`影子结案报表 · ${file}`);
  console.log(`起始 ${new Date(raw.startedAt || 0).toISOString().slice(0, 16)}Z · 覆盖 ${coverage?.coveragePct ?? '?'}% · 有效 ${coverage?.effectiveDays ?? '?'} 天 · 密集缺口峰值 ${Math.round((coverage?.maxGapMs || 0) / 60_000)} 分钟\n`);
  console.log('变体      笔数  胜率   PF基准  PF保守   净基准   净保守   DD%   毛利/费/滑              费/毛   持仓均  多/空   退出分布');
  for (const r of rows) {
    const exits = Object.entries(r.byExit).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(
      `${r.id.padEnd(9)} ${String(r.trades).padStart(4)} ${String(r.winRate + '%').padStart(5)}  ${String(r.pfBaseline).padStart(6)}  ${String(r.pfConservative).padStart(6)}  ${String(r.netBaseline).padStart(7)}  ${String(r.netConservative).padStart(7)}  ${String(r.maxDrawdownPct).padStart(5)}  ${(r.gross + '/' + r.fee + '/' + r.slip).padEnd(22)}  ${String(r.feeOverGrossPct + '%').padStart(6)}  ${String(r.avgHoldingMin + 'm').padStart(5)}  ${r.bySide.long + '/' + r.bySide.short}`,
    );
    console.log(`${' '.repeat(11)}${exits}${r.openPosition ? ` · 持仓中 ${r.openPosition}` : ''}`);
  }
  const passed = gate.checks.filter((c) => c.ok).length;
  console.log(`\n决断门（r2fast）: ${passed}/${gate.checks.length}${gate.pass ? ' ✅已达标' : ''}`);
  for (const c of gate.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}（当前 ${c.value}）`);
  console.log('\n注：净收益/回撤未含未平仓 MTM（离线报表无 mark 价）；运行中请看 /api/strategy/shadow/state。');
}
