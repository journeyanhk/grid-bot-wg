// 写门（M2）：任何下单前都必须过这里。纯函数，便于单测。
//
// 设计原则：**只拦开仓，不拦降风险**。数据不新鲜、账户状态可疑、双边持仓、
// 风控降档 —— 一律只允许 reduceOnly / 撤单 / 平仓。
export const DEFAULT_LIMITS = Object.freeze({
  dailyPct: 3,      // 官方日损
  ddPct: 6,         // 官方静态回撤
  soft: 50,         // 内部日软线（美元）
  hard: 100,        // 内部日硬线
  total: 150,       // 内部总回撤（美元）
  staleMs: 45_000,
});

/** 由权益推导风控状态。equity/balance/dayStartBalance 都是美元。 */
export function computeRiskState({
  equity, balance, dayStartBalance, startBalance,
  soft = DEFAULT_LIMITS.soft, hard = DEFAULT_LIMITS.hard, total = DEFAULT_LIMITS.total,
}) {
  const eq = Number(equity);
  const bal = Number(balance ?? equity);
  const day0 = Number(dayStartBalance ?? bal);
  const s0 = Number(startBalance ?? 5000);
  if (equity == null || !Number.isFinite(eq)) return { state: 'UNKNOWN', reason: 'equity 缺失', allowOpen: false };

  const dayLoss = day0 - eq;             // 正数 = 亏
  const totalLoss = s0 - eq;
  const dayFloorOfficial = day0 * (1 - 0.03);
  const staticFloor = s0 * (1 - 0.06);
  const internalTotalFloor = s0 - total;

  let state = 'NORMAL';
  const reasons = [];
  const totalFloor = Math.max(staticFloor, internalTotalFloor);
  if (eq <= totalFloor) {
    state = 'CLOSE_ALL';
    reasons.push(`总回撤触线：equity ${eq.toFixed(2)} ≤ ${totalFloor.toFixed(2)}`);
  } else if (dayLoss >= hard) {
    state = 'HALT_NEW';
    reasons.push(`日亏 ${dayLoss.toFixed(2)} ≥ 硬线 ${hard}`);
  } else if (dayLoss >= soft) {
    state = 'THROTTLE';
    reasons.push(`日亏 ${dayLoss.toFixed(2)} ≥ 软线 ${soft}`);
  } else if (eq - totalFloor < 25) {
    state = 'HALT_NEW';
    reasons.push(`距总回撤线仅 ${(eq - totalFloor).toFixed(2)}`);
  } else if (dayLoss >= soft - 10) {
    state = 'THROTTLE';
    reasons.push(`接近日软线（${dayLoss.toFixed(2)} / ${soft}）`);
  }
  return {
    state, reasons,
    dayLoss: round2(dayLoss), totalLoss: round2(totalLoss),
    dayFloorOfficial: round2(dayFloorOfficial), staticFloor: round2(staticFloor),
    allowOpen: state === 'NORMAL',
  };
}

/**
 * 写门。返回 {allowOpen, allowReduce, reasons[]}。
 * 任何一项不满足 → 只允许降风险操作。
 */
export function evaluateWriteGate({
  mode, allowLive, attemptStatus, accountAgeMs, staleMs = DEFAULT_LIMITS.staleMs,
  positions, risk, notional = 0, maxOpenNotional = 0, newNotional = 0,
  inventoryBtc = 0, maxInventoryBtc = 0, newQty = 0,
}) {
  const reasons = [];
  const allowReduce = true;   // 降风险永远允许

  if (!['sim-write', 'challenge'].includes(mode)) reasons.push(`mode=${mode} 不允许写`);
  if (!allowLive) reasons.push('PR_ALLOW_LIVE 未开启');
  if (String(attemptStatus).toLowerCase() !== 'active') reasons.push(`attempt 状态 ${attemptStatus} ≠ active`);
  if (!Number.isFinite(accountAgeMs) || accountAgeMs > staleMs) reasons.push(`账户快照过期 ${Math.round((accountAgeMs || 0) / 1000)}s`);
  if (positions?.dualSide) reasons.push('双边持仓：只允许减仓');
  if (!risk) reasons.push('风控状态未知（尚无快照）');
  else if (!risk.allowOpen) reasons.push(`风控状态 ${risk.state}`);
  if (Number(notional) + Number(newNotional) > Number(maxOpenNotional) + 1e-9) {
    reasons.push(`名义超限 ${(Number(notional) + Number(newNotional)).toFixed(2)} > ${Number(maxOpenNotional).toFixed(2)}`);
  }
  if (Number(maxInventoryBtc) > 0) {
    const gross = Number(inventoryBtc) + Number(newQty);
    if (gross > Number(maxInventoryBtc) + 1e-12) {
      reasons.push(`库存超限 ${gross.toFixed(4)} > ${Number(maxInventoryBtc).toFixed(4)} BTC（gross）`);
    }
  }
  return { allowOpen: reasons.length === 0, allowReduce, reasons };
}

function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }

/**
 * 双边持仓策略。
 *   freeze（默认，按附件 C）：检测到 long>0 且 short>0 → 禁止开仓，只允许减仓
 *   cap（沙盒）：允许继续，但每侧不得超过 maxPerSide；仍会告警
 * ack 由人工确认文件/按钮产生，只对 cap 生效。
 */
export function evaluateDualSide({ positions, policy = 'freeze', ack = false, maxPerSide = 0.003 }) {
  const long = positions?.long?.size ?? 0;
  const short = positions?.short?.size ?? 0;
  const dual = long > 0 && short > 0;
  if (!dual) return { dual: false, allowOpen: true, reason: null };
  if (policy === 'cap' && ack) {
    const over = long > maxPerSide + 1e-12 || short > maxPerSide + 1e-12;
    return { dual: true, allowOpen: !over, capped: true, reason: over ? `单侧超过 ${maxPerSide} BTC` : 'cap 模式：仍在每侧上限内' };
  }
  return { dual: true, allowOpen: false, reason: '双边持仓：冻结开仓，等待人工确认' };
}

/** 趋势过滤：命中时只允许减仓，并撤掉扩大敞口的挂单。 */
export function trendHalt({ trend, strength = 0, threshold = 0.6 }) {
  const strong = Math.abs(Number(strength) || 0) >= threshold;
  const dir = trend === 'down' ? 'long' : trend === 'up' ? 'short' : null;
  return { halt: strong && !!dir, blockSide: strong && dir ? dir : null, reason: strong && dir ? `趋势过滤：${trend} ${strength}` : null };
}

/** 突破处置：撤单 + reduce-only 平仓 + 停止（与 outOfRangeAction=close 对齐）。 */
export function breakoutAction({ price, lower, upper, hysteresis = 0 }) {
  if (!(upper > lower)) return { out: false, action: 'none' };
  const out = price < lower * (1 - hysteresis) || price > upper * (1 + hysteresis);
  return out
    ? { out: true, action: 'cancel_and_flatten', side: price < lower ? 'long' : 'short' }
    : { out: false, action: 'none' };
}
