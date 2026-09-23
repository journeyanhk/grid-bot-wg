// Propr Challenge 风控层：独立于 GridBot 的交易所级风控。
//
// 职责：
//  - UTC 日切（每日 00:00 UTC 重置日初权益；不用本地时区/进程启动时间）；
//  - 内部日损 / 总回撤分级（严于平台 3% / 6%，留足安全边际）；
//  - **权益口径统一为 equity（account.marginBalance，含未实现盈亏）**，不可用则 LOCKED；
//  - 平台状态 breach（挑战 failed/passed → 停机）；
//  - 按级别向 bot 下发指令（预警 / 暂停开仓 / 撤单平仓停机），并把状态写入
//    `exchange.riskState`（适配器据此**硬拦截开仓**，手动 /start 也无法绕过）；
//  - 动作失败不静默：记录 `actionError` + critical 通知，并在后续 tick 重试降风险动作。
//
// 设计要点：分级计算是纯函数 `evaluateRisk()`（可单测、无副作用）；本类只做 I/O 与动作编排。
import { logger } from '../log.js';
import { redactSecrets } from '../redact.js';

export const STATUS = Object.freeze({
  OK: 'OK',
  WARNING: 'WARNING',
  REDUCE_ONLY: 'REDUCE_ONLY',
  HALT: 'HALT',
  LOCKED: 'LOCKED',
  BREACHED: 'BREACHED',
});

export const STATUS_LABEL = Object.freeze({
  OK: '正常',
  WARNING: '预警',
  REDUCE_ONLY: '仅减仓',
  HALT: '已停机',
  LOCKED: '交易锁定',
  BREACHED: '挑战失效',
});

/** UTC 当日 00:00 的 epoch ms。 */
export function utcDayStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** 下一个 UTC 日切时刻（用于「暂停开仓至日切」）。 */
export function nextUtcDayStart(now = Date.now()) {
  return utcDayStart(now) + 24 * 3600_000;
}

/**
 * 纯计算：给定**权益**与阈值返回风险评级（无 I/O）。
 * 口径：equity = account.marginBalance（含未实现盈亏），与 highWaterMark 同口径。
 * `dailyLossPct` / `drawdownPct` 均为「负数表示亏损/回撤」。
 * 优先级：BREACHED > LOCKED > HALT > REDUCE_ONLY > WARNING > OK。
 */
export function evaluateRisk({
  equity,
  startOfDayEquity,
  highWaterMark,
  internalDailyStopPct = 0.01,
  internalMaxDrawdownPct = 0.03,
  equityUsable = true,
  attemptStatus = 'active',
} = {}) {
  if (attemptStatus && attemptStatus !== 'active') {
    return { status: STATUS.BREACHED, reason: `挑战状态非 active（${attemptStatus}）`, dailyLossPct: null, drawdownPct: null };
  }
  if (!equityUsable) {
    return { status: STATUS.LOCKED, reason: '权益不可用或已过期（禁止开仓）', dailyLossPct: null, drawdownPct: null };
  }
  const eq = Number(equity);
  const sod = Number(startOfDayEquity);
  const hwm = Number(highWaterMark);
  if (![eq, sod, hwm].every(Number.isFinite) || sod <= 0 || hwm <= 0) {
    return { status: STATUS.LOCKED, reason: '权益/日初权益/高水位数值不可用', dailyLossPct: null, drawdownPct: null };
  }
  const dailyLossPct = (eq - sod) / sod;
  const drawdownPct = (eq - hwm) / hwm;
  const dStop = Math.abs(Number(internalDailyStopPct));
  const dHalt = Math.abs(Number(internalMaxDrawdownPct));

  if (drawdownPct <= -dHalt) {
    return { status: STATUS.HALT, reason: `总回撤 ${(drawdownPct * 100).toFixed(2)}% 触及内部停机线 -${(dHalt * 100).toFixed(2)}%`, dailyLossPct, drawdownPct };
  }
  if (dailyLossPct <= -dStop) {
    return { status: STATUS.REDUCE_ONLY, reason: `日损 ${(dailyLossPct * 100).toFixed(2)}% 触及内部减仓线 -${(dStop * 100).toFixed(2)}%`, dailyLossPct, drawdownPct };
  }
  if (dailyLossPct <= -dStop * 0.5 || drawdownPct <= -dHalt * 0.5) {
    return { status: STATUS.WARNING, reason: `已达内部阈值一半（日损 ${(dailyLossPct * 100).toFixed(2)}% / 回撤 ${(drawdownPct * 100).toFixed(2)}%）`, dailyLossPct, drawdownPct };
  }
  return { status: STATUS.OK, reason: '正常', dailyLossPct, drawdownPct };
}

export class ProprChallengeRisk {
  constructor({ exchange, bot, notifier, logger: log = logger, cfg = {}, loadSnapshot, saveSnapshot } = {}) {
    this.exchange = exchange;
    this.bot = bot;
    this.notifier = notifier;
    this.log = log;
    this.internalDailyStopPct = Number(cfg.internalDailyStopPct ?? 0.01);
    this.internalMaxDrawdownPct = Number(cfg.internalMaxDrawdownPct ?? 0.03);
    // 平台限制仅用于展示对照（Free Trial 无风控约束，付费 Challenge 以实际规则为准）
    this.platformDailyLimitPct = Number(cfg.platformDailyLimitPct ?? 0.03);
    this.platformMaxDrawdownPct = Number(cfg.platformMaxDrawdownPct ?? 0.06);
    this.pollMs = Number(cfg.riskPollMs ?? 30_000);

    this.initialEquity = null;
    this.startOfDayEquity = null;
    this._dayKey = null;
    // fail closed（Review6-1 P0）：首次权益评估完成前一律 LOCKED，绝不因"还没评估"而放行开仓
    this.status = STATUS.LOCKED;
    this.reason = '等待首次权益风控评估';
    this.actionError = null;
    this._actionFailureStatus = null;  // HALT/BREACHED 动作失败锁：完成前不因权益恢复而回到 OK
    this._pausedByRisk = false;        // 是否由本层暂停过开仓（恢复时据此解除）
    this._timer = null;
    this._persist = { load: loadSnapshot, save: saveSnapshot };

    // 构造即接管适配器的风控门（适配器 fail-closed 依赖 riskGateEnabled）
    if (this.exchange) {
      this.exchange.riskGateEnabled = true;
      this.exchange.riskState = this.getState();
    }
  }

  start() {
    this._restore();
    if (!this._timer) {
      this._timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollMs);
      this._timer.unref?.();
    }
  }

  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  /** 从快照恢复当日基准：同一 UTC 日沿用原日初权益，跨日则重新建立（Review6-1 P1）。 */
  _restore() {
    try {
      const snap = this._persist.load?.('proprRisk');
      if (!snap) return;
      if (String(snap.riskDayKey) === String(utcDayStart())) {
        this._dayKey = String(snap.riskDayKey);
        this.startOfDayEquity = Number(snap.startOfDayEquity) || null;
        this.initialEquity = Number(snap.initialEquity) || null;
        this.log.info('propr-risk', `已恢复当日风控基准：日初权益 ${this.startOfDayEquity}`);
      }
    } catch { /* 持久化失败不影响风控 */ }
  }

  _save() {
    try {
      this._persist.save?.('proprRisk', {
        riskDayKey: this._dayKey,
        startOfDayEquity: this.startOfDayEquity,
        initialEquity: this.initialEquity,
        updatedAt: Date.now(),
      });
    } catch { /* 持久化失败不影响风控 */ }
  }

  getState() {
    const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number((Number(v) * 100).toFixed(4)));
    const dailyUsage = this.dailyLossPct != null && this.internalDailyStopPct > 0
      ? Number((Math.min(1, Math.abs(this.dailyLossPct) / this.internalDailyStopPct)).toFixed(4)) : null;
    const ddUsage = this.drawdownPct != null && this.internalMaxDrawdownPct > 0
      ? Number((Math.min(1, Math.abs(this.drawdownPct) / this.internalMaxDrawdownPct)).toFixed(4)) : null;
    return {
      status: this.status,
      statusLabel: STATUS_LABEL[this.status] || null,
      reason: this.reason,
      actionError: this.actionError,
      actionFailureStatus: this._actionFailureStatus,
      initialEquity: this.initialEquity,
      startOfDayEquity: this.startOfDayEquity,
      currentEquity: this.currentEquity ?? null,
      balance: this.balance ?? null,
      highWaterMark: this.highWaterMark ?? null,
      dailyLossPct: pct(this.dailyLossPct),
      drawdownPct: pct(this.drawdownPct),
      dailyUsage,
      drawdownUsage: ddUsage,
      internalDailyStopPct: this.internalDailyStopPct,
      internalMaxDrawdownPct: this.internalMaxDrawdownPct,
      platformDailyLimitPct: this.platformDailyLimitPct,
      platformMaxDrawdownPct: this.platformMaxDrawdownPct,
      equitySource: this.equitySource ?? null,
      equityFreshAt: this.equityFreshAt ?? null,
      utcDayStart: this._dayKey ? Number(this._dayKey) : null,
      updatedAt: this.updatedAt ?? null,
    };
  }

  /** 单次评估：读权益 → UTC 日切 → 分级 → 动作 → 状态写入 exchange.riskState。 */
  async tick() {
    const ex = this.exchange;
    if (!ex || ex.dataSource == null) return null;

    // 权益口径：marginBalance（含未实现盈亏），缺失才回退 balance（Review6 P1）
    const currentEquity = Number.isFinite(Number(ex.equity)) ? Number(ex.equity) : Number(ex.balance);

    const dayStart = utcDayStart();
    if (this._dayKey !== String(dayStart)) {
      this._dayKey = String(dayStart);
      if (Number.isFinite(currentEquity)) this.startOfDayEquity = currentEquity;
      this.log.info('propr-risk', `UTC 日切：日初权益重置为 ${this.startOfDayEquity}`);
      this._save();
    }
    if (this.initialEquity == null) {
      this.initialEquity = Number(ex.startingBalance) || (Number.isFinite(currentEquity) ? currentEquity : null);
      this._save();
    }
    if (this.startOfDayEquity == null && Number.isFinite(currentEquity)) {
      this.startOfDayEquity = currentEquity;
      this._save();
    }

    const equityUsable = typeof ex.isEquityStale === 'function' ? !ex.isEquityStale() : false;
    const r = evaluateRisk({
      equity: currentEquity,
      startOfDayEquity: this.startOfDayEquity,
      highWaterMark: ex.highWaterMark,
      internalDailyStopPct: this.internalDailyStopPct,
      internalMaxDrawdownPct: this.internalMaxDrawdownPct,
      equityUsable,
      attemptStatus: ex.attemptStatus ?? 'active',
    });

    this.currentEquity = Number.isFinite(currentEquity) ? currentEquity : null;
    this.balance = Number(ex.balance);
    this.highWaterMark = Number(ex.highWaterMark);
    this.dailyLossPct = r.dailyLossPct;
    this.drawdownPct = r.drawdownPct;
    this.reason = r.reason;
    this.equitySource = ex.equitySource ?? null;
    this.equityFreshAt = ex.equityFreshAt ?? null;
    this.updatedAt = Date.now();

    // HALT/BREACHED 动作未完成前不得因短暂权益恢复而回到 OK（Review6-1 P1：失败锁）
    let effective = r.status;
    if (this.actionError && (this._actionFailureStatus === STATUS.HALT || this._actionFailureStatus === STATUS.BREACHED)) {
      effective = this._actionFailureStatus;
    }
    const changed = this.status !== effective;
    this.status = effective;
    this.exchange.riskState = this.getState();

    // 状态变化或上次动作失败 → 执行/重试动作（失败不静默）
    if (changed || this.actionError) {
      const reason = effective === r.status
        ? r.reason
        : `上次 ${this._actionFailureStatus} 动作未完成，继续重试（当前评估 ${r.status}）`;
      this.log.warn('propr-risk', `风控状态 ${effective}：${reason}`);
      try {
        await this._apply(effective, reason);
        this.actionError = null;
        this._actionFailureStatus = null;
        this.exchange.riskState = this.getState();
      } catch (err) {
        this.actionError = redactSecrets(err?.message || String(err));
        this._actionFailureStatus = effective;
        this.exchange.riskState = this.getState();
        this.log.error('propr-risk', `风控动作执行失败（将在下一轮重试）：${this.actionError}`);
        this._send('critical', `🔴 Propr 风控动作执行失败，请立即人工确认挂单与持仓：${this.actionError}`, 'propr:risk:action-failed');
      }
    }
    return this.getState();
  }

  _send(level, message, key) {
    try { this.notifier?.send({ source: 'propr', level, message, title: 'Propr 风控', key }); } catch { /* 通知失败不影响 */ }
  }

  async _apply(status, reason) {
    const bot = this.bot;
    switch (status) {
      case STATUS.OK:
        // LOCKED/REDUCE_ONLY 期间可能设置过入场暂停：恢复时必须显式解除，避免残留到 24h/日切
        if (this._pausedByRisk) {
          try { bot?.resumeOpening?.('Propr 风控恢复正常'); } catch { /* ignore */ }
          this._pausedByRisk = false;
        }
        this._send('info', '✅ Propr 挑战风控恢复正常。', 'propr:risk:ok:recover');
        break;
      case STATUS.WARNING:
        this._send('warn', `⚠️ Propr 风控预警：${reason}`, 'propr:risk:warn');
        break;
      case STATUS.REDUCE_ONLY:
        try { bot?.pauseOpening(nextUtcDayStart(), 'Propr 内部日损线：仅减仓至 UTC 日切'); } catch { /* ignore */ }
        this._pausedByRisk = true;
        this._send('critical', `🔴 Propr 日损触及内部线，已暂停开仓（仅减仓，UTC 日切自动恢复）：${reason}`, 'propr:risk:reduce');
        break;
      case STATUS.HALT:
        await bot?.stop({ closePosition: true });
        this._pausedByRisk = false;
        this._send('critical', `🔴 Propr 总回撤触及内部线，已撤单 + 平仓 + 停机：${reason}`, 'propr:risk:halt');
        break;
      case STATUS.LOCKED:
        try { bot?.pauseOpening(Date.now() + 24 * 3600_000, 'Propr 权益不可用/过期：仅减仓'); } catch { /* ignore */ }
        this._pausedByRisk = true;
        this._send('critical', `🔴 Propr 权益不可用/过期，已暂停开仓（恢复后自动解除）：${reason}`, 'propr:risk:locked');
        break;
      case STATUS.BREACHED:
        await bot?.stop({ closePosition: false });
        this._pausedByRisk = false;
        this._send('critical', `🔴 Propr 挑战已失效（${reason}），策略已停止，请检查账户。`, 'propr:risk:breached');
        break;
    }
  }
}
