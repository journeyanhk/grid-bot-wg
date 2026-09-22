// 平台级脱敏：API Key 与认证信息绝不出现在任何输出中（日志/异常/告警/SSE/仪表盘）。
// 规则：禁止 Authorization / API Key / Cookie / 完整认证信息；accountId 仅允许「前 4 + 后 4」。
// 位置说明：从 exchange/propr/redact.js 上移到平台层，因为 src/log.js 需要在日志边界统一调用，
// 避免平台层反向依赖交易所适配层。

const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'token',
  'password',
  'secret',
  'privatekey',
  'private_key',
  'propr_api_key',
]);

const ID_KEYS = new Set(['accountid', 'account_id']);

const TEXT_PATTERNS = [
  // Propr Key 形如 pk_live_xxx / pk_test_xxx
  { re: /pk_(?:live|test)_[A-Za-z0-9_-]+/g, mask: 'pk_***REDACTED***' },
  // Authorization: Bearer xxx
  { re: /(Bearer\s+)[A-Za-z0-9._-]+/gi, mask: '$1***REDACTED***' },
  // key=value / key: value（保留键名，抹掉值）
  {
    re: /("?(?:api[-_]?key|authorization|cookie|token|password|secret|private[-_]?key)"?\s*[:=]\s*"?)([^"\s,}]+)/gi,
    mask: '$1***REDACTED***',
  },
];

const MAX_DEPTH = 6;

/** accountId 脱敏：仅保留前 4 + 后 4。 */
export function maskAccountId(id) {
  const s = String(id ?? '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** 文本脱敏：抹掉 API Key / Bearer / key=value 形态的凭证。 */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const { re, mask } of TEXT_PATTERNS) out = out.replace(re, mask);
  return out;
}

/**
 * 结构化脱敏：递归处理对象/数组。
 * - 密钥字段（apiKey/authorization/...）整体替换；
 * - accountId 字段按前 4+后 4 掩码；
 * - 超过深度上限不再透传原值（防深层泄漏与循环引用）。
 */
export function redactRecord(value, depth = 0) {
  if (value == null) return value;
  if (depth > MAX_DEPTH) return '[REDACTED_DEPTH_LIMIT]';
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redactRecord(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactSecrets(value.message) };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k).toLowerCase();
    if (SECRET_KEYS.has(key)) out[k] = '***REDACTED***';
    else if (ID_KEYS.has(key)) out[k] = maskAccountId(v);
    else out[k] = redactRecord(v, depth + 1);
  }
  return out;
}

/** 统一的错误安全包装：任何错误进入日志/告警/SSE/仪表盘前必须经过本函数。 */
export function safeError(err) {
  return redactRecord({
    name: err?.name,
    message: err?.message,
    statusCode: err?.statusCode,
    code: err?.code,
    detail: err?.detail,
  });
}
