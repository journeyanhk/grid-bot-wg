// 事件日历（静态精选表）：美国 CPI / FOMC / 非农（就业报告）。
// 这三类是「唯一能提前预测」的信号——时间表提前公布、零误报，正是网格哨兵最该用的。
// 时间为 UTC；美东 8:30（CPI/非农）与 14:00（FOMC 决议）已按 2026 夏令时（3/8–11/1 为 EDT）换算。
// ⚠️ 数据为 2026 全年预填，请每年（或遇 BLS/Fed 改期）核对官方日程后更新本表。
//   FOMC:  federalreserve.gov/monetarypolicy/fomccalendars.htm
//   CPI:   bls.gov/schedule/news_release/cpi.htm
//   非农:  bls.gov/schedule/news_release/empsit.htm

// type: 'CPI' | 'FOMC' | 'NFP'；at: ISO UTC；impact 仅用于前端配色
export const EVENTS = [
  // ── FOMC 利率决议（决议日 14:00 ET）──
  { type: 'FOMC', at: '2026-01-28T19:00:00Z', title: 'FOMC 利率决议' },
  { type: 'FOMC', at: '2026-03-18T18:00:00Z', title: 'FOMC 利率决议（含经济预测/点阵图）' },
  { type: 'FOMC', at: '2026-04-29T18:00:00Z', title: 'FOMC 利率决议' },
  { type: 'FOMC', at: '2026-06-17T18:00:00Z', title: 'FOMC 利率决议（含经济预测/点阵图）' },
  { type: 'FOMC', at: '2026-07-29T18:00:00Z', title: 'FOMC 利率决议' },
  { type: 'FOMC', at: '2026-09-16T18:00:00Z', title: 'FOMC 利率决议（含经济预测/点阵图）' },
  { type: 'FOMC', at: '2026-10-28T18:00:00Z', title: 'FOMC 利率决议' },
  { type: 'FOMC', at: '2026-12-09T19:00:00Z', title: 'FOMC 利率决议（含经济预测/点阵图）' },
  // ── CPI 通胀数据（8:30 ET）──
  { type: 'CPI', at: '2026-02-13T13:30:00Z', title: 'CPI 通胀数据（1 月）' },
  { type: 'CPI', at: '2026-03-11T12:30:00Z', title: 'CPI 通胀数据（2 月）' },
  { type: 'CPI', at: '2026-04-10T12:30:00Z', title: 'CPI 通胀数据（3 月）' },
  { type: 'CPI', at: '2026-05-12T12:30:00Z', title: 'CPI 通胀数据（4 月）' },
  { type: 'CPI', at: '2026-06-10T12:30:00Z', title: 'CPI 通胀数据（5 月）' },
  { type: 'CPI', at: '2026-07-14T12:30:00Z', title: 'CPI 通胀数据（6 月）' },
  { type: 'CPI', at: '2026-08-12T12:30:00Z', title: 'CPI 通胀数据（7 月）' },
  { type: 'CPI', at: '2026-09-11T12:30:00Z', title: 'CPI 通胀数据（8 月）' },
  { type: 'CPI', at: '2026-10-14T12:30:00Z', title: 'CPI 通胀数据（9 月）' },
  { type: 'CPI', at: '2026-11-10T13:30:00Z', title: 'CPI 通胀数据（10 月）' },
  { type: 'CPI', at: '2026-12-18T13:30:00Z', title: 'CPI 通胀数据（11 月，改期自 12/10）' },
  // ── 非农就业报告（第一个周五 8:30 ET）──
  { type: 'NFP', at: '2026-01-09T13:30:00Z', title: '非农就业报告（12 月）' },
  { type: 'NFP', at: '2026-02-06T13:30:00Z', title: '非农就业报告（1 月）' },
  { type: 'NFP', at: '2026-03-06T12:30:00Z', title: '非农就业报告（2 月）' },
  { type: 'NFP', at: '2026-04-03T12:30:00Z', title: '非农就业报告（3 月）' },
  { type: 'NFP', at: '2026-05-08T12:30:00Z', title: '非农就业报告（4 月）' },
  { type: 'NFP', at: '2026-06-05T12:30:00Z', title: '非农就业报告（5 月）' },
  { type: 'NFP', at: '2026-07-02T12:30:00Z', title: '非农就业报告（6 月）' },
  { type: 'NFP', at: '2026-08-07T12:30:00Z', title: '非农就业报告（7 月）' },
  { type: 'NFP', at: '2026-09-04T12:30:00Z', title: '非农就业报告（8 月）' },
  { type: 'NFP', at: '2026-10-02T12:30:00Z', title: '非农就业报告（9 月）' },
  { type: 'NFP', at: '2026-11-06T13:30:00Z', title: '非农就业报告（10 月）' },
  { type: 'NFP', at: '2026-12-04T13:30:00Z', title: '非农就业报告（11 月）' },
].map((e) => ({ ...e, id: `${e.type}-${e.at.slice(0, 10)}`, ts: Date.parse(e.at) }))
  .sort((a, b) => a.ts - b.ts);

export const TYPE_LABEL = { CPI: 'CPI', FOMC: 'FOMC', NFP: '非农' };

/** 全部事件（已排序，带 id/ts）。 */
export function getEvents() { return EVENTS; }

/** 指定自然月（year, month1=1..12）内的事件，按 UTC 日期归类。 */
export function eventsInMonth(year, month1) {
  return EVENTS.filter((e) => {
    const d = new Date(e.ts);
    return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month1;
  });
}

/** 未来 horizonDays 天内、尚未开始的事件。 */
export function upcomingEvents(now = Date.now(), horizonDays = 14) {
  const end = now + horizonDays * 86400_000;
  return EVENTS.filter((e) => e.ts >= now && e.ts <= end);
}

/**
 * 读取日历告警配置（env 实时读取，仪表盘改 .env 后立即生效）。
 * windowMin: 事件前后各多少分钟为预警窗（默认 30）；autoPause: 窗口内是否自动暂停入场侧。
 */
export function getCalendarConfig() {
  return {
    windowMin: Number(process.env.CALENDAR_ALERT_MINUTES) || 30,
    autoPause: /^(1|on|true|yes)$/i.test(String(process.env.CALENDAR_AUTO_PAUSE || '')),
  };
}

/**
 * 判断在 [prevTick, now] 这段时间里，是否有事件跨过了「进入预警窗」（T-window）或「事件时刻」（T）。
 * 用于调度器每次 tick 决定是否推送。返回 [{ event, edge: 'pre'|'at' }]。
 * @param {number} now 当前毫秒
 * @param {number} prevTick 上次 tick 毫秒（首次可传 now-tickMs）
 * @param {number} windowMin 预警窗（分钟）
 */
export function firingEdges(now, prevTick, windowMin = 30) {
  const w = windowMin * 60_000;
  const out = [];
  for (const e of EVENTS) {
    const preT = e.ts - w;               // 进入预警窗时刻
    if (preT > prevTick && preT <= now) out.push({ event: e, edge: 'pre' });
    if (e.ts > prevTick && e.ts <= now) out.push({ event: e, edge: 'at' });
  }
  return out;
}

/**
 * 某时刻是否落在任一事件的 ±window 窗口内；返回命中的事件（供自动暂停判断）。
 */
export function activeWindow(now, windowMin = 30) {
  const w = windowMin * 60_000;
  return EVENTS.find((e) => now >= e.ts - w && now <= e.ts + w) || null;
}
