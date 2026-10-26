// 批量下单的返回契约（M1 先把契约固化成纯函数 + 单测，M2 再接真实写入）。
//
// GridBot._placeMany 的硬约束（src/bot.js）：
//   if (!Array.isArray(results) || results.length !== chunk.length) throw ...
//   results[i] 必须对应 chunk[i]
// 违约的后果不是"报个错"，而是**整批进重试队列 → 已成功的单被重复提交**。
// 所以这里的铁律：
//   1) 永远等长、同序
//   2) 单项业务失败不抛整批，只把该项标成 accepted:false 且不带 orderId
//   3) 服务端返回形状非法（缺项/乱序）才抛 —— 且因为 intentId 幂等，重试仍安全
import { classify } from './errors.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 逐单执行，聚合结果。串行是刻意的：Propr 一次请求只允许一个入场单。
 * @param {object[]} orders   每项至少含 intentId
 * @param {(o:object)=>Promise<{orderId:string, price?:number, sizeBase?:number}>} placeOne
 */
export async function placeBatch({ orders, placeOne, paceMs = 0, sleep = defaultSleep }) {
  if (!Array.isArray(orders)) throw new Error('placeBatch 需要 orders 数组');
  if (typeof placeOne !== 'function') throw new Error('placeBatch 需要 placeOne');
  const out = [];
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    try {
      const r = await placeOne(o);
      if (!r?.orderId) throw new Error('placeOne 未返回 orderId');
      out.push({ inputIndex: i, intentId: o.intentId, accepted: true, orderId: r.orderId, price: r.price ?? null, sizeBase: r.sizeBase ?? null });
    } catch (e) {
      const c = classify(e);
      out.push({
        inputIndex: i, intentId: o.intentId, accepted: false,
        code: e?.code ?? null, error: e?.message || String(e),
        retryable: c.retryable, mayExist: c.mayExist,
      });
    }
    if (paceMs > 0 && i < orders.length - 1) await sleep(paceMs);
  }
  return out;
}

/**
 * 校验一个"批量返回数组"是否满足 bot 契约。用于 M2 若走真实批量端点。
 * 乱序判定依赖 inputIndex；没有 inputIndex 时只能校验长度。
 */
export function assertBatchShape(chunk, results) {
  if (!Array.isArray(results)) throw new Error('批量返回不是数组');
  if (results.length !== chunk.length) throw new Error(`批量返回长度不符：${results.length} != ${chunk.length}`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && r.inputIndex != null && r.inputIndex !== i) {
      throw new Error(`批量返回乱序：第 ${i} 项标了 inputIndex=${r.inputIndex}`);
    }
  }
  return true;
}

/** 把逐项结果压成 bot 需要的形态：成功项保留 orderId，失败项置空。 */
export function toBotResults(items) {
  return items.map((r) => (r.accepted && r.orderId ? { orderId: r.orderId, price: r.price, sizeBase: r.sizeBase } : null));
}

/** 汇总：成功数、失败数、其中"可能已建单"的数量（决定要不要先对账再重试）。 */
export function summarize(items) {
  const ok = items.filter((r) => r.accepted);
  const failed = items.filter((r) => !r.accepted);
  return {
    total: items.length,
    accepted: ok.length,
    failed: failed.length,
    mayExist: failed.filter((r) => r.mayExist).length,
    codes: [...new Set(failed.map((r) => r.code).filter((c) => c != null))],
  };
}