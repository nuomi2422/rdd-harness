'use strict';
/**
 * R-04 最小放行条件：
 *   1. 反查 dispatch 只作诊断，不能升 EFFECTIVE；
 *   2. 回执要同时匹配 command key + world/server；
 *   3. 保存/ownerStop 原值必须被 seam 保留（不被 null 覆盖）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { findStopCommand, scanOwnerStop, waitForStopEffective } = require('./stop-effective');
const { buildStopEvidence } = require('./stop-evidence');

const AI = (over = {}) => JSON.stringify({
  session: 'sess-1', category: 'ai', event_seq: 11, type: 'command_dispatch',
  timestamp: '2026-11-10T12:00:01.000Z',
  world_id: 'w1', server_session: 's1',
  data: { companion_id: 'uuid-1', command: 'stop', correlation_id: 'cmd-1', ...over },
});
const STOP = (over = {}, top = {}) => JSON.stringify({
  session: 'sess-1', category: 'ai', event_seq: 12, type: 'owner_stop',
  timestamp: '2026-11-10T12:00:02.000Z',
  world_id: 'w1', server_session: 's1', ...top,
  data: { companion_id: 'uuid-1', drained: 1, overflow_dropped: 0, command_correlation_id: 'cmd-1', ...over },
});

test('反查 dispatch 只标 diagnostic，不是本次调用凭据', () => {
  const hit = findStopCommand([AI()], 'uuid-1', '2026-11-10T12:00:00.000Z');
  assert.equal(hit.diagnostic, true);
  assert.equal(hit.correlationId, 'cmd-1');
});

test('没有本次入队 commandId：即便 dispatch/owner_stop 同键也不得 EFFECTIVE', async () => {
  let t = 0;
  const res = await waitForStopEffective({
    readText: () => AI() + '\n' + STOP(),
    companionId: 'uuid-1',
    enqueueAtIso: '2026-11-10T12:00:00.000Z',
    expectedCommandId: null,
    timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
  assert.strictEqual(res.effectiveAt, null);
});

test('回执 world/server 与 scope 不符 → 不接受', () => {
  const otherWorld = STOP({}, { world_id: 'w2' });
  assert.strictEqual(scanOwnerStop([otherWorld], 'uuid-1', '2026-11-10T12:00:00.000Z', 'cmd-1', { worldId: 'w1', serverSession: 's1' }), null);
  const otherServer = STOP({}, { server_session: 's2' });
  assert.strictEqual(scanOwnerStop([otherServer], 'uuid-1', '2026-11-10T12:00:00.000Z', 'cmd-1', { worldId: 'w1', serverSession: 's1' }), null);
  const ok = scanOwnerStop([STOP()], 'uuid-1', '2026-11-10T12:00:00.000Z', 'cmd-1', { worldId: 'w1', serverSession: 's1' });
  assert.strictEqual(ok.at, '2026-11-10T12:00:02.000Z');
});

test('seam 保留真实 saveConfirmed 与 ownerStop（不被 null 覆盖）', () => {
  const ownerStop = { ok: true, status: 0, out: 'enqueued' };
  const stop = buildStopEvidence({
    counterSnapshot: { violationCount: 0, violationBound: false, cleanZeroVerifiable: false, errors: [] },
    observation: null, coverageVerified: null, scopeVerified: null, observedGraceMs: null,
    javaExited: null, stopAt: 'T0', stopEffectiveAt: null, stopScope: null,
    postStopStatus: null, postStopReasons: [], rawScanCount: null,
    saveConfirmed: true, ownerStop,
  });
  assert.strictEqual(stop.saveConfirmed, true);
  assert.deepStrictEqual(stop.ownerStop, ownerStop);
});

test('最终组装：scope=null 绝不 true、原回执/保存保留、S4 仍 NOT_COVERED', () => {
  const fsx = require('fs');
  const osx = require('os');
  const pathx = require('path');
  const crypto = require('crypto');
  const { spawnSync } = require('child_process');
  const ownerStop = { ok: true, status: 0, out: 'enqueued' };
  const stop = buildStopEvidence({
    counterSnapshot: { violationCount: 0, violationBound: false, cleanZeroVerifiable: false, errors: [] },
    observation: { complete: true, observedMs: 60000 },
    coverageVerified: true,
    scopeVerified: null,
    observedGraceMs: 60000,
    javaExited: true,
    stopAt: 'T0', stopEffectiveAt: null, stopScope: null,
    postStopStatus: 'UNKNOWN', postStopReasons: ['scope-unverified-no-identity-interface'],
    rawScanCount: 0, saveConfirmed: true, ownerStop,
  });
  assert.strictEqual(stop.scopeVerified, null);
  assert.strictEqual(stop.saveConfirmed, true);
  assert.deepStrictEqual(stop.ownerStop, ownerStop);

  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'r05-final-'));
  const contract = pathx.join(dir, 'contract.json');
  const cbuf = Buffer.from(JSON.stringify({ revision: 'R05' }));
  fsx.writeFileSync(contract, cbuf);
  fsx.mkdirSync(pathx.join(dir, 'evidence'), { recursive: true });
  fsx.writeFileSync(pathx.join(dir, 'evidence', 'boot.log'), 'boot');
  const env = {
    phase: 'done',
    contract: { path: contract, sha256: crypto.createHash('sha256').update(cbuf).digest('hex'), revision: 'R05' },
    jarsAtPrepare: [{ file: 'numen-a.jar' }], jarsAtLaunch: [{ file: 'numen-a.jar' }],
    timings: { watchSeconds: 100 }, stop,
    a0: { version: 'a0-v1' }, session: { status: 'CLEAN', first_request_message_count: 1 },
    interventions: { status: 'NONE', count: 0 }, context_delivery: { status: 'PRESENT' },
  };
  fsx.writeFileSync(pathx.join(dir, 'envelope.json'), JSON.stringify(env));
  spawnSync(process.execPath, [pathx.join(__dirname, '..', 'exp-judge.js'), dir], { encoding: 'utf8' });
  const v = JSON.parse(fsx.readFileSync(pathx.join(dir, 'verdict.json'), 'utf8'));
  const s4 = (v.assertions || []).find((a) => a.id === 'S4') || {};
  assert.strictEqual(s4.verdict, 'NOT_COVERED');
});


// 051 (2026-11-12): real reader/receipt/effective/counter/coverage/assembler -> judge.
const fs051 = require('fs');
const os051 = require('os');
const path051 = require('path');
const { createPull } = require('./monitor-reader');
const { createStopCounter } = require('./stop-counter');
const { validateReceipt } = require('./stop-receipt');
const { observeStopWindow } = require('./stop-observation');
const coverage051 = require('./coverage');
const producer051 = require('./coverage-producer');
const ENQUEUE051 = '2026-11-12T00:00:00.000Z';
const EFFECT051 = '2026-11-12T00:00:01.000Z';
const RECEIPT051 = { delivery: 'SEEN', commandId: 'cmd-051', companionUuid: 'uuid-051',
  identityStatus: 'OK', worldId: 'world-051', serverSession: 'server-051', epoch: 0 };

async function chain051(o = {}) {
  const dir = fs051.mkdtempSync(path051.join(os051.tmpdir(), 'scope051-'));
  console.log('051 fixture: ' + dir);
  const receipt = JSON.parse(JSON.stringify({ ...RECEIPT051, ...o.receipt }));
  const accepted = validateReceipt(receipt, RECEIPT051.companionUuid).ok;
  const scope = { worldId: accepted ? receipt.worldId : null,
    serverSession: accepted ? receipt.serverSession : null,
    companionId: RECEIPT051.companionUuid, epoch: accepted ? receipt.epoch : null };
  const owner = { session: 'process-051', category: 'ai', event_seq: 1, event_id: 'owner-051',
    type: 'owner_stop', timestamp: EFFECT051, world_id: 'world-051', server_session: 'server-051', world_epoch: 0,
    ...o.ownerTop, data: { companion_id: 'uuid-051', command_correlation_id: 'cmd-051', drained: 1,
      overflow_dropped: 0, identity_status: 'OK', world_id: 'world-051', server_session: 'server-051', stamp_epoch: 0,
      ...o.ownerData } };
  const dispatch = { ...owner, event_seq: 2, type: 'command_dispatch',
    data: { companion_id: 'uuid-051', command: 'stop', correlation_id: 'cmd-051' } };
  for (const stream of coverage051.STREAMS) {
    if (stream === o.missingStream) continue;
    let text = '';
    if (stream === 'ai') text = (o.noEffect ? [dispatch] : [owner, dispatch]).map(JSON.stringify).join('\n') + '\n';
    if (stream === 'context') text = (o.requests || []).map((r, i) => JSON.stringify({
      session: 'process-051', category: 'context', event_seq: i + 10, type: 'llm_request',
      timestamp: '2026-11-12T00:00:02.000Z', world_id: 'world-051', server_session: 'server-051', world_epoch: 0,
      ...r.top, data: { companionId: 'uuid-051', requestId: 'request-' + i, attempt: 1,
        status: 'dispatched', stamp_epoch: 0, ...r.data },
    })).join('\n') + ((o.requests || []).length ? '\n' : '');
    if (stream === o.halfStream) text += '{"unfinished":';
    fs051.writeFileSync(path051.join(dir, stream + '.jsonl'), text);
  }
  let tick = 0;
  const effective = await waitForStopEffective({
    readText: () => fs051.readFileSync(path051.join(dir, 'ai.jsonl'), 'utf8'),
    companionId: RECEIPT051.companionUuid, enqueueAtIso: ENQUEUE051,
    expectedCommandId: accepted ? receipt.commandId : null, scope: accepted ? scope : null,
    timeoutMs: 1, pollMs: 1, now: () => tick, sleep: async ms => { tick += ms; },
  });
  const reader = createPull({ dir });
  const cutoff = effective.state === 'EFFECTIVE' ? effective.at : ENQUEUE051;
  const counter = createStopCounter(reader.pull, cutoff, scope, { commandCorrelationId: effective.commandCorrelationId });
  for (const s of coverage051.STREAMS) if (s !== 'context' && s !== 'ai') reader.pull(s + '.jsonl');
  let clock = 0;
  const observation = await observeStopWindow({ clock: () => clock, cutoffMono: 0,
    sleep: async ms => { clock += ms; }, durationMs: o.shortWindow ? 59999 : 60000, intervalMs: 5000,
    collect: () => { counter.collect(); return { ok: !reader.gaps['context.jsonl'] && !reader.gaps['ai.jsonl']
      && !reader.pending['context.jsonl'] && !reader.pending['ai.jsonl'] }; },
  });
  let coverage = null;
  try { coverage = coverage051.makeVerifiedCoverage(producer051.buildEvidence({ reader,
    bindings: { world_id: 'world-051', server_session: 'server-051', companionId: 'uuid-051', requestId: 'fixture-request' },
    stimulusSentAt: ENQUEUE051, stopEnqueuedAt: '2026-11-12T00:01:02.000Z', verify: reader.verifySegments(),
  })); } catch (e) { fs051.writeFileSync(path051.join(dir, 'coverage-error.txt'), e.message); }
  if (o.coverageOverride) coverage = o.coverageOverride(coverage);
  const input = { counterSnapshot: counter.snapshot(), observation, coverage, enqueueReceipt: receipt,
    selectedUuid: RECEIPT051.companionUuid, observedGraceMs: observation.observedMs,
    javaExited: true, saveConfirmed: true, ownerStop: { receipt }, stopAt: ENQUEUE051,
    stopEffectiveAt: effective.state === 'EFFECTIVE' ? effective.at : null,
    stopEffectiveReceipt: effective, stopScope: scope, rawScanCount: counter.snapshot().rawCount,
    postStopReasons: [], postStopStatus: 'UNKNOWN' };
  const stop = buildStopEvidence(input);
  const contract = path051.join(dir, 'contract.json');
  const contractBytes = JSON.stringify({ revision: 'COV-051' });
  fs051.writeFileSync(contract, contractBytes);
  fs051.mkdirSync(path051.join(dir, 'evidence'));
  fs051.writeFileSync(path051.join(dir, 'evidence', 'boot.log'), 'boot');
  fs051.writeFileSync(path051.join(dir, 'envelope.json'), JSON.stringify({ phase: 'done', stop,
    contract: { path: contract, revision: 'COV-051', sha256: require('crypto').createHash('sha256').update(contractBytes).digest('hex') },
    jarsAtPrepare: [{ file: 'fixture.jar' }], jarsAtLaunch: [{ file: 'fixture.jar' }],
    timings: { watchSeconds: 120 } }));
  fs051.writeFileSync(path051.join(dir, 'input.json'), JSON.stringify(input, null, 2));
  const r = require('child_process').spawnSync(process.execPath, [path051.join(__dirname, '..', 'exp-judge.js'), dir], { encoding: 'utf8' });
  fs051.writeFileSync(path051.join(dir, 'judge.stdout.txt'), r.stdout || '');
  fs051.writeFileSync(path051.join(dir, 'judge.stderr.txt'), r.stderr || '');
  assert.ifError(r.error);
  const verdict = JSON.parse(fs051.readFileSync(path051.join(dir, 'verdict.json'), 'utf8'));
  return { stop, input, s4: verdict.assertions.find(a => a.id === 'S4').verdict };
}

test('051 legitimate receipt + matching effect before dispatch + complete window reaches S4 PASS', async () => {
  const { stop, s4 } = await chain051();
  assert.strictEqual(stop.scopeVerified, true);
  assert.strictEqual(stop.cleanZeroVerified, true);
  assert.strictEqual(s4, 'PASS');
});
for (const [name, fixture] of [
  ['wrong world', { ownerTop: { world_id: 'other-world' } }],
  ['wrong companion', { ownerData: { companion_id: 'other-uuid' } }],
  ['old session', { ownerData: { server_session: 'old-server' }, ownerTop: { server_session: 'old-server' } }],
  ['wrong epoch', { ownerTop: { world_epoch: 1 }, ownerData: { stamp_epoch: 1 } }],
  ['missing epoch', { ownerTop: { world_epoch: undefined }, ownerData: { stamp_epoch: undefined } }],
  ['empty command', { receipt: { commandId: '' } }],
  ['wrong command', { ownerData: { command_correlation_id: 'old-command' } }],
  ['HANDED_OFF only', { receipt: { delivery: 'HANDED_OFF' } }],
  ['no owner_stop', { noEffect: true }],
  ['stamp conflict', { ownerTop: { stamp_conflict: true } }],
  ['short window', { shortWindow: true }],
  ['half line', { halfStream: 'context' }],
  ['missing stream', { missingStream: 'instrumentation' }],
  ['forged coverage', { coverageOverride: c => JSON.parse(JSON.stringify(c)) }],
  ['missing request epoch', { requests: [{ top: { world_epoch: undefined }, data: { stamp_epoch: undefined } }] }],
  ['conflicting request epoch', { requests: [{ data: { stamp_epoch: 1 } }] }],
]) test('051 ' + name + ' remains NOT_COVERED', async () => {
  const { stop, s4 } = await chain051(fixture);
  assert.notStrictEqual(stop.scopeVerified, true);
  assert.strictEqual(s4, 'NOT_COVERED');
});
test('051 bound violation still FAIL with missing stream', async () => {
  const { stop, s4 } = await chain051({ requests: [{}], missingStream: 'instrumentation' });
  assert.strictEqual(stop.violationBound, true);
  assert.strictEqual(s4, 'FAIL');
});
