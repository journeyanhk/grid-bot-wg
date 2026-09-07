// HL (Hyperliquid) Python signer bridge: spawns signer_worker.py and talks
// JSON-lines over stdin/stdout.  The worker holds only an agent wallet key
// (can trade, cannot withdraw) so the Node process never touches raw keys.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

function defaultPython() {
  const portable = path.join(ROOT, '.runtime', 'python', 'python.exe');
  const bundled = path.join(ROOT, '.hl-venv', 'Scripts', 'python.exe');
  if (fs.existsSync(portable)) return portable;
  return fs.existsSync(bundled) ? bundled : 'python';
}

export class HLSignerBridge {
  constructor(opts = {}) {
    this.python = opts.pythonPath || defaultPython();
    this.worker = opts.workerPath || path.join(HERE, 'signer_worker.py');
    this.env = {
      HL_API_URL: opts.apiUrl,
      HL_ACCOUNT_ADDRESS: opts.accountAddress || '',
      HL_AGENT_PRIVATE_KEY: opts.agentPrivateKey || '',
      HL_AGENT_PRIVATE_KEY_FILE: opts.agentPrivateKeyFile || '',
    };
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.ready = null;
  }

  async start() {
    if (this.child && !this.child.killed) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(this.python, ['-u', this.worker], {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      this.child = child;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) reject(new Error('HL 签名器启动超时。'));
      }, 15_000);
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (!settled && Object.hasOwn(msg, 'ready')) {
          settled = true; clearTimeout(timer);
          if (msg.ready) resolve(true);
          else reject(new Error(msg.error || 'HL 签名器启动失败。'));
          return;
        }
        const item = this.pending.get(msg.id);
        if (!item) return;
        this.pending.delete(msg.id); clearTimeout(item.timer);
        if (msg.ok) item.resolve(msg.result);
        else item.reject(new Error(msg.error || 'HL 签名失败。'));
      });
      let stderr = '';
      child.stderr.on('data', (buf) => { stderr = (stderr + String(buf)).slice(-2000); });
      child.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`无法启动 HL Python 签名器：${err.message}`)); }
        this._failAll(err);
      });
      child.on('exit', (code) => {
        this.child = null;
        const detail = stderr.trim().split(/\r?\n/).slice(-2).join(' ');
        const err = new Error(`HL 签名器已退出（code=${code ?? 'unknown'}）${detail ? `：${detail}` : ''}`);
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        this._failAll(err);
      });
    });
    return this.ready;
  }

  async request(command, payload = {}, timeoutMs = 15_000) {
    await this.start();
    if (!this.child?.stdin?.writable) throw new Error('HL 签名器未运行。');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HL 签名命令 ${command} 超时。`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, command, ...payload }) + '\n', (err) => {
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
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}