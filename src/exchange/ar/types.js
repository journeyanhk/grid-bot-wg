// Shared constants + the IExchange contract as implemented by the Arcus adapter.
//
// IExchange (EventEmitter):
//   async init()
//   async reconnect()
//   async getMarkets()                         -> Market[]
//   async getCandles(marketId, intervalSec, n) -> Candle[]
//   async getPrice(marketId)                   -> number
//   async setLeverage(marketId, x)
//   async placeLimitOrder(o)                   -> { orderId, clientOrderId }
//   async cancelOrder(marketId, orderId)
//   async cancelAll(marketId)
//   getOpenOrders(marketId)                    -> Order[]
//   async fetchOpenOrders(marketId)            -> Order[]   (bot 对账用)
//   adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase })
//   forgetOrder(orderId)
//   getPosition(marketId)                      -> Position | null
//   async closePosition(marketId)
//   start() / stop()
//   fields: equity / balance / realizedPnl / feeRate / dataSource / mode / network
//   events: 'price' ({marketId, price}), 'fill' (Fill), 'error' (Error)
//
// Market   { marketId, displayName, symbol, lastPrice, stepSize, stepPrice, maxLeverage, minOrderSize }
// Candle   { time, open, high, low, close, volume }
// Order    { orderId, marketId, side, price, sizeBase, reduceOnly, levelIndex, clientOrderId }
// Fill     { orderId, marketId, side, price, sizeBase, levelIndex, clientOrderId }
// Position { sizeBase(signed +long/-short), entryPrice, unrealizedPnl }

export const SIDE = { BUY: 0, SELL: 1 };
export const ORDER_TYPE = { MARKET: 0, LIMIT: 1 };
// Arcus TIF: 0 GTT, 1 FOK, 2 IOC, 3 ALO(post-only). 网格一律 ALO。
export const TIF = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 };
export const OP = { PLACE: 1, CANCEL: 2, MODIFY: 3 };