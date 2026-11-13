// test/per-rung-net.test.js —— 名字叫 Net 的字段，必须证明它真的是 net
//
// 2026-11-13 review 必改 1：巡检报出 `perRungNet=$0.0302`，而
//   0.0002 × 151.247 = 0.0302494  ← 精确等于报出值
// 一分手续费都没扣。真因：重启后 `ex.feeRate` 还是初始 0（费率表未加载），
// 而 0 同时被当作「免费」——一个叫「净」的字段静默变回了毛额。
//
// 现在：三数并列（gross/fee/net）+ feeRateKnown 语义 + 本文件的断言。
import assert from 'node:assert/strict';
import test from 'node:test';
import { GridBot, netPerRungUsd } from '../src/bot.js';

const SIZE = 0.0002;
const SPACING = 151.247;
const MID = (70_632.1 + 80_614.4) / 2;
const PPM = 150;

function mkEx({ feeRate = 0, feeRateKnown = false } = {}) {
  return { feeRate, feeRateKnown, displayFeeRate: feeRate, getPosition: () => null };
}

function mkBot(ex) {
  const bot = Object.create(GridBot.prototype);
  bot.ex = ex;
  bot.config = {
    marketId: 1, sizeBase: SIZE, lower: 70_632.1, upper: 80_614.4, leverage: 10,
    mode: 'neutral', displayName: 'BTC-USD',
  };
  bot.grid = { count: 66, spacing: SPACING, levels: [] };
  bot._applyGuard = () => {};
  return bot;
}

test('netPerRungUsd：净额 = 毛额 − 双边 maker 费', () => {
  const net = netPerRungUsd({ spacing: SPACING, sizeBase: SIZE, price: 68_758.7, feeRate: PPM / 1e6 });
  assert.ok(Math.abs(net - (0.0302494 - 0.0041255)) < 1e-6, `实际 ${net}`);
});

test('risk：费率未加载时 perRungNet=null（不许把 0 ppm 当成免费）', () => {
  const bot = mkBot(mkEx({ feeRate: 0, feeRateKnown: false }));
  bot._recomputeRisk();
  assert.equal(bot.risk.feeRateKnown, false);
  assert.equal(bot.risk.perRungNet, null, '未知费率必须留空，不能输出毛额冒充净额');
  assert.equal(bot.risk.grossPerRung, 0.0302494);
  assert.equal(bot.risk.feePerRung, null);
});

test('risk：加载 150ppm 后三数并列，且净额公式可机检', () => {
  const bot = mkBot(mkEx({ feeRate: PPM / 1e6, feeRateKnown: true }));
  bot._recomputeRisk();
  const { grossPerRung, feePerRung, perRungNet, feeRatePpm } = bot.risk;
  assert.equal(feeRatePpm, PPM);
  assert.equal(grossPerRung, 0.0302494);
  assert.equal(feePerRung, 0.00453739);     // 2×0.0002×75,623.25×150ppm（区间中点，不是成交价）
  assert.equal(perRungNet, 0.02571201);
  // review 要求的机检断言：perRungNet == size×spacing − 2×size×price×makerFee（误差 <1e-6）
  const want = SIZE * SPACING - 2 * SIZE * MID * (PPM / 1e6);
  assert.ok(Math.abs(perRungNet - want) < 1e-6, `实际 ${perRungNet} vs ${want}`);
  assert.ok(perRungNet < grossPerRung, '净额必须严格小于毛额');
});
