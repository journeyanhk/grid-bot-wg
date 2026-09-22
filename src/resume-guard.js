// 续跑看门狗（Review22 / 9·21 事故）：接管缺失态（快照 running=true 但 bot 未运行）防护。
//
// 背景：服务重启时交易所未连上 -> resumeIfWasRunning 跳过续跑并静默留单；适配器
// dataSource 无自愈（只在 init/reconnect 成功时置位）——“待下次连接”永远等不来，
// 挂单留在交易所无人管理（裸梯风险）。
//
// 三件套（决策：①A 自动退避重连 + ③A 10 分钟自动撤单，含三护栏）：
//   ① 自动退避重连：1/2/5/15 分梯度，封顶后每 15 分钟永续重试；连上后自动补续跑。
//   ② 响亮化：进入接管缺失态即 bot 级 operationalIssue（卡片红）+ notify（每 30
//      分钟重复推送，直至解除）；重连/续跑计数进日志与健康详情（“重连中（第 N 次）”）。
//   ③ 兜底撤单（护栏）：
//      - 撤单前先尽力接管：窗口内 ≥minResumeAttempts 次 resume 尝试，接管严格优先；
//      - 计时起点 = 交易所已连接且接管失败（firstResumeFailAt），不是进程启动；
//      - 只撤单、永不动仓位：调 bot.recoverStrayOrders()（内部走撤单确认链路），
//        孤儿仓位由既有“遗留持仓提示”人工接手；
//      - 撤单仅限“交易所已连上、resume 反复抛错”；撤单失败每 5 分钟重试。
import { logger as defaultLogger } from './log.js';

export const RESUME_GUARD_DEFAULTS = {
  tickMs: 60_000,
  reconnectBackoffMs: [60_000, 120_000, 300_000, 900_000], // 1/2/5/15 分；封顶后永续（每 15 分）
  fallbackMs: 10 * 60_000,      // 已连接且接管失败起算的兜底窗口
  minResumeAttempts: 3,         // 兜底前最少接管尝试次数
  cleanupRetryMs: 5 * 60_000,   // 兜底撤单失败后的重试间隔
  notifyRepeatMs: 30 * 60_000,  // 未解除期间重复推送节奏
};

/** 市场名归一化：marketId 会随连接会话漂移，续跑前按名称重解析（与手动重连路由同源）。 */
const normName = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** 共享续跑助手：按市场名修正 marketId 后接管续跑。手动“重连交易所”路由与看门狗共用。 */
export async function tryResumeBot(bot, exchange, snap, key, logger = defaultLogger) {
  const markets = await exchange.getMarkets();
  const want = normName(snap?.config?.displayName);
  const m = markets.find((x) => normName(x.displayName) === want || normName(x.name) === want);
  if (m) snap.config.marketId = m.marketId;
  await bot.resume(snap);
  logger.info('server', `${String(key).toUpperCase()} 续跑成功，接管挂单并完成对账。`);
  return true;
}

export function createResumeGuard(opts = {}) {
  const {
    bots = {}, exchanges = {}, loadSnapshot,
    notifier, logger = defaultLogger, now = () => Date.now(),
  } = opts;
  const tickMs = opts.tickMs ?? RESUME_GUARD_DEFAULTS.tickMs;
  const reconnectBackoffMs = opts.reconnectBackoffMs ?? RESUME_GUARD_DEFAULTS.reconnectBackoffMs;
  const fallbackMs = opts.fallbackMs ?? RESUME_GUARD_DEFAULTS.fallbackMs;
  const minResumeAttempts = opts.minResumeAttempts ?? RESUME_GUARD_DEFAULTS.minResumeAttempts;
  const cleanupRetryMs = opts.cleanupRetryMs ?? RESUME_GUARD_DEFAULTS.cleanupRetryMs;
  const notifyRepeatMs = opts.notifyRepeatMs ?? RESUME_GUARD_DEFAULTS.notifyRepeatMs;

  const pending = new Map(); // key -> 状态机记录
  let timer = null;

  /** 重连退避：已尝试 N 次后下一次的最小间隔（0 次=首轮立即；之后 1/2/5/15 分，封顶永续每 15 分）。 */
  function backoffFor(attemptsDone) {
    return reconnectBackoffMs[Math.min(Math.max(0, attemptsDone - 1), reconnectBackoffMs.length - 1)];
  }

  function statusText(st) {
    if (st.phase === 'connecting') {
      return `快照显示运行中但机器人未接管；交易所未连接，重连中（第 ${st.connectAttempts} 次${st.lastConnectError ? `，上次失败：${st.lastConnectError}` : ''}）`;
    }
    return `交易所已连接但接管续跑失败（第 ${st.resumeAttempts} 次：${st.lastResumeError || '未知错误'}）；持续失败将于 ${Math.round(fallbackMs / 60_000)} 分钟 / ${minResumeAttempts} 次尝试后自动撤单兜底（仅撤单、不动仓位）`;
  }

  function setIssue(bot, st) {
    const text = statusText(st);
    if (st.lastIssueText === text) return;
    st.lastIssueText = text;
    try { bot.setOperationalIssue?.({ title: '接管缺失（挂单无人管理）', message: text }); } catch { /* 展示失败不影响防护 */ }
  }

  function notify(st) {
    try {
      notifier?.send?.({
        source: st.key,
        level: 'critical',
        key: `resume-guard:${st.key}`,
        cooldownMs: notifyRepeatMs,
        message: `⚠️ [接管缺失] ${st.key.toUpperCase()} ${statusText(st)}`,
      });
    } catch { /* 通知失败不影响防护 */ }
  }

  function clearKey(key, bot, message) {
    pending.delete(key);
    try { bot.setOperationalIssue?.(null); } catch { /* ignore */ }
    if (message) { try { bot._alert?.(message); } catch { /* ignore */ } }
  }

  async function checkOne(key) {
    const bot = bots[key], exchange = exchanges[key];
    if (!bot || !exchange) return;
    let snap = null;
    try { snap = loadSnapshot?.(key); } catch { /* 读快照失败视为无运行态 */ }

    // 非“待接管”态：快照未运行、无配置、或 bot 已运行 -> 清状态解警（外部原因解除不冒功）
    if (!(snap?.running && snap?.config) || bot.running) {
      if (pending.has(key)) clearKey(key, bot, null);
      return;
    }

    let st = pending.get(key);
    if (!st) {
      st = {
        key, since: now(), phase: 'connecting',
        connectAttempts: 0, lastConnectAt: 0, lastConnectError: null,
        connectedAt: null, resumeAttempts: 0, firstResumeFailAt: null,
        lastResumeError: null, lastIssueText: null,
        lastCleanupAt: 0,
      };
      pending.set(key, st);
      logger.warn('server', `[接管缺失] ${key.toUpperCase()} 快照显示运行中但机器人未接管，看门狗开始介入（重连/接管/兜底）。`);
    }

    // ── 相位 A：交易所未连接 -> 自动退避重连（①，封顶后永续） ──
    if (exchange.dataSource == null) {
      st.phase = 'connecting';
      if (now() - st.lastConnectAt >= backoffFor(st.connectAttempts)) {
        st.lastConnectAt = now();
        st.connectAttempts++;
        try {
          if (typeof exchange.reconnect === 'function') await exchange.reconnect();
          else if (typeof exchange.init === 'function') await exchange.init();
          st.lastConnectError = null;
          logger.info('server', `[接管缺失] ${key.toUpperCase()} 第 ${st.connectAttempts} 次重连成功。`);
        } catch (e) {
          st.lastConnectError = String(e?.message || e);
          logger.warn('server', `[接管缺失] ${key.toUpperCase()} 第 ${st.connectAttempts} 次重连失败：${st.lastConnectError}`);
        }
      }
      setIssue(bot, st);
      notify(st);
      // 本轮刚重连成功则继续走续跑相位；仍离线则结束
      if (exchange.dataSource == null) return;
    }

    // ── 相位 B：已连接 -> 优先补续跑（严格优于撤单） ──
    st.phase = 'resuming';
    if (!st.connectedAt) st.connectedAt = now();
    try {
      await tryResumeBot(bot, exchange, snap, key, logger);
      clearKey(key, bot, `✅ [接管缺失] ${key.toUpperCase()} 已自动补续跑（第 ${st.resumeAttempts + 1} 次尝试），挂单已接管。`);
      return;
    } catch (e) {
      st.resumeAttempts++;
      st.lastResumeError = String(e?.message || e);
      if (!st.firstResumeFailAt) st.firstResumeFailAt = now();
    }

    // ── 兜底 ③：已连接 + 尝试≥minResumeAttempts + 距首次接管失败≥fallbackMs -> 撤单 ──
    const windowElapsed = now() - st.firstResumeFailAt >= fallbackMs;
    if (st.resumeAttempts >= minResumeAttempts && windowElapsed && now() - st.lastCleanupAt >= cleanupRetryMs) {
      st.lastCleanupAt = now();
      logger.error('server', `[接管缺失] ${key.toUpperCase()} 接管持续失败（${st.resumeAttempts} 次，${Math.round((now() - st.firstResumeFailAt) / 60_000)} 分钟），执行兜底撤单（仅撤单、不动仓位）。`);
      try {
        await bot.recoverStrayOrders?.();
        clearKey(key, bot, `⚠️ [接管缺失] ${key.toUpperCase()} 接管持续失败，已自动撤掉遗留挂单（仅撤单、仓位未动）。请确认持仓后手动重启网格。`);
        return;
      } catch (e) {
        st.lastCleanupError = String(e?.message || e);
        logger.error('server', `[接管缺失] ${key.toUpperCase()} 兜底撤单失败：${st.lastCleanupError}（${Math.round(cleanupRetryMs / 60_000)} 分钟后重试）`);
      }
    }

    setIssue(bot, st);
    notify(st);
  }

  async function tick() {
    for (const key of Object.keys(bots)) {
      try { await checkOne(key); } catch (e) { logger.warn('server', `[接管缺失] 看门狗巡检 ${key} 异常：${e?.message || e}`); }
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
    timer.unref?.();
    tick().catch(() => {}); // 启动即巡检一次（不等首个 tick）
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, tick, pending };
}
