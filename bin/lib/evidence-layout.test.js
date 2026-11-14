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
