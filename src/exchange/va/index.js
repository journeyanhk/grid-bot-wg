import { VariationalExchange } from './variational.js';
import { PaperExchange } from './paper.js';

// Factory for the Variational Omni adapter. LIVE requires a vr-token cookie
// (paste-token-first: VARIATIONAL_TOKEN); paper mode only needs public
// endpoints, so it always works.
export function createExchange(cfg = {}) {
  if (cfg.mode === 'live') {
    if (!cfg.token && !cfg.privateKey) {
      if (cfg.llToken) {
        throw new Error('仅 VA_LL_TOKEN 无法启动：refresh 续期需要一枚同会话的 vr-token。请同时提供 VARIATIONAL_TOKEN（可与 ll-token 一起从浏览器 Cookies 复制），或在面板粘贴两者。');
      }
      throw new Error('VA LIVE 模式需要 VARIATIONAL_TOKEN（贴 token）或 VA_WALLET_PRIVATE_KEY（自动登录）之一。');
    }
    return new VariationalExchange({
      underlyings: cfg.underlyings,
      precision: cfg.precision,
      instrument: cfg.instrument,
      slippageLimit: cfg.slippageLimit,
      leverage: cfg.leverage,
      feeRate: cfg.feeRate,
      pollMs: cfg.pollMs,
      baseUrl: cfg.baseUrl,
      address: cfg.address,
      token: cfg.token,
      llToken: cfg.llToken,
      privateKey: cfg.privateKey,
      tokenCachePath: cfg.tokenCachePath,
      transport: cfg.transport,
      pythonPath: cfg.pythonPath,
      maxOpenOrders: cfg.maxOpenOrders,
    });
  }
  return new PaperExchange({
    startBalance: cfg.startBalance,
    feeRate: cfg.feeRate,
    underlyings: cfg.underlyings,
    precision: cfg.precision,
    proxy: cfg.proxy,
    baseUrl: cfg.baseUrl,
    transport: cfg.transport,
    pythonPath: cfg.pythonPath,
  });
}
