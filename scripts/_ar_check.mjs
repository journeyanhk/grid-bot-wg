import { ArcusExchange } from '/data/home/repos/gridbot/src/exchange/ar/arcus.js';

const ex = new ArcusExchange({
  network: process.env.AR_NETWORK || 'testnet',
  address: process.env.AR_ACCOUNT_ADDRESS,
  keyHex: process.env.AR_API_SIGNING_KEY,
  accountIndex: Number(process.env.AR_ACCOUNT_INDEX ?? 0),
  market: 'BTC-USD',
});
ex.on('error', (e) => console.log('[ex error]', e.message));
await ex.init();
const mkt = ex._market(1) || (await ex.getMarkets()).find((m) => m.symbol === 'BTC-USD');
const oo = await ex.fetchOpenOrders(1);
const ids = new Set(oo.map((o) => String(o.orderId ?? o.id)));
const prices = oo.map((o) => Number(o.price)).sort((a,b)=>a-b);
const sides = oo.reduce((a,o)=>{a[o.side]=(a[o.side]||0)+1;return a;},{});
console.log('OPEN_ORDERS', JSON.stringify({count: oo.length, uniqueIds: ids.size, sides, minPx: prices[0], maxPx: prices[prices.length-1]}));
// gaps: find duplicated prices
const pc = {}; for (const o of oo) pc[o.price]=(pc[o.price]||0)+1;
const dupPrices = Object.entries(pc).filter(([,v])=>v>1);
console.log('DUP_PRICES', dupPrices.length);
const acct = await ex._refreshAccount();
console.log('ACCOUNT', JSON.stringify({equity: ex.equity, balance: ex.balance, realized: ex.realizedPnl}));
const pos = ex.getPosition(1);
console.log('POSITION', JSON.stringify(pos));
const rate = ex.health ? ex.health() : null;
console.log('HEALTH', JSON.stringify(rate));
console.log('MARK', ex.getPrice ? ex.getPrice(1) : null);
try { console.log('RATE_LIMIT', JSON.stringify(await ex._http('GET','/v1/rateLimit'))); } catch(e){ console.log('RATE_LIMIT_ERR', e.message); }
try { console.log('DMS', JSON.stringify(await ex._http('GET','/v1/deadman'))); } catch(e){ console.log('DMS_ERR', e.message); }
process.exit(0);
