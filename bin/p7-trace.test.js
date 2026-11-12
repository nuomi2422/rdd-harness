'use strict';
// Real P7 body + record/print/verdict, temporary Git only; no production preflight.
const test = require('node:test'), assert = require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),child=require('node:child_process');
const source=fs.readFileSync(path.join(__dirname,'harness-gate.js'),'utf8');
const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'..','registry.json'),'utf8'));
const start=source.indexOf('  // P7 规范/索引已补'),end=source.indexOf('  // P8 ',start);
assert.ok(start>0&&end>start);
const before='2026-11-11T12:00:00Z',fresh='2026-11-12T15:30:00Z',since=new Date('2026-11-12T15:00:00Z');
const entity=name=>JSON.stringify({type:'entity',name,entityType:'Verification',observations:['Actual finding and original evidence.']})+'\n';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'p7-consumer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const docsRepo=path.join(root,'docs-repo'),harness=path.join(root,'harness'),docs=path.join(docsRepo,'rdd架构');
 const unified=path.join(docs,'unified'),knowledge=path.join(docsRepo,'知识库'),record=path.join(knowledge,'记录','001-existing.md');
 const newRecord=path.join(knowledge,'记录','002-new.md'),memory=path.join(docs,'_memory','memory.jsonl'),standard=path.join(harness,'standards.md');
 const git=(repo,args,extra={})=>child.execFileSync('git',['-C',repo,...args],{encoding:'utf8',...extra});
 for(const d of [unified,path.dirname(record),path.dirname(memory),path.join(knowledge,'实验数据记录'),harness])fs.mkdirSync(d,{recursive:true});
 fs.writeFileSync(record,'# Original\nOriginal finding.\n');fs.writeFileSync(memory,entity('old'));fs.writeFileSync(standard,'# Standards\nOriginal rule.\n');
 for(const repo of [docsRepo,harness]){
  git(repo,['init','-q']);git(repo,['config','user.email','p7-test@example.invalid']);git(repo,['config','user.name','P7 fixture']);
  git(repo,['add','.']);git(repo,['commit','-qm','baseline'],{env:{...process.env,GIT_AUTHOR_DATE:before,GIT_COMMITTER_DATE:before}});
 }
 const reg=JSON.parse(JSON.stringify(raw));Object.assign(reg.roots,{docs,docsUnified:unified,knowledge,harness});
 for(const p of [record,memory,standard,unified,path.dirname(record),path.join(knowledge,'实验数据记录')])fs.utimesSync(p,new Date(before),new Date(before));
 function update(file,text){fs.writeFileSync(file,text);fs.utimesSync(file,new Date(fresh),new Date(fresh));}
 function run(options={}){
  const logs=[],cp={...child,spawnSync(exe,args,opts){if(options.gitFail&&exe==='git')return {status:1,stdout:'',stderr:'fixture unavailable'};return child.spawnSync(exe,args,opts);}};
  const sandbox={__dirname,__filename:path.join(__dirname,'harness-gate.js'),console:{log:(...x)=>logs.push(x.join(' ')),error:(...x)=>logs.push(x.join(' '))},
   process:{argv:['node','harness-gate.js','preflight'],env:{},execPath:process.execPath},
   require(n){
    if(n==='fs')return fs;if(n==='path')return path;if(n==='child_process')return cp;
    if(n==='./lib/registry.js')return {load:()=>reg};
    if(n==='./lib/commander-gates.js'||n==='./lib/learner-gates.js')return {};
    if(n==='./lib/timelock-scope.js')return {excludedForRuntime:()=>false};return require(n);
   }};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(0,source.lastIndexOf('try { process.exit(main()); }'))+
   '\nREG=registryLib.load();globalThis.runP7=function(ctx){const {since}=ctx;'+source.slice(start,end)+
   ';printResults();return {result:results.find(r=>r.id==="P7"),exit:verdict()};};',sandbox);
  return {...sandbox.runP7({since:options.since||since}),output:logs.join('\n')};
 }
 return {root,docsRepo,harness,docs,unified,knowledge,record,newRecord,memory,standard,git,update,run};
}
function pass(r,pattern){assert.equal(r.result.state,'PASS');assert.equal(r.exit,0);if(pattern)assert.match(r.output,pattern);}
function block(r){assert.equal(r.result.state,'BLOCK');assert.equal(r.exit,1);}
test('P7 tracked record content diff, old parent mtime, no tool words',t=>{
 const f=fixture(t);f.update(f.record,'# Original\nNew evidence and concrete lesson.\n');pass(f.run(),/001-existing\.md/);
});
test('P7 actual new record, old directory mtime',t=>{
 const f=fixture(t);f.update(f.newRecord,'# New finding\nVerified cause, evidence and regression.\n');
 fs.utimesSync(path.dirname(f.record),new Date(before),new Date(before));pass(f.run(),/002-new\.md/);
});
test('P7 standards real content diff remains accepted',t=>{
 const f=fixture(t);f.update(f.standard,'# Standards\nNew rule and regression reason.\n');pass(f.run(),/standards\.md/);
});
test('P7 unified Markdown real diff',t=>{
 const f=fixture(t),file=path.join(f.unified,'001-rule.md');f.update(file,'# Rule\nObserved regression and resolution.\n');
 fs.utimesSync(f.unified,new Date(before),new Date(before));pass(f.run(),/001-rule\.md/);
});
test('P7 real memory append with unchanged prefix',t=>{
 const f=fixture(t);f.update(f.memory,entity('old')+entity('new'));pass(f.run(),/memory\.jsonl/);
});
for(const target of ['directory','record','memory','standards'])test('P7 touch only '+target+' cannot PASS',t=>{
 const f=fixture(t),file={directory:f.unified,record:f.record,memory:f.memory,standards:f.standard}[target];
 fs.utimesSync(file,new Date(fresh),new Date(fresh));block(f.run());
});
for(const word of ['memory_search_nodes','memory_create_entities','memory_add_observations'])test('P7 tool word only '+word+' is not evidence',t=>{
 const f=fixture(t);f.update(f.newRecord,'# '+word+'\n');block(f.run());
});
for(const [label,text]of Object.entries({empty:'',unchanged:entity('old'),badJson:entity('old')+'{bad}\n',
 emptyEntity:entity('old')+JSON.stringify({type:'entity',name:'new',entityType:'Verification',observations:[]})+'\n',
 overwrite:entity('replaced'),duplicate:entity('old')+entity('old')}))test('P7 memory '+label+' cannot establish an append',t=>{
 const f=fixture(t);f.update(f.memory,text);block(f.run());
});
test('P7 old record outside cutoff',t=>{
 const f=fixture(t);f.update(f.record,'# Finding\nNew evidence.\n');fs.utimesSync(f.record,new Date(before),new Date(before));block(f.run());
});
test('P7 failed Git is UNKNOWN/BLOCK despite fresh standards',t=>{
 const f=fixture(t);f.update(f.standard,'# Rules\nChanged content.\n');const r=f.run({gitFail:true});block(r);assert.match(r.output,/UNKNOWN|不可|失败/);
});
test('P7 missing repo cannot PASS from directory mtime',t=>{
 const f=fixture(t);fs.renameSync(path.join(f.docsRepo,'.git'),path.join(f.docsRepo,'git-hidden'));
 fs.utimesSync(f.unified,new Date(fresh),new Date(fresh));block(f.run());
});
test('P7 unreadable candidate cannot PASS',t=>{
 const f=fixture(t);f.update(f.record,'# Finding\nReal changed content.\n');const original=fs.readFileSync;
 fs.readFileSync=function(file,...args){if(String(file)===f.record)throw new Error('fixture denied');return original.call(this,file,...args);};
 try{block(f.run());}finally{fs.readFileSync=original;}
});
test('P7 outside evidence roots is not counted',t=>{
 const f=fixture(t);f.update(path.join(f.docsRepo,'unrelated.md'),'# Finding\nReal content.\n');block(f.run());
});
test('P7 committed in-window diff with old checkout mtime',t=>{
 const f=fixture(t);f.update(f.record,'# Finding\nNew committed lesson.\n');f.git(f.docsRepo,['add','.']);
 f.git(f.docsRepo,['commit','-qm','real finding'],{env:{...process.env,GIT_AUTHOR_DATE:fresh,GIT_COMMITTER_DATE:fresh}});
 fs.utimesSync(f.record,new Date(before),new Date(before));pass(f.run(),/001-existing\.md/);
});
test('P7 Shanghai midnight separates previous-batch and next-day evidence',t=>{
 const f=fixture(t);f.update(f.memory,entity('old')+entity('new'));pass(f.run({since:new Date('2026-11-12T00:00:00+08:00')}),/memory\.jsonl/);
 const next=f.run({since:new Date('2026-11-13T00:00:00+08:00')});block(next);
 assert.match(next.output,/2026-11-12T16:00:00\.000Z/);assert.match(next.output,/2026-11-13/);
});
