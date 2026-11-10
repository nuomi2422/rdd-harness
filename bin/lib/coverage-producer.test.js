'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildEvidence, STREAMS } = require('./coverage-producer');

const base = () => ({
  windowStartOffset: {}, offsets: {}, segments: {}, gaps: {}, pending: {}, fileId: {},
});
const fill = (r, per) => {
  for (const s of STREAMS) {
    const f = s + '.jsonl';
    r.windowStartOffset[f] = per.from;
    r.offsets[f] = per.to;
    r.segments[f] = [{ from: per.from, to: per.to, sha256: 'x' }];
    r.fileId[f] = 'ino-' + s;
  }
  return r;
};

test('干净 reader：gaps 全 0、窗口完整、七流齐全', () => {
  const r = fill(base(), { from: 100, to: 400 });
  const e = buildEvidence({ reader: r, bindings: { world_id: 'w', server_session: 's', companionId: 'c', requestId: 'q' },
    stimulusSentAt: 'T0', stopEnqueuedAt: 'T1' });
  assert.deepStrictEqual(Object.keys(e.segments).sort(), STREAMS.slice().sort());
  for (const s of STREAMS) assert.strictEqual(e.gaps[s], 0);
  assert.strictEqual(e.window.completeness, 'verified-for-observed-window');
  assert.deepStrictEqual(e.missing, []);
});

test('reader 记了缺口 → gaps 不为 0（不默认填 0）', () => {
  const r = fill(base(), { from: 100, to: 400 });
  r.gaps['tools.jsonl'] = { at: 'T', reason: 'truncated-or-rotated' };
  const e = buildEvidence({ reader: r, bindings: {}, stimulusSentAt: 'T0', stopEnqueuedAt: 'T1' });
  assert.ok(e.gaps.tools > 0);
  assert.notStrictEqual(e.lifecycle.fileIds.tools.start, e.lifecycle.fileIds.tools.end);
});

test('段不连续（跳字节）→ gaps 报 >0', () => {
  const r = fill(base(), { from: 100, to: 400 });
  r.segments['events.jsonl'] = [{ from: 100, to: 200 }, { from: 250, to: 400 }];
  const e = buildEvidence({ reader: r, bindings: {}, stimulusSentAt: 'T0', stopEnqueuedAt: 'T1' });
  assert.ok(e.gaps.events > 0);
  assert.strictEqual(e.segments.events.broken, 1);
});

test('残留半行 → halfLine 且 gaps > 0', () => {
  const r = fill(base(), { from: 0, to: 300 });
  r.pending['ai.jsonl'] = 'partial-line';
  const e = buildEvidence({ reader: r, bindings: {}, stimulusSentAt: 'T0', stopEnqueuedAt: 'T1' });
  assert.strictEqual(e.segments.ai.halfLine, true);
  assert.ok(e.gaps.ai > 0);
});

test('缺流不补 0：漏一条就 missing 且窗口不完整', () => {
  const r = fill(base(), { from: 0, to: 50 });
  delete r.windowStartOffset['expmem.jsonl'];
  const e = buildEvidence({ reader: r, bindings: {}, stimulusSentAt: 'T0', stopEnqueuedAt: 'T1' });
  assert.ok(e.missing.includes('expmem'));
  assert.strictEqual(e.window.completeness, 'partial');
  assert.strictEqual(e.gaps.expmem, undefined);
});
