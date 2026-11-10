'use strict';
/**
 * P1-B（R-20261110-02 第 4/5 点）反例：
 *   - EMPTY 合法完整零必须 attributable；
 *   - failed 后同 requestId 再 dispatched 必须计违规；
 *   - 缺 status / 坏 JSON / 缺身份 → 不可签完整零。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStopCounter } = require('./stop-counter');

const SCOPE = { worldId: 'w1', serverSession: 's1', companionId: 'c1' };
const CORR = { receiptAt: '2026-11-10T12:00:00.000Z' };
const CUT = '2026-11-10T12:00:00.000Z';
const AFTER = '2026-11-10T12:00:01.000Z';

function counter(lines, scope = SCOPE, corr = CORR) {
  const chunk = lines.join('\n');
  const c = createStopCounter(() => chunk, CUT, scope, corr);
  c.collect();
  return c.snapshot();
}
const req = (over = {}) => JSON.stringify({
  type: 'llm_request', timestamp: AFTER, world_id: 'w1', server_session: 's1',
  data: { requestId: 'r1', attempt: 1, status: 'dispatched', companionId: 'c1', ...over },
});

test('同同伴/世界/会话 1 条 dispatched → 1 违规', () => {
  const s = counter([req()]);
  assert.equal(s.violationCount, 1);
  assert.equal(s.attributable, true);
  assert.equal(s.status, 'PRESENT');
});

test('EMPTY：无任何请求且窗口可归属 → attributable，status NONE（合法零）', () => {
  const s = counter([]);
  assert.equal(s.violationCount, 0);
  assert.equal(s.attributable, true);
  assert.equal(s.status, 'NONE');
  assert.equal(s.bound, false, '零请求不是 bound 违规');
});

test('failed 后同 requestId 再 dispatched → 必须计违规（不被吞）', () => {
  const s = counter([req({ status: 'failed' }), req({ attempt: 2 })]);
  assert.equal(s.violationCount, 1);
  assert.equal(s.failed, 1);
});

test('缺 status → 不可签完整零（UNKNOWN）', () => {
  const s = counter([req({ status: undefined })]);
  assert.equal(s.status, 'UNKNOWN');
  assert.equal(s.attributable, false);
  assert.ok(s.unknownStatus >= 1);
});

test('坏 JSON / 半行 → 不可签完整零', () => {
  const s = counter(['{"type":"llm_request"', 'not-json']);
  assert.equal(s.status, 'UNKNOWN');
  assert.ok(s.errors.includes('invalid-json'));
});

test('别的同伴/世界/会话 → foreign，不算违规', () => {
  const s = counter([req({ companionId: 'c2' }), req({ requestId: 'r2', companionId: 'c3' })]);
  assert.equal(s.violationCount, 0);
  assert.equal(s.foreign, 2);
  assert.equal(s.status, 'NONE');
});

test('缺身份（顶层与 data 都没有）→ unbound，不可签零', () => {
  const s = counter([JSON.stringify({ type: 'llm_request', timestamp: AFTER, data: { requestId: 'r9', status: 'dispatched' } })]);
  assert.equal(s.violationCount, 0);
  assert.equal(s.unbound, 1);
  assert.equal(s.status, 'NONE');
});

test('同一 requestId 不同 attempt 各算一条；同 attempt 重复只算一次', () => {
  const s = counter([req({ attempt: 1 }), req({ attempt: 2 }), req({ attempt: 1 })]);
  assert.equal(s.violationCount, 2);
});

test('无回执关联（无 receiptAt 也无 commandCorrelationId）→ UNKNOWN', () => {
  const s = counter([req()], SCOPE, {});
  assert.equal(s.attributable, false);
  assert.equal(s.status, 'UNKNOWN');
});

test('命令关联键不一致 → 不归属', () => {
  const s = counter([req({ command_correlation_id: 'other' })], SCOPE, { commandCorrelationId: 'cmd-1' });
  assert.equal(s.violationCount, 0);
});
