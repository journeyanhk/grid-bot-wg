// 空快照抖动检测器（Review14）：守卫盲区补丁。
//
// 背景：EX 曾出现挂单快照接口在空/满之间高频抖动（约一半轮询返回空数组，下一轮正常），
// 连击计时（_emptyStreakStart）刚起步就被正常快照清零——"已持续 0s" × 1,306 次，
// 3 分钟升级门槛永远够不着：守卫防住了误杀，但系统在"半盲"状态下静默降级跑了一天。
//
// 原则：守卫要"数次数"，不只"数秒数"——任何低于警报阈值的持续异常，累积起来都该自己变成警报。
//
// 用法（每个适配器一个实例）：
//   this._snapWatch = createSnapshotJitterWatcher({
//     tag: 'ex', label: 'Extended', logger,
//     onIssue: (s) => { this.operationalIssue = { title: '...高频抖动', message: ... }; this.emit('error', ...); },
//     onRecover: (s) => { clear issue },
//   });
//   // 每轮有效快照（Array.isArray(rows) 且 tracked >= minTracked）：
//   this._snapWatch.record(rows, this._tracked.size);
//
// 判定：近 windowMs 内，空快照轮次/总轮次 > thresholdPct 且 总轮次 >= minRounds -> 抖动。
// 恢复：率回落到阈值内（含窗口自然过期）-> 清除。
export const JITTER_DEFAULTS = Object.freeze({
  windowMs: 10 * 60_000, // 滑动窗口
  thresholdPct: 30,      // 空快照率阈值（>30% 判定抖动）
  minRounds: 10,         // 最少轮次（防小样本误判）
  minTracked: 10,        // 仅统计本地跟踪 >= 10 单的轮次（小梯不参与）
});

/**
 * @param {Object} o
 * @param {string} [o.tag]       日志标签（ex/lr/hl）
 * @param {string} [o.label]     展示名（Extended/RHC/HL）
 * @param {Function} [o.logger]
 * @param {Function} [o.onIssue]  进入抖动：回调 ({emptyRatePct, rounds, empties})
 * @param {Function} [o.onRecover] 恢复：回调 (state)
 * @param {Function} [o.now]      时钟（测试注入）
 */
export function createSnapshotJitterWatcher(opts = {}) {
  const cfg = { ...JITTER_DEFAULTS, ...opts };
  const tag = opts.tag || 'jitter';
  const label = opts.label || tag;
  const logger = opts.logger || console;
  const now = opts.now || (() => Date.now());
  const events = []; // {t, empty}
  let issueActive = false;

  function prune(at) {
    while (events.length && at - events[0].t > cfg.windowMs) events.shift();
  }

  function state(at = now()) {
    prune(at);
    const rounds = events.length;
    const empties = events.filter((e) => e.empty).length;
    const emptyRatePct = rounds ? Number(((empties / rounds) * 100).toFixed(1)) : 0;
    return { rounds, empties, emptyRatePct, jittering: rounds >= cfg.minRounds && emptyRatePct > cfg.thresholdPct };
  }

  /** 记录一轮快照。rows 非数组（取数失败）或 tracked 不足 -> 不记录、返回 null。 */
  function record(rows, trackedCount) {
    if (!Array.isArray(rows) || Number(trackedCount) < cfg.minTracked) return null;
    const at = now();
    events.push({ t: at, empty: rows.length === 0 });
    prune(at);
    const s = state(at);
    if (s.jittering && !issueActive) {
      issueActive = true;
      logger.warn?.(tag, `${label}挂单快照高频抖动：近 ${Math.round(cfg.windowMs / 60_000)} 分钟空快照率 ${s.emptyRatePct}%（${s.empties}/${s.rounds} 轮，阈值 ${cfg.thresholdPct}%）——成交确认降级中。`);
      try { opts.onIssue?.(s); } catch { /* 回调失败不影响统计 */ }
    } else if (!s.jittering && issueActive) {
      issueActive = false;
      logger.info?.(tag, `${label}挂单快照抖动恢复：空快照率 ${s.emptyRatePct}%（${s.empties}/${s.rounds} 轮）。`);
      try { opts.onRecover?.(s); } catch { /* 回调失败不影响统计 */ }
    }
    return s;
  }

  function reset() { events.length = 0; issueActive = false; }

  return {
    record,
    state,
    reset,
    get issueActive() { return issueActive; },
    emptyRatePct() { return state().emptyRatePct; },
  };
}
