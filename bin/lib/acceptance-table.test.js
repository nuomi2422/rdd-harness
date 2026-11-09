'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AT = require('./acceptance-table');

const card = (over) => ({ finalRequest: { status: 'PRESENT', total: 2, delivered: '2/2' },
  settle: { status: 'PRESENT', coverage: { judged: '1/1' } }, ...(over || {}) });
const ev = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');

test('全部达标 → MATCH', (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-all-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'skills.jsonl'), JSON.stringify({ status: 'PUBLISHED', bodyRef: 'skill-body:a.md' }) + '\n');
  fs.mkdirSync(path.join(dir, 'skill-bodies'));
  fs.writeFileSync(path.join(dir, 'skill-bodies', 'a.md'), 'b');
  const res = AT.build(card(), {
    events: ev([{ type: 'knowledge_gap', data: { reason: 'body-missing' } }, { type: 'side_context', data: { status: 'UNKNOWN' } },
      { type: 'runtime_state', data: { context: '<entry ref="skill:s1">' } }]),
    rdd: '',
  }, { configDir: dir });
  assert.equal(res.overall, 'MATCH');
});

test('why 未全覆盖 → MISMATCH', () => {
  const res = AT.build(card({ finalRequest: { status: 'PARTIAL', total: 2, delivered: '1/2' } }), { events: '', rdd: '' });
  assert.equal(res.overall, 'MISMATCH');
  assert.equal(res.rows.find((r) => r.id === 'R1').verdict, 'MISMATCH');
});

test('缺数据 → UNKNOWN，不算通过', () => {
  const res = AT.build({ finalRequest: { status: 'UNKNOWN' }, settle: { status: 'UNKNOWN' } }, { events: '', rdd: '' });
  assert.equal(res.overall, 'UNKNOWN');
});

test('SIDE_CONTEXT 声称身份已验证 → MISMATCH', () => {
  const res = AT.build(card(), {
    events: ev([{ type: 'knowledge_gap', data: { reason: 'read-failed' } }, { type: 'side_context', data: { identityVerified: true } }]),
    rdd: '',
  });
  assert.equal(res.rows.find((r) => r.id === 'R4').verdict, 'MISMATCH');
});

test('knowledge_gap 形状不全 → MISMATCH', () => {
  const res = AT.build(card(), { events: ev([{ type: 'knowledge_gap', data: {} }]), rdd: '' });
  assert.equal(res.rows.find((r) => r.id === 'R3').verdict, 'MISMATCH');
});
// ---- R5 skills 检索（口径对齐 scripts/verify-skills-retrieval.js） ----
const fs = require('fs');
const os = require('os');
const path = require('path');
function skillsFixture(rows, contexts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-'));
  fs.writeFileSync(path.join(dir, 'skills.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.mkdirSync(path.join(dir, 'skill-bodies'));
  for (const r of rows) if (r.makeBody) fs.writeFileSync(path.join(dir, 'skill-bodies', r.makeBody), 'body');
  const ev = contexts.map((c) => JSON.stringify({ type: 'runtime_state', data: { context: c } })).join('\n');
  return { dir, streams: { events: ev, rdd: '' } };
}

test('R5：registry 不可读 → UNKNOWN', () => {
  const res = AT.build(card(), { events: '', rdd: '' }, { configDir: path.join(os.tmpdir(), 'nope-' + Date.now()) });
  assert.equal(res.rows.find((r) => r.id === 'R5').verdict, 'UNKNOWN');
});

test('R5：可检索但运行期 0 命中 → NOT_COVERED（0 不算通过）', (t2) => {
  const fx = skillsFixture([{ status: 'TRIAL', bodyRef: 'skill-body:a.md', makeBody: 'a.md' }], []);
  t2.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const res = AT.build(card(), fx.streams, { configDir: fx.dir });
  assert.equal(res.rows.find((r) => r.id === 'R5').verdict, 'NOT_COVERED');
  assert.equal(res.overall, 'NOT_COVERED');
});

test('R5：命中且有正文 → MATCH；命中但正文全缺 → MISMATCH', (t2) => {
  const ok = skillsFixture([{ status: 'PUBLISHED', bodyRef: 'skill-body:a.md', makeBody: 'a.md' }], ['x <entry ref="skill:s1"> y']);
  t2.after(() => fs.rmSync(ok.dir, { recursive: true, force: true }));
  assert.equal(AT.build(card(), ok.streams, { configDir: ok.dir }).rows.find((r) => r.id === 'R5').verdict, 'MATCH');
  const bad = skillsFixture([{ status: 'TRIAL', bodyRef: 'draft:1' }], ['x <entry ref="skill:s1"> y']);
  t2.after(() => fs.rmSync(bad.dir, { recursive: true, force: true }));
  assert.equal(AT.build(card(), bad.streams, { configDir: bad.dir }).rows.find((r) => r.id === 'R5').verdict, 'MISMATCH');
});

test('R5：输出不含技能正文，只计数与指针', (t2) => {
  const fx = skillsFixture([{ status: 'PUBLISHED', bodyRef: 'skill-body:secret.md', makeBody: 'secret.md' }], ['SECRET-BODY <entry ref="skill:s1">']);
  t2.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const r5 = AT.build(card(), fx.streams, { configDir: fx.dir }).rows.find((r) => r.id === 'R5');
  assert.equal(JSON.stringify(r5).includes('SECRET-BODY'), false, '不得带上下文正文');
});
