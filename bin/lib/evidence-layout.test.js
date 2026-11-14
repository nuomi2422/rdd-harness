'use strict';
// 044 A1 opt-in bounded-window layout controls; exact original filenames/bytes remain the evidence.
// WHY 2026-11-14: external windows archive new-*.jsonl, which the ordinary fromDir contract rejects.
// USAGE: node --test bin/lib/evidence-layout.test.js; only disposable OS temp fixtures, never a game.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const P=require('./evidence-pack'),MR=require('./monitor-reader');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const T=n=>'2026-11-14T07:12:'+String(n).padStart(2,'0')+'.000Z';
function event(category,type,n,data={},over={}){return {schema_version:1,event_id:category+'-offline-'+n,event_seq:n+1,session:'monitor',timestamp:T(n),world_id:'world',server_session:'server',world_epoch:1,source:'numen',category,type,data:{companion_id:'comp',...data},...over};}
function fixture(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'a1-layout-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
const journal=rows=>rows.map(JSON.stringify).join('\r\n')+'\r\n';
function cli(dir,...flags){const c=spawnSync(process.execPath,[path.join(__dirname,'../bench.js'),'evidence','--dir',dir,...flags,'--json'],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});assert.ifError(c.error);assert.equal(c.status,0,c.stderr||c.stdout);return JSON.parse(c.stdout);}
const filters={worldId:'world',serverSession:'server',run:'monitor',companion:'comp'};

test('bounded layout: real CLI accepts explicit original new-events source without renaming its references',t=>{
 const dir=fixture(t),file='new-events.jsonl',raw=journal([event('events','dimension_change',1,{to:'minecraft:the_nether'}),event('events','dimension_change',2,{to:'minecraft:overworld'})]);fs.writeFileSync(path.join(dir,file),raw);
 const r=cli(dir,'--list','--source-layout','bounded-window','--streams','events','--source',file,'--content');
 assert.equal(r.status,'PRESENT',JSON.stringify(r));assert.equal(r.total,2);assert.deepEqual(r.rows.map(x=>x.ref),[file+':1',file+':2']);
 assert.equal(r.sources[file].sha256,hash(raw));assert.equal(r.sources[file].file,path.resolve(dir,file));
 assert.equal(r.rows[0].sha256,hash(raw.split('\n')[0]));assert.equal(r.rows[1].byteOffset,Buffer.byteLength(raw.split('\n')[0]+'\n'));
 for(const x of r.rows){assert.equal(x.sourceFile,path.resolve(dir,file));assert.equal(x.identityStatus,'UNKNOWN');assert.equal(x.claimedIdentity.generation,null);}
 assert.equal(r.rows[0].payload.value.to,'minecraft:the_nether');assert.equal(fs.readFileSync(path.join(dir,file),'utf8'),raw);
});

test('bounded layout: actual shared reader validates the logical category while retaining the physical key',t=>{
 const dir=fixture(t),file='new-events.jsonl',raw=journal([event('events','dimension_change',1,{to:'minecraft:the_nether'})]);fs.writeFileSync(path.join(dir,file),raw);
 const reader=MR.createPull({dir,sourceLayout:'bounded-window'});assert.equal(reader.pull(file),raw);
 assert.equal(reader.replayDomain.complete,true);assert.equal(reader.replays,0);assert.deepEqual(Object.keys(reader.offsets),[file]);assert.equal(reader.offsets[file],Buffer.byteLength(raw));assert.equal(reader.verifySegments().ok,true);
});

test('bounded layout: the existing query cursor cannot cross the opt-in boundary for identical source bytes',()=>{
 const file='new-events.jsonl',text=journal([event('events','dimension_change',1),event('events','dimension_change',2)]),lines={[file]:text};
 const opts={sourceFiles:[file],mode:'list',limit:1},normal=P.build(lines,opts),bounded=P.build(lines,{...opts,sourceLayout:'bounded-window'});
 assert.ok(normal.nextCursor);assert.ok(bounded.nextCursor);
 assert.equal(P.build(lines,{...opts,sourceLayout:'bounded-window',cursor:normal.nextCursor}).status,'RESET');
 assert.equal(P.build(lines,{...opts,cursor:bounded.nextCursor}).status,'RESET');
 assert.equal(P.build(lines,{...opts,sourceLayout:'bounded-window',cursor:bounded.nextCursor}).rows[0].ref,file+':2');
});

test('bounded layout: discovery uses only exact selected names; default and rotations stay separate',t=>{
 const dir=fixture(t);
 for(const stream of ['tools','events','context','rdd','learner']){
  fs.writeFileSync(path.join(dir,'new-'+stream+'.jsonl'),journal([event(stream,stream==='learner'?'review_started':'example',1,stream==='learner'?{companion_id:undefined,companion:'comp'}:{})]));
  fs.writeFileSync(path.join(dir,stream+'.jsonl'),journal([event(stream,'standard',2)]));
 }
 fs.writeFileSync(path.join(dir,'events-1794633968819.jsonl'),journal([event('events','rotation',3)]));
 fs.writeFileSync(path.join(dir,'new-events-1794633968819.jsonl'),journal([event('events','not-an-external-archive',4)]));
 fs.writeFileSync(path.join(dir,'new-ai.jsonl'),journal([event('ai','not-supported',5)]));
 const normal=P.fromDir(dir,{mode:'list'});assert.equal(normal.total,5);assert.ok(normal.rows.every(x=>!x.ref.startsWith('new-')));
 const defaultNew=P.fromDir(dir,{mode:'list',streams:['events'],sources:['new-events.jsonl']});assert.equal(defaultNew.reason,'invalid-source-selection');
 const bounded=P.fromDir(dir,{mode:'list',sourceLayout:'bounded-window'});assert.equal(bounded.total,4);assert.deepEqual(Object.keys(bounded.sources).sort(),['new-context.jsonl','new-events.jsonl','new-rdd.jsonl','new-tools.jsonl']);
 const all=P.fromDir(dir,{mode:'list',sourceLayout:'bounded-window',streams:['tools','events','context','rdd','learner'],order:'latest-per-stream'});assert.equal(all.total,5);assert.ok(all.rows.every(x=>x.ref.startsWith('new-')&&x.identityStatus==='UNKNOWN'));assert.equal(all.rows.at(-1).claimedIdentity.companion,'comp');
 for(const name of ['events.jsonl','events-1794633968819.jsonl','new-events-1794633968819.jsonl','new-ai.jsonl','NEW-events.jsonl','new-events.jsonl\n','../new-events.jsonl','sub/new-events.jsonl','sub\\new-events.jsonl',path.resolve(dir,'new-events.jsonl')])assert.equal(P.fromDir(dir,{mode:'list',sourceLayout:'bounded-window',streams:['events'],sources:[name]}).reason,'invalid-source-selection',name);
 for(const layout of ['',null,'monitor','anything'])assert.equal(P.fromDir(dir,{mode:'list',sourceLayout:layout}).reason,'invalid-source-layout');
 assert.equal(cli(dir,'--list','--source-layout').reason,'invalid-source-layout');
 assert.equal(cli(dir,'--list','--source-layout','bounded-window','--source-layout','bounded-window').reason,'invalid-source-layout');
 const help=spawnSync(process.execPath,[path.join(__dirname,'../bench.js'),'evidence','--help'],{encoding:'utf8',windowsHide:true});assert.equal(help.status,0);assert.match(help.stdout,/--source-layout bounded-window/);assert.match(help.stdout,/identity UNKNOWN/);
});

test('bounded layout: existing list/expand/episode/model-call consumers retain physical refs and UNKNOWN attribution',t=>{
 const dir=fixture(t),tools=[event('tools','tool_transport_binding',1,{model_call_id:'model',wire_call_id:'wire',tool:'goto'}),event('tools','tool_call',2,{tool_call_id:'wire',tool:'goto',args:{x:3}}),event('tools','tool_result',3,{tool_call_id:'wire',tool:'goto',result:JSON.stringify({success:true,data:{async:true,task_id:'task'}})})];
 for(const [stream,rows] of Object.entries({tools,events:[event('events','task_finished',4,{id:'task',status:'done'})],context:[event('context','final_request',0,{request_id:'request',body:'original input'})],rdd:[]}))fs.writeFileSync(path.join(dir,'new-'+stream+'.jsonl'),rows.length?journal(rows):'');
 const flags=['--source-layout','bounded-window','--world','world','--server-session','server','--run','monitor','--companion','comp'];
 const list=cli(dir,'--list',...flags,'--model-call','model','--content');assert.deepEqual(list.rows.map(x=>x.ref),['new-tools.jsonl:1','new-tools.jsonl:2','new-tools.jsonl:3']);assert.ok(list.rows.every(x=>x.identityStatus==='UNKNOWN'&&x.claimedIdentity.generation===null));
 const expand=cli(dir,'--expand','--event','new-tools.jsonl:2',...flags);assert.deepEqual(expand.rows.map(x=>x.ref),['new-tools.jsonl:1','new-tools.jsonl:2','new-tools.jsonl:3']);assert.match(expand.relation,/no causal/);
 const episode=cli(dir,'--event','new-tools.jsonl:2',...flags);assert.equal(episode.status,'PARTIAL');assert.equal(episode.action.identityStatus,'UNKNOWN');assert.deepEqual(episode.stages.terminal,[]);assert.equal(episode.rows.length,1);assert.equal(episode.anchor.ref,'new-tools.jsonl:2');
 const wrong=cli(dir,'--list',...flags,'--model-call','wrong');assert.equal(wrong.status,'EMPTY');assert.equal(wrong.reason,'filter-matches-no-rows');
 // Existing ledger, not a new relation algorithm: a synthetic independent binding can still use the logical stream.
 const resolveIdentity=(e,category)=>({worldId:e.world_id,serverSession:e.server_session,companion:e.data.companion_id,evidence:'synthetic-independent-fixture',[category==='tools'?'callId':'taskId']:category==='tools'?e.data.tool_call_id:e.data.id});
 const joined=P.fromDir(dir,{sourceLayout:'bounded-window',eventRef:'new-tools.jsonl:2',resolveIdentity});assert.equal(joined.action.state,'completed');assert.deepEqual(joined.stages.terminal,['new-events.jsonl:1']);
});

test('bounded layout: missing streams, partial rows and source budgets remain explicit',t=>{
 const dir=fixture(t),file='new-events.jsonl',first=JSON.stringify(event('events','dimension_change',1,{to:'minecraft:the_nether'}))+'\r\n',tail=JSON.stringify(event('events','unfinished',2));fs.writeFileSync(path.join(dir,file),first+tail);
 const opts={mode:'list',sourceLayout:'bounded-window'},r=P.fromDir(dir,opts);assert.equal(r.status,'PARTIAL');assert.equal(r.total,1);assert.ok(r.gaps.some(g=>g.reason==='partial-tail-not-consumed'));assert.equal(r.gaps.filter(g=>g.reason==='missing-stream').length,3);assert.equal(r.sources[file].sha256,hash(first));assert.equal(r.sources[file].observedTo,Buffer.byteLength(first));assert.equal(r.sourceCoverage.status,'PARTIAL');
 const tiny=P.fromDir(dir,{...opts,streams:['events'],maxSourceBytes:40});assert.equal(tiny.rows.length,0);assert.equal(tiny.sourceCoverage.status,'PARTIAL');assert.ok(tiny.gaps.some(g=>g.reason==='source-byte-budget'));
 const one=P.fromDir(dir,{...opts,maxSourceFiles:1});assert.ok(one.sourceCoverage.attemptedSources<=1);
 fs.writeFileSync(path.join(dir,file),'x'.repeat(3000)+'\n'+first);
 const latest=P.fromDir(dir,{...opts,streams:['events'],sourceWindow:'latest',order:'latest-per-stream',maxSourceBytes:1024});assert.equal(latest.rows.length,1);assert.equal(latest.rows[0].line,null);assert.equal(latest.rows[0].byteOffset,3001);assert.equal(latest.rows[0].ref,file+'@3001');assert.equal(latest.rows[0].sha256,hash(first.slice(0,-1)));assert.ok(latest.gaps.some(g=>g.reason==='source-prefix-excluded'));
 const expanded=P.fromDir(dir,{...opts,streams:['events'],sourceWindow:'latest',maxSourceBytes:1024,mode:'expand',eventRef:latest.rows[0].ref,eventHash:latest.rows[0].sha256});assert.equal(expanded.rows[0].ref,latest.rows[0].ref);
});

test('bounded layout: future cutoff and foreign/missing scope filter without granting authority',t=>{
 const dir=fixture(t),file='new-events.jsonl';
 const rows=[event('events','current',2),event('events','future',8),event('events','foreign-world',3,{}, {world_id:'other'}),event('events','foreign-server',3,{}, {server_session:'other'}),event('events','foreign-run',3,{}, {session:'other'}),event('events','foreign-owner',3,{companion_id:'other'}),event('events','missing-server',3,{}, {server_session:undefined}),event('events','late-ingested',3,{}, {ingestedAt:T(9)})];fs.writeFileSync(path.join(dir,file),journal(rows));
 const r=P.fromDir(dir,{...filters,sourceLayout:'bounded-window',streams:['events'],mode:'list',since:T(1),asOf:T(4)});assert.deepEqual(r.rows.map(x=>x.type),['current']);assert.equal(r.rows[0].identityStatus,'UNKNOWN');assert.equal(r.rows[0].claimedIdentity.generation,null);
 const empty=P.fromDir(dir,{...filters,sourceLayout:'bounded-window',streams:['events'],mode:'list',worldId:'absent'});assert.equal(empty.status,'EMPTY');
 assert.equal(P.fromDir(dir,{sourceLayout:'bounded-window',mode:'list',since:'bad'}).status,'UNKNOWN');
});

test('bounded layout: learner aliases use the original lifecycle claims and conflicting companion stays UNKNOWN',t=>{
 const dir=fixture(t),file='new-learner.jsonl',rows=[event('learner','review_started',1,{companion_id:undefined,companion:'comp',review_id:'review'}),event('learner','reviewed',2,{companion_id:undefined,companion:'comp',review_id:'review',committed:2}),event('learner','reviewed',3,{companion:'foreign',review_id:'conflict'}),event('learner','reviewed',8,{companion_id:undefined,companion:'comp',review_id:'future'})];fs.writeFileSync(path.join(dir,file),journal(rows));
 const flags=['--list','--source-layout','bounded-window','--streams','learner','--source',file,'--world','world','--server-session','server','--run','monitor','--companion','comp','--as-of',T(4),'--content'];
 const r=cli(dir,...flags);assert.deepEqual(r.rows.map(x=>x.type),['review_started','reviewed']);assert.ok(r.rows.every(x=>x.identityStatus==='UNKNOWN'&&x.claimedIdentity.generation===null));assert.equal(r.rows[1].payload.value.committed,2);
 const all=P.fromDir(dir,{sourceLayout:'bounded-window',mode:'list',streams:['learner'],asOf:T(4)}),bad=all.rows.find(x=>x.ref===file+':3');assert.equal(bad.claimedIdentity.companion,null);assert.equal(bad.claimedIdentity.companionConflict,true);assert.equal(bad.identityStatus,'UNKNOWN');
});

test('bounded layout: actual CLI pagination binds layout, scope and source bytes without duplicated refs',t=>{
 const dir=fixture(t),file='new-events.jsonl';fs.writeFileSync(path.join(dir,file),journal([event('events','dimension_change',1),event('events','dimension_change',2),event('events','dimension_change',3)]));
 const flags=['--list','--source-layout','bounded-window','--streams','events','--source',file,'--limit','1'];
 let r=cli(dir,...flags),refs=r.rows.map(x=>x.ref);assert.ok(r.nextCursor);const first=r.nextCursor;
 while(r.nextCursor){r=cli(dir,...flags,'--cursor',r.nextCursor);refs.push(...r.rows.map(x=>x.ref));}
 assert.deepEqual(refs,[file+':1',file+':2',file+':3']);
 assert.equal(cli(dir,...flags,'--cursor',first,'--companion','other').status,'RESET');
 fs.appendFileSync(path.join(dir,file),journal([event('events','dimension_change',4)]));assert.equal(cli(dir,...flags,'--cursor',first).status,'RESET');
});

test('bounded layout: source category mismatch uses the original reader rejection and never signs clean coverage',t=>{
 const dir=fixture(t),file='new-events.jsonl';fs.writeFileSync(path.join(dir,file),journal([event('tools','dimension_change',1)]));
 const reader=MR.createPull({dir,sourceLayout:'bounded-window'});reader.pull(file);assert.equal(reader.replayDomain.complete,false);assert.equal(reader.replays,null);
 const r=P.fromDir(dir,{sourceLayout:'bounded-window',streams:['events'],mode:'list'});assert.equal(r.sourceCoverage.status,'PARTIAL');assert.ok(r.gaps.some(x=>x.reason==='source-envelope-domain-incomplete'));assert.equal(r.rows[0].identityStatus,'UNKNOWN');
});

test('bounded layout: links and directory aliases cannot expand file access',t=>{
 const root=fixture(t),target=path.join(root,'target'),link=path.join(root,'linked');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'new-events.jsonl'),journal([event('events','dimension_change',1)]));
 fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
 const r=P.fromDir(link,{sourceLayout:'bounded-window',streams:['events'],mode:'list'});assert.equal(r.status,'UNKNOWN');assert.equal(r.reason,'source-directory-unreadable');
 const nested=path.join(target,'child');fs.mkdirSync(nested);fs.writeFileSync(path.join(nested,'new-events.jsonl'),journal([event('events','dimension_change',1)]));
 assert.equal(P.fromDir(path.join(link,'child'),{sourceLayout:'bounded-window',streams:['events'],mode:'list'}).status,'UNKNOWN');
 const selected=path.join(root,'new-events.jsonl');fs.symlinkSync(target,selected,process.platform==='win32'?'junction':'dir');
 const unsafe=P.fromDir(root,{sourceLayout:'bounded-window',streams:['events'],sources:['new-events.jsonl'],mode:'list'});assert.equal(unsafe.rows.length,0);assert.ok(unsafe.gaps.some(g=>g.reason==='source-unavailable'));
 const reader=MR.createPull({dir:root,sourceLayout:'bounded-window'});assert.equal(reader.pull('new-events.jsonl'),'');assert.equal(reader.pull('../target/new-events.jsonl'),'');assert.ok(reader.gaps['../target/new-events.jsonl']);
});

test('bounded layout: ordinary standard and rotated outputs match unchanged main implementation byte contract',t=>{
 const original=require('D:/rdd/harness/rdd-harness/bin/lib/evidence-pack.js'),dir=fixture(t);
 for(const stream of ['tools','events','context','rdd','learner']){fs.writeFileSync(path.join(dir,stream+'.jsonl'),journal([event(stream,stream==='learner'?'review_started':'example',1,stream==='learner'?{companion_id:undefined,companion:'comp'}:{})]));fs.writeFileSync(path.join(dir,stream+'-1794633968819.jsonl'),journal([event(stream,'rotated',2)]));}
 for(const opts of [{mode:'list'},{mode:'list',streams:['events'],limit:1},{mode:'list',streams:['learner'],companion:'comp'},{mode:'list',sourceWindow:'latest',order:'latest-per-stream',maxSourceBytes:4096},{mode:'expand',eventRef:'events.jsonl:1'},{mode:'episode',eventRef:'tools.jsonl:1'}])assert.deepEqual(P.fromDir(dir,opts),original.fromDir(dir,opts));
});
