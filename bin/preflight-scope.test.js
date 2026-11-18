'use strict';
// Run real gate bodies and record/output/verdict with fake IO; isolate the target before verdict.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const runtime = require('./lib/runtime-context');
const source = fs.readFileSync(path.join(__dirname,'harness-gate.js'),'utf8');
const raw = JSON.parse(fs.readFileSync(path.join(__dirname,'..','registry.json'),'utf8'));
const digestText = '# 实验台摘要 · 最近 120 分钟\n世界身份：UNKNOWN\n覆盖：ai=UNKNOWN（缺日志）；tools=读取完成（不保证日志完整）';
function fixture(o={}) {
 const reg=JSON.parse(JSON.stringify(raw)), base=path.resolve(__dirname,'fixture-project');
 for(const k of Object.keys(reg.roots)) reg.roots[k]=path.join(base,k);
 const docsRoot=path.join(base,'docs-repo');
 reg.roots.docs=path.join(docsRoot,'rdd架构'); reg.roots.knowledge=path.join(docsRoot,'知识库');
 reg._meta={root:base}; reg.timeLocks={locks:[]};
 const repos=[reg.roots.docs,reg.roots.harness,path.join(reg.roots.workspace,'minecraft-numen')];
 const script=path.join(reg.roots.harness,'bin','bench-digest.js');
 const io=[],children=[],logs=[],writes=[];
 const missing=p=>{io.push(String(p));throw new Error('fixture absent');};
 const fakeFs={
  existsSync(p){io.push(String(p));return repos.includes(p)?p!==o.missingRepo:p===script&&!o.noScript;},
  accessSync:missing,statSync(p){io.push(String(p));if(p===script&&!o.noScript)return {isFile:()=>true};throw new Error('absent');},
  readdirSync:()=>[],
  readFileSync(p){io.push(String(p));if(/bench-digest\.jsonl$/.test(p))return Object.hasOwn(o,'ledger')?o.ledger:JSON.stringify({at:new Date(Date.now()-60000).toISOString()});throw new Error('fixture absent');},
  mkdirSync:()=>{},appendFileSync:(...a)=>writes.push(a)
 };
 const child={spawnSync(exe,argv,opts){
  children.push({exe,argv,opts});
  if(argv.includes('rev-parse'))return {status:o.rootFail?1:0,stdout:docsRoot+'\n',stderr:''};
  if(argv.includes('status'))return {status:o.gitFail===repos.indexOf(argv[1])?1:0,stdout:argv.includes('-z')?((o.status||{})[repos.indexOf(argv[1])]||''):((o.status||{})[repos.indexOf(argv[1])]||'').replace(/\0/g,'\n'),stderr:''};
  if(argv[0]===script){if(o.throwChild)throw new Error('fixture transport failure');return o.child||{status:0,stdout:digestText,stderr:''};}
  return {status:0,stdout:'',stderr:''};
 },execFileSync:()=>{throw new Error('unexpected child');}};
 const args=o.title?['--instance','test','--title-only']:o.role?['--role',o.role]:[];
 const sandbox={__dirname,__filename:path.join(__dirname,'harness-gate.js'),
 console:{log:(...a)=>logs.push(a.join(' ')),error:(...a)=>logs.push(a.join(' '))},
 process:{argv:['node','harness-gate.js','preflight',...args],env:{},execPath:process.execPath},
 require(n){
  if(n==='fs')return fakeFs;if(n==='path')return path;if(n==='child_process')return child;
  if(n==='./lib/registry.js')return {load:()=>reg};
  if(n==='./lib/runtime-context.js')return runtime;
  if(n==='./lib/timelock-scope.js')return {excludedForRuntime:()=>false};
  if(n==='./lib/commander-gates.js'||n==='./lib/learner-gates.js')return {};
  if(n==='./lib/planner-entry.js')return {scan:()=>({verdict:'NO_CHAIN',note:'fixture'})};
  if(n==='./lib/p22-digest.js')return require(n);
  throw new Error('unexpected require '+n);
 }};
 vm.createContext(sandbox);
 vm.runInContext(source.slice(0,source.lastIndexOf('try { process.exit(main()); }'))+
 '\n globalThis.api={results,preflight,builtinChecks,applyRole,printResults,verdict,setup(){REG=registryLib.load();RUNTIME=runtimeContext.resolveRuntime(runtimeContext.selection(process.argv.slice(3)),REG);}};',sandbox);
 sandbox.api.setup();
 function run(id,phase='preflight'){
  const ctx={since:new Date('2026-11-11T00:00:00Z'),keyword:'fixture',head:'',stageTxt:''};
  if(id==='P14')sandbox.api.preflight(ctx);else sandbox.api.builtinChecks(ctx,phase);
  const result=sandbox.api.results.find(r=>r.id===id);
  sandbox.api.results.splice(0,sandbox.api.results.length,...(result?[result]:[]));
  if(o.role)sandbox.api.applyRole(o.role,phase);
  sandbox.api.printResults();
  return {result,exit:sandbox.api.verdict(),output:logs.join('\n')};
 }
 return {run,io,children,writes,repos,script,docsRoot,reg};
}
function p14(status={},extra={}){return fixture({status,...extra}).run('P14');}
for(const xy of [' M','M ','MM'])test('P14 tracked record '+JSON.stringify(xy)+' WARN and exit 0',()=>{
 const r=p14({0:xy+' 知识库/实验数据记录/003-判据 中文 空格.md\0'});
 assert.equal(r.result.state,'WARN');assert.equal(r.exit,0);assert.match(r.output,/003-判据 中文 空格/);
});
test('P14 original records directory permits tracked Markdown modifications',()=>{
 assert.equal(p14({0:' M 知识库/记录/001-窗口.md\0'}).result.state,'WARN');
});
for(const [label,entry]of Object.entries({
 source:' M src/index.js\0',governance:' M rdd架构/006-Harness模块.md\0',rules:' M 知识库/规则/001-规则.md\0',
 untracked:'?? 知识库/实验数据记录/new.md\0',added:'A  知识库/实验数据记录/new.md\0',deleted:' D 知识库/实验数据记录/003.md\0',
 renamed:'R  知识库/实验数据记录/new.md\0知识库/实验数据记录/old.md\0',typechange:' T 知识库/实验数据记录/003.md\0',
 recordRules:' M 知识库/实验数据记录/_格式规范.md\0',recordReadme:' M 知识库/记录/README.md\0',nested:' M 知识库/记录/规则/001-规则.md\0',nonMarkdown:' M 知识库/实验数据记录/source.js\0',prefix:' M 知识库/实验数据记录伪装/003.md\0',
 traversal:' M 知识库/实验数据记录/../规则/003.md\0',malformed:' M 知识库/实验数据记录/003.md',
 mixed:' M 知识库/实验数据记录/003.md\0 M registry.json\0'
}))test('P14 '+label+' BLOCK and exit 1',()=>{const r=p14({0:entry});assert.equal(r.result.state,'BLOCK');assert.equal(r.exit,1);});
test('P14 harness same named record remains BLOCK',()=>assert.equal(p14({1:' M 知识库/实验数据记录/003.md\0'}).exit,1));
test('P14 parallel source and test files WARN without blocking launch preflight',()=>{
 const r=p14({1:'?? bin/offline-feature.test.js\0',2:' M plugins/rdd/src/main/java/Planner.java\0A  core/common/src/test/java/PlannerTest.java\0'});
 assert.equal(r.result.state,'WARN');assert.equal(r.exit,0);
 assert.match(r.output,/Planner\.java/);assert.match(r.output,/offline-feature\.test\.js/);
});
test('P14 launch inputs and unresolved source conflicts still BLOCK alongside parallel work',()=>{
 for (const status of [' M bin/harness-gate.js\0',' M registry.json\0',' M gate-switches.json\0']) {
  assert.equal(p14({1:status,2:' M core/common/src/main/java/Planner.java\0'}).exit,1);
 }
 assert.equal(p14({2:'UU core/common/src/main/java/Planner.java\0'}).exit,1);
});
test('P14 clean and usage exemption PASS',()=>{
 assert.equal(p14().result.state,'PASS');assert.equal(p14({1:' M experiments/usage.jsonl\0'}).result.state,'PASS');
});
for(const o of [{gitFail:0},{gitFail:1},{gitFail:2},{rootFail:true}])test('P14 Git failure BLOCK '+JSON.stringify(o),()=>{
 const r=p14({},o);assert.equal(r.result.state,'BLOCK');assert.equal(r.exit,1);
});
test('P14 missing repo BLOCK',()=>{const f=fixture();const r=fixture({missingRepo:f.repos[0]}).run('P14');assert.equal(r.result.state,'BLOCK');assert.equal(r.exit,1);});
test('P14 docs root and NUL porcelain are used',()=>{
 const f=fixture({status:{0:' M 知识库/记录/001-窗口.md\0'}});assert.equal(f.run('P14').result.state,'WARN');
 assert.ok(f.children.some(c=>c.argv.includes('rev-parse')));
 const scans=f.children.filter(c=>c.argv.includes('status'));
 assert.ok(scans.every(c=>c.argv.includes('-z')));
 assert.equal(scans.filter(c=>c.argv.includes('--untracked-files=all')).length,2);
});
for(const ledger of ['', '{"at":"2000-01-01T00:00:00Z"}\n','{"at":"2999-01-01T00:00:00Z"}\n'])test('P22 direct bounded delivery independent of ledger '+ledger,()=>{
 const f=fixture({ledger}),r=f.run('P22');assert.equal(r.result.state,'PASS');assert.equal(r.exit,0);
 assert.match(r.output,/世界身份：UNKNOWN/);assert.match(r.output,/覆盖：ai=UNKNOWN/);assert.match(r.output,/输出交付/);assert.match(r.output,/不代表.*已读/);
 const c=f.children.filter(c=>c.argv[0]===f.script);assert.equal(c.length,1);assert.deepEqual(Array.from(c[0].argv),[f.script]);
 assert.ok(c[0].opts.timeout>0&&c[0].opts.maxBuffer>0);assert.ok(!f.io.some(p=>/bench-digest\.jsonl$/.test(p)));
});
for(const [label,o]of Object.entries({
 missing:{noScript:true},throw:{throwChild:true},error:{child:{status:0,error:new Error('spawn'),stdout:digestText}},
 nonzero:{child:{status:1,stdout:digestText}},empty:{child:{status:0,stdout:'  '}},signal:{child:{status:null,signal:'SIGTERM',stdout:digestText}},
 oversized:{child:{status:0,stdout:'a'.repeat(2000)}}
}))test('P22 '+label+' cannot PASS',()=>{const r=fixture(o).run('P22');assert.equal(r.result.state,'BLOCK');assert.equal(r.exit,1);});
const omission = '\n…（已截断，用 --full 看全）';
// Match the existing bench-digest default contract: slice(0,1200), then append its explicit marker.
const boundedDigest = (digestText + '\n' + '最近调用线索，尚未核验。'.repeat(200)).slice(0,1200) + omission;
test('P22 intentional bounded summary is WARN with unseen coverage UNKNOWN and exit 0',()=>{
 const f=fixture({child:{status:0,stdout:boundedDigest+'\n',stderr:''}}),r=f.run('P22');
 assert.equal(r.result.state,'WARN');assert.equal(r.exit,0);
 assert.match(r.output,/摘要有界省略/);assert.match(r.output,/未见部分.*UNKNOWN/);
 assert.match(r.output,/不代表.*已读/);assert.match(r.output,/世界.*UNKNOWN/);
 assert.ok(r.output.includes(boundedDigest));
 const c=f.children.filter(c=>c.argv[0]===f.script);assert.equal(c.length,1);
 assert.deepEqual(Array.from(c[0].argv),[f.script]);
});
for(const [label,child]of Object.entries({
 maxBuffer:{status:0,error:Object.assign(new Error('output buffer exceeded'),{code:'ENOBUFS'}),stdout:boundedDigest},
 boundedNonzero:{status:1,stdout:boundedDigest},
 missingTitle:{status:0,stdout:'世界身份：UNKNOWN\n覆盖：ai=UNKNOWN；tools=UNKNOWN'},
 missingCoverage:{status:0,stdout:'# 实验台摘要 · 最近 120 分钟\n世界身份：UNKNOWN\n统计：无数据'},
 missingIdentity:{status:0,stdout:'# 实验台摘要 · 最近 120 分钟\n覆盖：ai=UNKNOWN'},
 unstructured:{status:0,stdout:'任务完成'},
 unconfirmedOmission:{status:0,stdout:digestText+omission}
}))test('P22 '+label+' remains BLOCK and exit 1',()=>{
 const r=fixture({child}).run('P22');assert.equal(r.result.state,'BLOCK');assert.equal(r.exit,1);
});

test('P22 title-only SKIP before script/ledger IO and child',()=>{
 const f=fixture({title:true}),r=f.run('P22');assert.equal(r.result.state,'SKIP');assert.equal(r.exit,0);
 assert.ok(!f.io.some(p=>/bench-digest/.test(p)));assert.equal(f.children.filter(c=>c.argv[0]===f.script).length,0);
});
test('P22 postflight does not invoke digest',()=>{
 const f=fixture();assert.equal(f.run('P22','postflight').result,undefined);assert.equal(f.children.filter(c=>c.argv[0]===f.script).length,0);
});
for(const role of ['commander','learner'])test('P22 '+role+' SKIP before IO/child',()=>{
 const f=fixture({role}),r=f.run('P22');assert.equal(r.result.state,'SKIP');
 assert.ok(!f.io.some(p=>/bench-digest/.test(p)));assert.equal(f.children.filter(c=>c.argv[0]===f.script).length,0);
});

for(const xy of ['  ','!?'])test('P14 malformed XY '+JSON.stringify(xy)+' cannot hide behind usage whitelist',()=>{
 const r=p14({1:xy+' experiments/usage.jsonl\0'});
 assert.equal(r.result.state,'BLOCK');assert.equal(r.exit,1);assert.match(r.output,/UNKNOWN/);
});
for(const xy of [' M','M ','MM',' A','A ','D ',' T','T ','AM','AD','MD','TM','TD','DD','AU','UD','UA','DU','AA','UU','??','!!'])
 test('P14 legal porcelain XY '+JSON.stringify(xy)+' preserves existing usage exemption',()=>{
  assert.equal(p14({1:xy+' experiments/usage.jsonl\0'}).result.state,'PASS');
 });
