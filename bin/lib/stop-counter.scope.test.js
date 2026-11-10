'use strict';
/**
 * P1-B 反例（思考者 R-20261110-01）：stop-counter 的归属/去重/未知语义。
 * 旧实现只按 type+时间计数，双同伴/异世界/缺键/failed/重复都会串数。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStopCounter } = require('./stop-counter');

const SCOPE = { worldId: 'w1', serverSession: 's1', companionId: 'c1' };
const CORR = { stopSeq: 7 };
const CUT = '2026-11-10T12:00:00.000Z';
const AFTER = '2026-11-10T12:00:01.000Z';

function counter(lines, scope = SCOPE, corr = CORR) {
  let chunk = lines.join('\n');
  const pull = () => chunk;
  const c = createStopCounter(pull, CUT, scope, corr);
  c.collect();
  return c.snapshot();
}
const req = (over = {}) => JSON.stringify({
  type: 'llm_request', timestamp: AFTER,
  data: { requestId: 'r1', attemptId: 'a1', status: 'dispatched', stopSeq: 7, world_id: 'w1', server_session: 's1', companionId: 'c1', ...over },
});

test('同同伴/世界/会话的 1 条 → bound，count=1', () => {
  const s = counter([req()]);
  assert.equal(s.boundCount, 1);
  assert.equal(s.bound, true);
});

test('别的同伴 / 别的世界 / 别的会话 → 不计入，记 foreign', () => {
  const s = counter([req({ companionId: 'c2' }), req({ world_id: 'w2', requestId: 'r2' }), req({ server_session: 's2', requestId: 'r3' })]);
  assert.equal(s.boundCount, 0);
  assert.equal(s.foreign, 3);
  assert.equal(s.status, 'UNKNOWN');
});

test('缺身份 → 不计入，记 unbound；不得当 0 通过', () => {
  const s = counter([JSON.stringify({ type: 'llm_request', timestamp: AFTER, data: { requestId: 'r9' } })]);
  assert.equal(s.boundCount, 0);
  assert.equal(s.unbound, 1);
  assert.equal(s.status, 'UNKNOWN');
});

test('同一 requestId 多次 attempt 只算 1 条；重复回执不重复计数', () => {
  const s = counter([req({ attemptId: 'a1' }), req({ attemptId: 'a2' }), req({ attemptId: 'a1' })]);
  assert.equal(s.boundCount, 1);
});

test('failed 计入诊断，不计入已派发', () => {
  const s = counter([req({ status: 'failed' })]);
  assert.equal(s.boundCount, 0);
  assert.equal(s.failed, 1);
});

test('半行/非法 JSON → errors，且不冒充 0', () => {
  const s = counter(['{"type":"llm_request"', 'not-json']);
  assert.ok(s.errors.includes('invalid-json'));
  assert.equal(s.status, 'UNKNOWN');
});

test('scope 缺键 → bound=false、UNKNOWN（不能签 0）', () => {
  const s = counter([req()], { worldId: 'w1', companionId: 'c1' });
  assert.equal(s.bound, false);
  assert.equal(s.status, 'UNKNOWN');
});

test('缺 stop 回执关联 → 不归属、UNKNOWN；事件无 stopSeq 也不归属', () => {
  const s = counter([req()], SCOPE, {});
  assert.equal(s.bound, false);
  assert.equal(s.status, 'UNKNOWN');
  const s2 = counter([req({ stopSeq: undefined })]);
  assert.equal(s2.boundCount, 0);
  assert.equal(s2.status, 'UNKNOWN');
});

test('非 dispatched（failed/pending/缺 status）不计数', () => {
  for (const status of ['failed', 'pending', undefined]) {
    const s = counter([req({ status })]);
    assert.equal(s.boundCount, 0, 'status=' + status);
  }
});
