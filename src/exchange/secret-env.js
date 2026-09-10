// 凭证隔离：每个私钥只能进它自己的 worker。
//
// 背景：config.js 的 loadEnv() 会把整个 .env 灌进 process.env，而 hl/lr/va 三个
// 子进程若用 `{...process.env}` spawn，就会让每个 Python worker 都看到全部私钥
// （Lighter 的进程拿到 VA 的私钥，VA 的进程拿到 HL 的私钥……）。改法：worker 以
// sanitizedEnv()（剔除所有凭证）为基础环境，再各自显式注入自己需要的那一枚。
//
// 注意：这里【不】改动 process.env 本身——Node 主进程的适配器（de/ex/rs）仍从
// config 读凭证；只是给子进程一份洁净副本，避免全局副作用与重复 getConfig 的坑。

/** 绝不应泄漏到兄弟 worker 的凭证类环境变量名。 */
export const SECRET_ENV_KEYS = [
  'VA_WALLET_PRIVATE_KEY',
  'LIGHTER_API_PRIVATE_KEY',
  'LIGHTER_API_PRIVATE_KEY_FILE',
  'HL_AGENT_PRIVATE_KEY',
  'HL_AGENT_PRIVATE_KEY_FILE',
  'DECIBEL_PRIVATE_KEY',
  'EXTENDED_STARK_PRIVATE_KEY',
  'SIGNER_PRIVATE_KEY',
  'DASHBOARD_PASS',
  'DASHBOARD_TOKEN',
];

/** 返回 process.env 的副本，剔除所有凭证项（供子进程 spawn 的基础环境）。 */
export function sanitizedEnv(base = process.env) {
  const drop = new Set(SECRET_ENV_KEYS);
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (!drop.has(k)) out[k] = v;
  }
  return out;
}
