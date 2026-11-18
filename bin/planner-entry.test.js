'use strict';
// P18 regression: a bounded tail read must not report "never planned" when the
// planner event may simply sit before the window. Full coverage keeps old verdicts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pe = require('./lib/planner-entry.js');

const SINCE = new Date('2026-11-16T20:00:00.000Z');
const at = '2026-11-16T20:33:12.705Z';
const scope = {session:'jvm-1',world_id:'live',server_session:'server-1',world_epoch:1};
const ids = {companionId:'RDD-1',taskId:'goal-1'};
function ev(type,data={},envelope={}){return JSON.stringify({timestamp:at,type,data,...envelope})+'\n';}
function snap(reason,data={},envelope={}){return ev('taskchain_snapshot',{reason,...ids,...data},{...scope,...envelope});}
function scan(lines,maxBytes){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'planner-entry-'));
 try{fs.writeFileSync(path.join(dir,'rdd.jsonl'),lines.join(''));return pe.scan(SINCE,{dir,maxBytes});}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('same chain Stage-A snapshot is planner proof; intake is not required',()=>{
 assert.equal(scan([snap('goal_staged')]).verdict,'PLANNED');
 assert.equal(scan([ev('supervisor_input',{source:'goal_sink'}),snap('goal_staged')]).verdict,'PLANNED');
 assert.equal(scan([ev('supervisor_input',{source:'goal_sink'}),ev('goal_staged',{stages:4})]).verdict,'UNKNOWN');
});
test('legacy bind without source is never sufficient to demand replacing that chain',()=>{
 assert.equal(scan([ev('taskchain_snapshot',{reason:'task_bound'})]).verdict,'UNKNOWN');
 assert.equal(scan([snap('task_bound')]).verdict,'UNKNOWN');
 assert.equal(scan([snap('task_bound'),ev('supervisor_input',{source:'rdd_supervisor_submit'})]).verdict,'UNKNOWN');
});
test('explicit direct bind in one complete scoped window remains BYPASSED',()=>{
 assert.equal(scan([snap('task_bound',{source:'rdd_submit'})]).verdict,'BYPASSED');
 assert.equal(scan([snap('task_bound',{source:'rdd_submit'}),snap('goal_staged')]).verdict,'UNKNOWN');
});
test('different server, world, companion and chain cannot certify one another',()=>{
 for(const d of [{taskId:'goal-2'},{companionId:'RDD-2'}])assert.equal(scan([snap('goal_staged'),snap('task_bound',{...d,source:'rdd_submit'})]).verdict,'UNKNOWN');
 for(const loc of [{world_id:'test'},{server_session:'server-2'},{session:'jvm-2'},{world_epoch:2}])assert.equal(scan([snap('goal_staged'),snap('task_bound',{source:'rdd_submit'},loc)]).verdict,'UNKNOWN');
 assert.equal(scan([snap('goal_staged',{}, {stamp_conflict:true})]).verdict,'UNKNOWN');
});
test('truncated tail cannot prove bypass; a same-scope Stage-A snapshot stays positive',()=>{
 const head=ev('note',{text:'中文边界'}), direct=snap('task_bound',{source:'rdd_submit'}), staged=snap('goal_staged');
 assert.equal(scan([head,direct],Buffer.byteLength(direct)).verdict,'UNKNOWN');
 const r=scan([head,staged],Buffer.byteLength(staged)+2);
 assert.equal(r.verdict,'PLANNED');assert.equal(r.coverage.truncated,true);
 assert.equal(scan([head,ev('rdd_loop')],5).verdict,'UNKNOWN');
});
test('missing file stays NO_DATA, no chain and malformed rows do not error',()=>{
 assert.equal(pe.scan(SINCE,{dir:path.join(os.tmpdir(),'planner-entry-missing-'+Date.now())}).verdict,'NO_DATA');
 assert.equal(scan([ev('rdd_loop')]).verdict,'NO_CHAIN');
 assert.equal(scan(['{broken}\n',snap('goal_staged')]).verdict,'PLANNED');
});
