#!/usr/bin/env node
/**
 * 瞬扫回放：把 2026-10-22 20:00:04Z 那根大针打出来的 51 笔成交，按适配器真实的
 * 派发方式（同步 for..of emit）灌回 GridBot，验证「微任务排队 + 补齐」后阶梯无空洞。
 *
 * 用法：
 *   node scripts/replay-sweep.mjs [fills.json]
 * fills.json 来自 GET /v1/fills?address=…&accountIndex=1&from=…&to=…#须带 accountIndex
 *
 * 判定：被扫掉的每一档，其"对腿"必须存在于 active；缺失即空洞，退出码 1。
 */
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { GridBot } from '../src/bot.js';
import { parseFills } from '../src/exchange/ar/market.js';

const FILLS = process.argv[2] || '/data/home/sweep-fills.json';
const LOWER = 72030;
const UPPER = 74970;
const COUNT = 132;
const SIZE = 0.0002;

class FakeExchange extends EventEmitter {
  constructor() { super(); this.position = null; this.orderSeq = 0; this.placed = []; this.mode = 'live'; }
  async placeLimitOrder(o) { this.orderSeq += 1; const id = `r${this.orderSeq}`; this.placed.push({ id, ...o }); return { orderId: id }; }
  async placeMarketOrder() { return { ok: true }; }
  async cancelOrder() { return true; }
  async cancelAll() { return true; }
  async fetchOpenOrders() { return []; }
  async getPrice() { return 73400; }
  getPosition() { return this.position; }
  async init() {}
  async equity() { return { equity: 1000, balance: 1000 }; }
  displayFeeRate() { return 0.00015; }
}

const rows = JSON.parse(fs.readFileSync(FILLS, 'utf8'));
const fills = parseFills(rows);
if (!fills.length) { console.error('❌ 没有解析出成交，检查 fills.json'); process.exit(2); }

const spacing = (UPPER - LOWER) / COUNT;
const levelOf = (price) => Math.round((price - LOWER) / spacing);

const ex = new FakeExchange();
const bot = new GridBot(ex);
bot.config = {
  ...bot.config,
  marketId: 1, displayName: 'BTC-USD', mode: 'neutral',
  lower: LOWER, upper: UPPER, gridCount: COUNT, levels: COUNT + 1,
  sizeBase: SIZE, spacing, tickSize: 0.1,
};
bot.grid = { lower: LOWER, upper: UPPER, levels: COUNT + 1, spacing, sizeBase: SIZE, marketId: 1, mode: 'neutral' };
bot.running = true;
bot._alert = () => {};

// 只把"被扫掉的那些档"的挂单放进 active——这才是回放的起点：
// 大针穿过它们，每笔成交都消耗掉自己那一档，补腿必须落到对侧相邻档。
// 若像真实长跑那样把没被扫的档也铺上，目标档本来就有人，测不出补腿是否真的发生。
for (const f of fills) {
  const lvl = levelOf(f.price);
  bot.active.set(String(f.orderId), { orderId: String(f.orderId), levelIndex: lvl, side: f.side, price: f.price, sizeBase: SIZE });
}

const before = bot.active.size;
// 关键：同步连发，复刻适配器 for (const f of fresh) emit('fill', f) 的派发方式
for (const f of fills) bot._handleFill(f);
await new Promise((r) => setTimeout(r, 60));

const levelsNow = new Set([...bot.active.values()].map((a) => a.levelIndex));
const filledLevels = [...new Set(fills.map((f) => levelOf(f.price)))];
// 严格判定：买@i 成交 → i+1 必须有 SELL；卖@i 成交 → i-1 必须有 BUY。
// 只查"有没有单"是不够的——补到同一档或补错方向，同样是坏。
const legAt = (lvl, side) => [...bot.active.values()].some((a) => a.levelIndex === lvl && a.side === side);
const holes = [];
for (const [lvl, side] of new Map(fills.map((f) => [levelOf(f.price), f.side]))) {
  const [wantLvl, wantSide] = side === 'buy' ? [lvl + 1, 'sell'] : [lvl - 1, 'buy'];
  if (!legAt(wantLvl, wantSide)) holes.push(`${lvl}->${wantLvl}${wantSide}`);
}

console.log(`回合：成交 ${fills.length} 笔 / 扫掉 ${filledLevels.length} 档 / 回合前在簿 ${before} 张`);
console.log(`回合后：在簿 ${bot.active.size} 张 / 覆盖档位 ${levelsNow.size} / 补腿冲突 ${bot._replConflicts}`);
console.log(`空洞档位：${holes.length ? holes.join(',') : '0（无）'}`);
process.exit(holes.length ? 1 : 0);