'use strict';
// 总判定的优先级验证：真实尾部数据 + 违规夹具。核心要求：任何降级场景都不得给出 PRESENT。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const V = require('./evidence-verdict');
const { buildCard } = require('../evidence-card');

const DIR = process.env.RDD_MONITOR || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
const has = fs.existsSync(path.join(DIR, 'tools.jsonl'));

test('真实尾部：无身份 + 其余全齐 → 仍 UNKNOWN', { skip: has ? false : '无真实文件' }, () => {
  const card = buildCard(DIR);
  const clean = { ...card, reasons: [], window: { applied: false }, actions: { ...card.actions, attributable: 'UNKNOWN' } };
  const v = V.buildVerdict(clean, { status: 'PRESENT' });
  assert.equal(v.verdict, 'UNKNOWN');
  assert.ok(v.reasons.includes('identity-not-attributable'));
});

test('真实尾部：窗口过滤 + 身份可归属 + 无违规 → PARTIAL（不是 PRESENT）', { skip: has ? false : '无真实文件' }, () => {
  const card = buildCard(DIR, { since: '2026-11-09T05:00:00Z', until: '2026-11-09T06:00:00Z' });
  const okCard = { ...card, reasons: [], actions: { ...card.actions, attributable: 'PRESENT' } };
  const v = V.buildVerdict(okCard, { status: 'PRESENT' });
  assert.equal(v.verdict, 'PARTIAL');
  assert.ok(v.reasons.includes('window-filtered'));
});

test('真实尾部：有读取缺口 → UNKNOWN（连 PARTIAL 都不给）', { skip: has ? false : '无真实文件' }, () => {
  const card = buildCard(DIR);
  const gapped = { ...card, reasons: ['log-gap'], actions: { ...card.actions, attributable: 'PRESENT' } };
  const v = V.buildVerdict(gapped, { status: 'PRESENT' });
  assert.equal(v.verdict, 'UNKNOWN');
  assert.ok(v.reasons.includes('log-gap'));
});

test('违规优先：身份未知 + 时间明确违规 → VIOLATION，不被 UNKNOWN 吞掉', () => {
  const v = V.buildVerdict({ reasons: [], actions: { attributable: 'UNKNOWN' } }, { status: 'VIOLATION' });
  assert.equal(v.verdict, 'VIOLATION', '违规必须优先暴露');
});

test('反向：身份未知但无违规 → 不得因有数据给 PRESENT', () => {
  const v = V.buildVerdict({ reasons: [], actions: { attributable: 'UNKNOWN' } }, { status: 'PRESENT' });
  assert.equal(v.verdict, 'UNKNOWN');
});

test('消费守门：门禁/验收文件不得把总判定 PRESENT 当通过', () => {
  const dir = path.join(__dirname, '..');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
    if (name === 'bench.js') continue; // 只打印
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\//.test(l)).join('\n');
    // 只查"实际 require 进来用"；regress 里按路径登记自检不算（不参与放行）
    if (/require\(['"][^'"]*evidence-verdict/.test(code)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], '总判定只允许 bench evidence 打印，不得进入任何放行路径');
});
