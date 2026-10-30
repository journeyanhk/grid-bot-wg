// src/guard.js —— 网格机器人风控状态机 / 账户级熔断线 / 订单-仓位一致性巡检
//
// 设计原则：
//   1. 纯函数优先：evaluateRisk / checkConsistency 不碰 IO、不读时间，全部由 ctx 注入，
//      这样每条规则都能用单测钉死，不必起服务。
//   2. 只做"该不该继续下单"的判断，不自己去下单/撤单——执行仍归 bot.js，
//      避免风控层和交易层互相调用形成环路。
//   3. HALTED 是粘滞状态：只能人工清除（clearHalt），任何自动路径都不许把 HALTED 改回 RUNNING。
//
// 状态语义：
//   RUNNING          正常铺梯
//   DEFENSIVE        降级：可减仓、可平仓、可挂已验证的 reduceOnly，但不再新增开仓腿
//   HALTED           熔断：停止开仓、撤掉非减仓单，等人来看
//   RECOVERY_PENDING 一切就绪但仍需人工点头（不会自动进 RUNNING）

export const STATES = Object.freeze({
  RUNNING: 'RUNNING',
  DEFENSIVE: 'DEFENSIVE',
  HALTED: 'HALTED',
  RECOVERY_PENDING: 'RECOVERY_PENDING',
});

export const GUARD_DEFAULTS = Object.freeze({
  // 账户级三条线（USD，相对本次策略周期起点 startBalance）
  warnLossUsd: 40,
  defensiveLossUsd: 60,
  haltLossUsd: 80,
  // 库存占最大允许库存的比例
  inventoryWarnFrac: 0.5,
  inventoryBlockFrac: 0.75,
  inventoryHaltFrac: 1.0,
  // 成交偏置：窗口内开仓成交单边占比
  biasWindowFills: 20,
  biasWindowMs: 3_600_000,
  biasMinFills: 8,
  biasShare: 0.8,
  // 一致性容差
  positionDeltaTol: 1e-8,
  consistencyUnknownHaltStreak: 2,   // 连续 N 轮一致性检查失败 → HALTED（单次 → DEFENSIVE）
  // 恢复条件
  recoveryMaxInventoryFrac: 0.1,
  recoveryMinBarsAboveLower: 2,
});

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 加仓方向：多头加仓是 buy，空头加仓是 sell。仓位为 0 时返回 null。 */
export function addSideFor(positionBase) {
  const p = num(positionBase);
  if (p > 0) return 'buy';
  if (p < 0) return 'sell';
  return null;
}

/**
 * 评估风控状态。
 *
 * ctx 字段（全部可选，缺失即跳过对应规则）：
 *   price, lower, upper        网格区间
 *   outOfRange                 交易所/适配器给出的破界标记
 *   positionBase               当前持仓（带符号）
 *   maxInventoryBase           该参数下的最大允许库存（绝对值）
 *   equity, startBalance       账户权益与本次策略周期起点
 *   fills                      最近成交 [{ side, opening, ts }]
 *   now                        当前毫秒
 *   consistency                checkConsistency() 的结果
 *   haltReason                 已持久化的 HALT 原因（有值则保持 HALTED）
 *
 * 返回 { state, reasons, blockOpening, blockSide, haltReason, metrics }
 */
export function evaluateRisk(ctx = {}, limits = {}) {
  const L = { ...GUARD_DEFAULTS, ...limits };
  const reasons = [];
  const metrics = {};

  // 0) 已持久化的熔断：粘滞，任何自动路径都不许清除
  if (ctx.haltReason) {
    return {
      state: STATES.HALTED,
      reasons: [`已熔断：${ctx.haltReason}`],
      blockOpening: true,
      blockSide: 'both',
      haltReason: ctx.haltReason,
      metrics,
    };
  }

  // 1) 一致性异常 → 直接熔断（账本都不可信了，谈不上继续交易）
  // status='unknown' 是「没查明」，交给下面的分级处理；这里只处理「查明了不一致」
  if (ctx.consistency && ctx.consistency.ok === false && ctx.consistency.status !== 'unknown') {
    return {
      state: STATES.HALTED,
      reasons: ctx.consistency.issues.slice(0, 6),
      blockOpening: true,
      blockSide: 'both',
      haltReason: `账本不一致：${ctx.consistency.issues[0]}`,
      metrics,
    };
  }

  // 1b) 一致性「未知」（接口失败、账本读不出、适配器异常）→ fail-closed
  //     单次失败：禁止新增开仓（DEFENSIVE）；连续 N 次：熔断。
  let consistencyUnknown = false;
  if (ctx.consistency && ctx.consistency.status === 'unknown') {
    const streak = num(ctx.consistencyUnknownStreak);
    const why = (ctx.consistency.issues && ctx.consistency.issues[0]) || '未知原因';
    if (streak >= L.consistencyUnknownHaltStreak) {
      return {
        state: STATES.HALTED,
        reasons: [`一致性检查连续 ${streak} 次无法完成：${why}`],
        blockOpening: true,
        blockSide: 'both',
        haltReason: `一致性检查连续 ${streak} 次失败：${why}`,
        metrics,
      };
    }
    consistencyUnknown = true;
    reasons.push(`一致性无法确认（${why}），暂停新增开仓`);
  }

  const equity = Number.isFinite(Number(ctx.equity)) ? Number(ctx.equity) : null;
  const start = Number.isFinite(Number(ctx.startBalance)) ? Number(ctx.startBalance) : null;
  const loss = equity != null && start != null && start > 0 ? +(start - equity).toFixed(2) : null;
  metrics.accountLossUsd = loss;

  // 2) 账户级熔断线
  if (loss != null && loss >= L.haltLossUsd) {
    return {
      state: STATES.HALTED,
      reasons: [`账户累计亏损 $${loss} ≥ 熔断线 $${L.haltLossUsd}`],
      blockOpening: true,
      blockSide: 'both',
      haltReason: `账户级熔断：equity ${equity} ≤ start ${start} − ${L.haltLossUsd}`,
      metrics,
    };
  }

  // 3) 库存偏置
  const pos = num(ctx.positionBase);
  const maxInv = Math.abs(num(ctx.maxInventoryBase));
  const frac = maxInv > 0 ? Math.abs(pos) / maxInv : 0;
  metrics.inventoryFrac = +frac.toFixed(4);
  metrics.positionBase = pos;

  let state = STATES.RUNNING;
  let blockOpening = false;
  let blockSide = null;

  if (maxInv > 0) {
    if (frac >= L.inventoryHaltFrac) {
      return {
        state: STATES.HALTED,
        reasons: [`库存 ${pos} 达到上限 ${maxInv}（${(frac * 100).toFixed(0)}%）`],
        blockOpening: true,
        blockSide: 'both',
        haltReason: `库存触顶：|${pos}| ≥ ${maxInv}`,
        metrics,
      };
    }
    if (frac >= L.inventoryBlockFrac) {
      state = STATES.DEFENSIVE;
      blockSide = addSideFor(pos);
      reasons.push(`库存 ${(frac * 100).toFixed(0)}% ≥ ${(L.inventoryBlockFrac * 100)}%，停止 ${blockSide} 方向开仓`);
    } else if (frac >= L.inventoryWarnFrac) {
      state = STATES.DEFENSIVE;
      reasons.push(`库存 ${(frac * 100).toFixed(0)}% ≥ ${(L.inventoryWarnFrac * 100)}%，进入防守`);
    }
  }

  // 4) 破界：只允许减仓/平仓/已验证的 reduceOnly 回收
  const price = num(ctx.price);
  const lower = num(ctx.lower);
  const upper = num(ctx.upper);
  // bot 传来的 outOfRange 已经过「外侧半格 + 连续 2 拍 + 驻留时间」三重迟滞，
  // 那才是权威值。只有当调用方完全没给这个标记时，才退回严格价兜底，
  // 否则贴边启动（边界外侧半格内）会被误判成破界、直接拦掉正常开仓。
  const hasFlag = typeof ctx.outOfRange === 'boolean';
  const brokeLow = ctx.outOfRange === true || (!hasFlag && lower > 0 && price > 0 && price < lower);
  const brokeHigh = ctx.outOfRange === true || (!hasFlag && upper > 0 && price > 0 && price > upper);
  if (lower > 0 && upper > 0 && price > 0 && (price < lower || price > upper)) {
    metrics.brokeLow = price < lower;
    metrics.brokeHigh = price > upper;
  }
  if (brokeLow || brokeHigh) {
    state = STATES.DEFENSIVE;
    blockOpening = true;
    reasons.push(`价格 ${price} 在区间 [${lower}, ${upper}] 外，停止新增开仓`);
  }

  // 5) 成交偏置：窗口内开仓成交单边，且库存朝同方向增长
  if (Array.isArray(ctx.fills) && ctx.fills.length && maxInv > 0) {
    const now = num(ctx.now, Date.now());
    const win = ctx.fills
      .filter((f) => now - num(f.ts) <= L.biasWindowMs)
      .slice(-L.biasWindowFills);
    const openFills = win.filter((f) => f.opening !== false);
    if (openFills.length >= L.biasMinFills) {
      const buys = openFills.filter((f) => f.side === 'buy').length;
      const sells = openFills.length - buys;
      const dominant = Math.max(buys, sells) / openFills.length;
      metrics.openFillShare = +dominant.toFixed(2);
      metrics.openFillCount = openFills.length;
      if (dominant >= L.biasShare) {
        const dir = buys > sells ? 'buy' : 'sell';
        const growing = (dir === 'buy' && pos > 0) || (dir === 'sell' && pos < 0);
        if (growing) {
          state = STATES.DEFENSIVE;
          blockOpening = blockOpening || false;
          reasons.push(`成交偏置：${openFills.length} 笔中 ${(dominant * 100).toFixed(0)}% 为 ${dir} 开仓，且库存同向累积`);
        }
      }
    }
  }

  // 6) 账户预警（不改状态，只记原因供面板/巡检展示）
  if (loss != null && loss >= L.defensiveLossUsd && state === STATES.RUNNING) {
    state = STATES.DEFENSIVE;
    reasons.push(`账户累计亏损 $${loss} ≥ 防守线 $${L.defensiveLossUsd}`);
  } else if (loss != null && loss >= L.warnLossUsd) {
    reasons.push(`账户累计亏损 $${loss} ≥ 预警线 $${L.warnLossUsd}（禁止升量）`);
  }

  if (consistencyUnknown) {
    blockOpening = true;
    if (!blockSide) blockSide = 'both';
    // 评审要求：单次读取失败也必须降级到 DEFENSIVE，不能停在 RUNNING
    if (state === STATES.RUNNING) state = STATES.DEFENSIVE;
  }
  return { state, reasons, blockOpening, blockSide, haltReason: null, metrics };
}

/**
 * 一致性巡检：账本/持仓/挂单/成交互相核对。任何一条不成立都不该继续交易。
 *
 * ctx:
 *   positionBase, localPositionBase   交易所真实仓位 vs 本地预期
 *   exchangeOrderCount, localOrderCount
 *   unknownFills, untrackedFills      未识别/未跟踪成交笔数
 *   rejectedInTracked                 被拒订单却出现在本地台账的条数
 *   reduceOnlyMismatch                reduceOnly 单被当成开仓单的条数
 *   orderStatusUnknown                状态无法确认的订单条数
 */
export function checkConsistency(ctx = {}, limits = {}) {
  const L = { ...GUARD_DEFAULTS, ...limits };
  const issues = [];

  if (Number.isFinite(Number(ctx.positionBase)) && Number.isFinite(Number(ctx.localPositionBase))) {
    const delta = Number(ctx.positionBase) - Number(ctx.localPositionBase);
    if (Math.abs(delta) > L.positionDeltaTol) {
      issues.push(`仓位不一致：交易所 ${ctx.positionBase} vs 本地 ${ctx.localPositionBase}（Δ${delta}）`);
    }
  }
  if (num(ctx.unknownFills) > 0) issues.push(`存在 ${ctx.unknownFills} 笔未识别成交`);
  if (num(ctx.untrackedFills) > 0) issues.push(`存在 ${ctx.untrackedFills} 笔未跟踪成交`);
  if (num(ctx.rejectedInTracked) > 0) issues.push(`${ctx.rejectedInTracked} 张被拒订单出现在本地台账`);
  if (num(ctx.reduceOnlyMismatch) > 0) issues.push(`${ctx.reduceOnlyMismatch} 张 reduceOnly 单被当作开仓单`);
  if (num(ctx.orderStatusUnknown) > 0) issues.push(`${ctx.orderStatusUnknown} 张订单状态无法确认`);
  if (Number.isFinite(Number(ctx.exchangeOrderCount)) && Number.isFinite(Number(ctx.localOrderCount))) {
    const d = Number(ctx.exchangeOrderCount) - Number(ctx.localOrderCount);
    if (Math.abs(d) > 0 && num(ctx.orderCountTol, 1) < Math.abs(d)) {
      issues.push(`挂单数不一致：交易所 ${ctx.exchangeOrderCount} vs 本地 ${ctx.localOrderCount}`);
    }
  }

  return { ok: issues.length === 0, status: issues.length === 0 ? 'ok' : 'mismatch', issues };
}

/**
 * 是否满足"可以提请人工恢复"的全部条件。注意：满足也只是 RECOVERY_PENDING，
 * 不会自动回到 RUNNING——恢复必须有人点头。
 */
export function canEnterRecovery(ctx = {}, limits = {}) {
  const L = { ...GUARD_DEFAULTS, ...limits };
  const missing = [];

  const price = num(ctx.price);
  const lower = num(ctx.lower);
  const upper = num(ctx.upper);
  if (!(lower > 0 && upper > 0)) missing.push('缺少区间参数');
  else if (!(price >= lower && price <= upper)) missing.push(`价格 ${price} 未回到区间 [${lower}, ${upper}]`);

  const bars = num(ctx.barsClosedAboveLower);
  if (bars < L.recoveryMinBarsAboveLower) {
    missing.push(`站稳下沿的 1h K 线仅 ${bars}/${L.recoveryMinBarsAboveLower} 根`);
  }

  const pos = Math.abs(num(ctx.positionBase));
  const maxInv = Math.abs(num(ctx.maxInventoryBase));
  if (maxInv > 0 && pos > maxInv * L.recoveryMaxInventoryFrac) {
    missing.push(`持仓 ${pos} 超过恢复上限 ${(maxInv * L.recoveryMaxInventoryFrac).toFixed(8)}`);
  }

  if (num(ctx.openOrderCount) > 0) missing.push(`仍有 ${ctx.openOrderCount} 张未撤订单`);
  if (ctx.outOfRange === true) missing.push('仍处于破界状态');
  if (ctx.consistency && ctx.consistency.ok === false) missing.push('账本仍不一致');

  return { ok: missing.length === 0, missing };
}

/**
 * HALT 持久化账本：把熔断原因和策略起点余额写进 state 快照，重启后依然熔断。
 * startBalance 一旦写入就不再跟随当前 equity 变化（否则亏了钱重启就等于"重新开始"）。
 */
export class HaltLedger {
  constructor(raw = {}) {
    this.haltReason = raw.haltReason || null;
    this.haltedAt = num(raw.haltedAt) || null;
    this.startBalance = Number.isFinite(Number(raw.startBalance)) ? Number(raw.startBalance) : null;
    this.startBalanceAt = num(raw.startBalanceAt) || null;
    this.warnedAt = num(raw.warnedAt) || null;
  }

  /** 首次见到有效权益时锁定策略起点余额；已锁定则永不覆盖。 */
  lockStartBalance(equity, now = Date.now()) {
    if (this.startBalance != null) return { locked: false, startBalance: this.startBalance };
    if (!(Number(equity) > 0)) return { locked: false, startBalance: null };
    this.startBalance = Number(equity);
    this.startBalanceAt = now;
    return { locked: true, startBalance: this.startBalance };
  }

  halt(reason, now = Date.now()) {
    if (this.haltReason) return false;   // 粘滞：不覆盖首个原因
    this.haltReason = String(reason || '未指明原因');
    this.haltedAt = now;
    return true;
  }

  /** 仅人工调用。 */
  clearHalt() {
    const prev = this.haltReason;
    this.haltReason = null;
    this.haltedAt = null;
    return prev;
  }

  get isHalted() {
    return !!this.haltReason;
  }

  toJSON() {
    return {
      haltReason: this.haltReason,
      haltedAt: this.haltedAt,
      startBalance: this.startBalance,
      startBalanceAt: this.startBalanceAt,
      warnedAt: this.warnedAt,
    };
  }
}