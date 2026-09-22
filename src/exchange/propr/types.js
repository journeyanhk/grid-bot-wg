// Propr 适配器内部类型（JSDoc typedef，运行时零开销）。
// 约定：所有金额/数量在内部统一为 Number 展示；下单与持久化时用字符串保精度。
// positionSide 必须全程保真（long/short），不得仅存 buy/sell ——
// 二者风险语义不同：sell+long+reduceOnly=true 是平多；sell+short+reduceOnly=false 是开空。

/** @typedef {'paper'|'shadow'|'sim-write'|'challenge'} ProprMode */

/** @typedef {'buy'|'sell'} OrderSide */
/** @typedef {'long'|'short'} PositionSide */
/** @typedef {'net'|'hedge'|'unknown'} PositionMode */

/**
 * @typedef {Object} ProprMarket
 * @property {string} marketId        内部市场 ID（Propr 用 base 字符串，如 'BTC'）
 * @property {string} symbol
 * @property {string} displayName
 * @property {string} base
 * @property {string} quote
 * @property {string} status
 * @property {number} lastPrice
 * @property {number} stepSize
 * @property {number} stepPrice
 * @property {number} sizeDecimals
 * @property {number} priceDecimals
 * @property {number} minOrderSize
 * @property {number} minOrderNotional
 * @property {number} maxLeverage
 * @property {number|null} makerFee
 * @property {number|null} takerFee
 * @property {PositionMode} positionMode
 * @property {object} raw
 */

/**
 * @typedef {Object} ProprOrderView
 * @property {string} orderId
 * @property {string|null} clientOrderId   对应 Propr intentId（幂等键）
 * @property {string} marketId
 * @property {OrderSide} side
 * @property {PositionSide} positionSide
 * @property {'limit'|'market'} orderType
 * @property {number|null} price
 * @property {number} sizeBase
 * @property {boolean} reduceOnly
 * @property {number|null} levelIndex
 * @property {string} status
 * @property {number} createdAt
 * @property {object} raw
 */

/**
 * @typedef {Object} ProprPositionView
 * @property {string} positionId
 * @property {string} marketId
 * @property {PositionSide} positionSide
 * @property {number} sizeBase
 * @property {number} entryPrice
 * @property {number} markPrice
 * @property {number} unrealizedPnl
 * @property {number} leverage
 * @property {string} marginMode
 * @property {object} raw
 */

export const PROPR_MODES = Object.freeze(['paper', 'shadow', 'sim-write', 'challenge']);

/** 写操作方法名清单：shadow 模式必须全部拦截。 */
export const PROPR_WRITE_ACTIONS = Object.freeze([
  'setLeverage',
  'placeLimitOrder',
  'placeLimitOrders',
  'cancelOrder',
  'cancelAll',
  'closePosition',
]);
