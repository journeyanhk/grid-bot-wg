// Propr 数据映射：把 API 原始 JSON 变成 bot 能用的结构。
// 全部是纯函数（无 I/O），这样 fixture 单测可以覆盖每一个坑。
//
// 三个已由 M0 实测确认的坑：
//   1) 没有 equity 字段，权益 = marginBalance
//   2) 平仓残留是 quantity:"0" + status:"closed"（文档写的是 open）
//   3) liquidityType 恒为 "taker"，只能按 feeRate 判断 maker/taker

const num = (x) => (x == null || x === '' ? null : Number(x));

/** 账户快照。equity 明确取 marginBalance，缺失时退化为 balance + uPnL。 */
export function parseAccount(body) {
  const d = body?.data ?? body ?? {};
  const balance = num(d.balance);
  const uPnl = num(d.totalUnrealizedPnl) ?? 0;
  const equity = num(d.marginBalance) ?? (balance == null ? null : balance + uPnl);
  return {
    accountId: d.accountId ?? null,
    userId: d.userId ?? null,
    challengeId: d.challengeId ?? null,
    attemptId: d.challengeAttemptId ?? null,
    type: d.type ?? null,
    currency: d.currency ?? 'USDC',
    balance,
    equity,
    uPnl,
    available: num(d.availableBalance),
    highWaterMark: num(d.highWaterMark),
    crossMargin: num(d.crossPositionMargin) ?? 0,
    crossOrderMargin: num(d.crossOrderMargin) ?? 0,
    isolatedMargin: num(d.isolatedPositionMargin) ?? 0,
    maintenanceMargin: num(d.totalMaintenanceMargin) ?? 0,
    initialMargin: num(d.totalInitialMargin) ?? 0,
    updatedAt: d.updatedAt ?? null,
  };
}

/** 单个仓位。size 恒为正，方向看 side。 */
export function parsePosition(p) {
  return {
    positionId: p.positionId ?? null,
    asset: p.asset ?? p.base ?? null,
    side: p.positionSide === 'short' ? 'short' : 'long',
    size: Math.abs(num(p.quantity) ?? 0),
    entryPrice: num(p.entryPrice),
    markPrice: num(p.markPrice),
    liquidationPrice: num(p.liquidationPrice),
    uPnl: num(p.unrealizedPnl) ?? 0,
    marginUsed: num(p.marginUsed) ?? 0,
    leverage: num(p.leverage),
    marginMode: p.marginMode ?? null,
    cumulativeFunding: num(p.cumulativeFunding) ?? 0,
    status: p.status ?? null,
    raw: p,
  };
}

/** 只要真正有方向的仓位：数量非零且不是 closed。 */
export function livePositions(rows) {
  return (rows || [])
    .map(parsePosition)
    .filter((p) => p.size > 0 && p.status !== 'closed' && p.status !== 'liquidated');
}

/** long/short 两侧分开；dualSide=true 是风控要拦截的状态。 */
export function splitPositions(rows) {
  const live = livePositions(rows);
  const long = live.find((p) => p.side === 'long') || null;
  const short = live.find((p) => p.side === 'short') || null;
  return {
    long,
    short,
    dualSide: !!(long && short),
    netSize: (long?.size ?? 0) - (short?.size ?? 0),
  };
}

export function parseOrder(o) {
  return {
    orderId: o.orderId ?? null,
    intentId: o.intentId ?? null,
    orderGroupId: o.orderGroupId ?? null,
    asset: o.asset ?? o.base ?? null,
    side: o.side ?? null,
    positionSide: o.positionSide ?? null,
    type: o.type ?? null,
    qty: num(o.quantity) ?? 0,
    filledQty: num(o.cumulativeQuantity) ?? 0,
    price: num(o.price),
    triggerPrice: num(o.triggerPrice),
    reduceOnly: !!o.reduceOnly,
    closePosition: !!o.closePosition,
    status: o.status ?? null,
    feeRate: num(o.tradingFeeRate),
    createdAt: o.createdAt ?? null,
    raw: o,
  };
}

const OPEN_STATES = new Set(['pending', 'open', 'partially_filled']);
export function openOrders(rows) {
  return (rows || []).map(parseOrder).filter((o) => OPEN_STATES.has(o.status));
}

export function parseTrade(t) {
  return {
    tradeId: t.tradeId ?? null,
    orderId: t.orderId ?? null,
    positionId: t.positionId ?? null,
    type: t.type ?? null,
    side: t.side ?? null,
    positionSide: t.positionSide ?? null,
    qty: num(t.quantity) ?? 0,
    price: num(t.price) ?? 0,
    quoteQty: num(t.quoteQuantity) ?? 0,
    fee: num(t.fee) ?? 0,
    feeRate: num(t.feeRate),
    realizedPnl: num(t.realizedPnl) ?? 0,
    liquidityType: t.liquidityType ?? null,
    executedAt: t.executedAt ?? null,
    raw: t,
  };
}

/** feeRate → maker/taker。liquidityType 不可信，只在 feeRate 缺失时兜底。 */
export function feeTier(t, { maker = 0.00015, taker = 0.00045 } = {}) {
  const r = num(t.feeRate);
  if (r == null) return t.liquidityType === 'maker' ? 'maker' : 'taker';
  return Math.abs(r - maker) <= Math.abs(r - taker) ? 'maker' : 'taker';
}

/** 增量成交：按 tradeId 去重（不按时间戳）。 */
export function freshTrades(rows, seen) {
  const fresh = [];
  let duplicates = 0;
  for (const raw of rows || []) {
    const t = parseTrade(raw);
    if (!t.tradeId) continue;
    if (seen.has(t.tradeId)) { duplicates++; continue; }
    seen.add(t.tradeId);
    fresh.push(t);
  }
  return { fresh, duplicates };
}

export function sumTrades(rows) {
  let fees = 0, realized = 0, quote = 0;
  for (const t of rows || []) {
    fees += num(t.fee) ?? 0;
    realized += num(t.realizedPnl) ?? 0;
    quote += num(t.quoteQuantity) ?? 0;
  }
  return { fees, realized, quote };
}

/** 平仓方向：long 用 sell、short 用 buy。 */
export function closeSide(positionSide) {
  return positionSide === 'short' ? 'buy' : 'sell';
}

/**
 * 决定 positionSide。单向下单时它由"这一单是开还是平"决定：
 *   - 平多 → sell + long + reduceOnly
 *   - 开多 → buy + long + !reduceOnly
 * 双边持仓存在时不允许再开新仓（返回 null，由调用方拒绝）。
 */
export function resolvePositionSide({ side, reduceOnly, positions }) {
  const { long, short, dualSide } = positions;
  if (dualSide) return null;
  if (reduceOnly) {
    if (side === 'sell' && long) return 'long';
    if (side === 'buy' && short) return 'short';
    return null;            // 无仓可减：拒绝，不要重试
  }
  if (side === 'buy') return short ? null : 'long';
  return long ? null : 'short';
}

/** 下单 payload。一次只允许一个入场单，所以永远是单元素数组。 */
export function buildLimitOrder({ accountId, asset, side, positionSide, qty, price, reduceOnly = false, timeInForce = 'GTC', intentId }) {
  if (!accountId) throw new Error('buildLimitOrder 需要 accountId');
  if (!(qty > 0)) throw new Error('buildLimitOrder 需要 qty > 0');
  if (!(price > 0)) throw new Error('buildLimitOrder 需要 price > 0');
  if (!['buy', 'sell'].includes(side)) throw new Error(`非法 side: ${side}`);
  if (!['long', 'short'].includes(positionSide)) throw new Error(`非法 positionSide: ${positionSide}`);
  if (!intentId) throw new Error('buildLimitOrder 需要 intentId（幂等键）');
  return {
    accountId,
    intentId,
    exchange: 'hyperliquid',
    type: 'limit',
    side,
    positionSide,
    productType: 'perp',
    timeInForce,
    asset,
    base: asset,
    quote: 'USDC',
    quantity: String(qty),
    price: String(price),
    reduceOnly: !!reduceOnly,
    closePosition: false,
  };
}