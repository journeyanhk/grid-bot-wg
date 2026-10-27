// Arcus adapter factory. Picks LIVE vs PAPER the same way the other adapters do.
import { ArcusExchange } from './arcus.js';
import { ArcusPaperExchange } from './paper.js';

export function createExchange(cfg = {}) {
  if (cfg.mode === 'live') {
    if (!cfg.address) throw new Error('LIVE 模式需要 AR_ACCOUNT_ADDRESS（主钱包地址）。');
    if (!cfg.signingKey && !cfg.signingKeyFile) throw new Error('LIVE 模式需要 AR_API_SIGNING_KEY（Ed25519 私钥种子，64 位 hex）或 AR_API_SIGNING_KEY_FILE。');
    return new ArcusExchange({
      address: cfg.address,
      accountIndex: cfg.accountIndex ?? 0,
      keyHex: cfg.signingKey,
      keyPath: cfg.signingKeyFile || '',
      apiUrl: cfg.apiUrl,
      wsUrl: cfg.wsUrl,
      network: cfg.network,
      proxy: cfg.proxy,
      feeRate: cfg.feeRate,
      deadmanMs: cfg.deadmanMs,
      pollMs: cfg.pollMs,
      maxMakerFeePpm: cfg.maxMakerFeePpm,
    });
  }
  const paper = new ArcusPaperExchange({
    apiUrl: cfg.paperApiUrl,
    paperNetwork: cfg.paperNetwork,
    network: cfg.network,
    startBalance: cfg.startBalance,
  });
  // 与 live 保持同一启动闸门语义，便于 paper 复现主网费率判断。
  paper.maxMakerFeePpm = Number.isFinite(Number(cfg.maxMakerFeePpm)) ? Number(cfg.maxMakerFeePpm) : 200;
  return paper;
}