#!/usr/bin/env node
// 前端 HTML 交叉核对：重复 id / 缺失面板 / P() 引用核对 / 残缺标签。
// v1.4.2、v1.6.0、v1.6.3 三次前端大段复制插卡事故的机器防线，发版铁律。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const problems = [];

// ① 重复 id
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const seen = new Set();
const dup = [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
if (dup.length) problems.push(`重复 id: ${dup.join(', ')}`);

// ② 缺失面板：tab 数组里的每个前缀都必须有对应面板、导航按钮、控制台实例
const prefixes = ['de', 'ex', 'rs', 'lr', 'hl', 'va'];
for (const p of prefixes) {
  if (!html.includes(`<div id="tab-${p}" class="tab-panel">`)) problems.push(`缺失面板 tab-${p}`);
  if (!html.includes(`onclick="switchTab('${p}')"`)) problems.push(`缺失导航按钮 switchTab('${p}')`);
  if (!html.includes(`makeExchangeCtrl('${p}'`)) problems.push(`缺失控制台实例 makeExchangeCtrl('${p}')`);
  if (!html.includes(`id="hdr-${p}-dot"`)) problems.push(`缺失头部徽章 hdr-${p}-dot`);
}

// ③ P() 引用核对：每个 makeExchangeCtrl(prefix) 面板里引用的 ${prefix}-* id 必须存在于 DOM
for (const p of prefixes) {
  const panelStart = html.indexOf(`<div id="tab-${p}" class="tab-panel">`);
  if (panelStart === -1) continue;
  const panelEnd = html.indexOf('<div id="tab-"', panelStart + 10);
  const panelHtml = html.slice(panelStart, panelEnd === -1 ? html.length : panelEnd);
  const refs = [...panelHtml.matchAll(/P\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (!html.includes(`id="${p}-${ref}"`)) problems.push(`面板 ${p} 引用了缺失的 id ${p}-${ref}`);
  }
}

// ④ 残缺标签
const brokenOpen = [...html.matchAll(/(?<!<)div class="ov-card/g)].map((m) => m[0]);
const brokenClose = [...html.matchAll(/<\/div</g)].map((m) => m[0]);
if (brokenOpen.length) problems.push(`残缺标签(缺 <): ${brokenOpen.join(', ')}`);
if (brokenClose.length) problems.push(`未闭合 </div<: ${brokenClose.join(', ')}`);

if (problems.length) {
  console.error('✗ HTML 交叉核对失败:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('✓ HTML 交叉核对通过（无重复 id / 面板齐全 / P() 引用完整 / 无残缺标签）');