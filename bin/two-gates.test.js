'use strict';
// Tests use temporary jars/records and stub verifier calls, never the live game.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const g=require('./harness-gate');
function fixture(fn){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rdd-two-gates-'));
 const reg={_meta:{root},roots:{live:path.join(root,'game'),numen:path.join(root,'src'),knowledge:path.join(root,'knowledge'),scripts:path.join(root,'scripts')}};
 const mods=path.join(reg.roots.live,'mods');fs.mkdirSync(mods,{recursive:true});fs.mkdirSync(reg.roots.knowledge);
 const jar=(name,entries=['a.class'])=>fs.writeFileSync(path.join(mods,name),JSON.stringify(entries));
 const zip={listEntries:b=>JSON.parse(b.toString()).map(name=>({name})),check:()=>({ok:true,missing:[]})};
 jar('numen-api.jar');
 const run=()=>({status:0,stdout:'VERDICT=DEPLOYED',stderr:''});
 const record=(body,file='record.md')=>{const f=path.join(reg.roots.knowledge,file);fs.writeFileSync(f,'---\ndocId: test\nkind: record\nstatus: current\nupdatedAt: 2026-11-21\n---\n'+body);return f;};
 try{fn({root,reg,mods,jar,zip,run,record});}finally{
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('rdd-two-gates-'));
  fs.rmSync(root,{recursive:true,force:true});
 }
}
const body='## 本次\n时间：2026-11-21 run-test\n目标/判据：睡眠跨夜\n实际动作：调用sleep后检查世界时间\n原证：退出码0，已封存运行日志\n结论：UNKNOWN，缺少跨夜事件，下次补证。\n';
test('current installed deployment checked without role, commit, timer or workflow prerequisites',()=>fixture(({reg,zip,run})=>{
 const out=g.preflight(reg,['--role','worker','--since','2020-01-01'],{zip,run});
 assert.equal(out.state,'PASS');assert.equal(out.id,'DEPLOY');
}));
test('failed/empty/stale/error verifier output cannot pass even with retired skip flags',()=>fixture(({reg,zip})=>{
 for(const response of [{status:0,stdout:''},{status:0,stdout:'VERDICT=STALE'},{status:2,stdout:'VERDICT=DEPLOYED'},{status:null,stdout:''}])
  assert.throws(()=>g.preflight(reg,['--skip-check','DEPLOY','--skip-reason','ignore'],{zip,run:()=>response}),/核验未通过/);
}));
test('corrupted or empty jar and duplicate mixin still rejected',()=>fixture(({mods,jar,zip})=>{
 jar('numen-api.jar',[]);assert.throws(()=>g.packages(mods,zip),/没有class/);
 jar('numen-api.jar',['a/mixin/MixinA.class']);jar('numen-plugin-x.jar',['a/mixin/MixinA.class']);
 assert.throws(()=>g.packages(mods,zip),/重复mixin/);
 fs.writeFileSync(path.join(mods,'numen-api.jar'),'bad');
 assert.throws(()=>g.packages(mods,zip));
}));
test('explicit old-version target uses matching instance and hash, not latest-source age',()=>fixture(({reg,mods,root,zip,jar})=>{
 const target=path.join(root,'expected.json');
 const sha=crypto.createHash('sha256').update(fs.readFileSync(path.join(mods,'numen-api.jar'))).digest('hex');
 fs.writeFileSync(target,JSON.stringify({instance:reg.roots.live,jars:[{file:'numen-api.jar',sha256:sha}]}));
 assert.equal(g.preflight(reg,['--manifest',target],{zip,run:()=>{throw Error('must not inspect newer source');}}).state,'PASS');
 jar('numen-plugin-extra.jar');
 assert.throws(()=>g.preflight(reg,['--manifest',target],{zip}),/集合/);
 fs.rmSync(path.join(mods,'numen-plugin-extra.jar'));
 fs.writeFileSync(target,JSON.stringify({instance:reg.roots.live,jars:[{file:'numen-api.jar',sha256:'0'.repeat(64)}]}));
 assert.throws(()=>g.preflight(reg,['--manifest',target],{zip}),/哈希不符/);
 fs.writeFileSync(target,JSON.stringify({instance:root,jars:[{file:'numen-api.jar',sha256:sha}]}));
 assert.throws(()=>g.preflight(reg,['--manifest',target],{zip}),/实例/);
}));
test('missing referenced class blocks explicit package baseline',()=>fixture(({reg,mods,root,zip})=>{
 const target=path.join(root,'expected.json'),sha=crypto.createHash('sha256').update(fs.readFileSync(path.join(mods,'numen-api.jar'))).digest('hex');
 fs.writeFileSync(target,JSON.stringify({instance:reg.roots.live,jars:[{file:'numen-api.jar',sha256:sha}]}));
 assert.throws(()=>g.preflight(reg,['--manifest',target],{zip:{...zip,check:()=>({ok:false,missing:['Gone']})}}),/缺失/);
}));
test('postflight without record reminds and never certifies documentation',()=>fixture(({reg})=>{
 assert.equal(g.postflight(reg,[]).state,'REMINDER');
}));
test('honest unknown result with actionable four fields is accepted without memory/index fanout',()=>fixture(({reg,record})=>{
 const f=record(body);assert.equal(g.recordQuality(f,reg.roots.knowledge,'本次').state,'PASS');
}));
test('previous valid run cannot mask missing current fields or unfinished placeholders',()=>fixture(({reg,record})=>{
 const f=record(body+'\n## 新一轮\n时间：2026-11-21\n结论：PASS\n');
 assert.throws(()=>g.recordQuality(f,reg.roots.knowledge,'新一轮'),/缺少/);
 const p=record(body.replace('调用sleep后检查世界时间','TODO'),'todo.md');
 assert.throws(()=>g.recordQuality(p,reg.roots.knowledge,'本次'),/占位/);
 assert.throws(()=>g.recordQuality(f,reg.roots.knowledge,'不存在'),/找不到/);
}));
test('multi-section record requires an explicit current section',()=>fixture(({reg,record})=>{
 const f=record(body+'\n## 新一轮\n时间：2026-11-21\n结论：PASS\n');
 assert.throws(()=>g.recordQuality(f,reg.roots.knowledge),/--section/);
 assert.equal(g.recordQuality(f,reg.roots.knowledge,'本次').state,'PASS');
}));
test('record outside knowledge or missing metadata cannot pass',()=>fixture(({root,reg,record})=>{
 const outside=path.join(root,'outside.md');fs.writeFileSync(outside,body);
 assert.throws(()=>g.recordQuality(outside,reg.roots.knowledge),/知识库/);
 const f=record(body);fs.writeFileSync(f,body);
 assert.throws(()=>g.recordQuality(f,reg.roots.knowledge),/元数据/);
}));
test('explicit PASS requires actual source position, not just self-declaration',()=>fixture(({reg,record})=>{
 const f=record(body.replace('UNKNOWN，缺少跨夜事件，下次补证。','PASS，成功。').replace('退出码0，已封存运行日志','看见了'));
 assert.throws(()=>g.recordQuality(f,reg.roots.knowledge),/缺原始/);
}));
test('JSONL evidence check only receives current section and propagates failed anchors',()=>fixture(({reg,record})=>{
 const f=record('## 旧一轮\n坏引用 old.jsonl:999\n'+body.replace('退出码0，已封存运行日志','tools.jsonl:2'));
 let called=0;
 const run=(exe,args)=>{
  called++;const text=fs.readFileSync(path.join(args[args.indexOf('--cards')+1],'record.md'),'utf8');
  assert.ok(text.includes('tools.jsonl:2'));assert.equal(text.includes('old.jsonl'),false);
  return {status:0,stdout:JSON.stringify({hard:[],warn:[],total:1})};
 };
 assert.equal(g.postflight(reg,['--record',f,'--section','本次'],{run}).state,'PASS');
 assert.equal(called,1);
 assert.throws(()=>g.postflight(reg,['--record',f,'--section','本次'],{run:()=>({status:2,stdout:'bad coordinate'})}),/未对上/);
}));
test('retired supervision and learning gates ignore old prerequisites',()=>{
 for(const phase of ['round','learn','code','precommit'])assert.equal(g.main([phase],{reg:{}}),0);
});
test('title-only diagnostic never reads live deployment',()=>{
 assert.equal(g.main(['preflight','--instance','test','--title-only'],{reg:{}}),2);
});
