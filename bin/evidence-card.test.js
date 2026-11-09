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
test('隐私：输出不得泄漏 payload 正文/凭据', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec8-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const SECRET = 'sk-live-DEADBEEF-not-for-output';
  const row = JSON.stringify({ type: 'tool_result', session: 'run-1', data: {
    companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1',
    result: { success: true, data: { api_key: SECRET, body: 'SECRET-PROMPT-TEXT' } } } });
  fs.writeFileSync(path.join(d, 'tools.jsonl'), row + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  const card = buildCard(d);
  const text = render(card);
  const json = JSON.stringify(card);
  assert.ok(!text.includes(SECRET) && !json.includes(SECRET), '渲染与 JSON 都不得含凭据');
  assert.ok(!text.includes('SECRET-PROMPT-TEXT') && !json.includes('SECRET-PROMPT-TEXT'), '不得含正文');
});
test('回归守护：exp-runner 不得私接 resolver（身份未证，接了就是假绿）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'exp-runner.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/resolveIdentity/.test(code), '若将来要接 resolver，必须先满足事件绑定+可信来源，并同步改这条测试');
});
test('时间窗过滤：只统计窗口内事件，窗口外不计', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec9-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const row = (ts, id) => JSON.stringify({ type: 'tool_call', session: 'run-1', timestamp: ts,
    data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: id } });
  fs.writeFileSync(path.join(d, 'tools.jsonl'),
    row('2026-11-09T05:30:00Z', 'a') + '\n' + row('2026-11-09T08:30:00Z', 'b') + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  const all = buildCard(d);
  const win = buildCard(d, { since: '2026-11-09T05:00:00Z', until: '2026-11-09T06:00:00Z' });
  assert.equal(all.actions.calls, 2);
  assert.equal(win.actions.calls, 1, '时间窗内应只算 1 条');
});
test('时间窗语义：冲突/无时区/无效时间都保留并标记，不静默丢', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec10-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const mk = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(d, 'tools.jsonl'), [
    mk({ type: 'tool_call', session: 'r', timestamp: '2026-11-09T05:30:00Z', at: '2026-11-09T09:30:00Z', data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: 'conflict' } }),
    mk({ type: 'tool_call', session: 'r', timestamp: '2026-11-09T05:31:00', data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: 'naive' } }),
    mk({ type: 'tool_call', session: 'r', timestamp: 'not-a-time', data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: 'bad' } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  const card = buildCard(d, { since: '2026-11-09T05:00:00Z', until: '2026-11-09T06:00:00Z' });
  assert.equal(card.window.conflicts, 1, '双字段冲突要计数');
  assert.equal(card.window.ambiguous, 1, '无时区要计数');
  assert.equal(card.window.invalidOrMissing, 1, '无效时间要计数');
  assert.ok(card.reasons.includes('window-filtered'));
  assert.ok(card.reasons.includes('time-conflict'));
});

test('时间窗边界：闭区间两端都算在内', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec11-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const mk = (ts, id) => JSON.stringify({ type: 'tool_call', session: 'r', timestamp: ts, data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: id } });
  fs.writeFileSync(path.join(d, 'tools.jsonl'), mk('2026-11-09T05:00:00Z', 'a') + '\n' + mk('2026-11-09T06:00:00Z', 'b') + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  const card = buildCard(d, { since: '2026-11-09T05:00:00Z', until: '2026-11-09T06:00:00Z' });
  assert.equal(card.actions.calls, 2, '闭区间应包含两端');
});

test('筛选会拆开 call/result：结论只能是 PARTIAL/UNKNOWN，不得当无失败证明', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec12-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const callRow = JSON.stringify({ type: 'tool_call', session: 'r', timestamp: '2026-11-09T05:30:00Z', data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1' } });
  const resRow = JSON.stringify({ type: 'tool_result', session: 'r', timestamp: '2026-11-09T07:30:00Z', data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1', result: { success: true } } });
  fs.writeFileSync(path.join(d, 'tools.jsonl'), callRow + '\n' + resRow + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  const win = buildCard(d, { since: '2026-11-09T05:00:00Z', until: '2026-11-09T06:00:00Z' });
  assert.equal(win.actions.calls, 1);
  assert.ok(win.reasons.includes('window-filtered'));
  assert.equal(win.actions.attributable, 'UNKNOWN', '不得因窗口内没有失败就当作正常');
});
test('守门：没有任何生产消费者把 RAW_PRESENT / 字段自洽 当通过', () => {
  const dir = __dirname;
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
    if (name === 'evidence-card.js') continue; // 定义处
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\//.test(l)).join('\n');
    if (/RAW_PRESENT/.test(code)) offenders.push(name + ':RAW_PRESENT');
    // bench.js 是**只打印**的入口（允许 import）；门禁/验收/执行器不允许接证据卡。
    const passThrough = new Set(['bench.js']);
    const forbidden = new Set(['harness-gate.js', 'acceptance.js', 'exp-runner.js', 'regress.js']);
    if (!passThrough.has(name) && forbidden.has(name) && /require\(['"]\.\/evidence-card/.test(code)) {
      offenders.push(name + ':imports-evidence-card');
    }
  }
  assert.deepEqual(offenders, [], '只允许 bench evidence 打印，不允许任何门禁/验收把它当通过条件');
});
test('总判定：真实数据上只能是 UNKNOWN（身份不可归属），不会因有数据而 PRESENT', (t) => {
  const V = require('./lib/evidence-verdict');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec13-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'tools.jsonl'), call + '\n' + result + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  const card = buildCard(d);
  const v = V.buildVerdict(card, null);
  assert.equal(v.verdict, 'UNKNOWN');
  assert.ok(v.reasons.includes('identity-not-attributable'));
});
test('一致性：证据卡的观测窗与 monitor-reader.verifyWindow 必须同判', (t) => {
  const MR = require('./lib/monitor-reader');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec14-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'tools.jsonl'), call + '\n' + result + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  const card = buildCard(d);
  const r = MR.createPull({ dir: d });
  r.pull('tools.jsonl');
  r.pull('events.jsonl');
  const w = r.verifyWindow(['tools.jsonl', 'events.jsonl']);
  assert.equal(card.observedWindow.ok, !!w.ok, '两处对"窗口是否完整"必须一致');
  assert.deepEqual(Object.keys(card.observedWindow.files || {}).sort(), Object.keys(w.files || {}).sort(), '覆盖的流必须一致');
});
