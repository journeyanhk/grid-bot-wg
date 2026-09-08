import { VariationalExchange } from './variational.js';
import { PaperExchange } from './paper.js';

// Factory for the Variational Omni adapter. LIVE requires a vr-token cookie
// (paste-token-first: VARIATIONAL_TOKEN); paper mode only needs public
// endpoints, so it always works.
export function createExchange(cfg = {}) {
  if (cfg.mode === 'live') {
    if (!cfg.token) {
      throw new Error('VA LIVE 模式需要 VARIATIONAL_TOKEN（vr-token cookie）。');
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
