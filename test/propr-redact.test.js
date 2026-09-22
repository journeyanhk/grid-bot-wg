// Propr Review 1 tests: log redaction, error classification and startup guards.
// 目标：证明 API Key 与认证信息不会出现在任何对外输出中（含日志边界），且四种模式的启动护栏生效。
import { strict as assert } from 'node:assert';
import { maskAccountId, redactSecrets, redactRecord, safeError } from '../src/redact.js';
import { logger } from '../src/log.js';
import { validateProprConfig } from '../src/config.js';
import { ProprReadOnlyError, UnknownOrderStateError, classifyProprError, isRetryableProprError, isAuthError } from '../src/exchange/propr/errors.js';
import { ProprAPIError } from '../src/exchange/propr/propr-sdk.js';

{
  // accountId 仅保留前 4 + 后 4
  assert.equal(maskAccountId('acct-1234567890'), 'acct****7890');
  assert.equal(maskAccountId('short'), '****');
  assert.equal(maskAccountId(''), '');
}

{
  // 文本脱敏：pk_live / Bearer / key=value 三类凭证都必须被抹掉
  const raw = 'key=pk_live_ABC123xyz header=Bearer eyJhbGciOi.J9 tail apiKey: sk-abc';
  const out = redactSecrets(raw);
  assert.ok(!out.includes('pk_live_ABC123xyz'), 'pk_live key 必须被抹掉');
  assert.ok(!out.includes('eyJhbGciOi.J9'), 'Bearer token 必须被抹掉');
  assert.ok(out.includes('pk_***REDACTED***'));
  assert.ok(out.includes('***REDACTED***'));
}

{
  // 结构化脱敏：密钥字段整体替换，accountId 按 4+4 掩码，嵌套对象/数组/Error 全覆盖
  const rec = redactRecord({
    apiKey: 'pk_live_SECRET',
    nested: { authorization: 'Bearer abc', accountId: 'acct-1234567890' },
    list: [{ token: 't0k3n' }],
    err: new Error('failed with pk_live_SECRET'),
  });
  assert.equal(rec.apiKey, '***REDACTED***');
  assert.equal(rec.nested.authorization, '***REDACTED***');
  assert.equal(rec.nested.accountId, 'acct****7890', 'accountId 必须按前 4+后 4 掩码');
  assert.equal(rec.list[0].token, '***REDACTED***');
  assert.ok(!rec.err.message.includes('pk_live_SECRET'), 'Error.message 也必须脱敏');
}

{
  // 深度上限：超过 6 层不再透传原值（防深层泄漏/循环引用）
  let deep = 'pk_live_DEEP';
  for (let i = 0; i < 8; i++) deep = { nested: deep };
  const out = JSON.stringify(redactRecord(deep));
  assert.ok(!out.includes('pk_live_DEEP'), '深层字符串不得泄漏');
  assert.ok(out.includes('REDACTED_DEPTH_LIMIT'));
}

{
  // safeError：统一错误包装（进入日志/告警/SSE 前必须经过）
  const se = safeError(new ProprAPIError(401, 1001, 'bad key pk_live_SECRET'));
  assert.equal(se.name, 'ProprAPIError');
  assert.equal(se.statusCode, 401);
  assert.equal(se.code, 1001);
  assert.ok(!se.message.includes('pk_live_SECRET'));
}

{
  // 日志边界：logger 输出的 msg 必须已脱敏（Review1 P0）
  const orig = console.error; let captured = '';
  console.error = (line) => { captured += String(line); };
  try { logger.error('propr', '请求失败 pk_live_SECRET'); } finally { console.error = orig; }
  assert.ok(!captured.includes('pk_live_SECRET'), '日志控制台输出必须脱敏');
  assert.ok(captured.includes('pk_***REDACTED***'));
}

{
  // 启动护栏：paper 放行
  assert.doesNotThrow(() => validateProprConfig({ mode: 'paper' }));

  // 非 paper 必须显式 Key 与 accountId
  assert.throws(() => validateProprConfig({ mode: 'shadow', accountId: 'a-1234567890' }), /PROPR_API_KEY/);
  assert.throws(() => validateProprConfig({ mode: 'shadow', apiKey: 'pk_live_x' }), /PROPR_ACCOUNT_ID/);

  // 白名单非空时必须命中（错误信息中账户已掩码）
  assert.throws(
    () => validateProprConfig({ mode: 'sim-write', apiKey: 'pk_live_x', accountId: 'a-1234567890', allowedAccountIds: ['other'] }),
    /a-12\*\*\*\*7890/,
  );
  assert.doesNotThrow(() => validateProprConfig({
    mode: 'sim-write', apiKey: 'pk_live_x', accountId: 'a-1234567890', allowedAccountIds: ['a-1234567890'],
  }));

  // challenge 双保险
  assert.throws(
    () => validateProprConfig({ mode: 'challenge', apiKey: 'pk_live_x', accountId: 'a-1234567890', allowChallenge: false }),
    /PR_ALLOW_CHALLENGE=YES/,
  );
  assert.doesNotThrow(() => validateProprConfig({
    mode: 'challenge', apiKey: 'pk_live_x', accountId: 'a-1234567890', allowChallenge: true,
  }));
}

{
  // 错误分类：只读拦截/未知订单态/超时/限频/5xx/鉴权/拒单
  assert.equal(classifyProprError(new ProprReadOnlyError('placeLimitOrder')), 'read_only');
  assert.equal(classifyProprError(new UnknownOrderStateError('x')), 'unknown_order_state');
  assert.equal(classifyProprError(new ProprAPIError(429, null, 'rate')), 'rate_limited');
  assert.equal(classifyProprError(new ProprAPIError(500, null, 'oops')), 'server');
  assert.equal(classifyProprError(new ProprAPIError(401, null, 'bad key')), 'auth');
  assert.equal(classifyProprError(new ProprAPIError(400, null, 'bad params')), 'rejected');
  assert.equal(classifyProprError(new Error('fetch failed')), 'network');

  assert.equal(isRetryableProprError(new ProprAPIError(429, null, 'rate')), true);
  assert.equal(isRetryableProprError(new ProprAPIError(500, null, 'oops')), true);
  assert.equal(isRetryableProprError(new ProprAPIError(400, null, 'bad')), false);
  assert.equal(isRetryableProprError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), true);
  assert.equal(isAuthError(new ProprAPIError(403, null, 'forbidden')), true);
  assert.equal(isAuthError(new ProprAPIError(400, null, 'bad')), false);
}

console.log('propr-redact.test.js 全部通过');
