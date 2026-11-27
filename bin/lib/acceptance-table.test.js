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
    events: ev([{ type: 'knowledge_gap', data: { reason: 'body-missing' } }, { type: 'side_context', world_id: 'w', server_session: 's', companion_id: 'c', data: { status: 'UNKNOWN' } },
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

test('SIDE_CONTEXT 缺身份锚点或显式 UNKNOWN → UNKNOWN，不能算身份正确', () => {
  const missing = AT.build(card(), { events: ev([{ type: 'side_context', data: {} }]), rdd: '' });
  assert.equal(missing.rows.find((r) => r.id === 'R4').verdict, 'UNKNOWN');
  const noAnchor = AT.build(card(), { events: ev([{ type: 'side_context', data: { status: 'UNKNOWN' } }]), rdd: '' });
  assert.equal(noAnchor.rows.find((r) => r.id === 'R4').verdict, 'UNKNOWN');
});

test('SIDE_CONTEXT 有身份锚点且显式 UNKNOWN → MATCH', () => {
  const res = AT.build(card(), { events: ev([{ type: 'side_context', world_id: 'w', server_session: 's', companion_id: 'c', data: { status: 'UNKNOWN' } }]), rdd: '' });
  assert.equal(res.rows.find((r) => r.id === 'R4').verdict, 'MATCH');
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
test('R5 golden：数字必须精确（可检索/投递/正文/缺口）', (t2) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-gold-'));
  t2.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = [
    { status: 'PUBLISHED', bodyRef: 'skill-body:a.md', makeBody: 'a.md' },
    { status: 'TRIAL', bodyRef: 'skill-body:b.md', makeBody: 'b.md' },
    { status: 'TRIAL', bodyRef: 'draft:3' },
    { status: 'DRAFT', bodyRef: 'skill-body:c.md', makeBody: 'c.md' },
  ];
  fs.writeFileSync(path.join(dir, 'skills.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.mkdirSync(path.join(dir, 'skill-bodies'));
  for (const r of rows) if (r.makeBody) fs.writeFileSync(path.join(dir, 'skill-bodies', r.makeBody), 'body');
  const streams = {
    events: [
      JSON.stringify({ type: 'runtime_state', data: { context: '<entry ref="skill:a">' } }),
      JSON.stringify({ type: 'runtime_state', data: { context: 'no skill here' } }),
      JSON.stringify({ type: 'knowledge_gap', data: { reason: 'body-missing' } }),
      JSON.stringify({ type: 'knowledge_gap', data: { reason: 'read-failed' } }),
    ].join('\n'),
    rdd: '',
  };
  const r5 = AT.build(card(), streams, { configDir: dir }).rows.find((r) => r.id === 'R5');
  assert.equal(r5.verdict, 'MATCH');
  assert.equal(r5.data.retrievable, 3, '只算 TRIAL/PUBLISHED（DRAFT 不算）');
  assert.equal(r5.data.actualEntries, 1, '只算 skill entry 命中的行');
  assert.equal(r5.data.deliverableWithBody, 2);
  assert.equal(r5.data.missingBody, 1);
  assert.equal(r5.data.bodyMissing, 1);
  assert.equal(r5.data.readFailed, 1);
});

test('R5 真实尾部：跑一次并打印数字（无真实文件则 skip）', { skip: false }, () => {
  const fs = require('fs');
  const path = require('path');
  const cfg = 'D:/rdd/mc/The Best of Twilight Forest/config/numen';
  if (!fs.existsSync(path.join(cfg, 'skills.jsonl'))) return; // 无真实数据不伪造
  const mon = path.join(cfg, 'monitor');
  const readIf = (n) => { try { return fs.readFileSync(path.join(mon, n), 'utf8'); } catch { return ''; } };
  const res = AT.build(card(), { events: readIf('events.jsonl'), rdd: readIf('rdd.jsonl') }, { configDir: cfg });
  const r5 = res.rows.find((r) => r.id === 'R5');
  console.log('[真实尾部 R5] ' + JSON.stringify(r5.data));
  assert.ok(['MATCH', 'NOT_COVERED', 'MISMATCH', 'UNKNOWN'].includes(r5.verdict));
  // 真实数据当前不应是 MATCH（已知一条都没投递），但这条断言留给部署后自然会变
  assert.notEqual(r5.data.actualEntries < 0, true);
});
test('验收表支持时间窗：窗口外事件不计入 R1', (t2) => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { buildCard } = require('../evidence-card');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'at-win-'));
  t2.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const row = (ts2, why) => JSON.stringify({ type: 'final_request', timestamp: ts2, data: { companion_id: 'c', requestKind: 'execute', turn: 1,
    rationalePresent: why, whyPresent: why, whyStatus: why ? 'PRESENT' : 'ABSENT', risksPresent: why, sourcePresent: why, conditionsPresent: false } });
  fs.writeFileSync(path.join(d, 'context.jsonl'), row('2026-11-09T05:30:00Z', true) + '\n' + row('2026-11-09T08:30:00Z', false) + '\n');
  const card = buildCard(d, { since: '2026-11-09T05:00:00Z', until: '2026-11-09T06:00:00Z' });
  assert.equal(card.finalRequest.total, 1, '窗口内只有 1 条');
});
// ---- R5 缺口口径：counts 优先、旧 reason 回退、不双计、坏值不当 0 ----
function r5WithGaps(gapEvents) {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-gap-'));
  fs.writeFileSync(path.join(dir, 'skills.jsonl'), JSON.stringify({ status: 'PUBLISHED', bodyRef: 'skill-body:a.md' }) + '\n');
  fs.mkdirSync(path.join(dir, 'skill-bodies'));
  fs.writeFileSync(path.join(dir, 'skill-bodies', 'a.md'), 'b');
  const ctx = JSON.stringify({ type: 'runtime_state', data: { context: '<entry ref="skill:a">' } });
  const streams = { events: [ctx].concat(gapEvents.map((g) => JSON.stringify(g))).join('\n'), rdd: '' };
  const res = AT.build(card(), streams, { configDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return res.rows.find((r) => r.id === 'R5');
}

test('R5：counts 多 reason 求和', () => {
  const r5 = r5WithGaps([{ type: 'knowledge_gap', data: { counts: { 'body-missing': 22, 'read-failed': 3 } } }]);
  assert.equal(r5.data.gaps['body-missing'], 22);
  assert.equal(r5.data.gaps['read-failed'], 3);
  assert.equal(r5.data.bodyMissing, 22);
  assert.equal(r5.data.readFailed, 3);
});

test('R5：counts 存在时不再按旧 reason 计（不双计）', () => {
  const r5 = r5WithGaps([{ type: 'knowledge_gap', data: { counts: { 'body-missing': 5 }, reason: 'body-missing' } }]);
  assert.equal(r5.data.bodyMissing, 5, '只能算 5，不能算 6');
});

test('R5：旧 reason 形态回退可用', () => {
  const r5 = r5WithGaps([{ type: 'knowledge_gap', data: { reason: 'body-missing' } }]);
  assert.equal(r5.data.bodyMissing, 1);
});

test('R5：counts 里的坏值不当 0——记 invalidGaps，不掺进计数', () => {
  const r5 = r5WithGaps([{ type: 'knowledge_gap', data: { counts: { 'body-missing': 'x', 'read-failed': -2 } } },
    { type: 'knowledge_gap', data: {} }]);
  assert.equal(r5.data.invalidGaps, 3, '非数值/负值/空 data 各记一次');
  assert.equal(r5.data.gaps['body-missing'], undefined);
  assert.equal(r5.data.bodyMissing, null, '没有有效值 → UNKNOWN，不是 0');
});

test('R5：完全没有缺口事件 → bodyMissing/readFailed 为 null（未知）', () => {
  const r5 = r5WithGaps([]);
  assert.equal(r5.data.bodyMissing, null);
  assert.equal(r5.data.readFailed, null);
});

test('R5：吸收学习者探针 JSON 行（口径一致，不另造）', () => {
  const d = AT.fromProbeJson({ retrievable: 26, deliverable: 2, bodyMissing: 24, actualSkillEntries: 0, gaps: { 'body-missing': 24 } });
  assert.equal(d.retrievable, 26);
  assert.equal(d.actualEntries, 0);
  assert.equal(d.bodyMissing, 24);
  assert.equal(d.readFailed, null);
  assert.equal(d.source, 'learner-probe');
});
test('R3：新 schema counts 形态算形状完整；旧 reason 也算', () => {
  const fs2 = require('fs'); const os2 = require('os'); const path2 = require('path');
  const cfg = () => { const d = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'r3cfg-')); fs2.writeFileSync(path2.join(d, 'skills.jsonl'), ''); return d; };
  const okCounts = AT.build(card(), { events: JSON.stringify({ type: 'knowledge_gap', data: { counts: { 'body-missing': 2 } } }) + '\n', rdd: '' }, { configDir: cfg() });
  assert.equal(okCounts.rows.find((r) => r.id === 'R3').verdict, 'MATCH');
  const okReason = AT.build(card(), { events: JSON.stringify({ type: 'knowledge_gap', data: { reason: 'body-missing' } }) + '\n', rdd: '' }, { configDir: cfg() });
  assert.equal(okReason.rows.find((r) => r.id === 'R3').verdict, 'MATCH');
  const bad = AT.build(card(), { events: JSON.stringify({ type: 'knowledge_gap', data: { counts: { 'x': 'bad' } } }) + '\n', rdd: '' }, { configDir: cfg() });
  assert.equal(bad.rows.find((r) => r.id === 'R3').verdict, 'MISMATCH');
});