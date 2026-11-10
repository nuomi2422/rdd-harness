'use strict';
/**
 * P1-A 红→绿反例（思考者 R-20261110-01，003 卡 680–686）。
 * 全部走真实 reader（临时目录七条 jsonl + createPull），不手写 evidence。
 * 旧实现：verify 被丢弃、fingerprintMatch 写死 true、fileId 缺省 String(undefined)、
 * replays 缺省 0 —— 读完后同长度改字节仍签 verified。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPull } = require('./monitor-reader');
const producer = require('./coverage-producer');
const coverage = require('./coverage');

const STREAMS = ['tools', 'context', 'events', 'ai', 'rdd', 'expmem', 'instrumentation'];
const BINDINGS = { world_id: 'w1', server_session: 's1', companionId: 'c1', requestId: 'r1' };

function makeDir(empty) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1a-'));
  for (const s of STREAMS) {
    const body = empty && empty.includes(s) ? '' : JSON.stringify({ a: 1 }) + '\n';
    fs.writeFileSync(path.join(dir, s + '.jsonl'), body, 'utf8');
  }
  return dir;
}

function readAll(dir) {
  const reader = createPull({ dir });
  for (const s of STREAMS) reader.pull(s + '.jsonl');
  return reader;
}

const build = (reader, verify) => producer.buildEvidence({
  reader, bindings: BINDINGS,
  stimulusSentAt: new Date().toISOString(), stopEnqueuedAt: new Date().toISOString(), verify,
});

test('P1-A-1 真实 reader 读完后同长度改字节 → verify 失败 → 必须拒签', () => {
  const dir = makeDir();
  const reader = readAll(dir);
  const p = path.join(dir, 'tools.jsonl');
  const buf = fs.readFileSync(p);
  buf[0] = buf[0] === 0x7b ? 0x5b : 0x7b;
  fs.writeFileSync(p, buf);

  const verify = reader.verifySegments();
  assert.equal(verify.ok, false, '真实 reader 必须发现同长度篡改');
  assert.equal(verify.files['tools.jsonl'].broken, 1);

  const evidence = build(reader, verify);
  assert.throws(() => coverage.makeVerifiedCoverage(evidence), /coverage-rejected/,
    '篡改后仍签名 = P1-A 未修');
});

test('P1-A-2 上层拿到 verify.ok=false 时必须拒签', () => {
  const dir = makeDir();
  const reader = readAll(dir);
  const evidence = build(reader, { ok: false, files: { 'tools.jsonl': { broken: 1 } } });
  assert.throws(() => coverage.makeVerifiedCoverage(evidence), /coverage-rejected/);
});

test('P1-A-3 缺 fileId 身份 → 不得用 String(undefined) 冒充', () => {
  const dir = makeDir();
  const reader = readAll(dir);
  reader.fileId = {};
  const evidence = build(reader, reader.verifySegments());
  assert.throws(() => coverage.makeVerifiedCoverage(evidence), /coverage-rejected/);
});

test('P1-A-4 重放未核（replays 未知）→ 不得按 0 通过', () => {
  const dir = makeDir();
  const reader = readAll(dir);
  delete reader.replays;
  const evidence = build(reader, reader.verifySegments());
  assert.throws(() => coverage.makeVerifiedCoverage(evidence), /coverage-rejected/);
});

test('P1-A-5 合法零字节流：有起止与文件身份 → 允许（正例保留）', () => {
  const dir = makeDir(['instrumentation', 'expmem']);
  const reader = readAll(dir);
  reader.replays = 0; // 已核且无重放（未知时 A-4 已要求拒签）
  const evidence = build(reader, reader.verifySegments());
  coverage.makeVerifiedCoverage(evidence);
  for (const s of ['instrumentation', 'expmem']) {
    assert.strictEqual(evidence.window.start[s], evidence.window.end[s], s + ' 应为空窗口');
    assert.notStrictEqual(String(evidence.lifecycle.fileIds[s].start), 'undefined', s + ' 需真实身份');
  }
});
