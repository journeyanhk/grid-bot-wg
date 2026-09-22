// 方向策略共享类型与常量（阶段1 影子层与阶段4 执行层同构复用）。
// 仅类型/常量定义，无副作用。

/** 策略状态机（阶段3/4 使用；影子层以简化态映射）。严禁 LONG_ACTIVE → SHORT_ACTIVE 直接反转。 */
export const StrategyState = Object.freeze({
  FLAT: 'flat',
  LONG_ARMED: 'long_armed',
  LONG_ACTIVE: 'long_active',
  LONG_EXITING: 'long_exiting',
  SHORT_ARMED: 'short_armed',
  SHORT_ACTIVE: 'short_active',
  SHORT_EXITING: 'short_exiting',
  COOLDOWN: 'cooldown',
  DEGRADED: 'degraded',   // 行情/接口退化：禁止新增，允许减仓/止损
  PAUSED: 'paused',
  HALTED: 'halted',
});

/** 市场状态（RegimeFilter 输出）。 */
export const Regime = Object.freeze({
  TREND_UP: 'trend_up',
  TREND_DOWN: 'trend_down',
  RANGE: 'range',
  VOLATILE: 'volatile',
});

/** 订单意图类型（阶段4 OrderManager 消费；影子层先行定义保证同构）。 */
export const OrderKind = Object.freeze({
  OPEN: 'open',    // 初始开仓
  ADD: 'add',      // 分层加仓
  TP: 'tp',        // 分批止盈（必须 reduce-only）
  STOP: 'stop',    // 保护性止损（必须 reduce-only；原生触发单优先）
  EXIT: 'exit',    // 趋势失效退出
});

/**
 * @typedef {Object} OrderIntent 订单意图（阶段4 执行层接口）
 * @property {string} kind            OrderKind
 * @property {'buy'|'sell'} side
 * @property {boolean} reduceOnly     平仓类必须 true
 * @property {number|null} levelIndex 层号（0=初始，1..=加仓）
 * @property {string} strategyId
 * @property {string} reason          审计用：为何产生该意图
 */

/** 影子假设交易终态原因。 */
export const ExitReason = Object.freeze({
  TP_FULL: 'tp_full',
  STOP: 'stop',
  TRAILING_STOP: 'trailing_stop',
  SIGNAL_EXIT: 'signal_exit',
  MAX_HOLDING: 'max_holding', // 最长持仓时间熔断
});
