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
