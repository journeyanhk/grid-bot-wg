// Propr 适配器工厂。M1 只支持 paper 与 shadow；live 明确抛错（写路径在 M2）。
import fs from 'node:fs';
import path from 'node:path';
import { ProprClient } from './client.js';
import { ProprShadow, computeCapacity } from './shadow.js';
import { ProprExchange } from './propr.js';
import { ProprPaper } from './paper.js';
import { HlMarketData, BTC_MARKET } from './market.js';

export { ProprClient, ProprShadow, ProprPaper, ProprExchange, HlMarketData, BTC_MARKET, computeCapacity };

export function readKeyFile(file, root = process.cwd()) {
  if (!file) return '';
  const p = path.isAbsolute(file) ? file : path.resolve(root, file);
  const st = fs.statSync(p);
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} 权限过宽（应 600）`);
  return fs.readFileSync(p, 'utf8').trim();
}

/**
 * @param {object} cfg 至少含 mode / accountId / apiKey|apiKeyFile
 * @returns {{mode:string, market:object, client?:ProprClient, shadow?:ProprShadow, paper?:ProprPaper}}
 */
/** GridBot / server 用的适配器工厂。challenge / live 已在 ProprExchange 构造函数里硬拒绝。 */
export function createExchange(cfg = {}) {
  return new ProprExchange(cfg);
}

export function createPropr(cfg = {}) {
  const mode = String(cfg.mode || 'paper').toLowerCase();
  const market = cfg.market || BTC_MARKET;
  if (mode === 'paper') {
    return { mode, market, paper: new ProprPaper({ startBalance: cfg.startBalance ?? 5000, makerFee: cfg.makerFee ?? 0.00015, takerFee: cfg.takerFee ?? 0.00045 }) };
  }
  if (mode === 'shadow' || mode === 'live') {
    if (mode === 'live') throw new Error('M1 未实现写路径：live 模式请等 M2');
    const apiKey = cfg.apiKey || readKeyFile(cfg.apiKeyFile, cfg.root);
    if (!apiKey) throw new Error('shadow 需要 PR_API_KEY 或 PR_API_KEY_FILE');
    if (!cfg.accountId) throw new Error('shadow 需要 PR_ACCOUNT_ID');
    const client = new ProprClient({ apiKey, baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs });
    const marketData = new HlMarketData({});
    return {
      mode, market, client, marketData,
      shadow: new ProprShadow({
        client, accountId: cfg.accountId, marketData, symbol: market.symbol,
        maxInvUsd: cfg.maxInvUsd ?? 1500, capacityLeverage: cfg.capacityLeverage ?? 1, staleMs: cfg.staleMs ?? 45_000,
      }),
    };
  }
  throw new Error(`未知 PR_MODE: ${mode}`);
}

/**
 * 校验目标账户：PR_ACCOUNT_ID 必须精确命中一个 attempt，且该 attempt 为 active。
 * 刻意**不要求**全局只有一个 active attempt —— 该用户同时有 Free Trial 与 Starter。
 */
export async function resolveTargetAttempt({ client, accountId }) {
  const body = await client.getAttempts({ limit: 50 });
  const rows = body?.data ?? [];
  const norm = (x) => String(x).replace(/^urn:prp-account:/, '');
  const hits = rows.filter((a) => norm(a.accountId) === norm(accountId));
  if (hits.length === 0) throw new Error(`PR_ACCOUNT_ID=${accountId} 未命中任何 attempt`);
  if (hits.length > 1) throw new Error(`PR_ACCOUNT_ID=${accountId} 命中 ${hits.length} 个 attempt（异常状态）`);
  const a = hits[0];
  if (String(a.status).toLowerCase() !== 'active') throw new Error(`attempt ${a.attemptId} 状态为 ${a.status}，不是 active`);
  return a;
}