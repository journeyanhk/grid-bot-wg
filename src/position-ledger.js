// src/position-ledger.js —— 本地预期仓位账本
//
// 铁律（P0-2 评审结论）：
//   仓位 ≠ 挂单。绝不能把 active 里未成交的订单加总当成持仓。
//   本地预期仓位只能由「启动基线 + 已确认的真实成交」推导。
//
// 账本可持久化，重启后从 lastApplied 游标继续；重复/乱序成交都不会破坏结果。

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round8 = (v) => Math.round(v * 1e8) / 1e8;

/** 成交幂等键：同一笔成交即使被投递两次，也只会记一次账。 */
export function fillKey(f = {}) {
  // rawTs 是微秒原始戳；毫秒版会把同毫秒的两笔部分成交压成同一笔。
  const ts = f.rawTs ?? f.createdAt ?? f.t ?? f.ts ?? '';
  return [
    f.orderId ?? f.id ?? '',
    ts,
    f.side ?? '',
    num(f.sizeBase),
    num(f.price),
  ].join(':');
}

export class PositionLedger {
  constructor(raw = {}) {
    this.startBase = num(raw.startBase);          // 策略周期起点持仓（开仓基线）
    this.expected = raw.expected != null ? num(raw.expected) : this.startBase;
    this.version = num(raw.version);              // 账本版本号，每次变动 +1
    this.baseAt = num(raw.baseAt) || null;        // 基线锚定时刻
    this.appliedAt = num(raw.appliedAt) || null;  // 最后一次记账时刻
    this.resetCount = num(raw.resetCount);        // 重锚次数（应极少，可审计）
    this._seen = new Map();
    this._order = Array.isArray(raw.seenOrder) ? raw.seenOrder.slice(-400) : [];
    for (const k of this._order) this._seen.set(k, true);
  }

  /** 建立/重建基线：只在启动、人工重锚时调用，绝不能由成交或挂单驱动。 */
  reset(exchangeBase, now = Date.now()) {
    const base = num(exchangeBase);
    this.startBase = base;
    this.expected = base;
    this.baseAt = now;
    this.version += 1;
    this.resetCount += 1;
    return this;
  }

  /**
   * 记一笔已确认成交。返回 { applied, duplicate, expected }。
   * 重复投递（同一 fillKey）返回 duplicate=true 且不改账。
   */
  applyFill(f = {}) {
    const key = fillKey(f);
    if (this._seen.has(key)) {
      return { applied: false, duplicate: true, expected: this.expected };
    }
    this._seen.set(key, true);
    this._order.push(key);
    if (this._order.length > 400) {
      const old = this._order.shift();
      this._seen.delete(old);
    }
    const size = Math.abs(num(f.sizeBase));
    if (!(size > 0)) return { applied: false, empty: true, expected: this.expected };
    const signed = f.side === 'sell' ? -size : size;
    this.expected = round8(this.expected + signed);
    this.version += 1;
    this.appliedAt = Date.now();
    return { applied: true, expected: this.expected };
  }

  /** 交易所真值 − 本地预期。非 0 即账本漂移。 */
  diff(exchangeBase) {
    return round8(num(exchangeBase) - this.expected);
  }

  get value() { return this.expected; }

  toJSON() {
    return {
      startBase: this.startBase,
      expected: this.expected,
      version: this.version,
      baseAt: this.baseAt,
      appliedAt: this.appliedAt,
      resetCount: this.resetCount,
      seenOrder: this._order.slice(-400),
    };
  }
}