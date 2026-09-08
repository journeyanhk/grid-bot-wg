// VaTransport — Node ↔ Python (curl_cffi) bridge for Variational Omni.
//
// Node fetch cannot pass Cloudflare on omni.variational.io (403 challenge); a
// Chrome TLS/JA3 impersonation via curl_cffi does (200). This spawns the Python
// worker once and speaks JSON-lines over stdin/stdout — the exact pattern used by
// lr/signer.js. It exposes ONE method, request(method, path, {body, auth, token,
// address}), matching the seam in httpclient.js `this.transport.request(...)`.
//
// The worker returns the RAW {status, text, headers}; VaHttpClient still owns all
// Cloudflare-challenge detection and VaHttpError shaping, so live and probe paths
// share identical semantics. Token/address travel per-request, so a token refresh
// needs NO worker restart.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { logger } from '../../log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
// Resolve the Python interpreter that has curl_cffi. Priority:
//   1) explicit VA_PYTHON / opts.pythonPath (set this to your venv's python)
//   2) a bundled venv next to the repo (.va-venv / .runtime/python)
//   3) plain "python3" on PATH
function defaultPython() {
  const candidates = [
    path.join(ROOT, '.va-venv', 'bin', 'python3'),
    path.join(ROOT, '.va-venv', 'bin', 'python'),
    path.join(ROOT, '.va-venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.runtime', 'python', 'bin', 'python3'),
    path.join(ROOT, '.runtime', 'python', 'python.exe'),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'python3';
}

const START_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 20_000;

export class VaTransport {
  constructor(opts = {}) {
    this.python = opts.pythonPath || process.env.VA_PYTHON || defaultPython();
    this.worker = opts.workerPath || path.join(HERE, 'transport_worker.py');
    this.baseUrl = opts.baseUrl || process.env.VA_BASE_URL || 'https://omni.variational.io';
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.ready = null;
    this._restarts = 0;
  }

  async start() {
    if (this.child && !this.child.killed) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(this.python, ['-u', this.worker], {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, VA_BASE_URL: this.baseUrl, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      this.child = child;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('Variational 传输层（curl_cffi）启动超时。')); }
      }, START_TIMEOUT_MS);
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (!settled && Object.hasOwn(msg, 'ready')) {
          settled = true; clearTimeout(timer);
          if (msg.ready) resolve(true);
          else reject(new Error(msg.error || 'Variational 传输层启动失败。'));
          return;
        }
        const item = this.pending.get(msg.id);
        if (!item) return;
        this.pending.delete(msg.id); clearTimeout(item.timer);
        if (msg.ok) item.resolve(msg.result);
        else item.reject(new Error(msg.error || 'Variational 传输请求失败。'));
      });
      let stderr = '';
      child.stderr.on('data', (buf) => { stderr = (stderr + String(buf)).slice(-2000); });
      child.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`无法启动 Variational Python 传输层：${err.message}`)); }
        this._failAll(err);
      });
      child.on('exit', (code) => {
        this.child = null;
        const detail = stderr.trim().split(/\r?\n/).slice(-2).join(' ');
        const err = new Error(`Variational 传输层已退出（code=${code ?? 'unknown'}）${detail ? `：${detail}` : ''}`);
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        this._failAll(err);
      });
    });
    return this.ready;
  }

  /**
   * Normalized contract used by VaHttpClient: returns the RAW worker result
   * { status, text, headers } so the HTTP client keeps CF-detection in one place.
   */
  async request(method, reqPath, { body, auth = false, token = '', address = '' } = {}) {
    await this.start();
    if (!this.child?.stdin?.writable) throw new Error('Variational 传输层未运行。');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Variational 传输请求超时（${method} ${reqPath}）。`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const frame = JSON.stringify({ id, command: 'request', method, path: reqPath, body: body ?? null, auth, token, address }) + '\n';
      this.child.stdin.write(frame, (err) => {
        if (!err) return;
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id); clearTimeout(timer); reject(err);
      });
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.end(); } catch { /* ignore */ }
  }

  _failAll(error) {
    if (this.pending.size) logger.warn('va', `传输层中断，${this.pending.size} 个在途请求失败：${error.message}`);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}
