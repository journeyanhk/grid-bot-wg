// Arcus request signing (Ed25519) and the decimal→engine-integer conversions
// that the signature depends on.
//
// Why this file exists at all: Arcus signs the *request payload*, not a hash of
// it, and the payload holds engine-native integers. Price must be an exact
// multiple of tickSize and size an exact multiple of stepSize — a rounded float
// that "looks right" produces a signature that verifies and an order the engine
// rejects. Everything here is therefore exact-decimal arithmetic with BigInt,
// and floats never touch the signed bytes.
//
// Two schemes (docs: /api-reference/authentication):
//   Scheme 1 — typed payload, for placeOrder / cancelOrder / modifyOrder and
//              each element of the batch variants. Keys are sorted, `ct` equals
//              the X-Timestamp header (nanoseconds), times are nanoseconds.
//   Scheme 2 — `timestamp + action + canonical_json(body)`, for cancelAllOrders
//              and setLeverage. No delimiters.
//
// No third-party dependency: node:crypto has had Ed25519 since v12, and an
// Ed25519 key is a 32-byte seed that wraps into PKCS#8 with a fixed prefix.

import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

// PKCS#8 DER prefix for Ed25519 private keys (RFC 8410): the 16-byte header
// followed by the 32-byte seed. Verified against RFC 8032 vectors in the tests.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Scheme 1 operation codes. */
export const OP = { PLACE: 1, CANCEL: 2, MODIFY: 3 };
/** Arcus time-in-force codes (note: ALO is 3 here, unlike some venues). */
export const TIF = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 };
export const SIDE = { BUY: 0, SELL: 1 };

/** 32-byte seed as hex (with or without 0x) → Ed25519 KeyObject. */
export function privateKeyFromHex(hex) {
  const clean = String(hex ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('AR_API_SIGNING_KEY 必须是 64 位十六进制（Ed25519 私钥种子，32 字节）。');
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(clean, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Load the signing key from a file: either a 64-hex seed (what the web app hands
 * you) or a PEM Ed25519 private key (`openssl genpkey -algorithm ed25519`).
 * Keeps the credential off the process environment when an operator prefers a
 * file — the same split HL/Lighter use for their agent wallets.
 */
export function readKeyFile(path) {
  const raw = readFileSync(String(path), 'utf8').trim();
  if (!raw) throw new Error('AR_API_SIGNING_KEY_FILE 指向的文件为空。');
  if (raw.includes('-----BEGIN')) {
    // Editors and copy-paste routinely leave blank lines inside the PEM body,
    // which OpenSSL rejects with DECODER::unsupported. Collapse them.
    const pem = raw.replace(/\r\n/g, '\n').replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n');
    return createPrivateKey({ key: pem, format: 'pem' });
  }
  return privateKeyFromHex(raw);
}

/** The API key Arcus expects: the raw 32-byte public key, lowercase hex. */
export function apiKeyFromPrivate(privateKeyObject) {
  const spki = createPublicKey(privateKeyObject).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('hex');
}

/** Sign a message with the Ed25519 key; returns 128 lowercase hex chars. */
export function signMessage(privateKeyObject, message) {
  return cryptoSign(null, Buffer.from(String(message), 'utf8'), privateKeyObject).toString('hex');
}

function normalizeInteger(value, label) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${label} 必须是安全整数或 BigInt，收到 ${value}（浮点会丢精度）。`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`${label} 不是整数：${value}`);
}

/**
 * Canonical JSON for signing: keys sorted, no whitespace, integers as integers.
 *
 * Floats are rejected on purpose. A price that reaches this function as 82609.3
 * means an earlier conversion silently rounded, and the signature would then
 * disagree with the decimal string in the body.
 */
export function canonicalJson(object) {
  const walk = (value) => {
    if (value === null) return 'null';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw new Error(`签名载荷只接受整数，收到 ${value}；请先换算成 tick/quantum。`);
      return String(value);
    }
    if (Array.isArray(value)) return `[${value.map(walk).join(',')}]`;
    if (typeof value === 'object') {
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(value[k])}`).join(',')}}`;
    }
    throw new Error(`无法序列化的类型：${typeof value}`);
  };
  return walk(object);
}

/** `${tickSize}` or `'1e-8'` → decimal places. Expands exponent notation first. */
export function decimalScale(value) {
  let s = String(value ?? '').trim();
  if (!s) throw new Error('精度值不能为空。');
  if (/[eE]/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`无法解析精度值：${value}`);
    s = n.toFixed(20).replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
    if (/[eE]/.test(s)) throw new Error(`精度值过大，无法展开：${value}`);
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) throw new Error(`无法解析精度值：${value}`);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Exact decimal → integer scaled by 10^scale.
 * A value with more decimals than `scale` is accepted only when the extra digits
 * are all zero; otherwise it throws rather than silently truncating.
 */
export function toScaledInt(value, scale) {
  let s = String(value ?? '').trim();
  if (/[eE]/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`无法解析数值：${value}`);
    s = n.toFixed(20).replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  let negative = false;
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`无法解析数值：${value}`);

  let [intPart, fracPart = ''] = s.split('.');
  if (fracPart.length > scale) {
    const dropped = fracPart.slice(scale);
    if (/[1-9]/.test(dropped)) {
      throw new Error(`值 ${value} 超出 ${scale} 位精度（多余小数 ${dropped}），拒绝静默截断。`);
    }
    fracPart = fracPart.slice(0, scale);
  }
  fracPart = fracPart.padEnd(scale, '0');
  const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  return (negative ? -1n : 1n) * BigInt(digits || '0');
}

/**
 * Decimal → integer scaled by 10^scale, rounding the excess digits away
 * (halves away from zero). This is the *snapping* path, for computed values
 * (grid prices, mid ± offset) that are not yet exact at the unit's scale.
 * `toScaledInt` stays strict so signing never silently truncates.
 */
export function toScaledIntRounded(value, scale) {
  const PAD = 18;
  const extended = toScaledInt(value, scale + PAD);
  const unit = 10n ** BigInt(PAD);
  const negative = extended < 0n;
  const abs = negative ? -extended : extended;
  const rounded = (abs % unit) * 2n >= unit ? abs / unit + 1n : abs / unit;
  return negative ? -rounded : rounded;
}

/** Price → integer ticks. Must be an exact multiple of tickSize. */
export function toTicks(price, tickSize) {
  const scale = decimalScale(tickSize);
  const value = toScaledInt(price, scale);
  const unit = toScaledInt(tickSize, scale);
  if (unit === 0n) throw new Error(`tickSize 无效：${tickSize}`);
  if (value % unit !== 0n) {
    throw new Error(`价格 ${price} 不是 tickSize ${tickSize} 的整数倍（签名无法自洽）。`);
  }
  return Number(value / unit);
}

/** Size → integer quantums. Must be an exact multiple of stepSize. */
export function toQuantums(size, stepSize) {
  const scale = decimalScale(stepSize);
  const value = toScaledInt(size, scale);
  const unit = toScaledInt(stepSize, scale);
  if (unit === 0n) throw new Error(`stepSize 无效：${stepSize}`);
  if (value % unit !== 0n) {
    throw new Error(`数量 ${size} 不是 stepSize ${stepSize} 的整数倍（签名无法自洽）。`);
  }
  return Number(value / unit);
}

/** Quantums → decimal size string, as the order body expects. */
export function fromQuantums(quantums, stepSize) {
  const scale = decimalScale(stepSize);
  const unit = toScaledInt(stepSize, scale);
  const total = normalizeInteger(quantums, 'quantums') * unit;
  return formatScaled(total, scale);
}

/** Ticks → decimal price string. */
export function fromTicks(ticks, tickSize) {
  const scale = decimalScale(tickSize);
  const unit = toScaledInt(tickSize, scale);
  return formatScaled(normalizeInteger(ticks, 'ticks') * unit, scale);
}

function formatScaled(scaled, scale) {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
  const intPart = scale === 0 ? digits : digits.slice(0, digits.length - scale);
  const fracPart = scale === 0 ? '' : digits.slice(digits.length - scale);
  const trimmed = fracPart.replace(/0+$/, '');
  return `${negative ? '-' : ''}${intPart}${trimmed ? `.${trimmed}` : ''}`;
}

/** Round a price to the nearest tick; returns a decimal string. */
export function snapPrice(price, tickSize) {
  // Deliberately lenient: grid arithmetic produces values like 82670.74 that are
  // 0.4 tick off a tick. Snapping is the caller's intent; the strict exactness
  // gate lives in toTicks(), which runs on the snapped value before signing.
  const ticks = BigInt(Math.round(Number(price) / Number(tickSize)));
  return fromTicks(ticks, tickSize);
}

/** Round a size DOWN to the nearest step (never overshoot the risk budget). */
export function snapSize(size, stepSize) {
  const scale = decimalScale(stepSize);
  const unit = toScaledInt(stepSize, scale);
  const scaled = toScaledInt(size, scale);
  return formatScaled((scaled / unit) * unit, scale);
}

function toNs(value, label) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`${label} 必须用 BigInt 或数字字符串传纳秒（Number 会丢精度）。`);
}

/**
 * Scheme 1 payload for placeOrder (op 1).
 * `g` is goodTilTime converted µs→ns; `ct` is the same instant as X-Timestamp.
 */
export function placePayload({
  address, accountIndex = 0, clientId, timestampNs, goodTilNs,
  marketId, priceTicks, quantums, reduceOnly = false, side, tif = TIF.ALO,
}) {
  return canonicalJson({
    ad: String(address).toLowerCase(),
    ai: Number(accountIndex),
    c: clientId ? String(clientId) : undefined,
    ct: toNs(timestampNs, 'timestampNs'),
    g: toNs(goodTilNs, 'goodTilNs'),
    m: Number(marketId),
    op: OP.PLACE,
    p: Number(priceTicks),
    q: Number(quantums),
    r: reduceOnly ? 1 : 0,
    s: Number(side),
    t: Number(tif),
    v: 1,
  });
}

/** Scheme 1 payload for cancelOrder (op 2). Exactly one of orderId / clientId. */
export function cancelPayload({ address, accountIndex = 0, timestampNs, orderId, clientId, marketId }) {
  if ((orderId == null) === (clientId == null)) {
    throw new Error('cancelOrder 只能给 orderId 或 clientId 之一。');
  }
  return canonicalJson({
    ad: String(address).toLowerCase(),
    ai: Number(accountIndex),
    c: clientId ? String(clientId) : undefined,
    ct: toNs(timestampNs, 'timestampNs'),
    id: orderId != null ? String(orderId) : undefined,
    m: Number(marketId),
    op: OP.CANCEL,
    v: 1,
  });
}

/** Scheme 2 message for cancelAllOrders / setLeverage. */
export function scheme2Message(timestampNs, action, body) {
  const head = `${toNs(timestampNs, 'timestampNs')}${action}`;
  return body === undefined || body === null ? head : head + canonicalJson(body);
}

/**
 * Current time in Unix nanoseconds, as BigInt.
 * `ct` in the 1.79e18 range overflows Number.MAX_SAFE_INTEGER, so every
 * timestamp that reaches a signature payload must stay BigInt here.
 */
export function nowNs() {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Convenience for the probe: verify our own signature against the public key. */
export function verifyMessage(privateKeyObject, message, signatureHex) {
  // Pass the KeyObject, not its DER bytes: crypto.verify only accepts a raw
  // Buffer when it is wrapped as { key, format: 'der', type: 'spki' }.
  const publicKey = createPublicKey(privateKeyObject);
  return cryptoVerify(null, Buffer.from(String(message), 'utf8'), publicKey, Buffer.from(signatureHex, 'hex'));
}

// ── Exact rounding to a market unit ─────────────────────────────────────────

/**
 * Round `value` to the nearest multiple of `unit` (halves away from zero) and
 * return the engine integer together with the decimal string the request body
 * needs. Both come from ONE BigInt, so the signed `p`/`q` and the body's
 * `price`/`quantity` can never disagree — which is exactly the failure mode the
 * engine rejects with `invalid order signature`.
 */
export function roundToUnit(value, unit) {
  const scale = decimalScale(unit);
  const unitInt = toScaledInt(unit, scale);
  if (unitInt === 0n) throw new Error(`单位无效：${unit}`);
  const scaled = toScaledIntRounded(value, scale);
  const half = unitInt / 2n;
  const units = scaled >= 0n ? (scaled + half) / unitInt : -((-scaled + half) / unitInt);
  return { units, text: formatScaled(units * unitInt, scale) };
}
