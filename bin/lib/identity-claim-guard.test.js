'use strict';
// 身份 claim：**结构检查 ≠ 独立性证明**。没有真正解析指针就一律 false。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('./identity-claim-guard');
const AL = require('./action-ledger');

const claim = { worldId: 'w', serverSession: 's', companion: 'c', evidence: 'rdd.jsonl#snapshot:42' };

test('伪造任意路径：解析不出来 → 不算独立', () => {
  assert.equal(G.verifyIndependent({ ...claim, evidence: 'whatever/I/like#999' }, () => null).independent, false);
});

test('同根不同路径：解析成功但来源同根 → 不算独立', () => {
  const resolve = () => ({ worldId: 'w', serverSession: 's', companion: 'c', derivedFrom: 'stamp' });
  assert.equal(G.verifyIndependent(claim, resolve).why, 'same-root');
});

test('目标不对应：解析到别的会话 → 不算独立', () => {
  const resolve = () => ({ worldId: 'w', serverSession: 'SESSION-X', companion: 'c' });
  assert.equal(G.verifyIndependent(claim, resolve).why, 'session-mismatch');
});

test('篡改数据：记录字段被改过 → 校验失败', () => {
  const resolve = () => ({ worldId: 'w2', serverSession: 's', companion: 'c' });
  assert.equal(G.verifyIndependent(claim, resolve).independent, false);
});

test('接到账本：未验证的 claim 不得让身份变已知', () => {
  const line = (type, data) => JSON.stringify({ type, session: 'run-1', world_id: 'w', server_session: 's', data });
  const text = line('tool_call', { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1' }) + '\n'
    + line('tool_result', { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1', result: { success: true } });
  const unverified = (e) => ({ worldId: 'w', serverSession: 's', companion: 'c', evidence: 'rdd.jsonl#x', callId: e.data.tool_call_id });
  const gated = (e) => (G.verifyIndependent(unverified(e), () => null).independent ? unverified(e) : null);
  const lg = AL.build(text, '', { resolveIdentity: gated });
  assert.equal(lg.summary.coverage.identityKnown, '0/2', '未经解析验证的 claim 不得算已知身份');
});
