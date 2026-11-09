'use strict';
// 身份 claim 守门：接在 action-ledger 的 resolveIdentity 之前，挡住"同源自证"。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('./identity-claim-guard');
const AL = require('./action-ledger');

test('自证 claim 会被拒，独立指针才通过', () => {
  const ev = { world_id: 'w', server_session: 's', data: {} };
  assert.equal(G.judgeClaim(ev, { worldId: 'w', serverSession: 's', companion: 'c', evidence: 'envelope' }).ok, false);
  assert.equal(G.judgeClaim(ev, { worldId: 'w', serverSession: 's', companion: 'c', evidence: 'rdd.jsonl#taskchain_snapshot:42' }).ok, true);
});

test('接到账本：只让守门通过的 claim 生效，自证 claim 一律 UNKNOWN', () => {
  const line = (type, data) => JSON.stringify({ type, session: 'run-1', world_id: 'w', server_session: 's', data });
  const text = line('tool_call', { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1' }) + '\n'
    + line('tool_result', { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1', result: { success: true } });
  const selfClaim = (e) => ({ worldId: 'w', serverSession: 's', companion: 'c', evidence: 'envelope', callId: e.data.tool_call_id });
  const guarded = (e) => (G.judgeClaim(e, selfClaim(e)).ok ? selfClaim(e) : null);
  const lg = AL.build(text, '', { resolveIdentity: guarded });
  assert.equal(lg.summary.coverage.identityKnown, '0/2', '自证 claim 不得让身份变成已知');
});
