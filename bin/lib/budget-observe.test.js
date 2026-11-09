'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const B = require('./budget-observe');

const row = (o) => JSON.stringify(o);

test('有预算事件 → PRESENT；trimmed>0 单独计', () => {
  const r = B.build({ 'context.jsonl': [row({type:'budget_gate',data:{trimmed:10,source:'calibrated'}}), row({type:'llm_usage',data:{totalTokens:500}})].join('\n') });
  assert.equal(r.status, 'PRESENT');
  assert.equal(r.gateEvents, 1);
  assert.equal(r.trimmedEvents, 1);
  assert.equal(r.tokensTotal, 500);
});

test('坏值不当 0：单列 invalid 且状态 PARTIAL', () => {
  const r = B.build({ 'context.jsonl': [row({type:'budget_gate',data:{trimmed:'x'}}), row({type:'llm_usage',data:{totalTokens:-5}})].join('\n') });
  assert.equal(r.invalid, 2);
  assert.equal(r.trimmedTotal, 0);
  assert.equal(r.status, 'PARTIAL');
});

test('字段缺失不算坏值（旧 schema 不带预算字段）', () => {
  const r = B.build({ 'context.jsonl': [row({type:'llm_request',data:{actor:'a'}}), row({type:'budget_gate',data:{source:'calibrated'}})].join('\n') });
  assert.equal(r.invalid, 0);
  assert.equal(r.status, 'PRESENT');
});

test('完全没有预算事件 → UNKNOWN', () => {
  assert.equal(B.build({}).status, 'UNKNOWN');
  assert.deepEqual(B.build({}).reasons, ['no-budget-events']);
});

test('真实尾部：能给出 gate/trimmed/usage 计数（无数据 skip）', () => {
  const DIR = process.env.RDD_MONITOR || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
  const p = path.join(DIR, 'context.jsonl');
  if (!fs.existsSync(p)) return;
  const r = B.build({ 'context.jsonl': fs.readFileSync(p, 'utf8') });
  console.log('[真实预算] ' + JSON.stringify({ status: r.status, gate: r.gateEvents, trimmed: r.trimmedEvents, tokens: r.tokensTotal, invalid: r.invalid }));
  assert.ok(['PRESENT','PARTIAL','UNKNOWN'].includes(r.status));
});
test('shadow 模式：trimmed 要标为估算值（不能当已裁剪）', () => {
  const r = B.build({ 'context.jsonl': [row({type:'budget_gate',data:{trimmed:100,mode:'shadow',provider:'p',source:'calibrated'}})].join('\n') });
  assert.equal(r.trimmedIsEstimate, true);
  assert.deepEqual(r.byMode, { shadow: 1 });
});

test('非 shadow 模式不算估算', () => {
  const r = B.build({ 'context.jsonl': [row({type:'budget_gate',data:{trimmed:100,mode:'enforce',source:'calibrated'}})].join('\n') });
  assert.equal(r.trimmedIsEstimate, false);
});
test('一致性护栏：trimmed 大于 gateInput 要计数（不擅自解释）', () => {
  const r = B.build({ 'context.jsonl': [row({type:'budget_gate',data:{trimmed:148412,gateInput:41425,mode:'shadow',source:'calibrated'}})].join('\n') });
  assert.equal(r.trimmedGreaterThanInput, 1);
});
test('校准回退样本（source=trimmed 或 providerChanged）→ 语义标 UNKNOWN/PARTIAL', () => {
  const r1 = B.build({ 'context.jsonl': [row({type:'budget_gate',data:{trimmed:100,gateInput:30,source:'trimmed'}})].join('\n') });
  assert.equal(r1.uncalibrated, 1);
  assert.equal(r1.status, 'PARTIAL');
  assert.ok(r1.reasons.includes('uncalibrated-samples'));
  const r2 = B.build({ 'context.jsonl': [row({type:'budget_gate',data:{trimmed:100,gateInput:30,source:'calibrated',providerChanged:true}})].join('\n') });
  assert.equal(r2.uncalibrated, 1);
  assert.equal(r2.providerChanged, 1);
});
