// 结构化日志：JSON lines 写入 logs/app-YYYY-MM-DD.log（按天轮转），控制台同步
// 可读输出。LOG_LEVEL（error|warn|info|debug，默认 info）与 LOG_DIR（默认 logs/）
// 通过环境变量配置。任何日志失败（目录不可写/序列化异常）都绝不影响交易主路径。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const level = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const dir = path.resolve(ROOT, process.env.LOG_DIR || 'logs');

let stream = null;
let day = null;

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 按天轮转：日期变化时关闭旧文件、打开新文件（append）。 */
function rotate() {
  const t = today();
  if (stream && day === t) return;
  if (stream) { try { stream.end(); } catch { /* ignore */ } }
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  day = t;
  try {
    stream = fs.createWriteStream(path.join(dir, `app-${t}.log`), { flags: 'a' });
    stream.on('error', () => { /* 磁盘错误不打断交易 */ });
  } catch { /* ignore */ }
}

function write(lvl, module, msg, ctx) {
  if (LEVELS[lvl] > level) return;
  const rec = { t: new Date().toISOString(), level: lvl, module, msg: String(msg ?? '') };
  if (ctx && typeof ctx === 'object') Object.assign(rec, ctx);
  let line;
  try { line = JSON.stringify(rec); } catch { line = JSON.stringify({ t: rec.t, level: rec.level, module: rec.module, msg: rec.msg }); }
  try { rotate(); if (stream) stream.write(line + '\n'); } catch { /* ignore */ }
  const fn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
  try {
    fn(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} [${lvl.toUpperCase()}] [${module}] ${rec.msg}`);
  } catch { /* ignore */ }
}

export const logger = {
  info: (module, msg, ctx) => write('info', module, msg, ctx),
  warn: (module, msg, ctx) => write('warn', module, msg, ctx),
  error: (module, msg, ctx) => write('error', module, msg, ctx),
  debug: (module, msg, ctx) => write('debug', module, msg, ctx),
};
