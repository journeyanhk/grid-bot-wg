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
    address: process.env.VA_ADDRESS || '',
    slippageLimit: process.env.VA_SLIPPAGE_LIMIT || '0.005',
    // Cloudflare: Node fetch -> 403, curl_cffi(Chrome) -> 200. 'bridge' spawns the
    // Python transport worker and is the only mode that passes CF in prod.
    transport: (process.env.VA_TRANSPORT || 'bridge').toLowerCase() === 'node' ? 'node' : 'bridge',
    pythonPath: process.env.VA_PYTHON || '',
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
    lr,
    hl,
    va,
  };
}

export const ROOT = root;
