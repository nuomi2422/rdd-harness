'use strict';
// 生产者样例的端到端测试：证明"按契约算出来的证据"能被 makeVerifiedCoverage 合法签发，
// 破坏一个条件就必须被拒（样例不决定 verdict）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./coverage-producer-sample');
const C = require('./coverage');

const STREAMS = C.STREAMS;

function makeDir(streams) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-src-'));
  for (const s of streams) {
    const line = JSON.stringify({ type: 'x', event_id: s + '-1', timestamp: '2026-11-10T00:00:30Z' }) + '\n';
    fs.writeFileSync(path.join(dir, s + '.jsonl'), line);
  }
  return dir;
}

const bindings = { world_id: 'w', server_session: 's', companionId: 'c', requestId: 'r' };
const win = { stimulusSentAt: '2026-11-10T00:00:00Z', stopEnqueuedAt: '2026-11-10T00:01:00Z' };

test('正例：按游标算出的证据 → 合法签发 verified', () => {
  const dir = makeDir(STREAMS);
  const ev = P.buildEvidenceFromStreams({ dir, stimulusSentAt: win.stimulusSentAt, stopEnqueuedAt: win.stopEnqueuedAt, bindings });
  assert.deepEqual(ev.missing, []);
  const cov = C.makeVerifiedCoverage(ev);
  assert.equal(C.coverageLevel(cov), 'verified');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('半行：尾字节不是换行 → 签发被拒', () => {
  const dir = makeDir(STREAMS);
  fs.writeFileSync(path.join(dir, 'tools.jsonl'), '{"type":"x"}');  // 没有换行
  const ev = P.buildEvidenceFromStreams({ dir, stimulusSentAt: win.stimulusSentAt, stopEnqueuedAt: win.stopEnqueuedAt, bindings });
  assert.equal(ev.segments.tools.halfLine, true);
  assert.throws(() => C.makeVerifiedCoverage(ev), /半行未完成段/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺流：不补 0，签发被拒（流未消费）', () => {
  const dir = makeDir(STREAMS.filter((s) => s !== 'expmem'));
  const ev = P.buildEvidenceFromStreams({ dir, stimulusSentAt: win.stimulusSentAt, stopEnqueuedAt: win.stopEnqueuedAt, bindings });
  assert.deepEqual(ev.missing, ['expmem']);
  assert.equal(ev.window.completeness, 'partial');
  assert.throws(() => C.makeVerifiedCoverage(ev), /流未消费|gaps 未声明/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重放：同一 event_id 出现两次 → 签发被拒', () => {
  const dir = makeDir(STREAMS);
  const line = JSON.stringify({ type: 'x', event_id: 'dup-1' }) + '\n';
  fs.writeFileSync(path.join(dir, 'events.jsonl'), line + line);
  const ev = P.buildEvidenceFromStreams({ dir, stimulusSentAt: win.stimulusSentAt, stopEnqueuedAt: win.stopEnqueuedAt, bindings });
  assert.equal(ev.lifecycle.replays, 1);
  assert.throws(() => C.makeVerifiedCoverage(ev), /重放/);
  fs.rmSync(dir, { recursive: true, force: true });
});