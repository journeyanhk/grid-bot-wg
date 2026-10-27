#!/usr/bin/env node
// Arcus 主网（或任何网络）开跑前自检：只读，不下单、不改配置。
//
// 用法（密钥走环境变量，命令行不落 trace）：
//   AR_NETWORK=mainnet AR_ACCOUNT_ADDRESS=0x… AR_API_SIGNING_KEY=<64hex> AR_ACCOUNT_INDEX=0 \
//   node scripts/preflight-arcus.mjs --rungs 66 --spacing-pct 0.09 --size 0.0002 --leverage 10
//
// 检查项：密钥/地址合法、时钟偏差、市场闸门（24/7、CRYPTO）、费率上限、账户可用
// 保证金、遗留挂单、遗留持仓，以及"按这组参数铺梯要吃多少保证金、每格净利多少"。
// 任一硬项不通过 → 退出码 1，不要开机器人。
// ⚠️ 不要在机器人运行时执行：脚本会 arm/disarm 一次死手开关。
import { createExchange } from '../src/exchange/ar/index.js';
import { parseAccount, parsePositions } from '../src/exchange/ar/market.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] != null) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : dflt;
};

const rungs = Number(arg('rungs', 66));
const spacingPct = Number(arg('spacing-pct', 0.09));      // 百分比，如 0.09 表示 0.09%
const sizeBase = Number(arg('size', 0.0002));
const leverage = Number(arg('leverage', 10));
const marketHint = String(arg('market', process.env.AR_MARKET || 'BTC-USD'));

const rows = [];
const add = (ok, name, detail = '') => rows.push({ ok, name, detail });
const fmt = (n, d = 2) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : String(n));

const ex = createExchange({
  mode: 'live',
  network: process.env.AR_NETWORK || 'mainnet',
  address: process.env.AR_ACCOUNT_ADDRESS,
  signingKey: process.env.AR_API_SIGNING_KEY,
  signingKeyFile: process.env.AR_API_SIGNING_KEY_FILE,
  accountIndex: Number(process.env.AR_ACCOUNT_INDEX ?? 0),
  maxMakerFeePpm: Number(process.env.AR_MAX_MAKER_FEE_PPM ?? 200),
  market: marketHint,
});

let fatal = null;
try {
  await ex.init();
} catch (e) {
  fatal = e;
}

if (fatal) {
  console.log(`\n❌ 初始化失败：${fatal.message}`);
  const hint = /whitelist/i.test(fatal.message)
    ? '原因：该地址不在 Arcus 主网白名单，或用了测试网地址查主网。'
    : /api key|API key|401|403/i.test(fatal.message)
      ? '原因：密钥与该地址/子账户不匹配（accountIndex 是否写对？key 是否主网生成？）。'
      : '';
  if (hint) console.log(`   ${hint}`);
  process.exit(1);
}

const m = [...ex.markets.values()].find((x) => x.displayName === marketHint || String(x.marketId) === String(marketHint));
if (!m) {
  console.log(`❌ 找不到市场 ${marketHint}`);
  process.exit(1);
}

// 账户余额：_refreshAccount 只缓存 equity/balance，freeCollateral 现取一次。
let acct = null;
try {
  const payload = await ex._http('GET', '/v1/account', {
    query: { address: ex.address, accountIndex: String(ex.accountIndex) }, weight: 2,
  });
  acct = parseAccount(payload);
} catch (e) {
  acct = { error: e.message };
}

const price = ex._prices.get(m.symbol)?.last ?? Number(m.lastPrice) ?? null;
const spacingAbs = price ? price * spacingPct / 100 : null;
const half = (rungs / 2) * (spacingAbs ?? 0);
const notional = price ? rungs * sizeBase * price : null;
const margin = notional ? notional / leverage : null;
const feePpm = Number(m.makerFeePpm ?? 0);
const grossPerRung = price ? sizeBase * (spacingAbs ?? 0) : null;
const feePerRung = price ? sizeBase * price * 2 * feePpm / 1e6 : null;
const netPerRung = grossPerRung != null && feePerRung != null ? grossPerRung - feePerRung : null;
const freeCollateral = acct?.freeCollateral ?? acct?.equity ?? 0;

add(true, '网络/市场', `${ex.network} chain=${ex.chainId} ${m.displayName} id=${m.marketId} status=${m.status}`);
add(m.hasTradingHours !== true, '24/7 可交易', m.hasTradingHours ? '该市场有 regularTradingHours，不能做网格' : 'regularTradingHours=null');
add(feePpm <= ex.maxMakerFeePpm, 'maker 费率闸门', `maker ${feePpm} ppm / taker ${m.takerFeePpm} ppm，上限 ${ex.maxMakerFeePpm} ppm`);
add(Math.abs(ex.clockSkewMs ?? 999) < 1200, '时钟偏差', `${fmt(ex.clockSkewMs, 0)} ms（>1200ms 需校时，签名时间戳已被补偿）`);
add(Number(freeCollateral) > 0, '账户可用保证金', `equity ${fmt(acct?.equity)} / free ${fmt(freeCollateral)} / netDeposits ${fmt(acct?.netDeposits)} / balance ${fmt(acct?.balance)}`);
add(margin != null && Number(freeCollateral) >= margin * 1.2, '保证金充足', `需 ${fmt(margin)}（名义 ${fmt(notional)} @ ${leverage}x），可用 ${fmt(freeCollateral)}，余量 ${fmt(Number(freeCollateral) - (margin ?? 0))}`);
add(netPerRung != null && netPerRung > 0, '单格净利为正', `毛利 ${fmt(grossPerRung, 4)} − 双边费 ${fmt(feePerRung, 4)} = ${fmt(netPerRung, 4)} / 格（盈亏平衡格距 ${(2 * feePpm / 1e4).toFixed(3)}%）`);
add(sizeBase * price >= Number(m.minOrderNotional) && sizeBase >= Number(m.minOrderSize), '最小下单量', `size ${sizeBase} × ${fmt(price)} = ${fmt(sizeBase * price)} ≥ minNotional ${m.minOrderNotional}，size ≥ minOrderSize ${m.minOrderSize}`);

let openOrders = [];
try { openOrders = await ex.fetchOpenOrders(m.marketId); } catch (e) { add(false, '遗留挂单查询', e.message); }
if (openOrders.length === 0) add(true, '遗留挂单', '0 张（干净）');
else add(false, '遗留挂单', `${openOrders.length} 张未撤，开跑前必须先 cancelAll`);

let positions = [];
try {
  const p = await ex._http('GET', '/v1/positions', {
    query: { address: ex.address, accountIndex: String(ex.accountIndex) }, weight: 2,
  });
  positions = parsePositions(p).filter((x) => Math.abs(x.sizeBase) > 0);
} catch (e) { add(false, '遗留持仓查询', e.message); }
if (positions.length === 0) add(true, '遗留持仓', '无');
else add(false, '遗留持仓', positions.map((p) => `${p.marketId}: ${p.sizeBase} @ ${p.entryPrice}`).join(', ') + '（半梯开跑前应已平掉）');

console.log(`\n=== Arcus 开跑前自检（${ex.network}）===`);
for (const r of rows) console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(12, ' ')} ${r.detail}`);
console.log('\n--- 计划参数 ---');
console.log(`格数 ${rungs} / 格距 ${spacingPct}% (${fmt(spacingAbs)} 美元) / size ${sizeBase} / ${leverage}x`);
console.log(`区间 ${fmt(price - half)} – ${fmt(price + half)}（现价 ${fmt(price)}，±${(half / price * 100).toFixed(2)}%）`);
console.log(`名义 ${fmt(notional)} / 保证金 ${fmt(margin)} / 每格净利 ${fmt(netPerRung, 4)}`);
if (netPerRung != null && netPerRung > 0) {
  const crossingsPerDay = price ? (price * 0.01) / spacingAbs : 0;
  console.log(`粗略：BTC 日内 1% 波动 ≈ ${crossingsPerDay.toFixed(0)} 次穿越 ≈ $${fmt(netPerRung * crossingsPerDay)}/天`);
}

const failed = rows.filter((r) => !r.ok);
console.log(failed.length ? `\n结果：${failed.length} 项不通过，禁止开跑。\n` : '\n结果：全部通过，可以开跑。\n');

try { await ex.disarmDms(); } catch { /* 没武装过也无妨 */ }
ex.stop();
process.exit(failed.length ? 1 : 0);