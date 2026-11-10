'use strict';
/**
 * P1-B（R-03 契约）反例：violationBound 与 cleanZeroVerifiable 分离。
 * 三条原红必须消失：缺身份不得签零、已归属违规不被坏行吞、仅 receiptAt 不得签权威。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createStopCounter } = require('./stop-counter');

const SCOPE = { worldId: 'w1', serverSession: 's1', companionId: 'c1' };
const CMD = { commandCorrelationId: 'cmd-1' };
const CUT = '2026-11-10T12:00:00.000Z';
const AFTER = '2026-11-10T12:00:01.000Z';

function counter(lines, scope = SCOPE, corr = CMD) {
  const chunk = lines.join('\n');
  const c = createStopCounter(() => chunk, CUT, scope, corr);
  c.collect();
  return c.snapshot();
}
const req = (over = {}) => JSON.stringify({
  type: 'llm_request', timestamp: AFTER, world_id: 'w1', server_session: 's1',
  data: { requestId: 'r1', attempt: 1, status: 'dispatched', companionId: 'c1', ...over },
});

test('RED1 修复：缺 companion 的 dispatched → unbound=1 → cleanZeroVerifiable=false', () => {
  const s = counter([req({ companionId: undefined })]);
  assert.equal(s.unbound, 1);
  assert.equal(s.cleanZeroVerifiable, false);
  assert.equal(s.violationBound, false);
});

test('RED2 修复：已归属违规 + 坏 JSON → violationBound 仍为 true（不被吞）', () => {
  const s = counter([req(), 'not-json']);
  assert.equal(s.violationCount, 1);
  assert.equal(s.violationBound, true);
  assert.equal(s.cleanZeroVerifiable, false);
});

test('RED3 修复：只有 receiptAt、无命令关联 → 不得签 cleanZero', () => {
  const s = counter([], SCOPE, { receiptAt: CUT });
  assert.equal(s.cleanZeroVerifiable, false);
  assert.equal(s.violationBound, false);
});

test('EMPTY + 命令关联 + 身份齐全 → cleanZeroVerifiable=true', () => {
  const s = counter([]);
  assert.equal(s.violationCount, 0);
  assert.equal(s.cleanZeroVerifiable, true);
  assert.equal(s.status, 'NONE');
});

test('failed 后同 requestId 再 dispatched → 计违规', () => {
  const s = counter([req({ status: 'failed' }), req({ attempt: 2 })]);
  assert.equal(s.violationCount, 1);
});

test('foreign（身份明确属于别人）不挡 cleanZero', () => {
  const s = counter([req({ companionId: 'c2' })]);
  assert.equal(s.violationCount, 0);
  assert.equal(s.cleanZeroVerifiable, true);
});

test('缺 status → 不可签 cleanZero', () => {
  const s = counter([req({ status: undefined })]);
  assert.equal(s.cleanZeroVerifiable, false);
});

test('scope 缺键 → 不可签 cleanZero', () => {
  const s = counter([req()], { worldId: 'w1', companionId: 'c1' });
  assert.equal(s.cleanZeroVerifiable, false);
});

test('同 requestId 不同 attempt 各算；同 attempt 重复只算一次', () => {
  const s = counter([req({ attempt: 1 }), req({ attempt: 2 }), req({ attempt: 1 })]);
  assert.equal(s.violationCount, 2);
});
