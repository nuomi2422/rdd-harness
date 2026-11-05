#!/usr/bin/env node
'use strict';
// precommit-gate.js —— commit 前的物理门：没有近 30 分钟内的 code-gate PASS/WARN 记录，就拒绝提交。
const fs = require('fs');
const path = require('path');
const LEDGER = 'D:\\rdd\\.harness\\audit\\gate-usage.jsonl';
const MAX_AGE_MS = 30 * 60 * 1000;

function fail(msg) {
  console.error('');
  console.error('  ✘ pre-commit 物理门禁：' + msg);
  console.error('    先跑：node D:\\rdd\\harness\\rdd-harness\\bin\\code-gate.js');
  console.error('    跑完再 commit。绕过 = git commit --no-verify（审计看不到门禁痕迹）。');
  console.error('');
  process.exit(1);
}

let lines = [];
try { lines = fs.readFileSync(LEDGER, 'utf8').trim().split(/\r?\n/).filter(Boolean); } catch (e) { fail('没有门禁账本 ' + LEDGER); }
let last = null;
for (const ln of lines) { try { const j = JSON.parse(ln); if (j.gate === 'code') last = j; } catch (e) { } }
if (!last) fail('从没跑过 code-gate');
const age = Date.now() - Date.parse(last.at);
if (Number.isNaN(age) || age > MAX_AGE_MS) fail('code-gate 上次是 ' + last.at + '，超过 30 分钟');
if (last.result === 'BLOCK') fail('code-gate 上次结果 BLOCK');
console.log('  ✔ pre-commit：code-gate ' + last.at + ' ' + last.result);
process.exit(0);
