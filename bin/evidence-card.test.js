'use strict';
// 证据卡：三个来源各自独立判定，缺数据一律 UNKNOWN（不写"没问题"）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCard, render } = require('./evidence-card');

const call = JSON.stringify({ type: 'tool_call', session: 'run-1', data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1' } });
const result = JSON.stringify({ type: 'tool_result', session: 'run-1', data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1', result: { success: true } } });
const finalReq = JSON.stringify({ type: 'final_request', data: { companion_id: 'c', requestKind: 'execute', turn: 1,
  rationalePresent: true, whyPresent: true, whyStatus: 'PRESENT', risksPresent: true, sourcePresent: true,
  conditionsPresent: false, rationaleSource: 'x' } });
const settled = JSON.stringify({ type: 'primary_settled_by_fact', data: { companionId: 'c', primary: 'p', verified: true, verify_final_goal: true, unmet: [] } });

test('空目录：三项全 UNKNOWN 且列出缺口', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const card = buildCard(d);
  assert.equal(card.actions.status, 'UNKNOWN');
  assert.equal(card.finalRequest.status, 'UNKNOWN');
  assert.equal(card.settle.status, 'UNKNOWN');
  assert.ok(card.reasons.length >= 3);
});

test('有数据：动作/最终请求/结算分别判定，互不背书', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec2-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'tools.jsonl'), call + '\n' + result + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  fs.writeFileSync(path.join(d, 'context.jsonl'), finalReq + '\n');
  fs.writeFileSync(path.join(d, 'rdd.jsonl'), settled + '\n');
  const card = buildCard(d);
  // 没有身份解析器时，账本**不把 call 与 result 合并**（fail-closed），所以 2 行 → 2 条调用。
  // 这不是 evidence-card 的问题，而是"身份未证"的真实后果：调用数会被拆开、终态也拼不起来。
  assert.equal(card.actions.calls, 2);
  assert.equal(card.actions.identityKnown, '0/2');
  // 关键语义：原始流有数据 ≠ 可归属；身份 0/2 时 attributable 必须是 UNKNOWN
  assert.equal(card.actions.status, 'RAW_PRESENT');
  assert.equal(card.actions.attributable, 'UNKNOWN');
  assert.ok(card.actions.semantics.includes('NOT attributable'));
  assert.equal(card.finalRequest.status, 'PRESENT');
  assert.equal(card.settle.status, 'PRESENT');
  assert.ok(render(card).includes('[最终请求] PRESENT'));
});
test('读取异常（tools.jsonl 是目录）→ 记 log-gap，不静默', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec3-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, 'tools.jsonl'));
  const card = buildCard(d);
  assert.ok(card.reasons.includes('log-gap'), '必须显式记缺口');
  assert.equal(card.actions.status, 'UNKNOWN');
  assert.ok(render(card).includes('[读取缺口]'));
});
test('跨进程：同 callId、不同信封 session → 必须算两次调用，不能合并', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec4-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const row = (run) => JSON.stringify({ type: 'tool_call', session: run, data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: 'same' } });
  fs.writeFileSync(path.join(d, 'tools.jsonl'), row('run-A') + '\n' + row('run-B') + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  const card = buildCard(d);
  assert.equal(card.actions.calls, 2, '不同进程的运行号必须分开');
});

test('迟到 + 无身份：不能配对（这正是缺身份的代价，不得当成"配对成功"）', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec5-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'tools.jsonl'), result + '\n' + call + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  const card = buildCard(d);
  // 没有独立身份时账本不合并行，所以这里**配不上**是正确行为；配得上才是假绿。
  assert.equal(card.actions.states.completed || 0, 0);
  assert.equal(card.actions.identityKnown, '0/2');
  assert.equal(card.actions.attributable, 'UNKNOWN');
});
test('缺流：没有 context.jsonl → 最终请求 UNKNOWN，不是"没有 why"', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec6-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'tools.jsonl'), call + '\n');
  const card = buildCard(d);
  assert.equal(card.finalRequest.status, 'UNKNOWN');
  assert.ok(card.sources.context === 'missing');
});

test('窗口范围无条件可见：即使覆盖等级是 limited，也带 observedWindow', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec7-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'tools.jsonl'), call + '\n' + result + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  const card = buildCard(d);
  assert.ok(card.observedWindow, '必须带观测窗');
  assert.equal(card.observedWindow.scope, 'observed-bytes-only');
  assert.ok(render(card).includes('非业务时间完整') || render(card).includes('字节窗口'));
});
