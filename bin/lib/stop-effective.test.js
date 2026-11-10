'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scanOwnerStop, dispatchesBetween, waitForStopEffective } = require('./stop-effective');

const aiLine = (ts, drained, overflow = 0, cid = 'c1') => JSON.stringify({
  type: 'owner_stop', timestamp: ts,
  data: { companion_id: cid, was_busy: true, drained, overflow_dropped: overflow, command_correlation_id: 'cmd-1' },
});
const reqLine = (ts, id) => JSON.stringify({ type: 'llm_request', timestamp: ts, data: { requestId: id, status: 'dispatched' } });

test('找到同同伴的 owner_stop 回执（带 drained）', () => {
  const lines = [aiLine('2026-01-01T00:00:01Z', 1)];
  const hit = scanOwnerStop(lines, 'c1', '2026-01-01T00:00:00Z', 'cmd-1');
  assert.strictEqual(hit.at, '2026-01-01T00:00:01Z');
  assert.strictEqual(hit.drained, 1);
});

test('别的同伴/更早的回执不算', () => {
  const lines = [aiLine('2026-01-01T00:00:01Z', 1, 0, 'other'), aiLine('2025-12-31T23:59:59Z', 1)];
  assert.strictEqual(scanOwnerStop(lines, 'c1', '2026-01-01T00:00:00Z', 'cmd-1'), null);
});

test('没有 drained/overflow 字段的行不算回执', () => {
  const lines = [JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', data: { companion_id: 'c1' } })];
  assert.strictEqual(scanOwnerStop(lines, 'c1', '2026-01-01T00:00:00Z'), null);
});

test('enqueue→effective 之间的派发被单独数出来', () => {
  const lines = [
    reqLine('2026-01-01T00:00:00.5Z', 'r1'),
    reqLine('2026-01-01T00:00:01.6Z', 'r2'),
  ];
  const out = dispatchesBetween(lines, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z');
  assert.deepStrictEqual(out.map((x) => x.requestId), ['r1']);
});

test('等不到回执 → TIMEOUT，不是成功', async () => {
  let t = 0;
  const res = await waitForStopEffective({
    readText: () => aiLine('2026-01-01T00:00:01Z', 1).replace('owner_stop', 'other_type'),
    companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1', timeoutMs: 1000, pollMs: 100,
    sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
  assert.strictEqual(res.effectiveAt, null);
});

test('轮询到回执即返回 EFFECTIVE', async () => {
  let t = 0;
  const res = await waitForStopEffective({
    readText: () => aiLine('2026-01-01T00:00:01Z', 2, 1),
    companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1', timeoutMs: 1000, pollMs: 100,
    sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'EFFECTIVE');
  assert.strictEqual(res.drained, 2);
  assert.strictEqual(res.overflowDropped, 1);
});


test('缺 stamp_epoch 且 scope.epoch=0 → 不匹配（不为 Number(null)=0 放行）', async () => {
  let t = 0;
  const line = JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', world_id: 'w1', server_session: 's1',
    data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-1' } });
  const res = await waitForStopEffective({
    readText: () => line, companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1',
    scope: { worldId: 'w1', serverSession: 's1', epoch: 0 }, timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
});

test('top world_epoch 与 data stamp_epoch 不一致 → 拒绝', async () => {
  let t = 0;
  const line = JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', world_id: 'w1', server_session: 's1', world_epoch: 7,
    data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-1', stamp_epoch: 9 } });
  const res = await waitForStopEffective({
    readText: () => line, companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1',
    scope: { worldId: 'w1', serverSession: 's1', epoch: 7 }, timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
});

test('epoch 为字符串 → 拒绝（不 Number 强转）', async () => {
  let t = 0;
  const line = JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', world_id: 'w1', server_session: 's1', world_epoch: '7',
    data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-1' } });
  const res = await waitForStopEffective({
    readText: () => line, companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1',
    scope: { worldId: 'w1', serverSession: 's1', epoch: 7 }, timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
});

test('回执缺少/不匹配 command_correlation_id → 不算本次关联', () => {
  const noKey = [JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:01Z', data: { companion_id: 'c1', drained: 1 } })];
  assert.strictEqual(scanOwnerStop(noKey, 'c1', '2026-01-01T00:00:00Z', 'cmd-1'), null);
  const otherKey = [JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:01Z', data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-2' } })];
  assert.strictEqual(scanOwnerStop(otherKey, 'c1', '2026-01-01T00:00:00Z', 'cmd-1'), null);
});


test('stamp_conflict=true → 不接受', async () => {
  let t = 0;
  const line = JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', world_id: 'w1', server_session: 's1', stamp_conflict: true,
    data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-1' } });
  const res = await waitForStopEffective({
    readText: () => line, companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1',
    scope: { worldId: 'w1', serverSession: 's1' }, timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
});

test('top 与 data 的 world/session 不一致 → 不接受', async () => {
  let t = 0;
  const line = JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', world_id: 'w1', server_session: 's1',
    data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-1', world_id: 'w2' } });
  const res = await waitForStopEffective({
    readText: () => line, companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1',
    scope: { worldId: 'w1', serverSession: 's1' }, timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
});

test('scope 要求 epoch 但事件缺 epoch → 不接受', async () => {
  let t = 0;
  const line = JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', world_id: 'w1', server_session: 's1',
    data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-1' } });
  const res = await waitForStopEffective({
    readText: () => line, companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1',
    scope: { worldId: 'w1', serverSession: 's1', epoch: 7 }, timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
});

test('identity_status 非 OK → 不接受', async () => {
  let t = 0;
  const line = JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', world_id: 'w1', server_session: 's1', stamp_epoch: 7,
    data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-1', identity_status: 'NO_IDENTITY' } });
  const res = await waitForStopEffective({
    readText: () => line, companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1',
    scope: { worldId: 'w1', serverSession: 's1', epoch: 7 }, timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
});

test('owner_stop 先于 command_dispatch 出现也按 key 匹配（顺序不参与判定）', async () => {
  let t = 0;
  const stopLine = JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', world_id: 'w1', server_session: 's1',
    data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-1' } });
  const dispatchLine = JSON.stringify({ type: 'command_dispatch', timestamp: '2026-01-01T00:00:03Z', world_id: 'w1', server_session: 's1',
    data: { companion_id: 'c1', command: '/stop', correlation_id: 'cmd-1' } });
  const res = await waitForStopEffective({
    readText: () => stopLine + '\n' + dispatchLine,
    companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1',
    scope: { worldId: 'w1', serverSession: 's1' },
    timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'EFFECTIVE');
});

test('同 key 但 world/server 不符 → 不接受（他人调用）', async () => {
  let t = 0;
  const stopLine = JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', world_id: 'w2', server_session: 's2',
    data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-1' } });
  const res = await waitForStopEffective({
    readText: () => stopLine,
    companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1',
    scope: { worldId: 'w1', serverSession: 's1' },
    timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
});

test('epoch 不一致（换世界/重启）→ 不接受', async () => {
  let t = 0;
  const stopLine = JSON.stringify({ type: 'owner_stop', timestamp: '2026-01-01T00:00:02Z', world_id: 'w1', server_session: 's1', stamp_epoch: 9,
    data: { companion_id: 'c1', drained: 1, command_correlation_id: 'cmd-1' } });
  const res = await waitForStopEffective({
    readText: () => stopLine,
    companionId: 'c1', enqueueAtIso: '2026-01-01T00:00:00Z', expectedCommandId: 'cmd-1',
    scope: { worldId: 'w1', serverSession: 's1', epoch: 8 },
    timeoutMs: 50, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.strictEqual(res.state, 'TIMEOUT');
});

