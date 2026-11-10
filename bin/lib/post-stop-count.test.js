'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { countContextRequestsSince } = require('./post-stop-count');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'poststop-')); }
function line(ts, type = 'llm_request') { return JSON.stringify({ timestamp: ts, type }); }

test('counts current and rotated context files independently', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'context.jsonl'), [line('2026-11-10T01:00:00Z'), line('2026-11-10T01:10:00Z')].join('\n'));
  fs.writeFileSync(path.join(d, 'context-1.jsonl'), [line('2026-11-10T01:11:00Z'), line('2026-11-10T01:11:30Z', 'other')].join('\n'));
  assert.equal(countContextRequestsSince(d, '2026-11-10T01:05:00Z'), 2);
  assert.equal(countContextRequestsSince(d, '2026-11-10T01:20:00Z'), 0);
});

test('overlapping/duplicate raw lines are counted, not silently deduped', () => {
  const d = tmp();
  const same = line('2026-11-10T01:10:00Z');
  fs.writeFileSync(path.join(d, 'context.jsonl'), same + '\n' + same + '\n');
  fs.writeFileSync(path.join(d, 'context-2.jsonl'), same + '\n');
  assert.equal(countContextRequestsSince(d, '2026-11-10T01:05:00Z'), 3);
});

test('malformed/truncated/future-clock lines: raw parser behaviour is explicit', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'context.jsonl'), [
    '{"type":"llm_request"',                                  // truncated
    '{"type":"llm_request","timestamp":}',                    // malformed timestamp
    line('2026-11-10T01:20:00Z'),                             // future clock
  ].join('\n'));
  assert.equal(countContextRequestsSince(d, '2026-11-10T01:05:00Z'), 1);
});

test('missing directory is zero only because caller asked a missing dir', () => {
  assert.equal(countContextRequestsSince(path.join(tmp(), 'none'), '2026-11-10T01:00:00Z'), 0);
});
