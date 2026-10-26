// Propr 只读客户端：白名单、错误分类、分页、写不可达。
import { strict as assert } from 'node:assert';
import { ProprClient, ulid, GET_ROUTES } from '../src/exchange/pr/client.js';
import { ProprApiError, ProprReadOnlyError, classify, CODES } from '../src/exchange/pr/errors.js';

const okFetch = (body, status = 200) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

{
  // 白名单外不可达
  const c = new ProprClient({ apiKey: 'k', fetchImpl: okFetch({}) });
  await assert.rejects(() => c.get('accounts/delete', []), /未登记/);
  assert.ok(GET_ROUTES.account('urn:prp-account:x').endsWith('/accounts/urn:prp-account:x'));
}

{
  // 正常 GET + 头部
  let seen = null;
  const c = new ProprClient({
    apiKey: 'pk_test', baseUrl: 'https://api.example/v1',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => '{"data":{"balance":"5000"}}' }; },
  });
  const body = await c.getAccount('urn:prp-account:abc');
  assert.equal(body.data.balance, '5000');
  assert.equal(seen.init.headers['X-API-Key'], 'pk_test');
  assert.equal(seen.init.method, 'GET');
  assert.ok(seen.url.includes('/accounts/urn:prp-account:abc'));
}

{
  // 401 → 终态
  const c = new ProprClient({ apiKey: 'bad', fetchImpl: okFetch({ code: CODES.UNAUTHORIZED, message: 'unauthorized' }, 401) });
  const err = await c.getUser().then(() => null, (e) => e);
  assert.ok(err instanceof ProprApiError);
  assert.equal(err.status, 401);
  assert.equal(classify(err).terminal, true);
  assert.equal(classify(err).retryable, false);
}

{
  // 429 → 可重试；5xx → mayExist（写请求可能已生效）
  const r429 = await new ProprClient({ apiKey: 'k', fetchImpl: okFetch({ message: 'rate' }, 429) }).getUser().catch((e) => e);
  assert.equal(classify(r429).retryable, true);
  const r500 = await new ProprClient({ apiKey: 'k', fetchImpl: okFetch({ message: 'boom' }, 500) }).getUser().catch((e) => e);
  assert.equal(classify(r500).retryable, true);
  assert.equal(classify(r500).mayExist, true);
}

{
  // 网络错误 → status 0 + mayExist
  const c = new ProprClient({ apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  const err = await c.getUser().catch((e) => e);
  assert.equal(err.status, 0);
  assert.equal(classify(err).mayExist, true);
}

{
  // 分页：100 + 40 两页；超过 maxPages 抛错而不是静默截断
  const paged = new ProprClient({
    apiKey: 'k', pageLimit: 100, maxPages: 3,
    fetchImpl: async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      const n = offset === 0 ? 100 : 40;
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ tradeId: `t${offset + i}` })) }) };
    },
  });
  const r = await paged.getTrades('urn:prp-account:a');
  assert.equal(r.rows.length, 140);
  assert.equal(r.pages, 2);
  assert.equal(r.complete, true);

  const stuck = new ProprClient({
    apiKey: 'k', pageLimit: 2, maxPages: 2,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{}, {}] }) }),
  });
  await assert.rejects(() => stuck.getTrades('urn:prp-account:a'), /拒绝静默截断/);
}

{
  // 写操作：M1 不可达，且计数 +1
  const c = new ProprClient({ apiKey: 'k', fetchImpl: okFetch({}) });
  assert.throws(() => c.placeLimitOrder(), ProprReadOnlyError);
  assert.throws(() => c.cancelAll(), ProprReadOnlyError);
  assert.equal(c.writeAttemptCount, 2);
  assert.equal(c.requestCount, 0);
}

{
  // ULID：26 字符、时间前缀递增
  const a = ulid(1_700_000_000_000);
  const b = ulid(1_700_000_000_001);
  assert.equal(a.length, 26);
  assert.equal(b.length, 26);
  assert.ok(b > a);
}

console.log('✓ propr-client.test.js 全部通过');