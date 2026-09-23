// Propr 交易所工厂：四模式分流 + 启动护栏。
// 护栏必须在此真实创建入口执行（而不是只在测试或某个启动分支里），否则脚本/测试/
// 其他入口创建 Propr 时可能绕过（Review1 P0）。校验顺序：先护栏，后分流。
import { validateProprConfig } from '../../config.js';
import { PaperExchange } from './paper.js';
import { ShadowExchange } from './shadow.js';
import { ProprExchange } from './propr.js';

export function createExchange(cfg = {}) {
  validateProprConfig(cfg);

  if (cfg.mode === 'paper') {
    return new PaperExchange({ startBalance: cfg.startBalance, feeRate: cfg.feeRate });
  }
  if (cfg.mode === 'shadow') {
    return new ShadowExchange(cfg);
  }
  // sim-write / challenge：真实 API 读写（写路径在 Review 3 完成）
  return new ProprExchange(cfg);
}
