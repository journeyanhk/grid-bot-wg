// Arcus adapter factory. Picks LIVE vs PAPER the same way the other adapters do.
import { ArcusExchange } from './arcus.js';
import { ArcusPaperExchange } from './paper.js';

export function createExchange(cfg = {}) {
  if (cfg.mode === 'live') {
    if (!cfg.address) throw new Error('LIVE 模式需要 AR_ACCOUNT_ADDRESS（主钱包地址）。');
    if (!cfg.signingKey) throw new Error('LIVE 模式需要 AR_API_SIGNING_KEY（Ed25519 私钥）。');
    return new ArcusExchange({
      address: cfg.address,
      accountIndex: cfg.accountIndex ?? 0,
      signingKey: cfg.signingKey,
      apiUrl: cfg.apiUrl,
      wsUrl: cfg.wsUrl,
      network: cfg.network,
      proxy: cfg.proxy,
      feeRate: cfg.feeRate,
      deadmanMs: cfg.deadmanMs,
      pollMs: cfg.pollMs,
    });
  }
  return new ArcusPaperExchange({
    apiUrl: cfg.apiUrl,
    network: cfg.network,
    startBalance: cfg.startBalance,
  });
}