// Propr Challenge 风控层：独立于 GridBot 的交易所级风控。
//
// 职责：
//  - UTC 日切（每日 00:00 UTC 重置日初权益；不用本地时区/进程启动时间）；
//  - 内部日损 / 总回撤分级（严于平台 3% / 6%，留足安全边际）；
//  - 权益新鲜度（权威字段 + 本地拉取时刻，过期即锁定开仓）；
//  - 平台状态 breach（挑战 failed/passed → 停机）；
//  - 按级别向 bot 下发指令（预警 / 暂停开仓 / 撤单平仓停机），并把状态写入
//    `exchange.riskState` 供仪表盘展示。
//
// 设计要点：分级计算是纯函数 `evaluateRisk()`（可单测、无副作用）；本类只做 I/O 与动作编排。
import { logger } from '../log.js';

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
 * 纯计算：给定权益与阈值返回风险评级（无 I/O）。
 * `dailyLossPct` / `drawdownPct` 均为「负数表示亏损/回撤」。
 * 优先级：BREACHED > LOCKED > HALT > REDUCE_ONLY > WARNING > OK。
 */
export function evaluateRisk({
  balance,
  startOfDayBalance,
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
  const bal = Number(balance);
  const sod = Number(startOfDayBalance);
  const hwm = Number(highWaterMark);
  if (![bal, sod, hwm].every(Number.isFinite) || sod <= 0 || hwm <= 0) {
    return { status: STATUS.LOCKED, reason: '权益/日初/高水位数值不可用', dailyLossPct: null, drawdownPct: null };
  }
  const dailyLossPct = (bal - sod) / sod;
  const drawdownPct = (bal - hwm) / hwm;
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
  constructor({ exchange, bot, notifier, logger: log = logger, cfg = {} } = {}) {
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

    this.initialBalance = null;
    this.startOfDayBalance = null;
    this._dayKey = null;
    this.status = null;
    this.reason = null;
    this._timer = null;
  }

  start() {
    if (!this._timer) {
      this._timer = setInterval(() => { this.tick().catch(() => {}); }, this.pollMs);
      this._timer.unref?.();
    }
  }

  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

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
      initialBalance: this.initialBalance,
      startOfDayBalance: this.startOfDayBalance,
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

    const dayStart = utcDayStart();
    if (this._dayKey !== String(dayStart)) {
      this._dayKey = String(dayStart);
      const bal = Number(ex.balance);
      if (Number.isFinite(bal)) this.startOfDayBalance = bal;
      this.log.info('propr-risk', `UTC 日切：日初权益重置为 ${this.startOfDayBalance}`);
    }
    if (this.initialBalance == null) this.initialBalance = Number(ex.startingBalance) || Number(ex.balance) || null;
    if (this.startOfDayBalance == null) this.startOfDayBalance = Number(ex.balance) || null;

    const equityUsable = typeof ex.isEquityStale === 'function' ? !ex.isEquityStale() : false;
    const r = evaluateRisk({
      balance: ex.balance,
      startOfDayBalance: this.startOfDayBalance,
      highWaterMark: ex.highWaterMark,
      internalDailyStopPct: this.internalDailyStopPct,
      internalMaxDrawdownPct: this.internalMaxDrawdownPct,
      equityUsable,
      attemptStatus: ex.attemptStatus ?? 'active',
    });

    this.balance = Number(ex.balance);
    this.highWaterMark = Number(ex.highWaterMark);
    this.dailyLossPct = r.dailyLossPct;
    this.drawdownPct = r.drawdownPct;
    this.reason = r.reason;
    this.equitySource = ex.equitySource ?? null;
    this.equityFreshAt = ex.equityFreshAt ?? null;
    this.updatedAt = Date.now();

    const changed = this.status !== r.status;
    this.status = r.status;
    this.exchange.riskState = this.getState();

    if (changed) {
      this.log.warn('propr-risk', `风控状态 ${r.status}：${r.reason}`);
      await this._apply(r.status, r.reason).catch(() => {});
    }
    return this.getState();
  }

  async _apply(status, reason) {
    const bot = this.bot;
    const send = (level, msg, key) => {
      try { this.notifier?.send({ source: 'propr', level, message: msg, title: 'Propr 风控', key }); } catch { /* 通知失败不影响 */ }
    };
    switch (status) {
      case STATUS.OK:
        send('info', '✅ Propr 挑战风控恢复正常。', 'propr:risk:ok:recover');
        break;
      case STATUS.WARNING:
        send('warn', `⚠️ Propr 风控预警：${reason}`, 'propr:risk:warn');
        break;
      case STATUS.REDUCE_ONLY:
        try { bot?.pauseOpening(nextUtcDayStart(), 'Propr 内部日损线：仅减仓至 UTC 日切'); } catch { /* ignore */ }
        send('critical', `🔴 Propr 日损触及内部线，已暂停开仓（仅减仓，UTC 日切自动恢复）：${reason}`, 'propr:risk:reduce');
        break;
      case STATUS.HALT:
        try { await bot?.stop({ closePosition: true }); } catch { /* ignore */ }
        send('critical', `🔴 Propr 总回撤触及内部线，已撤单 + 平仓 + 停机：${reason}`, 'propr:risk:halt');
        break;
      case STATUS.LOCKED:
        try { bot?.pauseOpening(Date.now() + 24 * 3600_000, 'Propr 权益不可用/过期：仅减仓'); } catch { /* ignore */ }
        send('critical', `🔴 Propr 权益不可用/过期，已暂停开仓（等待恢复）：${reason}`, 'propr:risk:locked');
        break;
      case STATUS.BREACHED:
        try { await bot?.stop({ closePosition: false }); } catch { /* ignore */ }
        send('critical', `🔴 Propr 挑战已失效（${reason}），策略已停止，请检查账户。`, 'propr:risk:breached');
        break;
    }
  }
}
