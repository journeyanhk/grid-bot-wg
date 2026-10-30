// Propr 错误层：只保留三类 + 一个分类函数。
// 设计原则见 docs/propr/M1-DECISIONS.md：
//   1) 契约/解析错误不是"API 错误"，直接抛普通 Error 让单测红掉；
//   2) 业务错误必须能回答四个问题：可重试吗、是终态吗、能不能忽略、单可能已经存在吗。

export class ProprApiError extends Error {
  constructor(status, code, message, opts = {}) {
    super(message || `Propr API ${status}`);
    this.name = 'ProprApiError';
    this.status = status;
    this.code = code ?? null;
    this.endpoint = opts.endpoint || null;
    this.method = opts.method || 'GET';
    this.retryable = !!opts.retryable;
    this.mayExist = !!opts.mayExist;   // 写入超时/幂等冲突：单可能已建，必须对账而不是重发
  }
}

export class ProprReadOnlyError extends Error {
  constructor(what = '写操作') {
    super(`shadow 模式禁止${what}（Propr 只读）`);
    this.name = 'ProprReadOnlyError';
    this.readOnlyViolation = true;
  }
}

/**
 * 开仓被风控拒绝。**benign=true**：这不是网络/交易所故障，不能被放进重试队列，
 * 否则会每 30s 重试一次、把闸门当成故障刷屏。
 */
export class ProprOpeningBlockedError extends Error {
  constructor(reasons = []) {
    super('开仓被风控拒绝：' + (reasons.join('；') || '未知原因'));
    this.name = 'ProprOpeningBlockedError';
    this.benign = true;          // GridBot 的 _place/_placeMany 见 benign 只告警、不重试
    this.riskBlocked = true;
    this.reasons = reasons;
  }
}

export class ProprStaleError extends Error {
  constructor(ageMs, limitMs) {
    super(`Propr 快照过期 ${Math.round(ageMs / 1000)}s（上限 ${Math.round(limitMs / 1000)}s）`);
    this.name = 'ProprStaleError';
    this.ageMs = ageMs;
    this.limitMs = limitMs;
  }
}

// 已知业务码（来自 M0 探针与官方文档）
export const CODES = Object.freeze({
  UNAUTHORIZED: 10002,
  MULTIPLE_ENTRY: 13066,
  GROUP_ID_REQUIRED: 13059,
  INVALID_GROUP_ID: 13061,
  CONDITIONAL_NEEDS_POSITION: 13056,
  ASSET_NOT_FOUND: 13450,
  IDEMPOTENCY_CONFLICT: 13084,
});

/**
 * 把任意异常翻译成决策用的四个布尔量。
 * @returns {{retryable:boolean, terminal:boolean, benign:boolean, mayExist:boolean}}
 */
export function classify(e) {
  if (e instanceof ProprReadOnlyError) return { retryable: false, terminal: true, benign: false, mayExist: false };
  if (e instanceof ProprOpeningBlockedError) return { retryable: false, terminal: true, benign: true, mayExist: false };
  if (e instanceof ProprStaleError) return { retryable: true, terminal: false, benign: false, mayExist: false };

  const status = Number(e?.status) || 0;
  const code = Number(e?.code) || 0;
  const msg = String(e?.message || '');

  if (status === 401 || code === CODES.UNAUTHORIZED) return { retryable: false, terminal: true, benign: false, mayExist: false };
  if (status === 403) return { retryable: false, terminal: true, benign: false, mayExist: false };
  if (status === 429) return { retryable: true, terminal: false, benign: false, mayExist: false };
  if (status >= 500 || status === 0) return { retryable: true, terminal: false, benign: false, mayExist: true }; // 5xx/超时：写请求可能已生效

  if (code === CODES.IDEMPOTENCY_CONFLICT) return { retryable: false, terminal: false, benign: false, mayExist: true };
  if (code === CODES.MULTIPLE_ENTRY || code === CODES.GROUP_ID_REQUIRED || code === CODES.INVALID_GROUP_ID) {
    return { retryable: false, terminal: true, benign: false, mayExist: false }; // 我们的请求形状错了
  }
  if (code === CODES.ASSET_NOT_FOUND) return { retryable: false, terminal: true, benign: false, mayExist: false };
  if (code === CODES.CONDITIONAL_NEEDS_POSITION) return { retryable: false, terminal: true, benign: false, mayExist: false };

  // 400 且无已知码：多为"订单不可撤/已成交"这类可忽略状态
  if (status === 400 && /cancel|not found|already/i.test(msg)) {
    return { retryable: false, terminal: false, benign: true, mayExist: false };
  }
  if (status >= 400 && status < 500) return { retryable: false, terminal: true, benign: false, mayExist: false };
  return { retryable: false, terminal: true, benign: false, mayExist: false };
}