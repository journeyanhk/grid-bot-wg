// Shadow 门面：只读快照 + 差分 + 容量。M1 里没有下单路径。
//
// 容量的铁律（Review 补充，已采纳）：**平台把杠杆调高，不得静默放大仓位。**
// capacity = min(PR_MAX_INV_USD, availableBalance × min(leverage, PR_CAPACITY_LEVERAGE) × 0.8)
// 默认 PR_CAPACITY_LEVERAGE = 1，也就是无论平台报几倍，容量都按 1x 算。
import { parseAccount, splitPositions, openOrders, parseTrade } from './mapper.js';
import { ProprStaleError } from './errors.js';

export function computeCapacity({ available, leverage, maxInvUsd = 1500, capacityLeverage = 1, use = 0.8 }) {
  const avail = Number(available);
  const lev = Number(leverage);
  const maxInv = Number(maxInvUsd);
  if (!Number.isFinite(avail) || avail <= 0) return { maxOpenNotional: 0, cappedBy: 'no-available', effectiveLeverage: lev || null };
  if (!Number.isFinite(maxInv) || maxInv <= 0) throw new Error('PR_MAX_INV_USD 必须为正');
  // 只允许"比配置更保守"，绝不允许因平台杠杆上升而扩张
  const levForCapacity = Math.min(Number.isFinite(lev) && lev > 0 ? lev : 1, capacityLeverage);
  const accountCapacity = avail * levForCapacity * use;
  const maxOpenNotional = Math.min(maxInv, accountCapacity);
  return {
    maxOpenNotional: Math.round(maxOpenNotional * 100) / 100,
    cappedBy: maxOpenNotional === maxInv ? 'config' : 'account',
    effectiveLeverage: Number.isFinite(lev) ? lev : null,
    capacityLeverage: levForCapacity,
    leverageWarn: Number.isFinite(lev) && lev > 3,
  };
}

export class ProprShadow {
  constructor({ client, accountId, maxInvUsd = 1500, capacityLeverage = 1, staleMs = 45_000, marketData = null, symbol = 'BTC' }) {
    if (!client) throw new Error('ProprShadow 需要 client');
    if (!accountId) throw new Error('ProprShadow 需要 accountId');
    this.client = client;
    this.accountId = accountId;
    this.maxInvUsd = maxInvUsd;
    this.capacityLeverage = capacityLeverage;
    this.staleMs = staleMs;
    this.marketData = marketData;
    this.symbol = symbol;
    this.prev = null;
    this.seenTradeIds = new Set();
    this.stats = { rounds: 0, failures: 0, duplicateTrades: 0, newTrades: 0, pages: { orders: 0, trades: 0 } };
    this._bootstrapped = false;
  }

  /** 拉一轮完整快照。任何异常都由调用方决定降级。 */
  async refresh() {
    const t0 = Date.now();
    // 成交：首轮全量分页建基线，之后只拉最新一页（去重靠 tradeId，不靠时间）
    const tradesPromise = this._bootstrapped
      ? this.client.getTradesPage(this.accountId, { limit: this.client.pageLimit, offset: 0 })
        .then((body) => ({ rows: body?.data ?? [], pages: 1, complete: true }))
      : this.client.getTrades(this.accountId);
    const [acctRaw, posRaw, ordRaw, trdRaw, cfgRaw] = await Promise.all([
      this.client.getAccount(this.accountId),
      this.client.getPositions(this.accountId),
      this.client.getOrders(this.accountId, { status: 'open' }),
      tradesPromise,
      this.client.getMarginConfig(this.accountId, this.symbol),
    ]);

    const account = parseAccount(acctRaw);
    const positions = splitPositions(posRaw.rows);
    const orders = openOrders(ordRaw.rows);
    const cfg = cfgRaw?.data ?? cfgRaw;
    const leverage = Number(cfg?.leverage) || null;

    const trades = [];
    // 跨轮重复是正常的（每轮都拉最新一页）；真正的异常是**同一响应里**出现重复 tradeId
    const pageIds = trdRaw.rows.map((r) => r.tradeId).filter(Boolean);
    let dupes = pageIds.length - new Set(pageIds).size;
    for (const raw of trdRaw.rows) {
      const t = parseTrade(raw);
      if (!t.tradeId) continue;
      if (this.seenTradeIds.has(t.tradeId)) continue;
      this.seenTradeIds.add(t.tradeId);
      trades.push(t);
    }

    const snap = {
      at: Date.now(),
      latencyMs: Date.now() - t0,
      account,
      positions,
      orders,
      leverage,
      marginMode: cfg?.marginMode ?? null,
      newTrades: trades,
      capacity: computeCapacity({ available: account.available, leverage, maxInvUsd: this.maxInvUsd, capacityLeverage: this.capacityLeverage }),
      pages: { orders: ordRaw.pages, trades: trdRaw.pages },
      writeAttemptCount: this.client.writeAttemptCount,
      stale: false,
    };
    this.stats.rounds++;
    this.stats.duplicateTrades += dupes;
    this.stats.newTrades += trades.length;
    this.stats.pages = snap.pages;
    this.prev = snap;
    this._bootstrapped = true;
    return snap;
  }

  /** 与上一轮比较。首轮返回 null。 */
  static diff(prev, cur) {
    if (!prev || !cur) return null;
    const ids = (s) => new Set(s.orders.map((o) => o.orderId));
    const a = ids(prev), b = ids(cur);
    return {
      ms: cur.at - prev.at,
      equityDelta: round6(cur.account.equity - prev.account.equity),
      balanceDelta: round6(cur.account.balance - prev.account.balance),
      ordersAdded: [...b].filter((x) => !a.has(x)),
      ordersRemoved: [...a].filter((x) => !b.has(x)),
      longDelta: round6((cur.positions.long?.size ?? 0) - (prev.positions.long?.size ?? 0)),
      shortDelta: round6((cur.positions.short?.size ?? 0) - (prev.positions.short?.size ?? 0)),
      newTrades: cur.newTrades.length,
    };
  }

  assertFresh(snap, now = Date.now()) {
    const age = now - (snap?.at ?? 0);
    if (!snap || age > this.staleMs) throw new ProprStaleError(age, this.staleMs);
    return true;
  }

  /** 只读断言：任何一轮结束后都必须为 0。 */
  assertNoWrites() {
    if (this.client.writeAttemptCount !== 0) {
      throw new Error(`shadow 期间出现写尝试：${this.client.writeAttemptCount} 次`);
    }
    return true;
  }
}

function round6(x) { return Math.round((Number(x) || 0) * 1e6) / 1e6; }