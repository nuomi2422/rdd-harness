'use strict';
// 2026-11-11: explicit temporary slices only; never run runner/judge CLI/backfill or touch live logs.
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const A0 = require('./a0-evidence');
const { evaluate } = require('../exp-judge');
const root = process.argv[2];
if (!root || fs.existsSync(root)) throw new Error('supply a NEW explicit temporary test directory');
fs.mkdirSync(root, { recursive: true });
const start = '2026-11-11T00:00:00Z';
const stamp = { world_id: 'w', server_session: 's', timestamp: '2026-11-11T00:00:01Z' };
let seq = 0, passed = 0;
const event = (type, data, extra = {}) => ({...stamp, event_id: 'e' + (++seq), type, data, ...extra});
const toolPair = (actor, companion = 'A', tool = 'rdd_replan_chain', id = 'call-1') => [
 event('tool_call', {companion_id: companion, tool_call_id: id, tool, ...(actor ? {actor} : {})}),
 event('tool_result', {companion_id: companion, tool_call_id: id, tool, success: true, ...(actor ? {actor} : {})})];
function run(name, options = {}, mutate) {
 const dir = path.join(root, name), evidence = path.join(dir, 'evidence'), companions = path.join(dir, 'companions');
 fs.mkdirSync(evidence, {recursive: true}); fs.mkdirSync(path.join(companions, 'A'), {recursive: true});
 const contract = path.join(dir, 'contract.json'); fs.writeFileSync(contract, '{}');
 const env = {runId: name, phase: 'done', contract: {path: contract, sha256: crypto.createHash('sha256').update('{}').digest('hex'), revision: 'COV-S5'},
   stopScopeFrozen: {authority: 'enqueue-receipt', worldId: 'w', serverSession: 's', companionId: 'A'}, timings: {launchStart: start}};
 fs.writeFileSync(path.join(dir, 'envelope.json'), JSON.stringify(env));
 fs.writeFileSync(path.join(companions, 'A', 'chat.jsonl'), JSON.stringify({role:'user',ts:Date.parse(start)+1,content:'new'})+'\n');
 const rows = { 'context.jsonl': [event('llm_request', {request:{messages:[{role:'user',content:'new'}]}})],
   'expmem.jsonl': [], 'rdd.jsonl': options.admin || [], 'tools.jsonl': options.tools || []};
 for (const [file, values] of Object.entries(rows)) {
   if (options.missing === file) continue;
   fs.writeFileSync(path.join(evidence,file), values.map(v => JSON.stringify(v)).join('\n') + (values.length ? '\n' : '')
     + (options.bad === file ? '{bad-json\n' : '') + (options.half === file ? '{"partial":' : '')
     + (options.unterminated === file ? JSON.stringify(event('diagnostic', {})) : '')
     + (options.scalar === file ? 'null\n' : ''));
 }
 const collected = A0.collect({runDir:dir, companionsDir:companions, monitorDir:null, launchStart:start});
 let merged = A0.applyToEnvelope(env, collected);
 if (mutate) mutate(merged);
 fs.writeFileSync(path.join(dir,'envelope.json'),JSON.stringify(merged));
 const verdict = evaluate(dir).assertions.find(x => x.id === 'S5');
 const gate = A0.gateVerdict('PASS',merged);
 fs.writeFileSync(path.join(dir,'isolated-result.json'),JSON.stringify({collected,verdict,gate},null,2));
 return {collected,merged,verdict,gate};
}
function check(name, options, expect, mutate, extra) {
 const r = run(name, options, mutate);
 assert.equal(r.verdict.verdict, expect, name + ': judge');
 assert.equal(r.gate.overall, expect === 'PASS' ? 'PASS' : 'INCONCLUSIVE', name + ': gate');
 if(extra) extra(r);
 passed++; console.log('PASS '+name);
}
check('complete-clean-zero',{},'PASS');
for (const field of ['session','interventions','context_delivery']) {
 check('missing-'+field,{},'INCONCLUSIVE',e=>delete e[field]);
 check('empty-'+field,{},'INCONCLUSIVE',e=>e[field]={});
 check('unknown-enum-'+field,{},'INCONCLUSIVE',e=>e[field].status='MAGIC');
}
check('delivery-status-only',{},'INCONCLUSIVE',e=>e.context_delivery={status:'NONE'});
check('present-zero',{},'INCONCLUSIVE',e=>e.interventions.status='PRESENT');
check('missing-a0',{},'INCONCLUSIVE',e=>delete e.a0);
check('only-a0',{},'INCONCLUSIVE',e=>{delete e.session;delete e.interventions;delete e.context_delivery;});
check('rejected-only',{admin:[event('admin_command_used',{mode:'direct-give',companionId:'A'},{timestamp:undefined})]},'INCONCLUSIVE',null,r=>assert.equal(r.collected.interventions.status,'UNKNOWN'));
for(const stream of ['rdd.jsonl','tools.jsonl','context.jsonl','expmem.jsonl']) {
 check('missing-'+stream,{missing:stream},'INCONCLUSIVE');
 check('bad-'+stream,{bad:stream},'INCONCLUSIVE');
 check('half-'+stream,{half:stream},'INCONCLUSIVE');
}
check('admin-positive-plus-gap',{admin:[event('admin_command_used',{mode:'direct-give',companionId:'A'})],bad:'tools.jsonl'},'INCONCLUSIVE',null,r=>{
 assert.equal(r.collected.interventions.status,'PRESENT');assert.match(r.verdict.detail,/已证介入/);assert(r.collected.interventions.reasons.length);
});
check('unknown-external-replan',{tools:toolPair(null,'A','rdd_replan_chain','mcp-123')},'INCONCLUSIVE');
check('confirmed-human-replan',{tools:toolPair('HUMAN')},'INCONCLUSIVE',null,r=>assert.equal(r.collected.interventions.status,'PRESENT'));
check('automatic-replan',{tools:toolPair('numen')},'PASS',null,r=>assert.equal(r.collected.interventions.automatic.length,1));
check('automatic-standard-tools',{tools:['rdd_status','rdd_save','task_stop'].flatMap((t,i)=>toolPair('HARNESS','A',t,'auto-'+i))},'PASS');
const automatic = toolPair('numen');
check('exact-duplicate-result',{tools:[...automatic,automatic[1]]},'PASS',null,r=>assert.equal(r.collected.interventions.automatic.length,1));
check('conflicting-results',{tools:[...automatic,event('tool_result',{...automatic[1].data,success:false})]},'INCONCLUSIVE');
check('other-companion-not-attributed',{tools:toolPair('HUMAN','B')},'PASS',null,r=>assert.equal(r.collected.interventions.count,0));
check('other-world-not-attributed',{tools:toolPair('HUMAN').map(e=>({...e,world_id:'other'}))},'PASS');
check('missing-scope',{tools:toolPair('HUMAN').map(e=>({...e,server_session:null}))},'INCONCLUSIVE');
check('admin-positive-and-missing-block',{admin:[event('admin_command_used',{mode:'direct-give',companionId:'A'})]},'INCONCLUSIVE',e=>delete e.session,r=>assert.match(r.verdict.detail,/已证介入/));
check('human-positive-conflicting-result',{tools:[...toolPair('HUMAN'),event('tool_result',{companion_id:'A',tool_call_id:'call-1',tool:'rdd_replan_chain',success:false,actor:'HUMAN'})]},'INCONCLUSIVE',null,r=>assert.equal(r.collected.interventions.status,'PRESENT'));
check('human-status-not-name-exempt',{tools:toolPair('HUMAN','A','rdd_status')},'INCONCLUSIVE',null,r=>assert.equal(r.collected.interventions.status,'PRESENT'));
check('null-row',{scalar:'tools.jsonl'},'INCONCLUSIVE');
check('valid-json-without-line-end',{unterminated:'tools.jsonl'},'INCONCLUSIVE');
console.log('RESULT '+passed+'/'+passed+'; scope=temporary collect->apply->evaluate+gate, not live runner');
