'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectContextRequestsSince } = require('./post-stop-count');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'poststop-')); }
function line(ts, type = 'llm_request') { return JSON.stringify({ timestamp: ts, type }); }

test('counts current and rotated context files independently', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'context.jsonl'), [line('2026-11-10T01:00:00Z'), line('2026-11-10T01:10:00Z')].join('\n'));
  fs.writeFileSync(path.join(d, 'context-1.jsonl'), [line('2026-11-10T01:11:00Z'), line('2026-11-10T01:11:30Z', 'other')].join('\n'));
  assert.deepEqual(inspectContextRequestsSince(d, '2026-11-10T01:05:00Z').count, 2);
  assert.deepEqual(inspectContextRequestsSince(d, '2026-11-10T01:20:00Z').count, 0);
});

test('overlapping/duplicate raw lines are counted, not silently deduped', () => {
  const d = tmp();
  const same = line('2026-11-10T01:10:00Z');
  fs.writeFileSync(path.join(d, 'context.jsonl'), same + '\n' + same + '\n');
  fs.writeFileSync(path.join(d, 'context-2.jsonl'), same + '\n');
  const r = inspectContextRequestsSince(d, '2026-11-10T01:05:00Z');
  assert.equal(r.count, 3);
  assert.equal(r.rawCount, 3);
});

test('malformed/truncated/future-clock lines force UNKNOWN, not zero', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'context.jsonl'), [
    '{"type":"llm_request"',
    '{"type":"llm_request","timestamp":}',
    line('2026-11-10T01:20:00Z'),
  ].join('\n'));
  const r = inspectContextRequestsSince(d, '2026-11-10T01:05:00Z', Date.parse('2026-11-10T01:10:00Z'));
  assert.equal(r.count, null);
  assert.equal(r.status, 'UNKNOWN');
  assert.ok(r.reasons.length > 0);
});

test('missing directory is UNKNOWN, not a trusted zero', () => {
  const r = inspectContextRequestsSince(path.join(tmp(), 'none'), '2026-11-10T01:00:00Z');
  assert.equal(r.count, null);
  assert.equal(r.status, 'UNKNOWN');
  assert.ok(r.reasons.includes('missing-dir'));
});
