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

  // ── Propr Challenge（PR）────────────────────────────────────────────────
  // 四级模式：paper（本地模拟，不访问 API）| shadow（只读 Propr + 本地模拟）
  //   | sim-write（写入 Free Trial 模拟账户）| challenge（写入付费 Challenge，需显式确认）。
  // 刻意不使用 live：Propr 的 Challenge/Funded 官方均为模拟账户，避免与"真实资金"混淆。
  const PR_MODES = ['paper', 'shadow', 'sim-write', 'challenge'];
  const prModeRaw = String(process.env.PR_MODE || 'paper').toLowerCase();
  // 配置错误必须 fail closed：非法模式直接拒绝启动，绝不静默降级为 paper
  // （否则用户以为在连 Propr，实际只跑本地模拟，生产状态失真）。
  if (!PR_MODES.includes(prModeRaw)) {
    throw new Error(`非法 PR_MODE=${prModeRaw}，允许值：${PR_MODES.join('|')}`);
  }
  const propr = {
    mode: prModeRaw,
    apiKey: process.env.PROPR_API_KEY || '',
    apiUrl: (process.env.PROPR_API_URL || 'https://api.propr.xyz/v1').replace(/\/$/, ''),
    wsUrl: process.env.PROPR_WS_URL || 'wss://api.propr.xyz/ws',
    accountId: process.env.PROPR_ACCOUNT_ID || '',
    allowedAccountIds: (process.env.PROPR_ALLOWED_ACCOUNT_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    allowChallenge: String(process.env.PR_ALLOW_CHALLENGE || 'NO').toUpperCase() === 'YES',
    base: String(process.env.PR_BASE || 'BTC').toUpperCase(),
    leverage: Number(process.env.PR_LEVERAGE || 1),
    positionMode: String(process.env.PR_POSITION_MODE || 'auto').toLowerCase(),
    outOfRangeAction: String(process.env.PR_OUT_OF_RANGE_ACTION || 'close').toLowerCase(),
    enableAutoRecenter: String(process.env.PR_ENABLE_AUTO_RECENTER || 'false') === 'true',
    internalDailyStopPct: Number(process.env.PR_INTERNAL_DAILY_STOP_PCT || 0.01),
    internalMaxDrawdownPct: Number(process.env.PR_INTERNAL_MAX_DRAWDOWN_PCT || 0.03),
    orderPollMs: Number(process.env.PR_ORDER_POLL_MS || 3000),
    tradePollMs: Number(process.env.PR_TRADE_POLL_MS || 3000),
    reconcileMs: Number(process.env.PR_RECONCILE_MS || 15000),
    timeoutMs: Number(process.env.PR_TIMEOUT_MS || 30000),
    feeRate: Number(process.env.PR_FEE_RATE || 0.0005),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.PR_PROXY || globalProxy,
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
    propr,
  };
}

/** accountId 脱敏：仅保留前 4 + 后 4（错误信息与日志一律使用）。 */
export function maskAccountId(id) {
  const s = String(id ?? '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/**
 * Propr 启动护栏（ADR-006）：paper 之外必须显式配置账户并校验白名单，
 * challenge 额外要求 PR_ALLOW_CHALLENGE=YES。任何一条不满足都拒绝启动，
 * 宁可起不来，也不能误绑账户/误切付费账户。
 */
export function validateProprConfig(pr = {}) {
  const mode = pr.mode || 'paper';
  if (mode === 'paper') return;
  if (!pr.apiKey) {
    throw new Error(`Propr ${mode} 模式需要 PROPR_API_KEY（写入 .env，勿提交仓库）。`);
  }
  if (!pr.accountId) {
    throw new Error(`Propr ${mode} 模式必须显式配置 PROPR_ACCOUNT_ID（禁止自动发现，避免误绑定账户）。`);
  }
  const allowed = Array.isArray(pr.allowedAccountIds) ? pr.allowedAccountIds : [];
  if (allowed.length && !allowed.includes(pr.accountId)) {
    throw new Error(`Propr 账户 ${maskAccountId(pr.accountId)} 不在 PROPR_ALLOWED_ACCOUNT_IDS 白名单中。`);
  }
  if (mode === 'challenge' && !pr.allowChallenge) {
    throw new Error('Propr challenge 模式需显式设置 PR_ALLOW_CHALLENGE=YES（防止误切付费账户）。');
  }
}

export const ROOT = root;
