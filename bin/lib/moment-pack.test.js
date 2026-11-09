'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const MP = require('./moment-pack');

const row = (type, ts, data) => JSON.stringify({ type, timestamp: ts, data: data || {} });

test('按时刻取证：窗口内排序、带指针；窗口外不计', () => {
  const res = MP.pack({ 'tools.jsonl': row('tool_call', '2026-11-09T05:00:10Z', { tool: 'mine' }) + '\n' + row('tool_call', '2026-11-09T06:00:00Z', { tool: 'far' }),
    'events.jsonl': row('task_finished', '2026-11-09T05:00:05Z') }, '2026-11-09T05:00:00Z', { spanSec: 60 });
  assert.equal(res.status, 'PRESENT');
  assert.equal(res.total, 2, "窗口外那条不算");
  assert.equal(res.rows[0].type, "task_finished", "按时间升序");
  assert.match(MP.render(res), /tools\.jsonl:1/);
});

test('无数据/时间无效 → UNKNOWN，不编', () => {
  assert.equal(MP.pack({}, 'not-a-time', {}).status, 'UNKNOWN');
  const r = MP.pack({ 'ai.jsonl': '' }, '2026-11-09T05:00:00Z', {});
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'no-events-in-window');
});

test('不外带正文：只输出类型/工具名与指针', () => {
  const secret = 'sk-live-SHOULD-NOT-APPEAR';
  const res = MP.pack({ 'tools.jsonl': row('tool_result', '2026-11-09T05:00:01Z', { tool: 'write_file', result: { body: secret } }) }, '2026-11-09T05:00:00Z', { spanSec: 60 });
  assert.equal(MP.render(res).includes(secret), false);
  assert.equal(JSON.stringify(res).includes(secret), false, 'JSON 也不得带正文');
});
