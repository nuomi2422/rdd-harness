'use strict';
// Offline runner consumer regression; never invokes the runner CLI or game.
// Run: node bin/exp-runner.test.js
const assert = require('assert');
const AL = require('./lib/action-ledger');
const { actionEvidence, blockerScopeKey } = require('./exp-runner');
const C = require('./lib/coverage');
const row = (type, data) => JSON.stringify({type, session:'run-1', data:{companion_id:'c',session_id:'s',tool:'x',tool_call_id:'1',...data}});
const call = row('tool_call', {});
const result = row('tool_result', {result:{success:true}});
const resolveIdentity = (ev, category) => ({worldId:'w',serverSession:'s',companion:'c',evidence:'offline-fixture',callId:ev.data.tool_call_id,taskId:ev.data.id});

// 2026-11-09：PRESENT 目前**不可达** —— verified 覆盖还没有合法签发路径（见 lib/coverage.js）。
// 所以这里用"除覆盖等级外没有其它问题"来表达正例，而不是伪造一个 verified 去拿 PRESENT。
const LIMITED = { level: 'limited', windowStart: 'test-window', anchorBytes: 64 };
const check = (text, events='') => actionEvidence(AL.build(text, events, {resolveIdentity}), text, null, LIMITED);

assert.deepEqual(check(call+'\n'+result).reasons, ['coverage-limited'], '除覆盖等级外不应有其它问题');
assert.ok(check('').reasons.includes('no-action-evidence'));
assert.ok(check(call).reasons.length > 0);
assert.ok(check(call+'\n'+result+'\nbad').reasons.includes('malformed-lines'), '坏行必须出理由');
const noIdentity = JSON.stringify({type:'tool_call',data:{tool:'x',tool_call_id:'1'}});
assert(actionEvidence(AL.build(noIdentity, ''), noIdentity, null, LIMITED).reasons.includes('identity-coverage-unknown-or-incomplete'));
const asyncResult = row('tool_result', {result:{success:true,data:{async:true,task_id:'t'}}});
assert(check(call+'\n'+asyncResult).reasons.includes('accepted-without-terminal'));
assert.equal(actionEvidence({summary:{calls:1,states:{completed:1}},blockers:[]},call).status,'UNKNOWN');
const base = {worldId:'w',session:'s',companion:'c',tool:'x'};
const keys = [blockerScopeKey(base),blockerScopeKey(base),blockerScopeKey({...base,session:'s2'}),blockerScopeKey({...base,companion:'c2'}),blockerScopeKey({...base,tool:'y'}),blockerScopeKey({...base,worldId:'w2'})];
assert.equal(new Set(keys).size,5);
assert.equal(blockerScopeKey({...base,worldId:''}, 'guessed-world'), JSON.stringify([null,'s','c','x']));
console.log('exp-runner offline consumer tests PASS');

// 身份注入后的端到端断言（仍用真实消费者 actionEvidence）。
const envRow = (type, data, env) => JSON.stringify({ type, session: 'run-1', ...(env || {}), data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1', ...data } });

// 反例①：两条调用里有一条核验不出身份 → 覆盖率非 N/N → UNKNOWN
{
  const two = envRow('tool_call', { tool_call_id: '1' }) + '\n' + envRow('tool_result', { tool_call_id: '1', result: { success: true } })
    + '\n' + envRow('tool_call', { tool_call_id: '2' });
  const lg = AL.build(two, '', { resolveIdentity: (ev) => (ev.data.tool_call_id === '2' ? null : resolveIdentity(ev, 'tools')) });
  const ev = actionEvidence(lg, two, null, LIMITED);
  assert.equal(ev.status, 'UNKNOWN');
  assert.ok(ev.reasons.includes('identity-coverage-unknown-or-incomplete'), '理由应指向身份覆盖不足');
}

// 反例②：信封写旧世界 A、独立核验是 B（A 发起 / B 才 publish）→ 冲突 → UNKNOWN，不得产出 completed
{
  const conflicted = envRow('tool_call', {}, { world_id: 'world-A', server_session: 'sess-A' }) + '\n'
    + envRow('tool_result', { result: { success: true } }, { world_id: 'world-A', server_session: 'sess-A' });
  const resolverB = (ev) => ({ worldId: 'world-B', serverSession: 'sess-B', companion: 'c', evidence: 'offline-fixture-B', callId: ev.data.tool_call_id });
  const lg = AL.build(conflicted, '', { resolveIdentity: resolverB });
  const ev = actionEvidence(lg, conflicted, null, LIMITED);
  assert.equal(ev.status, 'UNKNOWN');
  assert.ok(ev.reasons.includes('identity-coverage-unknown-or-incomplete'));
}

// 反例③：同一 call_id 在两个世界各一次 → 不得合并
{
  const two = envRow('tool_call', { tool_call_id: '9' }, { world_id: 'wA' }) + '\n' + envRow('tool_call', { tool_call_id: '9' }, { world_id: 'wB' });
  const lg = AL.build(two, '', { resolveIdentity: (ev) => ({ worldId: ev.world_id, serverSession: 's', companion: 'c', evidence: 'offline-fixture', callId: ev.data.tool_call_id }) });
  assert.equal(lg.summary.calls, 2, '跨世界的同一个 call_id 必须是两条');
}

// 覆盖等级：limited 不得 PRESENT；调用方伪造 verified 必须被拒；合法签发路径当前必须抛错。
{
  const text = row('tool_call', {}) + '\n' + row('tool_result', { result: { success: true } });
  const lg = AL.build(text, '', { resolveIdentity });
  const limitedEv = actionEvidence(lg, text, null, LIMITED);
  assert.equal(limitedEv.status, 'UNKNOWN', '有限监测不得给 PRESENT');
  assert.ok(limitedEv.reasons.includes('coverage-limited'));
  const forged = actionEvidence(lg, text, null, { level: 'verified', windowStart: 'w', anchorBytes: 64 });
  assert.equal(forged.status, 'UNKNOWN', '伪造 verified 必须被拒');
  assert.ok(forged.reasons.includes('coverage-limited'));
  assert.throws(() => C.makeVerifiedCoverage({}), /coverage-rejected/);
  assert.equal(C.isVerifiedCoverage({ level: 'verified' }), false);
  console.log('覆盖分级断言 PASS（limited→UNKNOWN / 伪造verified被拒 / 无合法签发路径）');
}
