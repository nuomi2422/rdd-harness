'use strict';
// Offline runner consumer regression; never invokes the runner CLI or game.
// Run: node bin/exp-runner.test.js
const assert = require('assert');
const AL = require('./lib/action-ledger');
const { actionEvidence, blockerScopeKey } = require('./exp-runner');
const row = (type, data) => JSON.stringify({type, session:'run-1', data:{companion_id:'c',session_id:'s',tool:'x',tool_call_id:'1',...data}});
const call = row('tool_call', {});
const result = row('tool_result', {result:{success:true}});
const resolveIdentity = (ev, category) => ({worldId:'w',serverSession:'s',companion:'c',evidence:'offline-fixture',callId:ev.data.tool_call_id,taskId:ev.data.id});
const check = (text, events='') => actionEvidence(AL.build(text, events, {resolveIdentity}), text);
assert.equal(check(call+'\n'+result).status, 'PRESENT');
assert.equal(check('').status, 'UNKNOWN');
assert.equal(check(call).status, 'UNKNOWN');
assert.equal(check(call+'\n'+result+'\nbad').status, 'UNKNOWN');
const noIdentity = JSON.stringify({type:'tool_call',data:{tool:'x',tool_call_id:'1'}});
assert(actionEvidence(AL.build(noIdentity, ''), noIdentity).reasons.includes('identity-coverage-unknown-or-incomplete'));
const asyncResult = row('tool_result', {result:{success:true,data:{async:true,task_id:'t'}}});
assert(check(call+'\n'+asyncResult).reasons.includes('accepted-without-terminal'));
assert.equal(actionEvidence({summary:{calls:1,states:{completed:1}},blockers:[]},call).status,'UNKNOWN');
const base = {worldId:'w',session:'s',companion:'c',tool:'x'};
const keys = [blockerScopeKey(base),blockerScopeKey(base),blockerScopeKey({...base,session:'s2'}),blockerScopeKey({...base,companion:'c2'}),blockerScopeKey({...base,tool:'y'}),blockerScopeKey({...base,worldId:'w2'})];
assert.equal(new Set(keys).size,5);
assert.equal(blockerScopeKey({...base,worldId:''}, 'guessed-world'), JSON.stringify([null,'s','c','x']));
console.log('exp-runner offline consumer tests PASS');

// 2026-11-09：身份注入后，用**既有真实消费者** actionEvidence 做端到端断言。
// 消费者契约（exp-runner.js:43-44）：coverage.identityKnown 必须是 "N/N"（全知）才可能 PRESENT，
// 只要有一条 UNKNOWN 就整体 UNKNOWN —— 这比"抽几条看"严得多，测试就锚在这个契约上。
const envRow = (type, data, env) => JSON.stringify({ type, session: 'run-1', ...(env || {}), data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1', ...data } });

// 正例：全部可核验 → PRESENT
assert.equal(check(call + '\n' + result).status, 'PRESENT');

// 反例①：两条调用里有一条核验不出身份 → 覆盖率非 N/N → UNKNOWN
{
  const two = envRow('tool_call', { tool_call_id: '1' }) + '\n' + envRow('tool_result', { tool_call_id: '1', result: { success: true } })
    + '\n' + envRow('tool_call', { tool_call_id: '2' });
  const lg = AL.build(two, '', { resolveIdentity: (ev) => (ev.data.tool_call_id === '2' ? null : resolveIdentity(ev, 'tools')) });
  const ev = actionEvidence(lg, two);
  assert.equal(ev.status, 'UNKNOWN');
  assert.ok(ev.reasons.includes('identity-coverage-unknown-or-incomplete'), '理由应指向身份覆盖不足');
}

// 反例②：信封写旧世界 A、独立核验是 B（A 发起 / B 才 publish）→ 冲突 → 覆盖率 0/N → UNKNOWN
{
  const conflicted = envRow('tool_call', {}, { world_id: 'world-A', server_session: 'sess-A' }) + '\n'
    + envRow('tool_result', { result: { success: true } }, { world_id: 'world-A', server_session: 'sess-A' });
  const resolverB = (ev) => ({ worldId: 'world-B', serverSession: 'sess-B', companion: 'c', evidence: 'offline-fixture-B', callId: ev.data.tool_call_id });
  const lg = AL.build(conflicted, '', { resolveIdentity: resolverB });
  const ev = actionEvidence(lg, conflicted);
  assert.equal(ev.status, 'UNKNOWN');
  assert.ok(ev.reasons.includes('identity-coverage-unknown-or-incomplete'));
  assert.ok(!ev.states || !Object.keys(ev.states).some((k) => k === 'completed'), '冲突不得产出一个"已完成"结论');
}

// 反例③：同一 call_id 在两个世界各出现一次 → 不得合并成一条（作用域含 world）
{
  const two = envRow('tool_call', { tool_call_id: '9' }, { world_id: 'wA' }) + '\n' + envRow('tool_call', { tool_call_id: '9' }, { world_id: 'wB' });
  const lg = AL.build(two, '', { resolveIdentity: (ev) => ({ worldId: ev.world_id, serverSession: 's', companion: 'c', evidence: 'offline-fixture', callId: ev.data.tool_call_id }) });
  assert.equal(lg.summary.calls, 2, '跨世界的同一个 call_id 必须是两条');
}
console.log('身份注入消费端断言 PASS（正例 1 / 反例 3）');
