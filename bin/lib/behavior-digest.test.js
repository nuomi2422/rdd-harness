'use strict';
// 行为摘要：必须能检出异常、带来源行号、限额 1200 字。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const BD = require('./behavior-digest');

const L = (o) => JSON.stringify(o);
const ts = (min) => new Date(Date.UTC(2026, 10, 9, 6, min, 0)).toISOString();

test('检出重复失败/连续只读/死亡/原地打转，并带行号', () => {
  const tools = [
    L({ type: 'tool_call', timestamp: ts(0), data: { tool: 'get_self_status', tool_call_id: '1' } }),
    L({ type: 'tool_result', timestamp: ts(1), data: { tool: 'mine', tool_call_id: '1', success: false } }),
    L({ type: 'tool_result', timestamp: ts(2), data: { tool: 'mine', tool_call_id: '2', success: false } }),
    L({ type: 'tool_result', timestamp: ts(3), data: { tool: 'mine', tool_call_id: '3', success: false } }),
  ].join('\n');
  const events = [L({ type: 'death', timestamp: ts(4), data: { companion_id: 'c' } })].join('\n');
  const rdd = [
    L({ type: 'taskchain_snapshot', timestamp: ts(5), data: { phase: 'RUNNING', state: 'X' } }),
    L({ type: 'taskchain_snapshot', timestamp: ts(6), data: { phase: 'RUNNING', state: 'X' } }),
    L({ type: 'taskchain_snapshot', timestamp: ts(7), data: { phase: 'RUNNING', state: 'X' } }),
  ].join('\n');
  const res = BD.buildDigest({ tools, events, rdd, ai: '', sinceMs: Date.UTC(2026, 10, 9, 5, 0, 0), untilMs: Date.UTC(2026, 10, 9, 7, 0, 0) });
  assert.match(res.text, /重复失败 mine×3/);
  assert.match(res.text, /死亡事件 1 次/);
  assert.match(res.text, /原地打转/);
  assert.match(res.text, /tools\.jsonl:\d+/);
  assert.ok(res.text.length <= BD.LIMIT, '不得超过 1200 字');
});

test('窗口内无异常 → 明确写 UNKNOWN，而不是"一切正常"', () => {
  const res = BD.buildDigest({ ai: '', tools: '', events: '', rdd: '', sinceMs: 0, untilMs: Date.now() });
  assert.match(res.text, /异常：UNKNOWN/);
});
test('脱敏：输出不得含正文/参数/凭据（只允许元信息+指针）', () => {
  const SECRET = 'sk-live-SHOULD-NOT-APPEAR';
  const tools = [
    L({ type: 'tool_call', timestamp: ts(0), data: { tool: 'write_file', tool_call_id: '1', args_preview: 'PASSWORD=' + SECRET } }),
    L({ type: 'tool_result', timestamp: ts(1), data: { tool: 'write_file', tool_call_id: '1', success: true, result: { data: { body: SECRET } } } }),
  ].join('\n');
  const ai = L({ type: 'assistant', timestamp: ts(2), data: { text: '任务正文 ' + SECRET } });
  const res = BD.buildDigest({ tools, ai, events: '', rdd: '', sinceMs: 0, untilMs: Date.now() });
  assert.equal(res.text.includes(SECRET), false, '不得泄漏凭据/正文');
  assert.match(res.text, /assistant 文本 \d+ 字/);
});

test('阈值边界：同工具失败 2 次不报，3 次才报', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) =>
    L({ type: 'tool_result', timestamp: ts(i), data: { tool: 'mine', tool_call_id: String(i), success: false } })).join('\n');
  const base = { ai: '', events: '', rdd: '', sinceMs: Date.UTC(2026, 10, 9, 5, 0, 0), untilMs: Date.UTC(2026, 10, 9, 7, 0, 0) };
  assert.doesNotMatch(BD.buildDigest({ ...base, tools: mk(2) }).text, /重复失败/);
  assert.match(BD.buildDigest({ ...base, tools: mk(3) }).text, /重复失败 mine×3/);
});

test('坏行/缺文件不崩', () => {
  const res = BD.buildDigest({ ai: 'not-json\n' + L({ type: 'assistant', data: { text: 'x' } }), tools: undefined, events: null, rdd: '', sinceMs: 0, untilMs: Date.now() });
  assert.ok(res.text.length > 0);
});

test('窗口边界：闭区间两端都算', () => {
  const a = Date.UTC(2026, 10, 9, 6, 0, 0), b = Date.UTC(2026, 10, 9, 6, 30, 0);
  const tools = [L({ type: 'tool_call', timestamp: new Date(a).toISOString(), data: { tool: 'x', tool_call_id: '1' } }),
    L({ type: 'tool_call', timestamp: new Date(b).toISOString(), data: { tool: 'y', tool_call_id: '2' } })].join('\n');
  const res = BD.buildDigest({ tools, ai: '', events: '', rdd: '', sinceMs: a, untilMs: b });
  assert.equal(res.counts.did, 2);
});
