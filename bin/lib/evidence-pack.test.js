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
  assert.equal(P.fromDir(dir,{mode:'list',streams:['learner']}).status,'UNKNOWN');
  assert.equal(P.fromDir(dir,{mode:'list',streams:['context'],sources:['tools.jsonl']}).status,'UNKNOWN');
});
