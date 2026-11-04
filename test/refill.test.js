// 空档补齐：只在空仓时补，且不补贴价档。
import { strict as assert } from 'node:assert';
import { GridBot } from '../src/bot.js';

{
  const levels = [75891.5, 76407.83, 76924.17, 77440.5, 77956.83, 78473.17, 78989.5];
  const sp = 516.33;
  const occupied = new Set([0, 6]);
  const todo = GridBot.emptyLevels(levels, occupied, 77000, sp);
  // 76924.17 距现价 75.8 < 1/4 格（129）→ 必须跳过
  assert.ok(!todo.some((t) => t.levelIndex === 2), '贴价档不得补');
  assert.deepEqual(todo.map((t) => t.levelIndex), [3, 1, 4, 5], '按离现价由近到远');
  assert.equal(todo.find((t) => t.levelIndex === 3).side, 'sell');
  assert.equal(todo.find((t) => t.levelIndex === 1).side, 'buy');
  assert.ok(!todo.some((t) => t.levelIndex === 0 || t.levelIndex === 6), '已占用档不得重复补');
}

{
  // 全空 + 价格在正中：两侧都应出现
  const levels = [100, 110, 120, 130, 140];
  const todo = GridBot.emptyLevels(levels, new Set(), 120, 10);
  assert.equal(todo.length, 4); // 120 贴价被跳过
  assert.ok(todo.filter((t) => t.side === 'buy').length === 2);
  assert.ok(todo.filter((t) => t.side === 'sell').length === 2);
}

{
  // 价格缺失或非法 → 不补
  assert.deepEqual(GridBot.emptyLevels([100, 110], new Set(), 0, 10), []);
  assert.deepEqual(GridBot.emptyLevels([], new Set(), 100, 10), []);
}

console.log('✓ refill.test.js 全部通过');