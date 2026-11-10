'use strict';
/**
 * R-03 第 5 点：真实 consumer 全链（reader → 回执/覆盖 → 观察器 → 唯一组装 → judge）。
 * 不手填 coverageVerified/scopeVerified/60s/EFFECTIVE；身份/命令关联未接线处按 UNKNOWN 收口。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createPull } = require('./monitor-reader');
const producer = require('./coverage-producer');
const coverage = require('./coverage');
const { createStopCounter } = require('./stop-counter');
const { observeStopWindow } = require('./stop-observation');
const { buildStopEvidence } = require('./stop-evidence');

const JUDGE = path.join(__dirname, '..', 'exp-judge.js');
const STREAMS = ['tools', 'context', 'events', 'ai', 'rdd', 'expmem', 'instrumentation'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function writeStreams(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r03-chain-'));
  for (const s of STREAMS) {
    const lines = s === 'context'
      ? events
      : [JSON.stringify({ session: 'sess-1', category: s, event_seq: 100 + STREAMS.indexOf(s), type: 'x' })];
    fs.writeFileSync(path.join(dir, s + '.jsonl'), lines.join('\n') + '\n', 'utf8');
  }
  return dir;
}

const req = (over = {}) => JSON.stringify({
  session: 'sess-1', category: 'context', event_seq: 2, type: 'llm_request',
  timestamp: '2026-11-10T12:00:01.000Z', world_id: 'w1', server_session: 's1',
  data: { requestId: 'r1', attempt: 1, status: 'dispatched', companionId: 'uuid-1', ...over },
});

async function buildChain({ events, corr }) {
  const dir = writeStreams(events);
  const reader = createPull({ dir });
  for (const s of STREAMS) if (s !== 'context') reader.pull(s + '.jsonl');
  const scope = { worldId: 'w1', serverSession: 's1', companionId: 'uuid-1' };
  const counter = createStopCounter(reader.pull, '2026-11-10T12:00:00.000Z', scope, corr);
  counter.collect();
  const snap = counter.snapshot();
  const verify = reader.verifySegments();
  const bindings = { world_id: 'w1', server_session: 's1', companionId: 'uuid-1', requestId: 'q' };
  const evidence = producer.buildEvidence({
    reader, bindings, stimulusSentAt: '2026-11-10T12:00:01.000Z', stopEnqueuedAt: '2026-11-10T12:00:00.000Z', verify,
  });
  let coverageVerified = false;
  try { coverage.makeVerifiedCoverage(evidence); coverageVerified = true; } catch { coverageVerified = false; }
  const observation = await observeStopWindow({
    clock: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    cutoffMono: Date.now() - 1000, durationMs: 40, intervalMs: 10,
    collect: () => ({ ok: !reader.gaps['context.jsonl'] && !reader.pending['context.jsonl'] }),
  });
  const stop = buildStopEvidence({
    counterSnapshot: snap,
    observation,
    coverageVerified,
    // 身份/命令关联尚未接线 → 保持 false（不得手填 true）
    scopeVerified: false,
    observedGraceMs: observation.observedMs,
    javaExited: true,
    stopAt: '2026-11-10T12:00:00.000Z',
    stopEffectiveAt: null,
    stopScope: scope,
    postStopStatus: coverageVerified ? 'PRESENT' : 'UNKNOWN',
    postStopReasons: snap.errors,
    rawScanCount: snap.rawCount,
    saveConfirmed: null,
    ownerStop: null,
  });
  return { stop, snap, reader };
}

function runJudge(stop) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r03-judge-'));
  const contract = path.join(dir, 'contract.json');
  const cbuf = Buffer.from(JSON.stringify({ revision: 'R03' }));
  fs.writeFileSync(contract, cbuf);
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence', 'boot.log'), 'boot');
  const env = {
    phase: 'done', contract: { path: contract, sha256: sha(cbuf), revision: 'R03' },
    jarsAtPrepare: [{ file: 'numen-a.jar' }], jarsAtLaunch: [{ file: 'numen-a.jar' }],
    timings: { watchSeconds: 100 }, stop,
    a0: { version: 'a0-v1' }, session: { status: 'CLEAN', first_request_message_count: 1 },
    interventions: { status: 'NONE', count: 0 }, context_delivery: { status: 'PRESENT' },
  };
  fs.writeFileSync(path.join(dir, 'envelope.json'), JSON.stringify(env));
  spawnSync(process.execPath, [JUDGE, dir], { encoding: 'utf8' });
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8'));
  return (v.assertions || []).find((a) => a.id === 'S4') || { verdict: 'MISSING' };
}

test('真实链：无命令关联 → 不得 cleanZero → S4 NOT_COVERED', async () => {
  const { stop, snap } = await buildChain({ events: [req({ event_seq: 2 })], corr: {} });
  assert.equal(snap.cleanZeroVerifiable, false);
  assert.strictEqual(runJudge(stop).verdict, 'NOT_COVERED');
});

test('真实链：已归属违规 + 覆盖失败 → 仍 FAIL（不被坏行/覆盖掩盖）', async () => {
  const { stop, snap } = await buildChain({ events: [req({ event_seq: 2 }), 'not-json'], corr: { commandCorrelationId: 'cmd-1' } });
  assert.equal(snap.violationBound, true);
  assert.strictEqual(runJudge(stop).verdict, 'FAIL');
});

test('真实链：重放（同 session/category/seq）→ reader.replays=1 且覆盖拒签', async () => {
  const { reader, stop } = await buildChain({
    events: [
      req({ event_seq: 2 }),
      JSON.stringify({ session: 'sess-1', category: 'context', event_seq: 2, type: 'llm_request', timestamp: '2026-11-10T12:00:02.000Z', world_id: 'w1', server_session: 's1', data: { requestId: 'r2', attempt: 1, status: 'dispatched', companionId: 'uuid-1' } }),
    ],
    corr: {},
  });
  assert.equal(reader.replays, 1, '重放域必须计数');
  assert.strictEqual(runJudge(stop).verdict, 'NOT_COVERED');
});
