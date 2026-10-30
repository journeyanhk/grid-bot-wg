// 三交易所整合配置加载器
// 支持全局代理（GLOBAL_PROXY）+ 各交易所独立代理覆盖
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 可选数值环境变量：空/未配置返回 NaN（供 Lighter 的 accountIndex 等用）。 */
function optionalNumber(name) {
  const raw = process.env[name];
  return raw == null || String(raw).trim() === '' ? Number.NaN : Number(raw);
}

export function loadEnv() {
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        const q = v.match(/^"([^"]*)"|^'([^']*)'/); // quoted: take the quoted content
        if (q) v = q[1] ?? q[2];
        else v = v.replace(/\s+#.*$/, '').trim();   // unquoted: strip inline comments
        process.env[m[1]] = v;
      }
    }
  }
}

export function getConfig() {
  loadEnv();

  // 全局代理：作为所有交易所的默认代理
  const globalProxy =
    process.env.GLOBAL_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    '';

  // ── Decibel ──────────────────────────────────────────────────────────────
  const deNet = (process.env.DE_NETWORK || 'mainnet').toLowerCase();
  const deDefaults =
    deNet === 'testnet'
      ? { api: 'https://api.testnet.aptoslabs.com/decibel' }
      : { api: 'https://api.mainnet.aptoslabs.com/decibel' };

  const de = {
    mode: (process.env.DE_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: deNet,
    apiKey: process.env.DECIBEL_API_KEY || '',
    privateKey: process.env.DECIBEL_PRIVATE_KEY || '',
    subaccount: process.env.DECIBEL_SUBACCOUNT || '',
    apiUrl: (process.env.DECIBEL_API_URL || deDefaults.api).replace(/\/$/, ''),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.DECIBEL_PROXY || globalProxy,
  };

  // ── Extended ──────────────────────────────────────────────────────────────
  const exNet = (process.env.EX_NETWORK || 'mainnet').toLowerCase();
  const exDefaults =
    exNet === 'testnet'
      ? { api: 'https://api.starknet.sepolia.extended.exchange' }
      : { api: 'https://api.starknet.extended.exchange' };

  const ex = {
    mode: (process.env.EX_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: exNet,
    apiKey: process.env.EXTENDED_API_KEY || '',
    vault: process.env.EXTENDED_VAULT || '',
    starkPrivateKey: process.env.EXTENDED_STARK_PRIVATE_KEY || '',
    starkPublicKey: process.env.EXTENDED_STARK_PUBLIC_KEY || '',
    feeRate: process.env.EXTENDED_MAX_FEE || '0.0005',
    apiUrl: (process.env.EXTENDED_API_URL || exDefaults.api).replace(/\/$/, ''),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.EXTENDED_PROXY || globalProxy,
  };

  // ── RISEx ─────────────────────────────────────────────────────────────────
  const rsNet = (process.env.RS_NETWORK || 'mainnet').toLowerCase();
  const rsDefaults =
    rsNet === 'testnet'
      ? { api: 'https://api.testnet.rise.trade', ws: 'wss://ws.testnet.rise.trade' }
      : { api: 'https://api.risex.trade', ws: 'wss://ws.risex.trade' };

  const rs = {
    mode: (process.env.RS_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: rsNet,
    account: process.env.ACCOUNT_ADDRESS || '',
    signerKey: process.env.SIGNER_PRIVATE_KEY || '',
    apiUrl: process.env.RISEX_API_URL || rsDefaults.api,
    wsUrl: process.env.RISEX_WS_URL || rsDefaults.ws,
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.RISEX_PROXY || globalProxy,
  };

  // ── Arcus ─────────────────────────────────────────────────────────────────
  // 默认 testnet：主网需显式 AR_NETWORK=mainnet。Arcus 主网交易需邀请白名单，
  // testnet 网页 Deposit 白送 ~$1,000 USDG，D1-D5 全程不花钱。
  const arNet = (process.env.AR_NETWORK || 'testnet').toLowerCase();
  const arDefaults =
    arNet === 'testnet'
      ? { api: 'https://api.testnet.arcus.xyz', ws: 'wss://api.testnet.arcus.xyz/v1/ws' }
      : { api: 'https://api.arcus.xyz', ws: 'wss://api.arcus.xyz/v1/ws' };

  const ar = {
    mode: (process.env.AR_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: arNet,
    address: (process.env.AR_ACCOUNT_ADDRESS || '').toLowerCase(),
    signingKey: process.env.AR_API_SIGNING_KEY || '',
    signingKeyFile: process.env.AR_API_SIGNING_KEY_FILE || '',
    accountIndex: Number(process.env.AR_ACCOUNT_INDEX || 0),
    // 默认市场：主网有 75 个市场，不指定会取到第一个可交易标的（可能是股票永续）
    market: (process.env.AR_MARKET || '').trim(),
    apiUrl: (process.env.AR_API_URL || arDefaults.api).replace(/\/$/, ''),
    // paper 默认吃主网真实行情（AR_PAPER_API_URL 可覆盖为测试网）
    paperApiUrl: (process.env.AR_PAPER_API_URL || '').replace(/\/$/, ''),
    paperNetwork: process.env.AR_PAPER_NETWORK || 'mainnet',
    wsUrl: process.env.AR_WS_URL || arDefaults.ws,
    // 单格毛利仅几美分，双边 maker 费必须显著低于格距；未知按 0 处理，启动时读真实费率复核。
    feeRate: Number(process.env.AR_FEE_RATE || 0),
    // 主网启动闸门：maker 费超过此值直接拒绝启动（主网 BTC-USD 实测 150 ppm）。
    maxMakerFeePpm: Number(process.env.AR_MAX_MAKER_FEE_PPM ?? 200),
    // 单格净利红线（USD）：间距×size − 双边费低于它拒启；主网默认 0.01，testnet 默认 0。
    minGridNetUsd: Number(process.env.AR_MIN_GRID_NET_USD ?? ''),
    // 独立库存硬上限（单位：格）。0/空 = 沿用旧行为（= gridCount），仅为兼容。
    // 66 格价格覆盖 + 8 格真实库存上限，是两件事：覆盖范围决定成交机会，
    // 库存上限决定最大暴露。把后者绑到前者，等于让"铺得多"自动变成"敢扛得多"。
    maxInventoryGrids: Number(process.env.AR_MAX_INVENTORY_GRIDS || 0) || null,
    inventoryWarnGrids: Number(process.env.AR_INVENTORY_WARN_GRIDS || 0) || null,
    inventoryBlockGrids: Number(process.env.AR_INVENTORY_BLOCK_GRIDS || 0) || null,
    inventoryHaltGrids: Number(process.env.AR_INVENTORY_HALT_GRIDS || 0) || null,
    deadmanMs: Number(process.env.AR_DEADMAN_MS || 60_000),
    // 全局止损线（USDC，按盘口价重算）：持仓亏到这条线强制平仓停止；0 = 不启用。
    stopLossUsd: Number(process.env.AR_STOP_LOSS_USD ?? 50),
    pollMs: Number(process.env.AR_POLL_MS || 2500),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.AR_PROXY || globalProxy,
  };

  // ── 仪表盘鉴权 ────────────────────────────────────────────────────────────
  // 账号密码模式：DASHBOARD_USER + DASHBOARD_PASS 配置后，所有 /api/*（除
  // /api/login）必须通过登录获取的会话令牌访问，VPS 公网部署推荐使用。
  // 兼容模式：仅配置 DASHBOARD_TOKEN 时退化为静态令牌；两者都不配则仅允许
  // 回环 Host 访问。
  const dashboardUser = process.env.DASHBOARD_USER || '';
  const dashboardPass = process.env.DASHBOARD_PASS || '';
  const dashboardToken = process.env.DASHBOARD_TOKEN || '';
  // PUBLIC_ORIGIN: 可选。逗号分隔的允许 Origin（VPS 用域名访问时配置，如
  // https://trade.example.com）。用于 Origin 校验，阻断跨站请求/DNS rebinding。
  const publicOrigins = (process.env.PUBLIC_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  // ── Robinhood Chain Lighter (RHC) ────────────────────────────────────────
  // 固定官方主网端点/profile。从不接收 ETH 钱包私钥，无提现/转账操作。
  const lr = {
    mode: (process.env.LR_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: 'mainnet',
    apiUrl: 'https://api.rh.lighter.xyz',
    wsUrl: 'wss://api.rh.lighter.xyz/stream',
    chainId: 466324,
    accountIndex: optionalNumber('LIGHTER_ACCOUNT_INDEX'),
    apiKeyIndex: optionalNumber('LIGHTER_API_KEY_INDEX'),
    apiPrivateKey: process.env.LIGHTER_API_PRIVATE_KEY || '',
    apiPrivateKeyFile: process.env.LIGHTER_API_PRIVATE_KEY_FILE || '',
    pythonPath: process.env.LIGHTER_PYTHON || '',
    feeRate: Number(process.env.LIGHTER_FEE_RATE || 0.0005),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.LIGHTER_PROXY || globalProxy,
  };

  // ── Hyperliquid (HL) / Entropy io dex ────────────────────────────────────
  // 固定官方主网端点 + dex:"io" 命名空间（HIP-3 建设者市场，如 io:ANTH）。
  // 签名器只持 agent wallet 私钥（可交易不可提现）。
  const hl = {
    mode: (process.env.HL_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: 'mainnet',
    apiUrl: 'https://api.hyperliquid.xyz',
    infoUrl: 'https://api.hyperliquid.xyz/info',
    chainId: 42161,
    dex: process.env.HL_DEX || 'io',
    accountAddress: process.env.HL_ACCOUNT_ADDRESS || '',
    agentPrivateKey: process.env.HL_AGENT_PRIVATE_KEY || '',
    agentPrivateKeyFile: process.env.HL_AGENT_PRIVATE_KEY_FILE || '',
    pythonPath: process.env.HL_PYTHON || '',
    feeRate: Number(process.env.HL_FEE_RATE || 0.0005),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.HL_PROXY || globalProxy,
  };

  // ── Variational Omni (VA) ────────────────────────────────────────────────
  // RFQ/OLP 报价模型（无订单簿），全有或全无限价单，零手续费（点差成本）。
  // LIVE 鉴权用 vr-token cookie（VARIATIONAL_TOKEN，贴 token 优先）。
  // 精度默认保守，未经实盘校验前不要放大下单量（见 market.js 说明）。
  const vaUnderlyings = (process.env.VA_UNDERLYINGS || 'BTC')
    .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  const vaFundingInterval = optionalNumber('VA_FUNDING_INTERVAL_S');
  const vaLeverage = optionalNumber('VA_LEVERAGE');
  const va = {
    mode: (process.env.VA_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: 'mainnet',
    baseUrl: process.env.VA_BASE_URL || 'https://omni.variational.io',
    underlyings: vaUnderlyings.length ? vaUnderlyings : ['BTC'],
    token: process.env.VARIATIONAL_TOKEN || '',
    llToken: process.env.VA_LL_TOKEN || '',   // vr-ll-token（长期凭证；5 分钟 token 自动续期）
    address: process.env.VA_ADDRESS || '',
    // 独立热钱包自动登录（SIWE）：配了私钥即可无人值守续签 vr-token；贴 token 仍优先。
    privateKey: process.env.VA_WALLET_PRIVATE_KEY || '',
    tokenCachePath: process.env.VA_TOKEN_CACHE || '.runtime/va_token.json',
    slippageLimit: process.env.VA_SLIPPAGE_LIMIT || '0.005',
    // Cloudflare: Node fetch -> 403, curl_cffi(Chrome) -> 200. 'bridge' spawns the
    // Python transport worker and is the only mode that passes CF in prod.
    transport: (process.env.VA_TRANSPORT || 'bridge').toLowerCase() === 'node' ? 'node' : 'bridge',
    pythonPath: process.env.VA_PYTHON || '',
    // 50 orders/instrument/order-type is a HARD server limit (probe-verified: 51st => HTTP 422).
    maxOpenOrders: optionalNumber('VA_MAX_OPEN_ORDERS') || 50,
    leverage: Number.isFinite(vaLeverage) ? vaLeverage : null,
    instrument: {
      instrumentType: process.env.VA_INSTRUMENT_TYPE || 'perpetual_future',
      settlementAsset: process.env.VA_SETTLEMENT_ASSET || 'USDC',
      fundingIntervalS: Number.isFinite(vaFundingInterval) ? vaFundingInterval : undefined,
      kind: process.env.VA_KIND || '',
    },
    feeRate: Number(process.env.VA_FEE_RATE || 0.0001),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.VA_PROXY || globalProxy,
  };

  return {
    port: Number(process.env.PORT || 8080),
    // SECURITY: bind to loopback by default so the dashboard (which can start/stop
    // LIVE trading and edit .env) is NOT exposed to the local network. Set
    // HOST=0.0.0.0 explicitly only if you understand the risk and add your own auth.
    host: process.env.HOST || '127.0.0.1',
    dashboardUser,
    dashboardPass,
    dashboardToken,
    publicOrigins,
    globalProxy,
    de,
    ex,
    rs,
    ar,
    lr,
    hl,
    va,
  };
}

export const ROOT = root;
