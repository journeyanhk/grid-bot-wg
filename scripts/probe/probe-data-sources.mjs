#!/usr/bin/env node
// 数据源探针（阶段0 交付物）：验证单一信号源的可得性与边界一致性。
//   - HL：5M/1H/4H K线、l2Book 盘口、资金费率、K线边界对齐
//   - Binance（可选 --binance）：klines 可达性 + 与 HL 的收盘价偏差采样
// 用法：
//   node scripts/probe/probe-data-sources.mjs
//   node scripts/probe/probe-data-sources.mjs --binance            # 加测 Binance（可走 HTTPS_PROXY）
//   node scripts/probe/probe-data-sources.mjs --symbol BTC --json  # 纯 JSON 输出
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 代理支持：Node 原生 fetch 不认 HTTPS_PROXY，需显式挂 undici dispatcher
try {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.GLOBAL_PROXY || '';
  if (proxyUrl) {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[代理] 探针经 ${proxyUrl} 出网`);
  }
} catch (e) { console.log(`[代理] dispatcher 挂载失败（忽略）: ${e?.message || e}`); }
// 复用项目 .env（GLOBAL_PROXY/HTTPS_PROXY 等）
try {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/\s+#.*$/, '');
    }
  }
} catch { /* 探针不因 .env 失败 */ }

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const SYMBOL = opt('--symbol', 'BTC');
const WITH_BINANCE = args.includes('--binance');
const JSON_ONLY = args.includes('--json');
const HL_INFO = 'https://api.hyperliquid.xyz/info';
const report = { probe: 'data-sources', symbol: SYMBOL, at: new Date().toISOString(), checks: [] };

function note(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, detail });
  if (!JSON_ONLY) console.log(`[${ok ? '✓' : '✗'}] ${name}${detail !== undefined ? ' -> ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function probeHl() {
  const now = Date.now();
  const intervals = [['5m', 300], ['1h', 3600], ['4h', 14400]];
  for (const [interval, sec] of intervals) {
    try {
      const rows = await post(HL_INFO, { type: 'candleSnapshot', req: { coin: SYMBOL, interval, startTime: now - 60 * sec * 1000, endTime: now } });
      const n = Array.isArray(rows) ? rows.length : 0;
      const last = n ? rows[n - 1] : null;
      const aligned = last ? Number(last.t) % (sec * 1000) === 0 : false;
      const closed = last ? Number(last.T) <= now : false;
      note(`HL ${interval} K线`, n >= 20, { count: n, lastOpen: last?.t, lastClose: last?.T, 边界对齐: aligned, 最后一根已收盘: closed, lastClosePx: last?.c });
    } catch (e) { note(`HL ${interval} K线`, false, String(e?.message || e)); }
  }
  try {
    const book = await post(HL_INFO, { type: 'l2Book', coin: SYMBOL });
    const levels = Array.isArray(book?.levels) ? book.levels : [];
    const bid0 = levels[0]?.[0], ask0 = levels[1]?.[0];
    note('HL l2Book 盘口', levels.length === 2 && bid0 && ask0, { bids: levels[0]?.length, asks: levels[1]?.length, bid0: bid0?.px, ask0: ask0?.px, 结构: 'levels[0]=bids levels[1]=asks {px,sz,n}' });
  } catch (e) { note('HL l2Book 盘口', false, String(e?.message || e)); }
  try {
    const data = await post(HL_INFO, { type: 'metaAndAssetCtxs' });
    const meta = data[0], ctxs = data[1];
    const i = meta.universe.findIndex((u) => u.name === SYMBOL);
    const ctx = ctxs[i] || {};
    note('HL 资金费率/标记价', i >= 0 && ctx.funding != null, { fundingHourly: ctx.funding, markPx: ctx.markPx, oraclePx: ctx.oraclePx, openInterest: ctx.openInterest });
  } catch (e) { note('HL 资金费率/标记价', false, String(e?.message || e)); }
}

async function probeBinance() {
  try {
    // 用 Binance 合约（fapi）而非现货：与 HL 永续同口径
    const rows = await getJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}USDT&interval=5m&limit=8`);
    // Binance klines 最后一条是"在途"K线：仅保留已收盘（openTime + 5m <= now）
    const nowMs = Date.now();
    const closed = rows.filter((r) => Number(r[0]) + 300_000 <= nowMs);
    const lastClosed = closed[closed.length - 1];
    note('Binance 合约 5M klines 可达', closed.length > 0, { closedCount: closed.length, lastClosedOpenTime: lastClosed?.[0], lastClosedClose: lastClosed?.[4] });
    return closed.map((r) => ({ openTime: Number(r[0]), close: Number(r[4]) }));
  } catch (e) {
    note('Binance 5M klines 可达', false, `${String(e?.message || e)}（若被地区限制，VPS 上走代理重测）`);
    return null;
  }
}

async function main() {
  await probeHl();
  if (WITH_BINANCE) {
    const binanceClosed = await probeBinance();
    // 偏差采样：按 openTime 显式匹配同一根 5M K 线（仅已收盘），多样本
    try {
      const now = Date.now();
      const rows = await post(HL_INFO, { type: 'candleSnapshot', req: { coin: SYMBOL, interval: '5m', startTime: now - 3600 * 1000, endTime: now } });
      const hlClosed = new Map((rows || []).filter((c) => Number(c.T) <= now).map((c) => [Number(c.t), Number(c.c)]));
      const devs = [];
      for (const b of binanceClosed || []) {
        const hl = hlClosed.get(b.openTime);
        if (hl && b.close) devs.push(Math.abs(hl / b.close - 1) * 10_000);
      }
      if (devs.length) {
        const avg = devs.reduce((a, x) => a + x, 0) / devs.length;
        note('HL/Binance 同根 5M 收盘偏差', true, { 样本数: devs.length, 平均bps: Number(avg.toFixed(2)), 最大bps: Number(Math.max(...devs).toFixed(2)), 明细bps: devs.map((x) => Number(x.toFixed(2))) });
      } else {
        note('HL/Binance 同根 5M 收盘偏差', false, '无匹配样本（时间边界不一致？）');
      }
    } catch (e) { note('HL/Binance 偏差采样', false, String(e?.message || e)); }
  }
  report.ok = report.checks.every((c) => c.ok);
  if (JSON_ONLY) console.log(JSON.stringify(report, null, 2));
  else console.log(`\n数据源探针结论: ${report.ok ? '全部通过' : '存在失败项（见上）'}`);
  process.exit(report.ok ? 0 : 3);
}

main().catch((e) => { console.error('探针异常:', e?.message || e); process.exit(3); });
