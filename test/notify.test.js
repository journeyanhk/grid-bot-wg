// 通知总线 + 事件日历单测：防疲劳（分级/去重/限速摘要）与日历边界。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { inferLevel, notifier } from '../src/notify.js';
import { GridBot } from '../src/bot.js';
import { getEvents, eventsInMonth, upcomingEvents, firingEdges, activeWindow, getCalendarConfig, daysUntilExhausted } from '../src/calendar/index.js';

// ── 级别推断 ──
assert.equal(inferLevel('❌ 平仓失败'), 'critical');
assert.equal(inferLevel('会话 token 已过期'), 'critical');
assert.equal(inferLevel('⚠️ 保证金偏高'), 'warn');
assert.equal(inferLevel('启动完成：目标 21 单'), 'info');
// 传输层/网络抖动即便含「失败」也应降级为 warn（避免每次抖动 critical 刷屏）。
assert.equal(inferLevel('连接 Variational 失败（传输层）：ECONNRESET'), 'warn');
assert.equal(inferLevel('Variational 传输请求超时（GET /account）'), 'warn');
// 动作类失败仍是 critical。
assert.equal(inferLevel('下单失败：保证金不足'), 'critical');

// ── Notifier 防疲劳：用假的 provider 隔离真实网络 ──
{
  // 动态构造一个 Notifier 副本行为：直接测公开 send 的返回值（true=放行推送）。
  // 通过 import 单例 notifier；info 不推、warn 推、同 key 冷却窗内不重推、升级放行。
  const { notifier } = await import('../src/notify.js');
  // info 不推送
  assert.equal(notifier.send({ source: 't', message: '普通信息', level: 'info' }), false, 'info 不推送');
  // 首次 warn 放行
  assert.equal(notifier.send({ source: 't', message: 'x', level: 'warn', key: 'k1' }), true, '首次 warn 放行');
  // 同 key、同级别、冷却窗内 → 抑制
  assert.equal(notifier.send({ source: 't', message: 'x', level: 'warn', key: 'k1' }), false, '冷却窗内抑制');
  // 同 key 升级 critical → 放行
  assert.equal(notifier.send({ source: 't', message: 'x', level: 'critical', key: 'k1' }), true, '级别升级放行');
  const st = notifier.stats();
  assert.ok(st.sent >= 2 && st.suppressed >= 1, 'stats 记录 sent/suppressed');
}

// ── 全局限速 → 摘要合并 ──
{
  // 新建独立实例以免受上面单例状态影响：直接 import class 不导出，改用 fresh 计数验证。
  const { notifier } = await import('../src/notify.js');
  const before = notifier.stats();
  // 连打不同 key 的 warn，超过窗口上限后应进入 digest（返回 false）。
  let digestedSeen = false;
  for (let i = 0; i < 20; i++) {
    const r = notifier.send({ source: 'flood', message: 'm' + i, level: 'warn', key: 'flood-' + i });
    if (r === false) digestedSeen = true;
  }
  const after = notifier.stats();
  assert.ok(after.digested > before.digested || digestedSeen, '超过限速上限的消息进入摘要缓冲');
}

// ── 日历：数据完整性 ──
{
  const evs = getEvents();
  assert.ok(evs.length >= 30, '2026 事件表非空');
  for (const e of evs) {
    assert.ok(['CPI', 'FOMC', 'NFP'].includes(e.type), '类型合法');
    assert.ok(Number.isFinite(e.ts), 'ts 可解析');
    assert.ok(e.id && e.title, 'id/title 齐全');
  }
  // 已排序
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].ts >= evs[i - 1].ts, '按时间升序');
}

// ── 日历：某月归类 ──
{
  const sep = eventsInMonth(2026, 9);
  assert.ok(sep.some((e) => e.id === 'NFP-2026-09-04'), '9 月含非农 9/4');
  assert.ok(sep.some((e) => e.id === 'CPI-2026-09-11'), '9 月含 CPI 9/11');
  assert.ok(sep.some((e) => e.id === 'FOMC-2026-09-16'), '9 月含 FOMC 9/16');
}

// ── 日历：预警边界（T-window 与 T 各触发一次）──
{
  const evTs = Date.parse('2026-09-11T12:30:00Z'); // CPI 9/11 12:30Z
  const w = 30;
  // 跨过 T-30（12:00Z）
  const pre = firingEdges(evTs - 29 * 60_000, evTs - 31 * 60_000, w);
  assert.ok(pre.some((x) => x.event.id === 'CPI-2026-09-11' && x.edge === 'pre'), 'T-30 触发 pre');
  // 跨过 T（12:30Z）
  const at = firingEdges(evTs + 60_000, evTs - 60_000, w);
  assert.ok(at.some((x) => x.event.id === 'CPI-2026-09-11' && x.edge === 'at'), 'T 触发 at');
  // 窗口外不触发
  const none = firingEdges(evTs - 40 * 60_000, evTs - 42 * 60_000, w);
  assert.equal(none.length, 0, '窗口外不触发');
}

// ── 日历：activeWindow ──
{
  const evTs = Date.parse('2026-09-16T18:00:00Z'); // FOMC
  assert.ok(activeWindow(evTs, 30)?.id === 'FOMC-2026-09-16', '事件时刻在窗口内');
  assert.ok(activeWindow(evTs - 20 * 60_000, 30)?.id === 'FOMC-2026-09-16', 'T-20 在窗口内');
  assert.equal(activeWindow(evTs + 40 * 60_000, 30), null, 'T+40 在窗口外');
}

// ── 日历：配置读取（env 实时）──
{
  process.env.CALENDAR_ALERT_MINUTES = '45';
  process.env.CALENDAR_AUTO_PAUSE = 'on';
  const c = getCalendarConfig();
  assert.equal(c.windowMin, 45);
  assert.equal(c.autoPause, true);
  delete process.env.CALENDAR_ALERT_MINUTES;
  delete process.env.CALENDAR_AUTO_PAUSE;
  assert.equal(getCalendarConfig().windowMin, 30, '默认 30');
  assert.equal(getCalendarConfig().autoPause, false, '默认关闭');
}

// ── upcomingEvents 只取未来 ──
{
  const now = Date.parse('2026-09-09T00:00:00Z');
  const up = upcomingEvents(now, 45);
  assert.ok(up.every((e) => e.ts >= now), '全在未来');
  assert.ok(up.some((e) => e.id === 'CPI-2026-09-11'), '含近期 CPI');
}

// ── cooldownMs 覆盖：短冷却过期后可再次放行 ──
{
  notifier._pushes = [];   // 隔离前面 flood 测试对全局限速的影响
  const k = 'cd-' + Date.now();
  assert.equal(notifier.send({ source: 't', message: 'x', level: 'warn', key: k, cooldownMs: 1 }), true, 'cooldownMs 首推放行');
  const t0 = Date.now(); while (Date.now() - t0 < 5) { /* 自旋 >1ms */ }
  assert.equal(notifier.send({ source: 't', message: 'x', level: 'warn', key: k, cooldownMs: 1 }), true, 'cooldownMs=1ms 过期后再次放行');
}

// ── 成交流哨兵：健康震荡不误报，真单边才报 ──
{
  const bot = new GridBot(new EventEmitter(), {});
  bot.config = { displayName: 'BTC-TEST' };
  bot.grid = { count: 20, spacing: 10 };   // 相对阈值 = max(5, round(20*0.4)) = 8
  bot.lastPrice = 60000;
  bot._trendFillN = 0;                      // 走相对阈值
  const alerts = [];
  bot._alert = (m) => alerts.push(m);

  // 健康震荡：买入场(k=5) → 卖平仓(k=6) → …重复 20 轮。入场全是 buy，但被平仓腿隔开、档位不推进。
  for (let i = 0; i < 20; i++) {
    bot._checkTrendFills({ side: 'buy', levelIndex: 5, closing: false });
    bot._checkTrendFills({ side: 'sell', levelIndex: 6, closing: true });
  }
  assert.equal(alerts.length, 0, '健康震荡（买入场↔卖平仓）不应触发单边预警');

  // 真单边下跌：连续 8 次买入场，档位单调递减（越买越低），中间无反向/无平仓。
  const bot2 = new GridBot(new EventEmitter(), {});
  bot2.config = { displayName: 'BTC-TEST' };
  bot2.grid = { count: 20, spacing: 10 };
  bot2.lastPrice = 60000;
  bot2._trendFillN = 0;
  const alerts2 = [];
  bot2._alert = (m) => alerts2.push(m);
  for (let lvl = 12; lvl >= 5; lvl--) bot2._checkTrendFills({ side: 'buy', levelIndex: lvl, closing: false });
  assert.equal(alerts2.length, 1, '连续 8 格单调下行入场应触发一次预警');
  assert.ok(/单边下跌/.test(alerts2[0]) && /行程/.test(alerts2[0]), '文案含方向与行程');
}

// ── daysUntilExhausted：非负且与最后一个事件一致 ──
{
  const evs = getEvents();
  const last = evs[evs.length - 1].ts;
  const now = last - 30 * 86_400_000;
  assert.equal(daysUntilExhausted(now), 30, '距最后事件 30 天');
  assert.equal(daysUntilExhausted(last + 86_400_000), 0, '耗尽后为 0');
}

console.log('✓ notify.test.js 全部通过');
