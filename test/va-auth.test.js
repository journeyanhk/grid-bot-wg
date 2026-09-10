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
  const a = new VaAuth({ http, address: '0xA', envToken: jwt(inHours(48)), privateKey: '0xpk' });
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
  const a = new VaAuth({ http, address: '0xA', privateKey: '0xpk', cachePath: cache });
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
  const a = new VaAuth({ http, address: '0xA', envToken: jwt(inHours(-1)), privateKey: '0xpk', cachePath: cache });
  await a.init();
  assert.equal(logins, 0, 'env 过期但缓存有效 → 不登录');
  assert.equal(http.token, cacheTok, '用缓存 token');
  fs.unlinkSync(cache);
}

// ④ 健康 token 时 ensure() 不续签；<24h 时续签
{
  let logins = 0;
  const http = makeHttp(async () => { logins++; return { token: jwt(inHours(168)) }; });
  const a = new VaAuth({ http, address: '0xA', envToken: jwt(inHours(48)), privateKey: '0xpk' });
  await a.init();               // 48h 健康
  await a.ensure();
  assert.equal(logins, 0, '健康 token 不续签');
  // 手动置成 <24h 的 token → ensure 应续签
  a._use(jwt(inHours(5)));
  a._lastLoginAt = 0;           // 清节流
  await a.ensure();
  assert.equal(logins, 1, '剩余 <24h 应续签一次');
}

// ⑤ 节流：throttle 窗内不重复登录；force 绕过；每小时上限
{
  let logins = 0;
  const http = makeHttp(async () => { logins++; return { token: jwt(inHours(1)) }; });
  const a = new VaAuth({ http, address: '0xA', privateKey: '0xpk' });
  await a.init();               // 首登（boot）→ logins=1，且 token 只剩 1h
  assert.equal(logins, 1);
  await a.ensure();             // 距上次 <5min → 节流，不登录
  assert.equal(logins, 1, '节流窗内不重复登录');
  await a.ensure({ force: true }); // force 绕过节流
  assert.equal(logins, 2, 'force 绕过节流');
  // 每小时上限：已 2 次，再灌到 6 次后应停
  for (let i = 0; i < 10; i++) await a.ensure({ force: true });
  assert.ok(logins <= 6, `每小时上限 6，实际 ${logins}`);
}

// ⑥ 连续 2 次失败 → onAlert（❌）
{
  const alerts = [];
  const http = makeHttp(async () => { throw new Error('boom'); });
  const a = new VaAuth({ http, address: '0xA', privateKey: '0xpk', onAlert: (m) => alerts.push(m) });
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

console.log('✓ va-auth.test.js 全部通过');
