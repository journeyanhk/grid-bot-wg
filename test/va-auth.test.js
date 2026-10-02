// VaAuth 单测：token 解析优先级、续签、节流/每小时上限、连续失败告警、缓存落盘。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaAuth, decodeJwtExp } from '../src/exchange/va/auth.js';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (expSec) => `h.${b64url({ exp: expSec })}.s`;
const inHours = (h) => Math.floor(Date.now() / 1000) + h * 3600;

// ── decodeJwtExp ──
assert.equal(decodeJwtExp(jwt(inHours(48))), inHours(48));
assert.equal(decodeJwtExp('not-a-jwt'), null);
assert.equal(decodeJwtExp(''), null);

// 假 http：记录 setToken，login 可注入实现。
function makeHttp(login) {
  return { token: '', setToken(t) { this.token = t || ''; }, login };
}

// ① env token 有效（48h）→ 直接用，不触发登录
{
  let logins = 0;
  const http = makeHttp(async () => { logins++; return { token: jwt(inHours(168)) }; });
  const a = new VaAuth({ http, address: '0xA', envToken: jwt(inHours(48)), hasPrivateKey: true });
  await a.init();
  assert.equal(logins, 0, 'env token 有效时不应登录');
  assert.equal(http.token, jwt(inHours(48)), 'http 用上 env token');
}

// ② 无 token + 有私钥 → 登录并写缓存
{
  let logins = 0;
  const tok = jwt(inHours(168));
  const http = makeHttp(async () => { logins++; return { token: tok }; });
  const cache = path.join(os.tmpdir(), `vatok-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const a = new VaAuth({ http, address: '0xA', hasPrivateKey: true, cachePath: cache });
  await a.init();
  assert.equal(logins, 1, '无 token 有私钥应登录一次');
  assert.equal(http.token, tok, '登录后 http 拿到新 token');
  const saved = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.equal(saved.token, tok, '缓存写入 token');
  const mode = fs.statSync(cache).mode & 0o777;
  assert.equal(mode, 0o600, '缓存文件 600 权限');
  fs.unlinkSync(cache);
}

// ③ env 过期但缓存有效 → 用缓存，不登录
{
  let logins = 0;
  const cacheTok = jwt(inHours(100));
  const cache = path.join(os.tmpdir(), `vatok-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cache, JSON.stringify({ token: cacheTok }));
  const http = makeHttp(async () => { logins++; return { token: jwt(inHours(168)) }; });
  const a = new VaAuth({ http, address: '0xA', envToken: jwt(inHours(-1)), hasPrivateKey: true, cachePath: cache });
  await a.init();
  assert.equal(logins, 0, 'env 过期但缓存有效 → 不登录');
  assert.equal(http.token, cacheTok, '用缓存 token');
  fs.unlinkSync(cache);
}

// ④ 健康 token 时 ensure() 不续签；<24h 时续签
{
  let logins = 0;
  const http = makeHttp(async () => { logins++; return { token: jwt(inHours(168)) }; });
  const a = new VaAuth({ http, address: '0xA', envToken: jwt(inHours(48)), hasPrivateKey: true });
  await a.init();               // 48h 健康
  await a.ensure();
  assert.equal(logins, 0, '健康 token 不续签');
  // 手动置成 <24h 的 token → ensure 应续签
  a._use(jwt(inHours(5)));
  a._lastLoginAt = 0;           // 清节流
  await a.ensure();
  assert.equal(logins, 1, '剩余 <24h 应续签一次');
}

// ⑤ 节流：健康 5min 窗不重复；force 也有 60s 下限；每小时上限 6
{
  let logins = 0;
  const http = makeHttp(async () => { logins++; return { token: jwt(inHours(1)) }; });
  const a = new VaAuth({ http, address: '0xA', hasPrivateKey: true });
  await a.init();               // 首登（boot）→ logins=1，且 token 只剩 1h
  assert.equal(logins, 1);
  await a.ensure();             // 距上次 <5min → 健康节流，不登录
  assert.equal(logins, 1, '健康节流窗内不重复登录');
  await a.ensure({ force: true }); // 距上次 <60s → force 也被节流
  assert.equal(logins, 1, 'force 仍受 60s 下限约束');
  a._lastLoginAt = Date.now() - 61_000; // 模拟已过 60s
  await a.ensure({ force: true });       // force 且已过 60s → 续签
  assert.equal(logins, 2, 'force 且过 60s 后续签');
  // 每小时上限：清 60s 节流后连灌，到 6 次应停
  for (let i = 0; i < 10; i++) { a._lastLoginAt = 0; await a.ensure({ force: true }); }
  assert.ok(logins <= 6, `每小时上限 6，实际 ${logins}`);
}

// ⑥ 连续 2 次失败 → onAlert（❌）
{
  const alerts = [];
  const http = makeHttp(async () => { throw new Error('boom'); });
  const a = new VaAuth({ http, address: '0xA', hasPrivateKey: true, onAlert: (m) => alerts.push(m) });
  await a.init();                 // 第 1 次失败（仅日志）
  a._lastLoginAt = 0;
  await a.ensure({ force: true }); // 第 2 次失败 → 告警
  assert.equal(alerts.length, 1, '连续 2 次失败触发一次告警');
  assert.ok(/❌/.test(alerts[0]) && /自动登录/.test(alerts[0]));
}

// ⑦ 无私钥 → canRefresh=false，ensure 不登录
{
  let logins = 0;
  const http = makeHttp(async () => { logins++; return { token: jwt(inHours(168)) }; });
  const a = new VaAuth({ http, address: '0xA', envToken: jwt(inHours(-1)) }); // 无私钥
  assert.equal(a.canRefresh(), false);
  await a.init();
  assert.equal(logins, 0, '无私钥不登录');
}

// ⑧ env 5h + 缓存 6d → _pickSeed 按 exp 取最新（用缓存），不登录
{
  let logins = 0;
  const cacheTok = jwt(inHours(6 * 24));      // 6 天
  const cache = path.join(os.tmpdir(), `vatok-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cache, JSON.stringify({ token: cacheTok }));
  const http = makeHttp(async () => { logins++; return { token: jwt(inHours(168)) }; });
  const a = new VaAuth({ http, address: '0xA', envToken: jwt(inHours(5)), hasPrivateKey: true, cachePath: cache });
  await a.init();
  assert.equal(http.token, cacheTok, 'env 5h vs 缓存 6d → 选缓存（exp 更晚）');
  assert.equal(logins, 0, '缓存更新鲜，无需登录');
  fs.unlinkSync(cache);
}

// ⑨ 401 风暴：连续 20 轮 force 续签，受 60s 节流 + 每小时上限约束 → 登录次数 <=6
{
  let logins = 0;
  const http = makeHttp(async () => { logins++; return { token: jwt(inHours(1)) }; });
  const a = new VaAuth({ http, address: '0xA', hasPrivateKey: true });
  await a.init();                              // boot 首登 → logins=1
  // 每轮清掉 60s 节流，只留每小时上限把关 → 20 轮 401 仍 <=6 次登录
  for (let i = 0; i < 20; i++) { a._lastLoginAt = 0; await a.ensure({ force: true }); }
  assert.ok(logins <= 6, `401 风暴下登录应 <=6，实际 ${logins}`);
  assert.ok(logins >= 1, '至少首登一次');
}

// ⑩ adopt：空/过期拒绝；有效 token 接纳并落缓存 + setToken
{
  const http = makeHttp(async () => ({ token: jwt(inHours(168)) }));
  const cache = path.join(os.tmpdir(), `vatok-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const a = new VaAuth({ http, address: '0xA', cachePath: cache });
  assert.throws(() => a.adopt(''), /为空/, '空 token 应拒绝');
  assert.throws(() => a.adopt(jwt(inHours(-1))), /过期/, '过期 token 应拒绝');
  const good = jwt(inHours(100));
  const info = a.adopt(good);
  assert.equal(http.token, good, 'adopt 后 http 拿到新 token');
  assert.ok(info.hrs >= 90 && info.hrs <= 100, 'adopt 返回剩余小时数');
  assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).token, good, 'adopt 落缓存');
  fs.unlinkSync(cache);
}

// ══ refresh 模式（wg004-desgin15：5 分钟 access + ll-token 续期）══════════════
// 假 http 支持 refresh（记录调用参数/可注入结果）。
function makeRefreshHttp(refreshImpl) {
  return {
    token: '', setToken(t) { this.token = t || ''; },
    login: async () => ({ token: jwt(inHours(168)) }),
    refreshCalls: [],
    async refresh(args) { this.refreshCalls.push(args); return refreshImpl(args); },
  };
}
const mkCache = () => path.join(os.tmpdir(), `vatok-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

// ⑪ mode：ll-token + http.refresh -> refresh；无 ll -> siwe/manual（既有语义不变）
{
  const http = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(1)) }));
  const a = new VaAuth({ http, address: '0xA', llToken: 'll-abc.def' });
  assert.equal(a.mode(), 'refresh');
  const b = new VaAuth({ http: makeHttp(async () => ({ token: jwt(inHours(168)) })), address: '0xA' });
  assert.equal(b.mode(), 'manual');
  assert.equal(new VaAuth({ http, hasPrivateKey: true }).mode(), 'siwe');
}

// ⑫ 剩余 <90s -> 续期并写缓存（含 llToken/envSeed）
{
  const cache = mkCache();
  const newTok = jwt(inHours(1));
  const http = makeRefreshHttp(async () => ({ ok: true, status: 200, token: newTok, setCookies: {} }));
  const a = new VaAuth({ http, address: '0xA', llToken: 'll-abc.def', envToken: jwt(inHours(0.01)) /* ~36s */, cachePath: cache });
  await a.init();
  assert.equal(http.refreshCalls.length, 1, '临期应续期一次');
  assert.equal(http.refreshCalls[0].llToken, 'll-abc.def', '携带 ll-token');
  assert.ok(http.refreshCalls[0].token, '必须携带同会话 vr-token（ll-only 会被 400）');
  assert.equal(http.token, newTok, '新 token 已生效');
  assert.equal(a.stats().totalRefresh, 1);
  const saved = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.equal(saved.llToken, 'll-abc.def');
  assert.equal(saved.envSeed, 'll-abc.def', 'envSeed 记录本次 env 值（用于变更检测）');
  fs.unlinkSync(cache);
}

// ⑬ 剩余 >90s -> 不续期
{
  const http = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(1)) }));
  const a = new VaAuth({ http, address: '0xA', llToken: 'll', envToken: jwt(inHours(0.5)) /* 30min */, cachePath: '' });
  await a.init();
  assert.equal(http.refreshCalls.length, 0, '健康态不应续期');
}

// ⑭ 节流：10s 内二次 ensure 不重复续期；force 也受节流
{
  let now = Date.now();
  const origNow = Date.now;
  Date.now = () => now;
  try {
    const http = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(0.5)), setCookies: {} }));
    const a = new VaAuth({ http, address: '0xA', llToken: 'll', envToken: jwt(inHours(0.01)) });
    await a.init();                       // boot 首续期
    const first = http.refreshCalls.length;
    await a.ensure({ force: true });      // 10s 内 -> 节流
    assert.equal(http.refreshCalls.length, first, '节流窗内不重复续期');
    now += 11_000;
    await a.ensure({ force: true });
    assert.equal(http.refreshCalls.length, first + 1, '节流窗过后可续期');
  } finally { Date.now = origNow; }
}

// ⑮-a 400（会话不匹配/ll 失效）立即 critical，不等第 4 次（Review24 P2-1）
{
  const alerts = [];
  const http = makeRefreshHttp(async () => ({ ok: false, status: 400, detail: 'Unable to refresh session' }));
  const a = new VaAuth({ http, address: '0xA', llToken: 'll', envToken: jwt(inHours(0.01)), onAlert: (m) => alerts.push(m) });
  await a.init();                          // 第一次即 400
  assert.equal(a.stats().totalRefreshFail, 1);
  assert.ok(alerts.some((m) => m.includes('同一会话')), `400 应立即 critical 并指向同会话（${alerts.join('|')}）`);
}

// ⑮-b 非 400（如 500/传输层）→ 分级：第 2 次才 warn
{
  const alerts = [];
  const http = makeRefreshHttp(async () => ({ ok: false, status: 500, detail: 'server error' }));
  const a = new VaAuth({ http, address: '0xA', llToken: 'll', envToken: jwt(inHours(0.01)), onAlert: (m) => alerts.push(m) });
  await a.init();                              // 第 1 次失败：仅日志
  assert.equal(alerts.length, 0, '首次 500 不打扰');
  a._lastRefreshAt = 0;
  await a.ensure({ force: true, boot: true }); // 第 2 次失败：warn
  assert.ok(alerts.some((m) => m.includes('2 次')), `第 2 次失败应告警（${alerts.join('|')}）`);
}

// ⑯ 轮换：Set-Cookie vr-ll-token -> 采纳并持久化（重启不退回旧值）
{
  const cache = mkCache();
  const http = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(0.5)), setCookies: { 'vr-ll-token': 'rotated.ll' } }));
  const a = new VaAuth({ http, address: '0xA', llToken: 'old.ll', envToken: jwt(inHours(0.01)), cachePath: cache });
  await a.init();
  assert.equal(a.llToken, 'rotated.ll', '轮换被采纳');
  assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).llToken, 'rotated.ll', '轮换持久化');
  // 重启（无 env ll-token）→ 从缓存取轮换后的值
  const http2 = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(0.5)) }));
  const a2 = new VaAuth({ http: http2, address: '0xA', cachePath: cache, envToken: jwt(inHours(0.01)) });
  await a2.init();
  assert.equal(a2.llToken, 'rotated.ll', '重启取缓存轮换值');
  fs.unlinkSync(cache);
}

// ⑰ env 变更优先：.env 与缓存的 envSeed 不一致 -> 用 env
{
  const cache = mkCache();
  fs.writeFileSync(cache, JSON.stringify({ token: jwt(inHours(0.5)), llToken: 'cached.ll', envSeed: 'old-env.ll' }));
  const http = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(0.5)) }));
  const a = new VaAuth({ http, address: '0xA', llToken: 'new-env.ll', envToken: jwt(inHours(0.01)), cachePath: cache });
  await a.init();
  assert.equal(a.llToken, 'new-env.ll', '用户改了 .env -> env 优先');
  fs.unlinkSync(cache);
}

// ⑱ adopt({token(可过期), llToken})：refresh 模式接受过期 token；仅 ll 无 token 拒绝并给指引
{
  const http = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(0.5)), setCookies: {} }));
  const a = new VaAuth({ http, address: '0xA' });
  const info = a.adopt(jwt(inHours(-1)), 'll.abc');
  assert.equal(info.mode, 'refresh', '带 ll-token 时接受过期 access token');
  assert.equal(a.llToken, 'll.abc');

  const b = new VaAuth({ http: makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(0.5)) })), address: '0xA' });
  b.llToken = 'll.abc';
  assert.throws(() => b.adopt('', ''), /同时粘贴/, '仅 ll-token 无 vr-token 应给出指引');
}

// ⑲ 冷启动缺同会话 token：ensure 不调用 refresh，且一次性提示
{
  const alerts = [];
  const http = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(0.5)) }));
  const a = new VaAuth({ http, address: '0xA', llToken: 'll.abc', onAlert: (m) => alerts.push(m) });
  await a.init();
  assert.equal(http.refreshCalls.length, 0, '无 token 不应调用 refresh（ll-only 会被 400）');
  assert.ok(alerts.some((m) => m.includes('缺少 vr-token')), '应提示面板同时粘贴两者');
}

// ⑳ httpclient 钩子：beforeAuth 被调用 + Set-Cookie 被动捕获 + refresh 封装
{
  const { VaHttpClient } = await import('../src/exchange/va/httpclient.js');
  let beforeAuthCalls = 0;
  const captured = [];
  const client = new VaHttpClient({
    transport: {
      async request() { return { status: 200, text: 'null', headers: {}, set_cookies: { 'vr-token': 'rotated-access' } }; },
      async refresh() { return { status: 200, text: '', headers: {}, set_cookies: {}, token: 't-new', exp: 1 }; },
    },
  });
  client.beforeAuth = async () => { beforeAuthCalls++; };
  client.onServerCookies = (c) => captured.push(c);
  await client.get('/api/portfolio', { auth: true });
  assert.equal(beforeAuthCalls, 1, '鉴权请求触发 beforeAuth');
  assert.equal(captured[0]?.['vr-token'], 'rotated-access', '被动捕获 Set-Cookie');
  const out = await client.refresh({ llToken: 'll', token: 'vr' });
  assert.equal(out.ok, true);
  assert.equal(out.token, 't-new');
}

// ㉑ pickSeed 同会话规则（Review24 P2-2）：未改 .env -> 缓存 token 优先（不按 exp 选）
{
  const cache = mkCache();
  const cacheTok = jwt(inHours(0.2)); // 更短 exp
  const envTok = jwt(inHours(9));     // 更长 exp（旧会话残留的诱惑）
  fs.writeFileSync(cache, JSON.stringify({ token: cacheTok, llToken: 'll.same', envSeed: '' }));
  const http = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(1)) }));
  const a = new VaAuth({ http, address: '0xA', llToken: 'll.same', envToken: envTok, cachePath: cache });
  await a.init();
  assert.equal(http.token, cacheTok, '缓存 token 优先（同会话），不按 exp 选 env');
  fs.unlinkSync(cache);
}

// ㉒ .env 换了新 ll-token -> 旧缓存 token 不采用（同会话原则）；无 env token 则冷启动提示
{
  const cache = mkCache();
  fs.writeFileSync(cache, JSON.stringify({ token: jwt(inHours(5)), llToken: 'old.ll', envSeed: 'old.ll' }));
  const envTok = jwt(inHours(0.01));
  const http = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(1)) }));
  const a = new VaAuth({ http, address: '0xA', llToken: 'new.ll', envToken: envTok, cachePath: cache });
  await a.init();
  assert.equal(http.refreshCalls[0]?.token, envTok, 'env 换 ll 后应使用 env token（新会话）');

  const cache2 = mkCache();
  fs.writeFileSync(cache2, JSON.stringify({ token: jwt(inHours(5)), llToken: 'old.ll', envSeed: 'old.ll' }));
  const alerts = [];
  const http2 = makeRefreshHttp(async () => ({ ok: true, status: 200, token: jwt(inHours(1)) }));
  const b = new VaAuth({ http: http2, address: '0xA', llToken: 'new.ll', cachePath: cache2, onAlert: (m) => alerts.push(m) });
  await b.init();
  assert.equal(http2.refreshCalls.length, 0, '换 ll 且无新 token -> 不拿旧会话 token 硬试');
  assert.ok(alerts.some((m) => m.includes('缺少 vr-token')), '应提示面板贴两枚');
  fs.unlinkSync(cache); fs.unlinkSync(cache2);
}

// ㉓ P1：refresh 模式健康检查节流 60s（而非 30min），4 分钟停滞立即 warn；1 分钟内不重复
{
  const { VariationalExchange } = await import('../src/exchange/va/variational.js');
  const notes = [];
  const fake = {
    auth: { mode: () => 'refresh', stats: () => ({ lastRefreshOkAt: Date.now() - 4 * 60_000, totalRefreshFail: 0 }) },
    _lastTokenCheckAt: 0,
    _notify: (p) => notes.push(p),
    http: { hasToken: () => true },
  };
  VariationalExchange.prototype._checkTokenLife.call(fake, { throttle: true });
  assert.equal(notes.length, 1, '4 分钟停滞应告警（阈值 3 分钟）');
  assert.equal(notes[0].level, 'warn');
  assert.equal(notes[0].key, 'refresh-health');
  VariationalExchange.prototype._checkTokenLife.call(fake, { throttle: true });
  assert.equal(notes.length, 1, '60s 节流内不重复');
}

console.log('✓ va-auth.test.js 全部通过');
