'use strict';
// 真实生产日志的**只读脱敏**测试：读端输出不得带出正文/参数/结果片段。
// 做法：从真实流里取一段真实正文，断言它不出现在各命令/模块的输出里（只出现计数与指针）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const BD = require('./behavior-digest');
const MP = require('./moment-pack');
const T = require('./taskchain-observe');
const B = require('./budget-observe');

const DIR = process.env.RDD_MONITOR || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
const has = fs.existsSync(path.join(DIR, 'ai.jsonl'));
const read = (n) => { try { return fs.readFileSync(path.join(DIR, n), 'utf8'); } catch { return ''; } };

function sampleText() {
  const rows = read('ai.jsonl').split(/\r?\n/).filter(Boolean).slice(-200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (const r of rows) {
    const t = r && r.data && typeof r.data.text === 'string' ? r.data.text.trim() : '';
    if (t.length >= 30) return t.slice(0, 30);
  }
  return null;
}

test('摘要输出不得带出真实正文片段', { skip: has ? false : '无真实日志' }, () => {
  const snip = sampleText();
  if (!snip) return;
  const res = BD.buildDigest({ ai: read('ai.jsonl'), tools: read('tools.jsonl'), events: read('events.jsonl'), rdd: read('rdd.jsonl'), sinceMs: 0, untilMs: Date.now() });
  assert.equal(res.text.includes(snip), false, '摘要不得含真实正文');
  assert.equal(JSON.stringify(res).includes(snip), false, 'JSON 也不得含');
});

test('时刻证据包/任务链/预算输出不得带出正文', { skip: has ? false : '无真实日志' }, () => {
  const snip = sampleText();
  if (!snip) return;
  const mp = MP.pack({ 'ai.jsonl': read('ai.jsonl'), 'tools.jsonl': read('tools.jsonl') }, '2026-11-09T05:00:00Z', { spanSec: 3600 });
  assert.equal(JSON.stringify(mp).includes(snip), false);
  const tc = T.build({ 'rdd.jsonl': read('rdd.jsonl') });
  assert.equal(JSON.stringify(tc).includes(snip), false);
  const bg = B.build({ 'context.jsonl': read('context.jsonl') });
  assert.equal(JSON.stringify(bg).includes(snip), false);
});

test('预算读端不把 trimmed 当实际裁剪（只给计数与估算合计）', () => {
  const r = B.build({ 'context.jsonl': [JSON.stringify({ type: 'budget_gate', data: { trimmed: 999, gateInput: 30, source: 'calibrated' } })].join('\n') });
  assert.equal(r.trimmedTotal, 999, '原样累计估算，不做"已裁剪"推断');
  assert.equal(Object.keys(r).includes('actualTrimmed'), false, '不得杜撰实际裁剪字段');
});
