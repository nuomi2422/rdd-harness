#!/usr/bin/env node
/* arch-check.js — 指挥官「激活即巡检架构」的记账器（2026-11-07 深夜主人定）
 *
 *   node bin/arch-check.js --dedupe "查重结论" --changed "035" --decision D-20261108-002 --note "改了什么"
 *   node bin/arch-check.js --dedupe "查重结论" --note "本轮无改动，原因：……"
 *   node bin/arch-check.js --show
 *
 * 为什么要有：主人要求「每次被激活都必须更新一小下，看看有没有要更新的架构图谱或普通内容，
 * 先查重再修再更改，然后还要保留记录」。光靠改文件证明不了「先查重」，所以每次激活都往
 * 架构意图/036-架构巡检记录.jsonl 追加一行，门禁 C5 只认这一行。
 *
 * 规矩：dedupe 必须写你查了什么（不是「已查重」三个字）；改了东西就必须挂 decisionId，
 * 并在 035 的 decisionHistory 里真有那条 —— 否则 C5 判 BLOCK。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HARNESS = path.resolve(__dirname, '..');
const ARCH = path.join(HARNESS, '..', '..', 'docs', 'rdd-docs', '知识库', '架构意图');
const FILE = path.join(ARCH, '036-架构巡检记录.jsonl');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

if (process.argv.includes('--show')) {
  const lines = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
  console.log(lines.length ? lines.slice(-5).join('\n') : '(还没有巡检记录)');
  process.exit(0);
}

const dedupe = arg('--dedupe', '');
const changedRaw = arg('--changed', '');
const changed = changedRaw ? changedRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
const decisionId = arg('--decision', '');
const note = arg('--note', '');

if (dedupe.trim().length < 4) {
  console.error('✘ --dedupe 必填且要写清你查了什么（少于 4 个字等于没查）');
  process.exit(2);
}
if (changed.length && !decisionId) {
  console.error('✘ 有 --changed 就必须给 --decision（改了架构不许没决策号）');
  process.exit(2);
}
if (!changed.length && note.trim().length < 4) {
  console.error('✘ 没改就必须给 --note 说明为什么不用改');
  process.exit(2);
}

const row = { at: new Date().toISOString(), actor: arg('--actor', 'commander'), dedupe: dedupe.trim() };
if (changed.length) { row.changed = changed; row.decisionId = decisionId; }
if (note.trim()) row.note = note.trim();
const session = arg('--session', '');
if (session) row.session = session;

fs.mkdirSync(ARCH, { recursive: true });
fs.appendFileSync(FILE, JSON.stringify(row) + '\n', 'utf8');
console.log('已记巡检：' + JSON.stringify(row));
