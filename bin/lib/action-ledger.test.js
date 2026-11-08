'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build: rawBuild } = require('./action-ledger');
// Test-only resolver: synthetic fixture fields represent independently verified evidence.
const resolveIdentity = (ev, category) => {
  const d = ev.data || {};
  return { worldId: d.world_id || 'w', serverSession: d.session_id, companion: d.companion_id,
    evidence: 'fixture-proof', [category === 'tools' ? 'callId' : 'taskId']: category === 'tools' ? d.tool_call_id : d.id };
};
const build = (a, b) => rawBuild(a, b, { resolveIdentity });
const line = (type, id, companion, session, extra = {}) => JSON.stringify({ type, session: (extra && extra.__run) || 'run-1', data: { ...(type === 'task_finished' ? { id } : { tool_call_id: id, tool: 'goto' }), ...(companion ? { companion_id: companion } : {}), ...(session ? { session_id: session } : {}), ...extra } });
const call = (id, c='a', s='s') => line('tool_call', id, c, s);
const result = (id, c='a', s='s', p={success:true}) => line('tool_result', id, c, s, {result:p});
const done = (id, c='a', s='s', status='completed') => line('task_finished', id, c, s, {status});
const asyncResult = (id, c, s, task) => result(id,c,s,{success:true,data:{async:true,task_id:task}});
const join = (...x) => x.join('\n');

test('result before call and duplicate richer async receipt are order independent', () => {
  for (const rows of [[result('1'),asyncResult('1','a','s','t'),call('1')],[call('1'),asyncResult('1','a','s','t'),result('1')]]) {
    const r=build(join(...rows),done('t'));
    assert.equal(r.calls.length,1); assert.equal(r.calls[0].state,'completed');
    assert.equal(r.summary.duplicates.resultWithoutCall,0); assert.equal(r.summary.duplicates.results,1);
  }
});
test('same call and task IDs do not cross companion or session', () => {
  const r=build(join(call('1'),call('1','b','s'),call('1','a','s2'),asyncResult('1','a','s','t'),asyncResult('1','b','s','t'),asyncResult('1','a','s2','t')),join(done('t','a','s'),done('t','b','s','failed')));
  assert.equal(r.calls.length,3);
  assert.deepEqual(r.calls.map(c=>c.state).sort(),['accepted-no-terminal','completed','failed']);
});
test('missing identity never links even for legacy rows', () => {
  const r=build(join(line('tool_call','1'),line('tool_result','1',null,null,{result:{success:true,data:{async:true,task_id:'t'}}}),call('2')),done('t'));
  assert.equal(r.calls.filter(c=>c.state==='identity-unknown').length,2);
  assert.equal(r.calls.find(c=>c.callId==='2').state,'no-result');
  assert.equal(r.summary.duplicates.terminalWithoutCall,1);
});
test('unmatched results and ambiguous task IDs remain unknown', () => {
  const r=build(join(result('orphan'),call('1'),call('2'),asyncResult('1','a','s','t'),asyncResult('2','a','s','t')),done('t'));
  assert.equal(r.calls.find(c=>c.callId==='orphan').state,'no-call');
  assert.equal(r.summary.duplicates.resultWithoutCall,1);
  assert.equal(r.calls.filter(c=>c.state==='accepted-no-terminal').length,2);
  assert.equal(r.summary.duplicates.terminalWithoutCall,1);
});
test('conflicting evidence cannot produce a terminal success', () => {
  const r=build(join(call('1'),asyncResult('1','a','s','t'),result('1','a','s',{success:false})),done('t'));
  assert.equal(r.calls[0].state,'result-conflict');
  const x=build(join(call('2'),asyncResult('2','a','s','t')),join(done('t'),done('t','a','s','failed')));
  assert.equal(x.calls[0].state,'terminal-conflict');
});
test('real monitor process session is not a world identity', () => {
  const row = (category, type, data, session='process-1') => JSON.stringify({schema_version:1, source:'numen', category, type, session, data});
  const tools = join(row('tools','tool_result',{companion_id:'a',tool_call_id:'c',tool:'goto',result:JSON.stringify({success:true,data:{async:true,task_id:'t'}})}),row('tools','tool_call',{companion_id:'a',tool_call_id:'c',tool:'goto'}));
  const terminal = row('events','task_finished',{companion_id:'a',id:'t',status:'done'});
  const r = rawBuild(tools,terminal);
  assert.equal(r.calls.length,2); assert.ok(r.calls.every(c => c.state === 'identity-unknown'));
  assert.equal(r.summary.coverage.identityKnown,'0/2');
});
test('unverified session and missing identity report coverage gaps', () => {
  const r=rawBuild(JSON.stringify({type:'tool_call',session:'x',data:{tool_call_id:'c',companion_id:'a'}}),'');
  assert.equal(r.calls[0].state,'identity-unknown'); assert.equal(r.summary.coverage.identityUnknown,'1/1');
});
test('legacy malformed and missing-id rows remain observable', () => {
  const r=build(join('bad',line('tool_call',null),line('tool_result',null,null,null,{success:true})), '');
  assert.equal(r.parse.tools,1); assert.equal(r.summary.duplicates.callWithoutId,2);
  assert.equal(r.calls.length,2); assert.ok(r.calls.every(c=>c.state==='identity-unknown'));
});

test('world is part of every call, task and streak scope', () => {
  const w = (row, world) => { const o=JSON.parse(row); o.data.world_id=world; return JSON.stringify(o); };
  const r=build(join(w(call('1'),'w1'),w(asyncResult('1','a','s','t'),'w1'),w(call('1'),'w2'),w(asyncResult('1','a','s','t'),'w2')),w(done('t'),'w1'));
  assert.equal(r.calls.length,2);
  assert.equal(r.calls.find(c=>c.worldId==='w1').state,'completed');
  assert.equal(r.calls.find(c=>c.worldId==='w2').state,'accepted-no-terminal');
});
test('untrusted fields alone and invalid or conflicting injection never establish identity', () => {
  const rows=join(call('1'),result('1'));
  assert.ok(rawBuild(rows,'').calls.every(c=>c.state==='identity-unknown'));
  for (const resolver of [() => {throw Error('no evidence');}, () => ({worldId:'w',serverSession:'s',companion:'a',callId:'1'}), () => ({worldId:'w',serverSession:'s',companion:'wrong',callId:'1',evidence:'proof'}), () => ({worldId:'w',serverSession:'s',companion:'a',callId:'other',evidence:'proof'})]) {
    assert.ok(rawBuild(rows,'',{resolveIdentity:resolver}).calls.every(c=>c.state==='identity-unknown'));
  }
});
test('async terminal requires its own independently verified full scope', () => {
  const rows=join(call('1'),asyncResult('1','a','s','t'));
  const partial=(ev,category)=> category==='events' ? {worldId:'w',serverSession:'s',companion:'a',taskId:'t'} : resolveIdentity(ev,category);
  assert.equal(rawBuild(rows,done('t'),{resolveIdentity:partial}).calls[0].state,'accepted-no-terminal');
  assert.equal(rawBuild(rows,done('t'),{resolveIdentity}).calls[0].state,'completed');
  assert.equal(rawBuild(rows,done('t','a','other'),{resolveIdentity}).calls[0].state,'accepted-no-terminal');
});

 test('unknown outcomes and malformed input cannot establish consecutive failures', () => {
 const rows=join(call('1'),result('1','a','s',{success:false}),call('2'),result('2','a','s',{success:false}),call('3'),call('4'),result('4','a','s',{success:false}));
 assert.equal(build(rows,'').blockers.length,0);
 const failed=join(call('1'),result('1','a','s',{success:false}),call('2'),result('2','a','s',{success:false}),call('3'),result('3','a','s',{success:false}));
 assert.equal(build(failed,'').blockers.length,1);
 assert.equal(build(failed+'\ninvalid','').blockers.length,0);
 });

// 2026-11-09：身份注入后，信封顶层可能带 world_id/server_session（由 WorldContextStamp 写）。
// 账本口径：**信封里的身份是约束、不是证明** —— 与独立核验冲突时必须落到 UNKNOWN，
// 这正是"A 发起、B 才 publish"被错标时该走的 fail-closed 路径。
const envLine = (type, id, c, s, env, extra = {}) => JSON.stringify({
  type, session: 'run-1', ...(env || {}), data: { ...(type === 'task_finished' ? { id } : { tool_call_id: id, tool: 'goto' }),
    ...(c ? { companion_id: c } : {}), ...(s ? { session_id: s } : {}), ...extra },
});

test('信封身份与独立核验一致时才算 KNOWN', () => {
  const rows = join(
    envLine('tool_call', '1', 'a', 's', { world_id: 'w', server_session: 's' }),
    envLine('tool_result', '1', 'a', 's', { world_id: 'w', server_session: 's' }, { result: { success: true } }));
  const r = build(rows, '');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].identityStatus, 'KNOWN');
  assert.equal(r.calls[0].state, 'completed');
});

test('信封身份与核验冲突（旧世界事件被打上新身份）→ UNKNOWN，不得按新身份归并', () => {
  // 事件在 A 世界产生（信封带 A），但独立核验拿到的是 B 身份 —— 典型的 A 发起 / B 才 publish。
  const rows = join(
    envLine('tool_call', '1', 'a', 's', { world_id: 'world-A', server_session: 'sess-A' }, { world_id: 'world-A', session_id: 'sess-A' }),
    envLine('tool_result', '1', 'a', 's', { world_id: 'world-A', server_session: 'sess-A' }, { result: { success: true } }));
  const resolverB = (ev, category) => {
    const d = ev.data || {};
    return { worldId: 'world-B', serverSession: 'sess-B', companion: d.companion_id,
      evidence: 'fixture-proof-B', [category === 'tools' ? 'callId' : 'taskId']: d.tool_call_id };
  };
  const r = rawBuild(rows, '', { resolveIdentity: resolverB });
  assert.ok(r.calls.every((c) => c.state === 'identity-unknown'), '冲突时必须 UNKNOWN');
  assert.ok(r.calls.every((c) => c.worldId !== 'world-B'), '不得被标成新世界 B');
});

test('信封带身份但核验拒绝时仍为 UNKNOWN（信封不能单独当证明）', () => {
  const rows = join(
    envLine('tool_call', '1', 'a', 's', { world_id: 'w', server_session: 's' }),
    envLine('tool_result', '1', 'a', 's', { world_id: 'w', server_session: 's' }, { result: { success: true } }));
  const r = rawBuild(rows, '', { resolveIdentity: () => null });
  assert.ok(r.calls.every((c) => c.state === 'identity-unknown'));
});
