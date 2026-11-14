'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const P = require('./evidence-pack');
const T = n => '2026-11-11T10:00:' + String(n).padStart(2, '0') + 'Z';
function row(type, sec, over = {}, envelope = {}) {
  return { session: 'run', event_seq: sec + 1, timestamp: T(sec), type,
    data: { world_id: 'world', server_session: 'server', companion_id: 'c', chain_id: 'chain',
      chain_epoch: 1, request_id: 'req', ...over }, ...envelope };
}
const call = (sec = 1, over = {}, env = {}) => row('tool_call', sec, { tool_call_id: 'call', tool: 'goto', args: { x: 4 }, ...over }, env);
const receipt = (sec = 2, over = {}, env = {}) => row('tool_result', sec, { tool_call_id: 'call', tool: 'goto',
  result: JSON.stringify({ success: true, data: { async: true, task_id: 'task' } }), ...over }, env);
const terminal = (sec = 8, over = {}, env = {}) => row('task_finished', sec, { id: 'task', task: 'goto', status: 'done', request_id: 'later-request', ...over }, env);
const texts = (tools = [], events = [], context = [], rdd = []) => Object.fromEntries(
  ['tools.jsonl','events.jsonl','context.jsonl','rdd.jsonl'].map((f,i) => [f, [tools,events,context,rdd][i].map(JSON.stringify).join('\n') + '\n']));
// Synthetic independent-binding adapter only. Production CLI deliberately installs none.
function fixtureIdentity(e, category) {
  const d = e.data;
  return { worldId: d.world_id, serverSession: d.server_session, companion: d.companion_id,
    evidence: 'fixture:independent-binding', [category === 'tools' ? 'callId' : 'taskId']: category === 'tools' ? d.tool_call_id : d.id };
}
const opt = extra => ({ eventRef: 'tools.jsonl:1', resolveIdentity: fixtureIdentity, ...extra });
test('verified fixture: call→receipt→cross-request terminal, final request and source references', () => {
  const t = texts([call(),receipt()], [terminal()], [row('final_request',0,{ body:'actual input' })]);
  const r = P.build(t, opt({ content: true }));
  assert.equal(r.action.state, 'completed');
  assert.deepEqual(r.stages.terminal, ['events.jsonl:1']);
  assert.deepEqual(r.stages.finalRequest, ['context.jsonl:1']);
  assert.ok(r.unknowns.includes('post:NOT_COLLECTED_OR_UNASSOCIATED'));
  assert.equal(r.status, 'PARTIAL');
  const request = r.rows.find(r => r.type === 'final_request');
  assert.equal(request.payload.value.body, 'actual input');
  assert.equal(request.line, 1); assert.ok(request.sha256.length === 64);
});
test('explicit transport model-call links request/response to the wire call by IDs', () => {
  const transport = row('tool_transport_binding', 0, { model_call_id: 'model-call', wire_call_id: 'call' });
  const request = row('llm_request', 0, { requestId: 'req1', request: { messages: [{ role: 'user', content: 'fixture' }] } });
  const response = row('llm_response', 1, { requestId: 'req1',
    response: { tool_calls: [{ id: 'model-call', name: 'goto' }] } });
  const t = texts([transport, call(1,{request_id:null}), receipt(2,{request_id:null})], [terminal()], [request, response]);
  const r = P.build(t, opt({ eventRef: 'tools.jsonl:2' }));
  assert.equal(r.action.state, 'completed');
  assert.deepEqual(r.stages.finalRequest, ['context.jsonl:1']);
  assert.deepEqual(r.stages.terminal, ['events.jsonl:1']);
  assert.equal(r.rows.filter(x => x.type === 'llm_response').length, 1);
  assert.ok(r.rows.some(x => x.type === 'llm_response' && x.ref === 'context.jsonl:2'));
  assert.ok(r.rows.some(x => x.type === 'tool_transport_binding' && x.ref === 'tools.jsonl:1'));
  assert.ok(!r.unknowns.includes('request-id-missing-or-ambiguous'));

  const wrong = row('llm_response', 1, { requestId: 'req1',
    response: { tool_calls: [{ id: 'other-model-call', name: 'goto' }] } });
  const miss = P.build(texts([transport, call(1,{request_id:null}), receipt(2,{request_id:null})], [terminal()], [request, wrong]), opt({ eventRef: 'tools.jsonl:2' }));
  assert.deepEqual(miss.stages.finalRequest, []);
  assert.ok(miss.unknowns.includes('request-id-missing-or-ambiguous'));
});
test('ambiguous model-call links are not resolved by picking one request', () => {
  const transport = row('tool_transport_binding', 0, { request_id: null, model_call_id: 'model-call', wire_call_id: 'call' });
  const requests = [row('llm_request', 0, { request_id: null, requestId: 'req1', request: { messages: [] } }),
    row('llm_request', 0, { request_id: null, requestId: 'req2', request: { messages: [] } })];
  const responses = [row('llm_response', 1, { request_id: null, requestId: 'req1', response: { tool_calls: [{ id: 'model-call' }] } }),
    row('llm_response', 2, { request_id: null, requestId: 'req2', response: { tool_calls: [{ id: 'model-call' }] } })];
  const r = P.build(texts([transport, call(1,{request_id:null}), receipt(2,{request_id:null})], [terminal()], [...requests, ...responses]), opt({ eventRef: 'tools.jsonl:2' }));
  assert.deepEqual(r.stages.finalRequest, []);
  assert.ok(r.unknowns.includes('request-id-missing-or-ambiguous'));
});
test('one wire with two model_call_id bindings is not joined by either', () => {
  const t1 = row('tool_transport_binding', 0, { request_id: null, model_call_id: 'model-a', wire_call_id: 'call' });
  const t2 = row('tool_transport_binding', 0, { request_id: null, model_call_id: 'model-b', wire_call_id: 'call' });
  const response = row('llm_response', 1, { request_id: null, requestId: 'req1', response: { tool_calls: [{ id: 'model-a' }] } });
  const r = P.build(texts([t1, t2, call(1,{request_id:null}), receipt(2,{request_id:null})], [terminal()], [response]), opt({ eventRef: 'tools.jsonl:3' }));
  assert.deepEqual(r.stages.finalRequest, []);
  assert.ok(r.unknowns.includes('model-call-binding-ambiguous'));
});
test('same model id in another world/server/companion/run does not cross scope', () => {
  const transport = row('tool_transport_binding', 0, { request_id: null, model_call_id: 'model-call', wire_call_id: 'call' });
  const rt = row('llm_request', 0, { request_id: null, requestId: 'req1', request: { messages: [] } });
  const rp = row('llm_response', 1, { request_id: null, requestId: 'req1', response: { tool_calls: [{ id: 'model-call' }] } });
  for (const [over, env] of [[{ world_id: 'other' }, {}], [{ server_session: 'other' }, {}],
    [{ companion_id: 'other' }, {}], [{}, { session: 'other' }]]) {
    const r = P.build(texts([transport, call(1,{request_id:null}), receipt(2,{request_id:null})], [terminal()],
      [row('llm_request', 0, { request_id: null, requestId: 'req1', request: { messages: [] }, ...over }, env),
        row('llm_response', 1, { request_id: null, requestId: 'req1', response: { tool_calls: [{ id: 'model-call' }] }, ...over }, env)]), opt({ eventRef: 'tools.jsonl:2' }));
    assert.deepEqual(r.stages.finalRequest, []);
  }
});
test('decision cutoff and late-ingested response cannot borrow a future response', () => {
  const transport = row('tool_transport_binding', 0, { request_id: null, model_call_id: 'model-call', wire_call_id: 'call' });
  const req = row('llm_request', 0, { request_id: null, requestId: 'req1', request: { messages: [] } });
  const response = (sec, env = {}) => row('llm_response', sec, { request_id: null, requestId: 'req1', response: { tool_calls: [{ id: 'model-call' }] } }, env);
  const tools = [transport, call(1,{request_id:null}), receipt(2,{request_id:null})];
  const future = P.build(texts(tools, [terminal(8)], [req, response(30)]), opt({ eventRef: 'tools.jsonl:2', view: 'decision', asOf: T(10) }));
  assert.deepEqual(future.stages.finalRequest, []);
  const late = P.build(texts(tools, [terminal(8)], [req, response(5, { ingestedAt: T(30) })]), opt({ eventRef: 'tools.jsonl:2', view: 'decision', asOf: T(10) }));
  assert.deepEqual(late.stages.finalRequest, []);
});
test('default production boundary: even complete claims are unverified and never joined', () => {
  const r = P.build(texts([call(),receipt()], [terminal()]), { eventRef:'tools.jsonl:1' });
  assert.equal(r.action.identityStatus,'UNKNOWN'); assert.equal(r.rows.length,1);
  assert.deepEqual(r.stages.terminal, []);
});
for (const [name,d,env] of [
  ['companion',{ companion_id:'other' },{}], ['world',{ world_id:'other' },{}],
  ['server',{ server_session:'other' },{}], ['run',{}, {session:'other'}],
  ['chain',{chain_id:'other'},{}], ['generation',{chain_epoch:2},{}],
]) test('same call/task IDs do not cross '+name, () => {
  const r=P.build(texts([call(),receipt(2,d,env)], [terminal(8,d,env)]),opt());
  assert.equal(r.action.state,'no-result'); assert.deepEqual(r.stages.terminal,[]);
});
test('missing world/server/run/companion never falls back to time or bare call ID', () => {
  for (const k of ['world_id','server_session','companion_id']) {
    const a=call(),b=receipt(); delete a.data[k]; delete b.data[k];
    const r=P.build(texts([a,b],[terminal()]),opt());
    assert.equal(r.action.identityStatus,'UNKNOWN'); assert.equal(r.rows.length,1);
  }
  const a=call(); delete a.session;
  assert.equal(P.build(texts([a,receipt()],[terminal()]),opt()).action.identityStatus,'UNKNOWN');
});
test('cutoff is applied before ledger calculation; T+10 cannot complete T+2', () => {
  const t=texts([call(),receipt()],[terminal()]);
  const r=P.build(t,opt({view:'decision',asOf:T(2)}));
  assert.equal(r.action.state,'accepted-no-terminal'); assert.deepEqual(r.stages.terminal,[]);
  assert.equal(r.rows.some(r=>r.type==='task_finished'),false);
  assert.equal(P.build(t,opt()).action.state,'completed');
  assert.equal(P.build(t,opt({view:'decision'})).status,'UNKNOWN');
});
test('late ingested terminal and ambiguous/conflicting clocks excluded from cutoff', () => {
  for (const env of [{ingestedAt:T(9)},{timestamp:'2026-11-11T10:00:01'}, {at:T(9)}]) {
    const r=P.build(texts([call(),receipt()],[terminal(1,{},env)]),opt({asOf:T(2)}));
    assert.equal(r.action.state,'accepted-no-terminal'); assert.deepEqual(r.stages.terminal,[]);
  }
});
test('missing terminal/duplicates/cancellation retain distinct states', () => {
  const t=texts([call(),receipt(),receipt(3)],[]);
  const a=P.build(t,opt()); assert.equal(a.action.state,'accepted-no-terminal'); assert.equal(a.action.duplicates,1);
  const b=P.build(texts([call(),receipt(),receipt(3)],[terminal(8,{status:'stopped'})]),opt());
  assert.equal(b.action.state,'cancelled'); assert.equal(b.action.duplicates,1);
});
test('conflicting terminal cannot become success; shared task ID is ambiguous', () => {
  const a=P.build(texts([call(),receipt()],[terminal(),terminal(9,{status:'failed'})]),opt());
  assert.equal(a.action.state,'terminal-conflict');
  const b=P.build(texts([call(),receipt(),call(3,{tool_call_id:'other'}),receipt(4,{tool_call_id:'other'})],[terminal()]),opt());
  assert.equal(b.action.state,'accepted-no-terminal');
  assert.deepEqual(b.stages.terminal,[]);
});
test('pagination binds filters/cutoff/source/content; appends and replacements reset cursor', () => {
  const t=texts([call(),receipt(),call(3,{tool_call_id:'other'})]);
  const options={mode:'list',limit:1};
  let r=P.build(t,options), refs=r.rows.map(r=>r.ref);
  while(r.nextCursor) {r=P.build(t,{...options,cursor:r.nextCursor}); refs.push(...r.rows.map(r=>r.ref));}
  assert.deepEqual(refs,['tools.jsonl:1','tools.jsonl:2','tools.jsonl:3']);
  const c=P.build(t,options).nextCursor;
  for(const o of [{asOf:T(1)},{content:true},{companion:'other'}]) assert.equal(P.build(t,{...options,...o,cursor:c}).status,'RESET');
  assert.equal(P.build({...t,'tools.jsonl':t['tools.jsonl']+'\n'}, {...options,cursor:c}).status,'RESET');
});
test('expand respects cutoff and never labels source neighbours as causal', () => {
  const r=P.build(texts([call(),receipt(),call(9)]),{mode:'expand',eventRef:'tools.jsonl:1',after:20,asOf:T(2)});
  assert.equal(r.rows.length,2); assert.match(r.relation,/no causal/);
  const hash=r.rows[0].sha256;
  assert.equal(P.build(texts([call(3)]),{eventRef:'tools.jsonl:1',eventHash:hash}).status,'UNKNOWN');
});
test('default omits content, opt-in redacts nested and stringified secrets; oversize payload explicit', () => {
  const e=call(1,{api_key:'private',args:{password:'private'},body:'Bearer private sk-testsecret',result:'{"api_key":"private"}'});
  const t=texts([e]);
  assert.equal(JSON.stringify(P.build(t,{mode:'list'})).includes('private'),false);
  assert.equal(JSON.stringify(P.build(t,{mode:'list',content:true})).includes('private'),false);
  const big=call(1,{body:'文'.repeat(3000)});
  const r=P.build(texts([big]),{mode:'list',content:true,maxBytes:2048});
  assert.equal(r.rows[0].payload.status,'TRUNCATED');
});
test('real reader: UTF-8 partial tail kept out, missing streams and byte offsets explicit', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-pack-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const first=JSON.stringify(call(1,{text:'村庄'}))+'\n';
  const partial=Buffer.from(JSON.stringify(receipt(2,{text:'床'}))+'\n');
  const cut=partial.indexOf(Buffer.from('床'))+1;
  fs.writeFileSync(path.join(dir,'tools.jsonl'),Buffer.concat([Buffer.from(first),partial.subarray(0,cut)]));
  let r=P.fromDir(dir,{mode:'list'});
  assert.equal(r.rows.length,1); assert.ok(r.gaps.some(g=>g.reason==='partial-tail-not-consumed'));
  assert.ok(r.gaps.some(g=>g.file==='events.jsonl'));
  fs.appendFileSync(path.join(dir,'tools.jsonl'),partial.subarray(cut));
  r=P.fromDir(dir,{mode:'list',content:true});
  assert.equal(r.rows.length,2); assert.equal(r.rows[1].byteOffset,Buffer.byteLength(first));
  assert.equal(r.rows[1].payload.value.text,'床');
});
test('bench evidence episode CLI is wired; old summary still available', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-cli-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const [f,v] of Object.entries(texts([call(),receipt()],[terminal()]))) fs.writeFileSync(path.join(dir,f),v);
  const run=args=>spawnSync(process.execPath,[path.join(__dirname,'../bench.js'),'evidence','--dir',dir,...args],{encoding:'utf8',windowsHide:true});
  const r=run(['--event','tools.jsonl:1','--json']);
  assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).action.identityStatus,'UNKNOWN');
  const old=run(['--json']); assert.equal(old.status,0,old.stderr); assert.ok(JSON.parse(old.stdout).actions);
});

const digest = s => require('crypto').createHash('sha256').update(s).digest('hex');
function rotationDir(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-rotation-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}
test('fromDir discovers selected stream rotations with physical CRLF/hash/UTF8 pointers, no identity upgrade', t => {
  const dir=rotationDir(t), a='context-1794438028809.jsonl', b='context-1794438585430.jsonl';
  const first=JSON.stringify(row('llm_request',0,{body:'村庄'}))+'\r\n';
  const second=JSON.stringify(row('llm_response',1,{body:'床'}))+'\r\n';
  fs.writeFileSync(path.join(dir,a),first+second);
  fs.writeFileSync(path.join(dir,b),JSON.stringify(row('llm_request',2))+'\n');
  fs.writeFileSync(path.join(dir,'context.jsonl'),JSON.stringify(row('llm_response',3))+'\n');
  fs.writeFileSync(path.join(dir,'context-backup.jsonl'),first);
  fs.mkdirSync(path.join(dir,'sub'));
  fs.writeFileSync(path.join(dir,'sub','context-1794438585431.jsonl'),first);
  const r=P.fromDir(dir,{mode:'list',streams:['context'],content:true});
  assert.equal(r.rows.length,4,'both archived sources must be read alongside the current stream');
  assert.deepEqual(Object.keys(r.sources).sort(),[a,b,'context.jsonl'].sort());
  const found=r.rows.find(r=>r.ref===a+':2');
  assert.equal(found.sourceFile,path.join(dir,a));
  assert.equal(found.line,2);
  assert.equal(found.byteOffset,Buffer.byteLength(first));
  assert.equal(found.sha256,digest(second.slice(0,-1)),'CR belongs to original line hash');
  assert.equal(r.sources[a].sha256,digest(first+second));
  assert.equal(found.identityStatus,'UNKNOWN');
  assert.equal(found.payload.value.body,'床');
  assert.equal(r.sourceCoverage.status,'OBSERVED_FILES_ONLY');
  assert.match(r.sourceCoverage.scope,/not session completeness/);
  assert.deepEqual(r.gaps,[]);
});
test('archived expand stays within one physical file and ledger sees logical streams only with independent adapter', t => {
  const dir=rotationDir(t), tf='tools-1794438028809.jsonl', ef='events-1794438028809.jsonl', cf='context-1794438028809.jsonl';
  fs.writeFileSync(path.join(dir,tf),[call(),receipt()].map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(path.join(dir,ef),JSON.stringify(terminal())+'\n');
  fs.writeFileSync(path.join(dir,cf),JSON.stringify(row('final_request',0,{body:'input'}))+'\n');
  const sources=[tf,ef,cf], opts={sources,eventRef:tf+':1'};
  const expanded=P.fromDir(dir,{...opts,mode:'expand',after:5});
  assert.deepEqual(expanded.rows.map(r=>r.ref),[tf+':1',tf+':2']);
  assert.match(expanded.relation,/no causal/);
  const unknown=P.fromDir(dir,opts);
  assert.equal(unknown.action.identityStatus,'UNKNOWN'); assert.equal(unknown.rows.length,1);
  const known=P.fromDir(dir,{...opts,resolveIdentity:fixtureIdentity});
  assert.equal(known.action.state,'completed');
  assert.deepEqual(known.stages.finalRequest,[cf+':1']);
  assert.deepEqual(known.stages.terminal,[ef+':1']);
});
test('file and byte budgets explicitly retain unread coverage; partial records never become rows', t => {
  const dir=rotationDir(t), a='context-1794438028809.jsonl';
  const first=JSON.stringify(row('llm_request',0))+'\n', next=JSON.stringify(row('llm_response',1))+'\n';
  fs.writeFileSync(path.join(dir,'context.jsonl'),first+next);
  fs.writeFileSync(path.join(dir,a),first);
  const limited=P.fromDir(dir,{mode:'list',streams:['context'],maxSourceFiles:1});
  assert.equal(limited.rows.length,2);
  assert.ok(limited.gaps.some(g=>g.file===a&&g.reason==='source-file-budget'));
  assert.equal(limited.sourceCoverage.status,'PARTIAL');
  const bytes=P.fromDir(dir,{mode:'list',streams:['context'],maxSourceBytes:Buffer.byteLength(first)+7});
  assert.equal(bytes.rows.length,1);
  assert.ok(bytes.gaps.some(g=>g.reason==='source-byte-budget'));
  assert.equal(bytes.sources['context.jsonl'].readStatus,'PARTIAL');
  assert.equal(bytes.sources['context.jsonl'].bytes,Buffer.byteLength(first));
  assert.equal(bytes.sourceCoverage.status,'PARTIAL');
});
test('physical manifest additions and replaced archives reset cursors; expansion binds original line hash', t => {
  const dir=rotationDir(t), a='context-1794438028809.jsonl';
  const original=JSON.stringify(row('llm_request',0))+'\n';
  fs.writeFileSync(path.join(dir,a),original);
  fs.writeFileSync(path.join(dir,'context.jsonl'),JSON.stringify(row('llm_response',1))+'\n');
  const opts={mode:'list',streams:['context'],limit:1};
  const first=P.fromDir(dir,opts);
  assert.ok(first.nextCursor);
  fs.writeFileSync(path.join(dir,'context-1794438585430.jsonl'),original);
  assert.equal(P.fromDir(dir,{...opts,cursor:first.nextCursor}).status,'RESET');
  const cursor=P.fromDir(dir,opts).nextCursor;
  fs.writeFileSync(path.join(dir,a),JSON.stringify(row('llm_request',2))+'\n');
  assert.equal(P.fromDir(dir,{...opts,cursor}).status,'RESET');
  assert.equal(P.fromDir(dir,{mode:'expand',streams:['context'],eventRef:a+':1',eventHash:digest(original.slice(0,-1))}).status,'UNKNOWN');
});
test('archive malformed line and unfinished tail remain explicit source gaps', t => {
  const dir=rotationDir(t), a='context-1794438028809.jsonl';
  fs.writeFileSync(path.join(dir,a),'{broken}\r\n'+JSON.stringify(row('llm_request',0))+'\r\n{"unfinished":');
  const r=P.fromDir(dir,{mode:'list',streams:['context'],sources:[a]});
  assert.equal(r.rows.length,1);
  assert.equal(r.rows[0].ref,a+':2');
  assert.equal(r.rows[0].byteOffset,Buffer.byteLength('{broken}\r\n'));
  assert.ok(r.gaps.some(g=>g.ref===a+':1'&&g.reason==='malformed-line'));
  assert.ok(r.gaps.some(g=>g.file===a&&g.reason==='partial-tail-not-consumed'));
  assert.equal(r.sourceCoverage.status,'PARTIAL');
});
test('source replacement during bounded read is diagnosed and changed bytes cannot produce references', t => {
  const dir=rotationDir(t), a='context-1794438028809.jsonl', file=path.join(dir,a);
  const original=JSON.stringify(row('llm_request',0))+'\n';
  fs.writeFileSync(file,original);
  const ino=fs.statSync(file).ino, saved=fs.readSync; let changed=false;
  fs.readSync=function(fd,buffer,offset,length,position) {
    const n=saved.call(fs,fd,buffer,offset,length,position);
    if(!changed&&length>64&&fs.fstatSync(fd).ino===ino) {
      changed=true; fs.writeFileSync(file,original.replace('llm_request','llm_changed'));
    }
    return n;
  };
  t.after(()=>{fs.readSync=saved;});
  const r=P.fromDir(dir,{mode:'list',streams:['context'],sources:[a]});
  assert.ok(changed);
  assert.equal(r.rows.length,0);
  assert.ok(r.gaps.some(g=>g.reason==='source-changed-during-read'));
  assert.equal(r.sourceCoverage.status,'PARTIAL');
});
test('CLI selects physical sources and rejects invalid names instead of reading paths or unrelated streams', t => {
  const dir=rotationDir(t), a='context-1794438028809.jsonl';
  fs.writeFileSync(path.join(dir,a),JSON.stringify(row('llm_request',0))+'\n');
  const r=P.cli(['--list','--streams','context','--source',a,'--dir',dir]);
  assert.equal(r.rows[0].ref,a+':1');
  assert.equal(P.fromDir(dir,{mode:'list',streams:['context'],sources:['../tools.jsonl']}).status,'UNKNOWN');
  assert.equal(P.fromDir(dir,{mode:'list',streams:['unlisted']}).status,'UNKNOWN');
  assert.equal(P.fromDir(dir,{mode:'list',streams:['context'],sources:['tools.jsonl']}).status,'UNKNOWN');
});

test('筛选 0 行 = EMPTY，不许冒充 PRESENT（2026-11-13 A1）', () => {
  const t = texts([call(), receipt()], [terminal()]);
  const none = P.build(t, { mode: 'list', resolveIdentity: fixtureIdentity, companion: 'no-such-companion' });
  assert.equal(none.status, 'EMPTY');
  assert.equal(none.total, 0);
  assert.equal(none.reason, 'filter-matches-no-rows');
  const world = P.build(t, { mode: 'list', resolveIdentity: fixtureIdentity, worldId: 'no-such-world' });
  assert.equal(world.status, 'EMPTY');
  assert.equal(world.reason, 'filter-matches-no-rows');
  const empty = P.build(texts([], []), { mode: 'list' });
  assert.equal(empty.status, 'EMPTY');
  assert.equal(empty.reason, 'no-rows-in-named-sources');
  const hit = P.build(t, { mode: 'list', resolveIdentity: fixtureIdentity, companion: 'c' });
  assert.ok(['PRESENT', 'PARTIAL'].includes(hit.status), '命中的过滤仍按原样：' + hit.status);
  // episode 模式找不到 anchor 仍是 UNKNOWN（不许被 EMPTY 吞掉）
  const noAnchor = P.build(t, { ...opt(), companion: 'no-such-companion' });
  assert.equal(noAnchor.status, 'UNKNOWN');
});

test('--model-call 用绑定行的 model_call_id 串起同 scope 的 call/result；错 id 空集', () => {
  const bind = (sec = 1, over = {}, env = {}) => row('tool_transport_binding', sec, { model_call_id: 'mc-1', wire_call_id: 'call', tool: 'goto', ...over }, env);
  const t = texts([bind(), call(), receipt()], [terminal()]);
  const r = P.build(t, { mode: 'list', modelCallId: 'mc-1' });
  assert.equal(r.status, 'PRESENT');
  assert.deepEqual(r.rows.map((x) => x.ref), ['tools.jsonl:1', 'tools.jsonl:2', 'tools.jsonl:3']);
  assert.equal(r.rows[0].modelCallId, 'mc-1');
  assert.equal(r.rows[1].modelCallId, null);
  // 只做投影，不认证
  assert.equal(r.rows[0].identityStatus, 'UNKNOWN');
  const none = P.build(t, { mode: 'list', modelCallId: 'mc-nope' });
  assert.equal(none.status, 'EMPTY');
  assert.equal(none.reason, 'filter-matches-no-rows');
  // 同 wire id、不同 scope 的行不许被拉进来
  const other = call(2, { world_id: 'world-other' });
  const t2 = texts([bind(), other], [terminal()]);
  const r2 = P.build(t2, { mode: 'list', modelCallId: 'mc-1' });
  assert.deepEqual(r2.rows.map((x) => x.ref), ['tools.jsonl:1']);
});

test('cursor+--model-call+--as-of 不变量：翻页不重复、换过滤/as-of 必须 RESET、as-of 前无未来行', () => {
  const bind = (sec) => row('tool_transport_binding', sec, { model_call_id: 'mc-1', wire_call_id: 'call', tool: 'goto' });
  const t = texts([bind(2), call(3), receipt(4)], [terminal(8)]);
  const p1 = P.build(t, { mode: 'list', modelCallId: 'mc-1', limit: 1 });
  assert.equal(p1.rows.length, 1); assert.equal(p1.rows[0].ref, 'tools.jsonl:1'); assert.ok(p1.nextCursor);
  const p2 = P.build(t, { mode: 'list', modelCallId: 'mc-1', limit: 1, cursor: p1.nextCursor });
  assert.equal(p2.rows[0].ref, 'tools.jsonl:2');
  const p3 = P.build(t, { mode: 'list', modelCallId: 'mc-1', limit: 1, cursor: p2.nextCursor });
  assert.equal(p3.rows[0].ref, 'tools.jsonl:3'); assert.equal(p3.nextCursor, null);
  const reset = P.build(t, { mode: 'list', modelCallId: 'mc-1', limit: 1, cursor: p1.nextCursor, asOf: T(4) });
  assert.equal(reset.status, 'RESET');
  const early = P.build(t, { mode: 'list', modelCallId: 'mc-1', asOf: T(1) });
  assert.equal(early.status, 'EMPTY');
  assert.equal((early.rows || []).length, 0);
  const late = P.build(t, { mode: 'list', modelCallId: 'mc-1', asOf: T(9) });
  assert.deepEqual(late.rows.map((x) => x.ref), ['tools.jsonl:1', 'tools.jsonl:2', 'tools.jsonl:3']);
});

test('--model-call 必须成对匹配 [scopeKey,wireId]；同 id 跨 scope 冲突保 UNKNOWN', () => {
  const bind = (sec, over) => row('tool_transport_binding', sec, { tool: 'goto', ...over });
  // 同 modelId 在两个 scope：不许把两个 scope 的 wire 混在一起
  const conflict = texts([
    bind(1, { model_call_id: 'mc-X', wire_call_id: 'wire-A', world_id: 'world-A' }),
    bind(2, { model_call_id: 'mc-X', wire_call_id: 'wire-B', world_id: 'world-B' }),
    call(3, { world_id: 'world-A', tool_call_id: 'wire-B' }),
  ], []);
  const rc = P.build(conflict, { mode: 'list', modelCallId: 'mc-X' });
  assert.equal(rc.status, 'UNKNOWN');
  assert.equal(rc.reason, 'model-call-scope-conflict');
  assert.equal((rc.rows || []).length, 0);
  // 不同 id 各自 scope：mc-A 不许把同 scope 里属 mc-B 的 wire 行拉进来
  const cross = texts([
    bind(1, { model_call_id: 'mc-A', wire_call_id: 'wire-A', world_id: 'world-A' }),
    bind(2, { model_call_id: 'mc-B', wire_call_id: 'wire-B', world_id: 'world-B' }),
    call(3, { world_id: 'world-A', tool_call_id: 'wire-B' }),
  ], []);
  const rx = P.build(cross, { mode: 'list', modelCallId: 'mc-A' });
  assert.deepEqual(rx.rows.map((x) => x.ref), ['tools.jsonl:1']);
});

// 2026-11-14 A1: five incremental real CLI/reader controls, not a rerun of the old suite.
function learner(type, sec, over = {}, envelope = {}) {
  return { schema_version: 1, category: 'learner', event_id: 'learner-' + sec, event_seq: sec + 1,
    session: 'run', timestamp: T(sec), world_id: 'world', server_session: 'server', world_epoch: 1,
    type, data: { review_id: 'rev', companion: 'c', ...over }, ...envelope };
}
const journal = events => events.map(JSON.stringify).join('\n') + '\n';
test('learner stream: real CLI queries stamped review lifecycle by companion without authenticating it', t => {
  const dir = rotationDir(t), events = [learner('review_started', 1, { reviewing: 3 }),
    learner('reviewed', 2, { reviewed: 3, committed: 3, publishable: false,
      artifact_delivery: [{ kind: 'EXPERIENCE', status: 'DELEGATED' }, { kind: 'SIDE_TASK', status: 'REJECTED' }] })];
  fs.writeFileSync(path.join(dir, 'learner.jsonl'), journal(events));
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../bench.js'), 'evidence', '--list',
    '--dir', dir, '--streams', 'learner', '--source', 'learner.jsonl', '--world', 'world',
    '--server-session', 'server', '--run', 'run', '--companion', 'c', '--content', '--json'],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr);
  const r = JSON.parse(cli.stdout);
  assert.equal(r.status, 'PRESENT', cli.stdout);
  assert.deepEqual(r.rows.map(x => x.type), ['review_started', 'reviewed']);
  assert.deepEqual(r.sourceCoverage.streams, ['learner.jsonl']);
  for (const x of r.rows) {
    assert.equal(x.claimedIdentity.companion, 'c'); assert.equal(x.identityStatus, 'UNKNOWN');
    assert.equal(x.ingestedAt, null); assert.equal(x.requestId, null);
  }
  assert.equal(r.rows[1].payload.value.committed, 3); assert.equal(r.rows[1].payload.value.publishable, false);
  assert.deepEqual(r.rows[1].payload.value.artifact_delivery.map(x => x.status), ['DELEGATED', 'REJECTED']);
  assert.match(r.visibility, /not proof of model-visible delivery/);
});
test('learner stream: rotated and latest sources retain original byte references and source budgets', t => {
  const dir = rotationDir(t), archive = 'learner-1794633968819.jsonl';
  const first = JSON.stringify(learner('review_started', 1)) + '\r';
  fs.writeFileSync(path.join(dir, archive), first + '\n');
  fs.writeFileSync(path.join(dir, 'learner.jsonl'), 'x'.repeat(2400) + '\n' + journal([learner('reviewed', 2)]));
  const o = { mode: 'list', streams: ['learner'], companion: 'c', content: true,
    sourceWindow: 'latest', order: 'latest-per-stream', maxSourceFiles: 2, maxSourceBytes: 2048 };
  const r = P.fromDir(dir, o);
  assert.deepEqual(r.rows.map(x => x.type), ['reviewed', 'review_started']);
  const live = r.rows[0], old = r.rows[1];
  assert.equal(live.byteOffset, 2401); assert.equal(live.line, null); assert.equal(live.ref, 'learner.jsonl@2401');
  assert.equal(old.ref, archive + ':1'); assert.equal(old.line, 1); assert.equal(old.sha256, digest(first));
  assert.equal(r.sources[archive].stream, 'learner.jsonl'); assert.equal(r.sources[archive].sha256, digest(first + '\n'));
  assert.ok(r.sourceCoverage.allocatedReadBytes <= 2048); assert.equal(r.sourceCoverage.maxSourceFiles, 2);
  assert.ok(r.gaps.some(g => g.reason === 'source-prefix-excluded')); assert.equal(r.status, 'PARTIAL');
  assert.ok(r.rows.every(x => x.identityStatus === 'UNKNOWN'));
  const limited = P.fromDir(dir, { ...o, maxSourceFiles: 1 });
  assert.deepEqual(limited.rows.map(x => x.type), ['reviewed']);
  assert.ok(limited.gaps.some(g => g.file === archive && g.reason === 'source-file-budget'));
  const bounded = P.fromDir(dir, { ...o, asOf: T(1) });
  assert.deepEqual(bounded.rows.map(x => x.type), ['review_started']);
  assert.equal(bounded.rows[0].ingestedAt, null); assert.match(bounded.visibility, /journal-time-only/);
});
test('learner stream: legacy missing world and session-only nudges stay UNKNOWN, never borrow nearby scope', t => {
  const dir = rotationDir(t), events = [learner('review_nudge_sent', 0, {},
    { world_id: undefined, server_session: undefined, data: { companionId: 'c', queue_depth: 64 } }),
    learner('review_started', 1, {}, { world_id: undefined }),
    learner('review_interrupted', 2, {}, { data: { review_id: 'rev', reason: 'server stopping' } }),
    learner('unlisted_review', 3), learner('review_started', 4, {}, { category: 'context' })];
  fs.writeFileSync(path.join(dir, 'learner.jsonl'), journal(events));
  const r = P.fromDir(dir, { mode: 'list', streams: ['learner'], run: 'run' });
  assert.equal(r.rows.length, 5); assert.ok(r.rows.every(x => x.identityStatus === 'UNKNOWN'));
  assert.equal(r.rows[0].claimedIdentity.worldId, null); assert.equal(r.rows[1].claimedIdentity.worldId, null);
  assert.deepEqual(r.rows.slice(2).map(x => x.claimedIdentity.companion), [null, null, null]);
  const strict = P.fromDir(dir, { mode: 'list', streams: ['learner'], worldId: 'world',
    serverSession: 'server', companion: 'c', run: 'run' });
  assert.equal(strict.status, 'EMPTY');
  const episode = P.fromDir(dir, { streams: ['learner'], eventRef: 'learner.jsonl:2' });
  assert.equal(episode.rows.length, 1); assert.equal(episode.action.identityStatus, 'UNKNOWN');
  assert.ok(episode.unknowns.includes('identity-unverified; no records joined'));
});
test('learner stream: conflicting companion aliases and cross-world scope cannot be rescued by session or adapter', t => {
  const dir = rotationDir(t), file = path.join(dir, 'learner.jsonl');
  const events = [learner('review_started', 1, { companion_id: 'other' }),
    learner('reviewed', 2, { companionId: 'other' }),
    learner('review_failed', 3, {}, { companion_id: 'other' })];
  fs.writeFileSync(file, journal(events));
  const o = { mode: 'list', streams: ['learner'], run: 'run' };
  const conflict = P.fromDir(dir, { ...o, resolveIdentity: () => ({ worldId: 'world', serverSession: 'server',
    companion: 'other', evidence: 'fixture:independent-binding' }) });
  assert.equal(conflict.rows.length, 3);
  for (const x of conflict.rows) {
    assert.equal(x.claimedIdentity.companion, null); assert.equal(x.claimedIdentity.companionConflict, true);
    assert.equal(x.identityStatus, 'UNKNOWN');
  }
  for (const companion of ['c', 'other']) assert.equal(P.fromDir(dir, { ...o, companion }).status, 'EMPTY');
  fs.writeFileSync(file, journal([learner('review_started', 1, { model_call_id: 'mc-X' }),
    learner('reviewed', 2, { model_call_id: 'mc-X' }, { world_id: 'other-world' })]));
  const cross = P.fromDir(dir, { ...o, modelCallId: 'mc-X' });
  assert.equal(cross.status, 'UNKNOWN'); assert.equal(cross.reason, 'model-call-scope-conflict');
  assert.equal(cross.rows.length, 0);
});
test('learner stream: original four default streams and invalid source validation are unchanged', t => {
  const dir = rotationDir(t), original = texts([call()], [terminal()], [row('final_request', 0)], [row('chain', 1)]);
  for (const [f, text] of Object.entries(original)) fs.writeFileSync(path.join(dir, f), text);
  fs.writeFileSync(path.join(dir, 'learner.jsonl'), journal([learner('reviewed', 2)]));
  const r = P.cli(['--list', '--dir', dir]);
  assert.equal(r.status, 'PRESENT'); assert.deepEqual(Object.keys(r.sources).sort(), Object.keys(original).sort());
  assert.deepEqual(r.sourceCoverage.streams, ['tools.jsonl', 'events.jsonl', 'context.jsonl', 'rdd.jsonl']);
  assert.equal(r.rows.length, 4); assert.deepEqual(r.gaps, []);
  assert.ok(r.rows.every(x => x.identityStatus === 'UNKNOWN' && x.claimedIdentity.companion === 'c'));
  const wrongStream = learner('review_started', 3, {}, { category: 'context' });
  fs.writeFileSync(path.join(dir, 'context.jsonl'), journal([wrongStream]));
  assert.equal(P.fromDir(dir, { mode: 'list', streams: ['context'] }).rows[0].claimedIdentity.companion, null);
  assert.equal(P.fromDir(dir, { mode: 'list', streams: ['unlisted'] }).reason, 'invalid-stream-selection');
  for (const source of ['../learner.jsonl', 'learner-backup.jsonl', 'learner-0179463396881.jsonl', 'tools.jsonl'])
    assert.equal(P.fromDir(dir, { mode: 'list', streams: ['learner'], sources: [source] }).reason, 'invalid-source-selection');
});
