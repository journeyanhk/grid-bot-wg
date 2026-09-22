// Propr 交易所工厂：四模式分流 + 启动护栏。
// 护栏必须在此真实创建入口执行（而不是只在测试或某个启动分支里），否则脚本/测试/
// 其他入口创建 Propr 时可能绕过（Review1 P0）。校验顺序：先护栏，后分流。
import { validateProprConfig } from '../../config.js';
import { PaperExchange } from './paper.js';

export function createExchange(cfg = {}) {
  validateProprConfig(cfg);

  if (cfg.mode === 'paper') {
    return new PaperExchange({ startBalance: cfg.startBalance, feeRate: cfg.feeRate });
  }
  if (cfg.mode === 'shadow') {
    throw new Error('Propr shadow 适配器将在 Review 2 提供（只读 Propr + 本地模拟，硬禁止写）。');
  }
  throw new Error(`Propr ${cfg.mode} 适配器将在 Review 3 提供（写路径 + intentId 幂等）。`);
}
