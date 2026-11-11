'use strict';
// 真实 monitor 文件上的读端测试（不是夹具）：读取器 + 动作账本。无真实文件则 skip。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const MR = require('./monitor-reader');
const AL = require('./action-ledger');

const DIR = process.env.RDD_MONITOR || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
const has = fs.existsSync(path.join(DIR, 'tools.jsonl'));

test('真实读取器：首拉有数据、再拉不重复、窗口可判', { skip: has ? false : '无真实 monitor 文件' }, () => {
  const r = MR.createPull({ dir: DIR });
  const first = r.pull('tools.jsonl');
  assert.ok(typeof first === 'string' && first.length > 0, '首拉应有数据');
  // 2026-11-11: live writers may append between pulls. Verify the exact new byte
  // range instead of mistaking legitimate growth for a replay.
  const firstEnd = r.offsets['tools.jsonl'];
  const second = r.pull('tools.jsonl');
  const secondEnd = r.offsets['tools.jsonl'];
  const source = fs.readFileSync(path.join(DIR, 'tools.jsonl'));
  assert.equal(secondEnd - firstEnd, Buffer.byteLength(second), '偏移只推进新增完整字节');
  assert.equal(second, source.subarray(firstEnd, secondEnd).toString('utf8'), '再拉必须是原件新增字节，不重放前段');
  const w = r.verifyWindow(['tools.jsonl', 'events.jsonl']);
  assert.ok(w && typeof w.ok === 'boolean', '应能判窗口');
  assert.ok(w.files && Object.keys(w.files).length >= 1, '至少覆盖一个流');
});

test('真实动作账本：能出调用数与覆盖，且无解析器时身份为 0/N', { skip: has ? false : '无真实 monitor 文件' }, () => {
  const raw = fs.readFileSync(path.join(DIR, 'tools.jsonl'), 'utf8');
  const tail = raw.split(/\r?\n/).filter(Boolean).slice(-2000).join('\n');
  const lg = AL.build(tail, '');
  assert.ok(lg.summary.calls > 0, '应统计到调用');
  const known = String(lg.summary.coverage.identityKnown || '0/0');
  assert.ok(known.endsWith('/' + lg.summary.calls) || known !== '0/0', '覆盖分母应为调用数');
  assert.equal(known.split('/')[0], '0', '没有解析器时不应出现已知身份');
  assert.ok(lg.summary.states && typeof lg.summary.states === 'object', '应给终态分布');
});
test('真实摘要：sources 指针必须逐条能对回原行', { skip: has ? false : '无真实 monitor 文件' }, () => {
  const BD = require('./behavior-digest');
  const read = (n) => { try { return fs.readFileSync(path.join(DIR, n), 'utf8'); } catch { return ''; } };
  const files = { 'ai.jsonl': read('ai.jsonl'), 'tools.jsonl': read('tools.jsonl'), 'events.jsonl': read('events.jsonl'), 'rdd.jsonl': read('rdd.jsonl') };
  const res = BD.buildDigest({ ai: files['ai.jsonl'], tools: files['tools.jsonl'], events: files['events.jsonl'], rdd: files['rdd.jsonl'], sinceMs: 0, untilMs: Date.now() });
  if (!res.sources.length) return; // 窗口内没有说/做/果，跳过（不伪造）
  for (const s2 of res.sources) {
    const lines = files[s2.file].split(/\r?\n/);
    const row = JSON.parse(lines[s2.line - 1]);
    assert.equal(String(row.type), s2.type, '指针 ' + s2.file + ':' + s2.line + ' 必须指到同类型事件');
  }
});
test('真实时刻证据包：每条指针都要能对回同一行同一类型', { skip: has ? false : '无真实 monitor 文件' }, () => {
  const MPk = require('./moment-pack');
  const toolsText = fs.readFileSync(path.join(DIR, 'tools.jsonl'), 'utf8');
  const rows = toolsText.split(/\r?\n/).filter(Boolean);
  const last = rows[rows.length - 1];
  const ts = JSON.parse(last).timestamp;
  const res = MPk.pack({ 'tools.jsonl': toolsText }, ts, { spanSec: 5 });
  for (const r of res.rows) {
    const line = fs.readFileSync(path.join(DIR, r.file), 'utf8').split(/\r?\n/)[r.line - 1];
    const obj = JSON.parse(line);
    assert.equal(String(obj.type), r.type, r.file + ':' + r.line + ' 类型必须一致');
  }
});
