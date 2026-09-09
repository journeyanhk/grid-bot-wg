// 通知总线：把全站告警（bot 告警 / 成交流哨兵 / 事件日历）统一收口，
// 经防疲劳过滤后交给 provider.notify() 多渠道推送（Telegram / Webhook / Server酱）。
//
// 设计目标（用户需求「做好放疲劳即可」）：
//   1) 分级：info 只进仪表盘不推送；warn / critical 才推手机。
//   2) 按 key 去重 + 冷却：同一类告警在冷却窗内不重发，除非级别升级（warn→critical 立即放行）。
//   3) 全局限速：滚动窗口内推送数超上限 → 后续合并成一条摘要，避免刷屏。
//   4) 失败隔离：推送失败只记日志，绝不影响交易主流程。
import { notify } from './ai/provider.js';
import { logger } from './log.js';

const LEVELS = { info: 0, warn: 1, critical: 2 };

// 各级别的按-key 冷却窗（毫秒）。critical 更短——严重问题值得多提醒几次。
const COOLDOWN_MS = { warn: 30 * 60_000, critical: 10 * 60_000 };

// 全局限速：滚动窗口 & 上限。超过后把消息压入摘要缓冲，延时合并推送一条。
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 6;
const DIGEST_FLUSH_MS = 60_000;

/** 从消息文本推断级别：❌ → critical，⚠️ → warn，其余 → info。 */
export function inferLevel(message) {
  const m = String(message || '');
  if (m.includes('❌') || /严重|强平|止损|已过期|崩溃|失败/.test(m)) return 'critical';
  if (m.includes('⚠')) return 'warn';
  return 'info';
}

/** 从消息派生去重 key：去掉数字/标点，取前若干字，让「82%」「83%」这类抖动折叠成一类。 */
function deriveKey(source, message) {
  const norm = String(message || '')
    .replace(/[0-9.,%：:()（）\s]+/g, '')
    .slice(0, 24);
  return `${source}:${norm}`;
}

class Notifier {
  constructor() {
    this._seen = new Map();      // key -> { at, level }
    this._pushes = [];           // 最近推送时间戳（滚动限速）
    this._digest = [];           // 被限速合并的待发消息
    this._digestTimer = null;
    this._stats = { sent: 0, suppressed: 0, digested: 0 };
  }

  /**
   * 发送一条告警。
   * @param {object} o
   * @param {string} o.source  来源标签（如 'va' / 'calendar' / 'trend'）
   * @param {string} o.message 正文
   * @param {'info'|'warn'|'critical'} [o.level] 级别（不传则从 message 推断）
   * @param {string} [o.key]   去重 key（不传则从 message 派生）
   * @param {string} [o.title] 推送标题（Server酱用）
   * @returns {boolean} 是否放行推送（被抑制/合并/info 返回 false）
   */
  send({ source = 'bot', message, level, key, title } = {}) {
    if (!message) return false;
    const lv = level || inferLevel(message);
    if (LEVELS[lv] === undefined) return false;
    // info 不推送——仅存在于仪表盘告警环
    if (lv === 'info') return false;

    const k = key || deriveKey(source, message);
    const now = Date.now();
    const prev = this._seen.get(k);
    // 冷却窗内、且级别没有升级 → 抑制
    if (prev && now - prev.at < (COOLDOWN_MS[lv] || 0) && LEVELS[lv] <= LEVELS[prev.level]) {
      this._stats.suppressed++;
      return false;
    }
    this._seen.set(k, { at: now, level: lv });

    // 全局限速
    this._pushes = this._pushes.filter((t) => now - t < RATE_WINDOW_MS);
    if (this._pushes.length >= RATE_MAX) {
      this._digest.push({ source, message, lv });
      this._stats.digested++;
      this._armDigest();
      return false;
    }
    this._pushes.push(now);
    this._stats.sent++;
    this._dispatch(this._format(lv, source, message), title);
    return true;
  }

  _format(lv, source, message) {
    const tag = lv === 'critical' ? '严重' : '注意';
    return `【网格机器人·${tag}】${message}`;
  }

  _dispatch(text, title) {
    // 失败只记日志，绝不抛（provider.notify 内部已 allSettled）。
    Promise.resolve(notify(text, title ? { title } : {}))
      .catch((e) => logger.error('notify', '推送失败：' + (e?.message || e)));
  }

  _armDigest() {
    if (this._digestTimer) return;
    this._digestTimer = setTimeout(() => this._flushDigest(), DIGEST_FLUSH_MS);
    if (this._digestTimer.unref) this._digestTimer.unref();
  }

  _flushDigest() {
    this._digestTimer = null;
    if (!this._digest.length) return;
    const items = this._digest.splice(0, this._digest.length);
    const worst = items.some((x) => x.lv === 'critical') ? 'critical' : 'warn';
    const head = `【网格机器人·摘要】过去数分钟 ${items.length} 条告警（已限速合并）`;
    const lines = items.slice(0, 12).map((x) => `· ${x.message}`).join('\n');
    this._pushes.push(Date.now());
    this._dispatch(`${head}\n${lines}`, worst === 'critical' ? '网格机器人·严重摘要' : '网格机器人·告警摘要');
  }

  stats() { return { ...this._stats }; }
}

export const notifier = new Notifier();
