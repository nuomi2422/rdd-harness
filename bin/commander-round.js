#!/usr/bin/env node
/* commander-round.js — 给指挥官的监督轮记一行（C1/C3 的证据来源）
 *
 *    node bin/commander-round.js --arch arch_overview --docs "施工文档/044-xxx.md,角色/006-指挥官.md"
 *    node bin/commander-round.js --show            只看最近 5 行
 *
 * 为什么要有这个文件（2026-11-07）：主人要求指挥官「每 2 轮读架构 MCP、4 轮内读施工单和角色卡」，
 * 但架构 MCP 只读不记日志、DSH 的 read 调用不落盘（会话目录只有会话头），
 * 所以这两条只能靠**指挥官自己每轮写一行**当作证据 —— 这是自报型判据，已在 registry.knownGaps 登记。
 *
 * 规矩：只有真的做了才写。写了没做，就是把「看起来做了」伪造进账本，比不做更坏。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HARNESS = path.resolve(__dirname, '..');
const FILE = path.join(HARNESS, 'runs', 'commander-rounds.jsonl');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

if (process.argv.includes('--show')) {
  const lines = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
  console.log(lines.length ? lines.slice(-5).join('\n') : '(还没有任何轮次记录)');
  process.exit(0);
}

const archMcp = arg('--arch', '');
const docsRaw = arg('--docs', '');
const readDocs = docsRaw ? docsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

if (!archMcp && !readDocs.length) {
  console.error('至少给一个：--arch <工具名> 或 --docs "施工文档/xxx,角色/xxx"');
  process.exit(2);
}

const row = { at: new Date().toISOString() };
if (archMcp) row.archMcp = archMcp;
if (readDocs.length) row.readDocs = readDocs;

fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.appendFileSync(FILE, JSON.stringify(row) + '\n', 'utf8');
console.log('已记一轮：' + JSON.stringify(row));
