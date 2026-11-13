'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'harness-gate.js'),'utf8');
const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../registry.json'),'utf8'));
function fixture(){
 const logs=[],reads=[],children=[];const reg=JSON.parse(JSON.stringify(raw));
 const fakeFs={existsSync:()=>false,readFileSync:p=>{reads.push(p);throw Error('missing')},mkdirSync(){},appendFileSync(){},statSync(){throw Error('missing')},accessSync(){throw Error('missing')},readdirSync:()=>[]};
 const box=vm.createContext({__dirname,process:{argv:['node','gate','round'],env:{}},console:{log:(...x)=>logs.push(x.join(' ')),error(){}},
 require(n){if(n==='fs')return fakeFs;if(n==='path')return path;if(n==='child_process')return{spawnSync:(...x)=>children.push(x)};
 if(n==='./lib/commander-gates.js')return{lastMcpCall:()=>({at:0}),lastArchScan:()=>({known:false})};
 if(n==='./lib/registry.js')return{load:()=>reg};return{};}});
 vm.runInContext(source.slice(0,source.lastIndexOf('try { process.exit(main()); }'))+'\nREG=registryLib.load();globalThis.api={record,verdict,roundGates,results};',box);
 return {...box.api,logs,reads,children};
}
for(const [id,state,exit] of [['P13','BLOCK',1],['P11','WARN',0],['P12','ASK',0],['P22','SKIP',0],['unregistered','BLOCK',1]])
test('summary and exit agree '+id+' '+state,()=>{const f=fixture();f.record(id,'fixture','block','artifact',state,'fixture');assert.equal(f.verdict(),exit);
 assert.match(f.logs.join('\n'),exit?/GK-0.*BLOCK[\s\S]*VERDICT=BLOCKED/:/GK-0.*无 BLOCK[\s\S]*VERDICT=PASS/);
 assert.doesNotMatch(f.logs.join('\n'),/必须你亲自.*点头/);});
test('round missing evidence never invents live status or mtime blockers',()=>{
 const f=fixture();f.roundGates();assert.equal(f.results.length,11);assert.ok(f.results.every(x=>['WARN','SKIP'].includes(x.state)));
 assert.equal(f.verdict(),0);assert.ok(!f.reads.some(p=>/goal-keeper|schedule.json/.test(p)));assert.equal(f.children.length,0);
});
test('P11 uses current entry checks, never retired stager scripts',()=>{
 const start=source.indexOf('// 2026-11-13：stage已于11-06退役');
 const end=source.indexOf('// P12',start);
 const block=source.slice(start,end);
 assert.match(block,/入口.md/);assert.doesNotMatch(block,/spawnSync|check-align.js|check-global.js/);
});
