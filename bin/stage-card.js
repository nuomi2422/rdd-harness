#!/usr/bin/env node
'use strict';
// stage-card.js —— 打印三阶段注入卡；write | enter | exit
const fs = require('fs');
const path = require('path');
const CARD = 'D:\\rdd\\docs\\rdd-docs\\知识库\\进游戏验证\\004-三阶段注入卡.md';
const map = { write: '## 写代码', enter: '## 进游戏', exit: '## 退游戏' };
const which = process.argv[2];
const t = fs.readFileSync(CARD, 'utf8');
const key = map[which];
if (!key) { console.error('usage: stage-card.js write|enter|exit'); process.exit(2); }
const i = t.indexOf(key);
if (i < 0) { console.error('card section missing: ' + which); process.exit(2); }
const rest = t.slice(i + key.length);
const j = rest.search(/\n## /);
const body = (j < 0 ? rest : rest.slice(0, j)).trim();
console.log('\n=== 三阶段注入卡 · ' + which + '（自动打印，不用翻文档） ===');
console.log(body);
console.log('=== end card ===\n');
