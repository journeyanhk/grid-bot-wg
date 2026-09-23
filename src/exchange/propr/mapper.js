// Propr 字段映射层（纯函数，零 I/O，全部可单测）。
// 约定：positionSide 全程保真（long/short）——服务端虽会按净仓归一化，但审计与对账必须保留原始值；
// 金额/数量内部用 Number 展示，下单与持久化时用字符串保精度。
import { redactSecrets } from '../../redact.js';
import { classifyProprError, isRetryableProprError } from './errors.js';
import { toEpochMs } from './market.js';

/** Propr 订单状态枚举（文档）→ 内部状态机。 */
export const ORDER_STATUS = Object.freeze({
  PENDING: 'pending',
  OPEN: 'open',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
});

/** 仍可能成交（活动）的状态。 */
export const LIVE_STATUSES = Object.freeze(['pending', 'open', 'partially_filled']);

const STATUS_TO_INTERNAL = Object.freeze({
  pending: 'submitted',
  open: 'open',
  partially_filled: 'partially_filled',
  filled: 'filled',
  cancelled: 'cancelled',
  rejected: 'rejected',
  expired: 'expired',
});

const INTERNAL_TO_STATUS = Object.freeze(
  Object.fromEntries(Object.entries(STATUS_TO_INTERNAL).map(([k, v]) => [v, k])),
);

export function toInternalStatus(status) {
  return STATUS_TO_INTERNAL[String(status)] ?? 'unknown';
}

export function fromInternalStatus(status) {
  return INTERNAL_TO_STATUS[String(status)] ?? null;
}

export function isLiveStatus(status) {
  return LIVE_STATUSES.includes(String(status));
}

/** Propr Order → 内部订单视图。extra 可注入 levelIndex（来自铺单/接纳）。 */
export function mapProprOrder(raw = {}, extra = {}) {
  return {
    orderId: String(raw.orderId ?? ''),
    clientOrderId: raw.intentId ?? null,
    marketId: raw.base ?? null,
    side: raw.side,
    positionSide: raw.positionSide,
    orderType: raw.type,
    price: raw.price == null ? null : Number(raw.price),
    sizeBase: Number(raw.quantity ?? 0),
    filledBase: Number(raw.cumulativeQuantity ?? 0),
    averageFillPrice: raw.averageFillPrice == null ? null : Number(raw.averageFillPrice),
    reduceOnly: !!raw.reduceOnly,
    closePosition: !!raw.closePosition,
    status: String(raw.status ?? 'unknown'),
    internalStatus: toInternalStatus(raw.status),
    createdAt: toEpochMs(raw.createdAt),
    updatedAt: toEpochMs(raw.updatedAt),
    levelIndex: extra.levelIndex ?? null,
    raw,
  };
}

/** Propr Position → 内部持仓视图。 */
export function mapProprPosition(raw = {}) {
  return {
    positionId: String(raw.positionId ?? ''),
    marketId: raw.base ?? null,
    positionSide: raw.positionSide,
    sizeBase: Number(raw.quantity ?? 0),
    entryPrice: Number(raw.entryPrice ?? 0),
    markPrice: Number(raw.markPrice ?? 0),
    breakEvenPrice: raw.breakEvenPrice == null ? null : Number(raw.breakEvenPrice),
    liquidationPrice: raw.liquidationPrice == null ? null : Number(raw.liquidationPrice),
    unrealizedPnl: Number(raw.unrealizedPnl ?? 0),
    realizedPnl: Number(raw.realizedPnl ?? 0),
    marginUsed: Number(raw.marginUsed ?? 0),
    notionalValue: Number(raw.notionalValue ?? 0),
    leverage: Number(raw.leverage ?? 0) || null,
    marginMode: raw.marginMode ?? null,
    status: raw.status ?? null,
    updatedAt: toEpochMs(raw.updatedAt),
    raw,
  };
}

/** Propr Trade → 内部成交视图。 */
export function mapProprTrade(raw = {}) {
  return {
    tradeId: String(raw.tradeId ?? ''),
    orderId: String(raw.orderId ?? ''),
    positionId: raw.positionId ?? null,
    marketId: raw.base ?? null,
    side: raw.side,
    positionSide: raw.positionSide,
    type: raw.type,
    liquidityType: raw.liquidityType,
    price: Number(raw.price ?? 0),
    sizeBase: Number(raw.quantity ?? 0),
    quoteQuantity: Number(raw.quoteQuantity ?? 0),
    fee: Number(raw.fee ?? 0),
    feeRate: Number(raw.feeRate ?? 0),
    realizedPnl: Number(raw.realizedPnl ?? 0),
    positionSizeBefore: Number(raw.positionSizeBefore ?? 0),
    isLiquidation: !!raw.isLiquidation,
    executedAt: toEpochMs(raw.executedAt),
    createdAt: toEpochMs(raw.createdAt),
    raw,
  };
}

/** Propr MarginConfig → 内部保证金配置视图。 */
export function mapProprMargin(raw = {}) {
  return {
    configId: raw.configId ?? null,
    marketId: raw.asset ?? null,
    leverage: Number(raw.leverage ?? 0) || null,
    marginMode: raw.marginMode ?? null,
    raw,
  };
}

/**
 * 多空视图 → 净仓视图。**仅适用于 Propr net 模式**（已实测：服务端按净仓归一化，
 * 通常只返回一条）。若未来用于 hedge 数据，不能只取第一条——entryPrice 需按方向分别加权，
 * 本函数不做该假设，故不应复用于双向持仓。
 * @returns {null | {sizeBase:number, entryPrice:number, unrealizedPnl:number, ...}}
 */
export function netPositionFromViews(views = []) {
  const long = views.filter((p) => p.positionSide === 'long');
  const short = views.filter((p) => p.positionSide === 'short');
  const longQty = long.reduce((s, p) => s + Number(p.sizeBase ?? p.quantity ?? 0), 0);
  const shortQty = short.reduce((s, p) => s + Number(p.sizeBase ?? p.quantity ?? 0), 0);
  const sizeBase = longQty - shortQty;
  if (!sizeBase) return null;
  const side = sizeBase > 0 ? long : short;
  const sideQty = side.reduce((s, p) => s + Number(p.sizeBase ?? p.quantity ?? 0), 0);
  const entryPrice = sideQty
    ? side.reduce((s, p) => s + Number(p.entryPrice ?? 0) * Number(p.sizeBase ?? p.quantity ?? 0), 0) / sideQty
    : 0;
  const dominant = side[0];
  if (!dominant) return null;
  return {
    positionId: dominant.positionId ?? null,
    marketId: dominant.marketId ?? dominant.base ?? null,
    positionSide: sizeBase > 0 ? 'long' : 'short',
    sizeBase,
    entryPrice,
    markPrice: Number(dominant.markPrice ?? 0),
    liquidationPrice: dominant.liquidationPrice ?? null,
    unrealizedPnl: views.reduce((s, p) => s + Number(p.unrealizedPnl ?? 0), 0),
    leverage: dominant.leverage ?? null,
    marginMode: dominant.marginMode ?? null,
    raw: dominant.raw ?? dominant,
  };
}

/** 错误归一化（供日志/告警/SSE 使用，message 已脱敏）。 */
export function mapProprError(err) {
  return {
    kind: classifyProprError(err),
    retryable: isRetryableProprError(err),
    statusCode: err?.statusCode ?? null,
    code: err?.code ?? null,
    message: redactSecrets(err?.message ?? String(err ?? 'unknown')),
  };
}
