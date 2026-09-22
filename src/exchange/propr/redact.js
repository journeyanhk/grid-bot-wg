// Propr 日志/异常/仪表盘脱敏：API Key 与认证信息绝不出现在任何输出中。
// 规则来自补充方案：禁止 Authorization / API key / Cookie / 完整认证信息；
// accountId 仅允许「前 4 + 后 4」。所有对外文案（日志、告警、错误）必须经过本模块。

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

/** 结构化脱敏：递归处理对象/数组，密钥字段整体替换，字符串值再走文本脱敏。 */
export function redactRecord(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactRecord(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactSecrets(value.message) };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.has(String(k).toLowerCase()) ? '***REDACTED***' : redactRecord(v, depth + 1);
  }
  return out;
}
