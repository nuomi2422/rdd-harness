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
