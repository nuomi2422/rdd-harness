'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPull} = require('./monitor-reader');
const {createStopCounter} = require('./stop-counter');
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-cursor-'));
  const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
  for (const name of ['context.jsonl','ai.jsonl']) fs.writeFileSync(path.join(root,name), '');
  const reader = createPull({dir:root,evidenceDir:evidence,offsets:{'context.jsonl':0,'ai.jsonl':0}});
  return {root,evidence,reader,counter:createStopCounter(reader.pull,'2026-11-10T01:00:00Z')};
}
const event = JSON.stringify({type:'llm_request',timestamp:'2026-11-10T01:00:01Z'});
test('one physical request is counted once across repeated polls', () => {
  const {root,evidence,counter}=setup();
  fs.appendFileSync(path.join(root,'context.jsonl'),event+'\n');
  assert.equal(counter.collect(),1); assert.equal(counter.collect(),1);
  assert.equal(fs.readFileSync(path.join(evidence,'context.jsonl'),'utf8'),event+'\n');
});
test('half line is retained until completed', () => {
  const {root,counter}=setup(); const f=path.join(root,'context.jsonl');
  fs.appendFileSync(f,event); assert.equal(counter.collect(),0);
  fs.appendFileSync(f,'\n'); assert.equal(counter.collect(),1);
});
test('fractional seconds and timezone offsets compare by instant', () => {
  const {root,counter}=setup();
  const f=path.join(root,'context.jsonl');
  fs.appendFileSync(f,JSON.stringify({type:'llm_request',timestamp:'2026-11-10T00:59:59.999Z'})+'\n');
  fs.appendFileSync(f,JSON.stringify({type:'llm_request',timestamp:'2026-11-10T09:00:00+08:00'})+'\n');
  assert.equal(counter.collect(),1);
});
test('missing stream is a gap, never evidence of a complete zero', () => {
  const {root,reader,counter}=setup();
  fs.appendFileSync(path.join(root,'context.jsonl'),event+'\n'); counter.collect();
  fs.unlinkSync(path.join(root,'context.jsonl')); counter.collect();
  assert.equal(reader.gaps['context.jsonl'].reason,'missing-file');
});
