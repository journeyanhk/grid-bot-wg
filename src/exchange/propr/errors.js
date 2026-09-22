// Propr 错误语义统一层：把官方 ProprAPIError 归一到项目内可判定的分类。
// 目的：区分「可重试（429/5xx/超时）」「不可重试（400/401/403/404）」
// 「未知订单态」「只读模式写拦截」，供适配器、对账与风控决策。
import { ProprAPIError } from './propr-sdk.js';

export { ProprAPIError };

/** shadow 模式下任何写方法调用（绝对禁止写 Propr）。 */
export class ProprReadOnlyError extends Error {
  constructor(action) {
    super(`shadow 模式禁止写操作: ${action}`);
    this.name = 'ProprReadOnlyError';
    this.action = action;
  }
}

/** 下单/撤单后无法确认订单真实状态（必须进入 TRADING_LOCKED 并走对账）。 */
export class UnknownOrderStateError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'UnknownOrderStateError';
    this.detail = detail;
  }
}

/** 启动校验失败（账户状态/权益/持仓不可信）。 */
export class ProprStartupError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ProprStartupError';
    this.detail = detail;
  }
}

/** 请求超时/中断（AbortController 或 undici 中断）。 */
export function isTimeoutError(err) {
  return (
    err?.name === 'AbortError' ||
    err?.code === 'UND_ERR_ABORTED' ||
    /aborted|timeout/i.test(String(err?.message || ''))
  );
}

/** 可安全重试的 API 错误（限频与 5xx）。 */
export function isRetryableProprError(err) {
  if (isTimeoutError(err)) return true;
  const status = err?.statusCode;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

/** 鉴权/权限错误（401/403）：需人工检查 Key 与账户归属，不可重试。 */
export function isAuthError(err) {
  return err?.statusCode === 401 || err?.statusCode === 403;
}

/** 归一化错误分类（用于日志与告警文案）。 */
export function classifyProprError(err) {
  if (err instanceof ProprReadOnlyError) return 'read_only';
  if (err instanceof UnknownOrderStateError) return 'unknown_order_state';
  if (err instanceof ProprStartupError) return 'startup';
  if (isTimeoutError(err)) return 'timeout';
  if (err instanceof ProprAPIError) {
    if (err.statusCode === 429) return 'rate_limited';
    if (isAuthError(err)) return 'auth';
    if (err.statusCode >= 500) return 'server';
    return 'rejected';
  }
  return 'network';
}
