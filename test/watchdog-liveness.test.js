// test/watchdog-liveness.test.js —— 「活动水位」不得只依赖外部行情路径
//
// 背景（2026-11-02 实测）：testnet 实例在 WS 半开（socket open、30s 零帧）+ Arcus 429 限流
// 期间，活动水位只剩「对账定时器」一个刷新源，停滞后 server 端 watchdog 打出
//   [ERROR] [watchdog] ar 活动停滞 96s（阈值 90s），主动退出等待 supervisor 重启
// 把「行情源故障」误判成「机器人卡死」，等于给行情抖动加了一个自杀开关。
//
// 修复后：风控心跳（5s，无条件）负责兜底刷新水位；暂停运行态（撤单确认中摘掉了全部定时器）
// 由 _pausedRuntime 标记豁免，避免在多分钟的撤单确认里被误杀。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { GridBot } from '../src/bot.js';

test('风控心跳必须刷新活动水位（否则行情断流即被判停滞）', () => {
  const bot = Object.create(GridBot.prototype);
  bot._lastActivityAt = 1;
  bot.running = false;          // 停机态：_runRiskCycle 会提前返回，但水位仍必须推进
  bot.guardState = { state: 'RUNNING' };

  bot._runRiskCycle('timer');
  assert.ok(bot._lastActivityAt > 1, '即使 running=false 也要 _touch()：水位是「进程活着」的证据，不是「在下单」的证据');

  const before = bot._lastActivityAt;
  bot._runRiskCycle('price');
  assert.ok(bot._lastActivityAt >= before, '连续心跳不得回退水位');
});

test('暂停运行态被标记，避免撤单确认期间被 watchdog 误杀', () => {
  const ex = new EventEmitter();
  const bot = Object.create(GridBot.prototype);
  bot.ex = ex;
  bot.running = true;
  bot.config = { marketId: 1 };
  bot._onFill = () => {};
  bot._onPrice = () => {};
  bot.active = new Map();
  bot._reconTimer = null;
  bot._riskTimer = null;

  bot._pauseTradingRuntime();
  assert.equal(bot._pausedRuntime, true, '暂停期间必须置标记（server 端据此跳过停滞判定）');
  assert.equal(bot._reconTimer, null, '暂停应摘掉对账定时器');

  bot._resumeTradingRuntime();
  assert.equal(bot._pausedRuntime, false, '恢复后必须清标记，否则会长期屏蔽 watchdog');
});