// Arithmetic (equal-spacing) grid generation and the rung-replacement rules
// shared by neutral / long / short grid modes. Pure functions — no I/O.

/**
 * Build an arithmetic grid.
 * @returns {{levels:number[], spacing:number, count:number}}
 *   levels[0]=lower ... levels[count]=upper, count = number of cells.
 */
export function buildGrid({ lower, upper, gridCount }) {
  if (!(upper > lower)) throw new Error('upper 必须大于 lower');
  if (!(gridCount >= 2)) throw new Error('gridCount 至少为 2');
  const spacing = (upper - lower) / gridCount;
  const levels = [];
  for (let i = 0; i <= gridCount; i++) levels.push(round(lower + i * spacing));
  return { levels, spacing: round(spacing), count: gridCount };
}

/** reduce-only flag for an order side under a given mode. */
export function isReduceOnly(side, mode) {
  if (mode === 'long') return side === 'sell';   // sells only close longs
  if (mode === 'short') return side === 'buy';    // buys only close shorts
  return false;                                    // neutral: both can open
}

/**
 * Initial orders to place given current price and mode.
 * neutral: buys below price, sells above price.
 * long:    buys below price only (accumulate long, take profit as price rises).
 * short:   sells above price only (build short, take profit as price falls).
 * Levels within `skipBand` (fraction of spacing) of price are skipped so we
 * don't immediately cross the market.
 * @returns {{levelIndex:number, price:number, side:'buy'|'sell', reduceOnly:boolean}[]}
 */
export function seedOrders({ levels, price, mode, skipBand = 0.25, spacing, windowGrids }) {
  const sp = spacing ?? gridSpacing(levels);
  const band = sp * skipBand;
  // 活跃窗口：只把现价附近 windowGrids 格内的档位提交为真实开仓单。
  // 66 格价格覆盖保留，但远端档位只作候选——否则同向 33 张挂单全算进库存暴露，
  // 持仓 0 时就顶到上限，第一笔成交即自锁。windowGrids 缺省 = 不限（旧行为）。
  const win = Number.isFinite(windowGrids) && windowGrids > 0 ? sp * windowGrids : Infinity;
  const orders = [];
  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i];
    if (Math.abs(lvl - price) < band) continue;
    if (Math.abs(lvl - price) > win) continue;
    if (lvl < price) {
      if (mode === 'neutral' || mode === 'long') {
        orders.push({ levelIndex: i, price: lvl, side: 'buy', reduceOnly: isReduceOnly('buy', mode) });
      }
    } else if (lvl > price) {
      if (mode === 'neutral' || mode === 'short') {
        orders.push({ levelIndex: i, price: lvl, side: 'sell', reduceOnly: isReduceOnly('sell', mode) });
      }
    }
  }
  return orders;
}

/**
 * Given a just-filled order, return the replacement order to place (the other
 * side, one rung away), or null if it would fall outside the grid.
 * Buy filled at i  -> Sell at i+1 (lock in one grid of profit).
 * Sell filled at i -> Buy  at i-1.
 */
export function replacementFor(filled, levels, mode) {
  if (filled.side === 'buy') {
    const j = filled.levelIndex + 1;
    if (j > levels.length - 1) return null;
    return { levelIndex: j, price: levels[j], side: 'sell', reduceOnly: isReduceOnly('sell', mode) };
  } else {
    const j = filled.levelIndex - 1;
    if (j < 0) return null;
    return { levelIndex: j, price: levels[j], side: 'buy', reduceOnly: isReduceOnly('buy', mode) };
  }
}

/** Profit (quote currency) captured by one completed buy->sell rung. */
export function rungProfit(spacing, sizeBase) {
  return spacing * sizeBase;
}

function gridSpacing(levels) { return levels.length > 1 ? levels[1] - levels[0] : 0; }
function round(x) { return Math.round(x * 1e8) / 1e8; }
