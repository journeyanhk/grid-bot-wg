#!/usr/bin/env node
// 前端 HTML 交叉核对：抓重复 id、残缺标签、未闭合标签。
// v1.4.2 与 v1.6.0 曾因大段复制插卡漏检导致全站崩溃，此脚本作为发版铁律。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const seen = new Set();
const dup = [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
const brokenOpen = [...html.matchAll(/(?<!<)div class="ov-card/g)].map((m) => m[0]);
const brokenClose = [...html.matchAll(/<\/div</g)].map((m) => m[0]);

const problems = [];
if (dup.length) problems.push(`重复 id: ${dup.join(', ')}`);
if (brokenOpen.length) problems.push(`残缺标签(缺 <): ${brokenOpen.join(', ')}`);
if (brokenClose.length) problems.push(`未闭合 </div<: ${brokenClose.join(', ')}`);

if (problems.length) {
  console.error('✗ HTML 交叉核对失败:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('✓ HTML 交叉核对通过（无重复 id / 无残缺标签 / 无未闭合标签）');