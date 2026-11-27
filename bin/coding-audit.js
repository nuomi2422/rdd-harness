#!/usr/bin/env node
'use strict';
// Show the two actual receipts. No age, commit, batch-card or timer compliance lights.
const fs=require('fs'),path=require('path');
const reg=require('./lib/registry').load();
const ledger=path.join(reg._meta.root,'.harness','audit','gate-usage.jsonl');
let rows=[];
try{rows=fs.readFileSync(ledger,'utf8').split(/\r?\n/).filter(Boolean).map(s=>{try{return JSON.parse(s);}catch{return null;}}).filter(r=>r&&r.schema==='two-gates-v1');}catch{}
const checks=['preflight','postflight'].map(gate=>{
 const row=rows.filter(r=>r.gate===gate).at(-1);
 return {id:gate,label:gate==='preflight'?'安装/包件':'本次记录质量',state:row?row.result:'UNKNOWN',at:row?.at||null,detail:row?.detail||'尚无两项门禁的新回执；不是失败'};
});
if(process.argv.includes('--json'))console.log(JSON.stringify({checks},null,2));
else for(const r of checks)console.log(r.label+' '+r.state+' '+(r.at||'')+' '+r.detail);
