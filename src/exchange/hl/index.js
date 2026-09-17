import { HyperliquidExchange } from './hyperliquid.js';
import { PaperExchange } from './paper.js';

export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.accountAddress || (!cfg.agentPrivateKey && !cfg.agentPrivateKeyFile)) {
      throw new Error('HL LIVE 模式需要 HL_ACCOUNT_ADDRESS（agent 钱包地址），以及 HL_AGENT_PRIVATE_KEY 或 HL_AGENT_PRIVATE_KEY_FILE。');
    }
    return new HyperliquidExchange(cfg);
  }
  return new PaperExchange({ startBalance: cfg.startBalance, feeRate: cfg.feeRate });
}