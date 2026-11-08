'use strict';
// Offline runner consumer regression; never invokes the runner CLI or game.
// Run: node bin/exp-runner.test.js
const assert = require('assert');
const AL = require('./lib/action-ledger');
const { actionEvidence, blockerScopeKey } = require('./exp-runner');
const row = (type, data) => JSON.stringify({type, data:{companion_id:'c',session_id:'s',tool:'x',tool_call_id:'1',...data}});
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
