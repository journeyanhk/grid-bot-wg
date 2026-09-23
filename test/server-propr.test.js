// Propr server 集成测试：真实拉起 src/server.js（全部交易所 paper，无网络请求），
// 校验 /api/overview 含 propr、/api/propr/* 路由、SSE 首帧与 reconnect。
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18080 + Math.floor(Math.random() * 500);

function waitPort(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/version`);
        if (r.ok) return resolve(await r.json());
      } catch { /* 还没起来 */ }
      if (Date.now() > deadline) return reject(new Error('server 启动超时'));
      setTimeout(tick, 400);
    };
    tick();
  });
}

async function main() {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1', LOG_LEVEL: 'error',
      DE_MODE: 'paper', EX_MODE: 'paper', RS_MODE: 'paper', LR_MODE: 'paper',
      HL_MODE: 'paper', VA_MODE: 'paper', PR_MODE: 'paper',
      GLOBAL_PROXY: '', PR_PROXY: '',
      DASHBOARD_USER: '', DASHBOARD_PASS: '', DASHBOARD_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += String(d); });
  child.stderr.on('data', (d) => { logs += String(d); });

  try {
    const ver = await waitPort();
    assert.equal(ver.name, 'grid-bot-all');

    // /api/overview 必须包含 propr（paper 模式：卡片隐藏但状态在）
    const ov = await (await fetch(`http://127.0.0.1:${PORT}/api/overview`)).json();
    assert.ok(ov.propr, 'overview 必须包含 propr');
    assert.equal(ov.propr.mode, 'paper');
    assert.equal(ov.propr.exchangeInfo, null, 'paper 模式无适配器公开信息');

    // /api/propr/state 可访问
    const st = await (await fetch(`http://127.0.0.1:${PORT}/api/propr/state`)).json();
    assert.equal(st.running, false);
    assert.ok('openOrders' in st);

    // /api/propr/markets 返回 BTC（PaperExchange 兜底市场）
    const mk = await (await fetch(`http://127.0.0.1:${PORT}/api/propr/markets`)).json();
    assert.equal(mk.exchange, 'Propr');
    assert.ok(Array.isArray(mk.markets) && mk.markets.some((m) => m.marketId === 'BTC'), '市场列表必须含 BTC');

    // /api/propr/stream 首帧必须是 SSE data（且含状态字段）
    const ctrl = new AbortController();
    const streamRes = await fetch(`http://127.0.0.1:${PORT}/api/propr/stream`, { signal: ctrl.signal });
    const reader = streamRes.body.getReader();
    const first = await reader.read();
    const chunk = new TextDecoder().decode(first.value || new Uint8Array());
    assert.ok(chunk.startsWith('data: '), 'SSE 首帧必须是 data: 前缀');
    assert.ok('running' in JSON.parse(chunk.slice(6)));
    ctrl.abort();

    // /api/propr/reconnect 可调用且返回 ok
    const rc = await (await fetch(`http://127.0.0.1:${PORT}/api/propr/reconnect`, { method: 'POST' })).json();
    assert.equal(rc.ok, true);
  } catch (err) {
    console.error('server 日志尾部:\n' + logs.split('\n').slice(-20).join('\n'));
    throw err;
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 600));
    if (child.exitCode == null) child.kill('SIGKILL');
  }
}

main().then(() => console.log('server-propr.test.js 全部通过')).catch((err) => { console.error(err); process.exit(1); });
