'use strict';
// 身份：**有限检查 + 接口假设**，不是证明。resolver 返回值同样可伪造，所以要求
// 事件绑定 + 来源标记 + 可信来源清单；任一缺失一律 UNKNOWN。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('./identity-claim-guard');
const AL = require('./action-ledger');

const claim = { worldId: 'w', serverSession: 's', companion: 'c', evidence: 'rdd.jsonl#snapshot:42' };
const OPTS = { eventKey: 'ev-1', trustedSources: ['rdd.jsonl'] };

test('resolver 返回伪造对象（无事件绑定）→ UNKNOWN', () => {
  assert.equal(G.verifyIndependent(claim, () => ({ worldId: 'w', serverSession: 's', companion: 'c' }), OPTS).independent, false);
});

test('缺 provenance（来源标记）→ UNKNOWN', () => {
  const r = G.verifyIndependent(claim, () => ({ eventKey: 'ev-1', worldId: 'w', serverSession: 's', companion: 'c' }), OPTS);
  assert.equal(r.why, 'missing-provenance');
});

test('同根但未标注：来源不在可信清单 → UNKNOWN', () => {
  const r = G.verifyIndependent(claim, () => ({ eventKey: 'ev-1', provenance: 'stamp', worldId: 'w', serverSession: 's', companion: 'c' }), OPTS);
  assert.equal(r.why, 'untrusted-provenance');
});

test('指针指到别的事件但字段全同 → UNKNOWN', () => {
  const r = G.verifyIndependent(claim, () => ({ eventKey: 'ev-OTHER', provenance: 'rdd.jsonl', worldId: 'w', serverSession: 's', companion: 'c' }), OPTS);
  assert.equal(r.why, 'pointer-to-other-or-unbound');
});

test('四项都满足才通过，且措辞标明是"有限检查内的通过"', () => {
  const ok = G.verifyIndependent(claim, () => ({ eventKey: 'ev-1', provenance: 'rdd.jsonl', worldId: 'w', serverSession: 's', companion: 'c' }), OPTS);
  assert.equal(ok.independent, true);
  assert.ok(ok.why.includes('assumptions'), '结论必须自称在假设内');
});

test('接到账本：未通过检查的 claim 不得让身份变已知', () => {
  const line = (type, data) => JSON.stringify({ type, session: 'run-1', world_id: 'w', server_session: 's', data });
  const text = line('tool_call', { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1' }) + '\n'
    + line('tool_result', { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1', result: { success: true } });
  const raw = (e) => ({ worldId: 'w', serverSession: 's', companion: 'c', evidence: 'rdd.jsonl#x', callId: e.data.tool_call_id });
  const gated = (e) => (G.verifyIndependent(raw(e), () => null, OPTS).independent ? raw(e) : null);
  const lg = AL.build(text, '', { resolveIdentity: gated });
  assert.equal(lg.summary.coverage.identityKnown, '0/2');
});
test('仅证明给定假设成立时 JS 链路算得对（不证明接线正确）', () => {
  const { actionEvidence } = require('../exp-runner');
  // 测试内自建的"独立来源"：显式 eventKey + provenance，仅用于证明接线可行，不代表生产存在。
  const SOURCE = { 'ev-1': { eventKey: 'ev-1', provenance: 'test-source/index', worldId: 'w', serverSession: 's', companion: 'c' } };
  const resolvePtr = (p) => SOURCE[p] || null;
  const line = (type, data) => JSON.stringify({ type, session: 'run-1', world_id: 'w', server_session: 's', data });
  const text = line('tool_call', { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1' }) + '\n'
    + line('tool_result', { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1', result: { success: true } });
  const resolver = (e) => {
    const claim = { worldId: 'w', serverSession: 's', companion: 'c', evidence: 'ev-1', callId: e.data.tool_call_id };
    return G.verifyIndependent(claim, resolvePtr, { eventKey: 'ev-1', trustedSources: ['test-source/index'] }).independent ? claim : null;
  };
  const lg = AL.build(text, '', { resolveIdentity: resolver });
  // 身份可判后，call 与 result 会被正确合并成 1 条（对比无身份时的 2 条拆分）
  assert.equal(lg.summary.coverage.identityKnown, '1/1', '接线齐全时身份应可判且能合并');
  assert.equal(lg.summary.calls, 1);
  const ev = actionEvidence(lg, text, null, { level: 'limited' });
  assert.equal(ev.status, 'UNKNOWN', '即使身份可判，覆盖等级 limited 仍应 UNKNOWN');
  assert.ok(ev.reasons.includes('coverage-limited'));
});