import { LighterExchange } from './lighter.js';
import { PaperExchange } from './paper.js';

export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!Number.isInteger(cfg.accountIndex) || !Number.isInteger(cfg.apiKeyIndex) || (!cfg.apiPrivateKey && !cfg.apiPrivateKeyFile)) {
      throw new Error('RHC LIVE 模式需要 LIGHTER_ACCOUNT_INDEX、LIGHTER_API_KEY_INDEX，以及 LIGHTER_API_PRIVATE_KEY 或 LIGHTER_API_PRIVATE_KEY_FILE。');
    }
    return new LighterExchange(cfg);
  }
  return new PaperExchange({ startBalance: cfg.startBalance, feeRate: cfg.feeRate });
}
