'use strict';
// 最终请求 why 字段的读端判据：用真实 monitor 入口路径（context.jsonl 原文）驱动。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FR = require('./final-request-evidence');
const L = require('./bench-live');

const ev = (over) => JSON.stringify({ category: 'context', type: 'final_request', data: Object.assign({
  companion_id: 'c', requestKind: 'execute', turn: 1, rationalePresent: true, whyPresent: true,
  whyStatus: 'PRESENT', risksPresent: true, sourcePresent: true, conditionsPresent: false,
  rationaleSource: 'planner_tool:rdd_patch:x',
}, over || {}) });

test('真实入口：从 context.jsonl 读原样行 → 可判', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fre-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'context.jsonl');
  fs.writeFileSync(f, ev() + '\n' + ev({ whyPresent: false, whyStatus: 'ABSENT' }) + '\n');
  const r = L.readTail(f, 0, 1024 * 1024, {});
  const res = FR.build((r.lines || []).join('\n'));
  assert.equal(res.total, 2);
  assert.equal(res.status, 'PARTIAL', '一条有 why、一条没有 → PARTIAL');
  assert.equal(res.delivered, '1/2');
});

test('没有事件时是 UNKNOWN，不是"没有 why"', () => {
  const res = FR.build('');
  assert.equal(res.status, 'UNKNOWN');
  assert.ok(res.reasons.includes('no-final-request-events'));
});

test('坏行显式记录，不静默吞掉', () => {
  const res = FR.build('{bad json}\n' + ev());
  assert.ok(res.reasons.includes('malformed-lines'));
  assert.equal(res.total, 1);
});
test('可选代次：带 rationaleGeneration 时原样带出，缺省为 null', () => {
  const withGen = FR.build(JSON.stringify({ type: 'final_request', data: {
    companion_id: 'c', requestKind: 'execute', turn: 3, rationalePresent: true, whyPresent: true,
    whyStatus: 'PRESENT', risksPresent: true, sourcePresent: true, conditionsPresent: false,
    rationaleSource: 'planner_tool:rdd_patch:x', rationaleGeneration: 10 } }));
  assert.equal(withGen.events[0].rationaleGeneration, 10);
  const noGen = FR.build(JSON.stringify({ type: 'final_request', data: {
    companion_id: 'c', requestKind: 'execute', turn: 3, rationalePresent: true, whyPresent: true,
    whyStatus: 'PRESENT', risksPresent: true, sourcePresent: true, conditionsPresent: false,
    rationaleSource: 'x' } }));
  assert.equal(noGen.events[0].rationaleGeneration, null);
});
test('代次顺序：执行请求用旧代次必须被判 STALE', () => {
  const mk = (kind, gen) => ({ index: 0, requestKind: kind, rationaleGeneration: gen });
  const ok = FR.checkGenerationOrder([{ ...mk('plan', 9), index: 0 }, { ...mk('execute', 10), index: 1 }]);
  assert.equal(ok.status, 'PRESENT');
  const stale = FR.checkGenerationOrder([{ ...mk('plan', 10), index: 0 }, { ...mk('execute', 9), index: 1 }]);
  assert.equal(stale.status, 'STALE');
  assert.equal(stale.stale[0].execute, 9);
  assert.equal(stale.stale[0].plan, 10);
});
