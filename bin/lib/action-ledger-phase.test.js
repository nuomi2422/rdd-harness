'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('./action-ledger');
// V19 tools L21-24 and events L3: raw fields only, never production identity proof.
const rows = [
  {
    "schema_version": 1,
    "event_id": "tools-1794639211240-0",
    "event_seq": 128,
    "session": "19842271-d52d-4c97-b61a-ffa6b69d0d03",
    "timestamp": "2026-11-14T06:53:31.240Z",
    "server_session": "e39da62b-7922-4666-94e9-7eb4c43f53e1",
    "world_id": "live-daddc3495116e710",
    "world_epoch": 1,
    "source": "numen",
    "category": "tools",
    "type": "tool_transport_binding",
    "data": {
      "model_call_id": "call_41afccaa3a474fa98a8cb91a",
      "wire_call_id": "wire-916a618d-7bc0-4303-964f-cb679e6d90fc",
      "companion_id": "a43d753e-790d-472b-8d5b-dc18ac0afbc0",
      "tool": "goto",
      "journaled_by": "client-transport"
    }
  },
  {
    "schema_version": 1,
    "event_id": "tools-1794639211242-0",
    "event_seq": 129,
    "session": "19842271-d52d-4c97-b61a-ffa6b69d0d03",
    "timestamp": "2026-11-14T06:53:31.242Z",
    "server_session": "e39da62b-7922-4666-94e9-7eb4c43f53e1",
    "world_id": "live-daddc3495116e710",
    "world_epoch": 1,
    "source": "numen",
    "category": "tools",
    "type": "tool_call",
    "data": {
      "companion_id": "a43d753e-790d-472b-8d5b-dc18ac0afbc0",
      "tool_call_id": "wire-916a618d-7bc0-4303-964f-cb679e6d90fc",
      "args_chars": 26,
      "tool": "goto"
    }
  },
  {
    "schema_version": 1,
    "event_id": "tools-1794639211357-0",
    "event_seq": 130,
    "session": "19842271-d52d-4c97-b61a-ffa6b69d0d03",
    "timestamp": "2026-11-14T06:53:31.357Z",
    "server_session": "e39da62b-7922-4666-94e9-7eb4c43f53e1",
    "world_id": "live-daddc3495116e710",
    "world_epoch": 1,
    "source": "numen",
    "category": "tools",
    "type": "tool_result",
    "data": {
      "tool_call_id": "wire-916a618d-7bc0-4303-964f-cb679e6d90fc",
      "tool": "goto",
      "result": "{\"success\":true,\"message\":\"已受理,后台执行中。完成会自动收到 task_finished 事件;不要调用 task_status 轮询。需要中止时用 task_stop。\",\"data\":{\"task\":\"goto\",\"task_id\":\"t3\",\"async\":true,\"standing\":false}}",
      "journaled_by": "server",
      "companion_id": "a43d753e-790d-472b-8d5b-dc18ac0afbc0"
    }
  },
  {
    "schema_version": 1,
    "event_id": "tools-1794639212758-1",
    "event_seq": 150,
    "session": "19842271-d52d-4c97-b61a-ffa6b69d0d03",
    "timestamp": "2026-11-14T06:53:32.758Z",
    "server_session": "e39da62b-7922-4666-94e9-7eb4c43f53e1",
    "world_id": "live-daddc3495116e710",
    "world_epoch": 1,
    "source": "numen",
    "category": "tools",
    "type": "tool_result",
    "data": {
      "companion_id": "a43d753e-790d-472b-8d5b-dc18ac0afbc0",
      "tool_call_id": "wire-916a618d-7bc0-4303-964f-cb679e6d90fc",
      "tool": "goto",
      "journaled_by": "server-async",
      "async_status": "stopped",
      "success": false,
      "result": "cancelled before reaching target（任务已结束，无需 task_stop；确需中止请先 task_status 确认在跑。）"
    }
  }
];
const terminal = {
  "schema_version": 1,
  "event_id": "events-1794639212759-0",
  "event_seq": 151,
  "session": "19842271-d52d-4c97-b61a-ffa6b69d0d03",
  "timestamp": "2026-11-14T06:53:32.759Z",
  "server_session": "e39da62b-7922-4666-94e9-7eb4c43f53e1",
  "world_id": "live-daddc3495116e710",
  "world_epoch": 1,
  "source": "numen",
  "category": "events",
  "type": "task_finished",
  "data": {
    "urgent": false,
    "companion_id": "a43d753e-790d-472b-8d5b-dc18ac0afbc0",
    "message": "cancelled before reaching target（任务已结束，无需 task_stop；确需中止请先 task_status 确认在跑。）",
    "id": "t3",
    "task": "goto",
    "status": "stopped",
    "attrs_written": 3
  }
};
const [binding, call, accepted, stopped] = rows;
const text = xs => xs.map(x => JSON.stringify(x)).join('\n');
// Test-only fixed binding: exercises phase logic without authenticating the V19 recording.
const resolveIdentity = (_ev, category) => ({
  worldId: 'live-daddc3495116e710', serverSession: 'e39da62b-7922-4666-94e9-7eb4c43f53e1',
  companion: 'a43d753e-790d-472b-8d5b-dc18ac0afbc0', evidence: 'synthetic:phase-test-only',
  [category === 'tools' ? 'callId' : 'taskId']: category === 'tools'
    ? 'wire-916a618d-7bc0-4303-964f-cb679e6d90fc' : 't3',
});
const ledger = (xs, events = []) => build(text(xs), text(events), { resolveIdentity });

test('acceptance then server-async stopped reaches only the task_finished terminal, in either order', () => {
  for (const xs of [rows, [stopped, accepted, call, binding]]) {
    const r = ledger(xs, [terminal]);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].state, 'cancelled');
    assert.equal(r.calls[0].success, true);
    assert.equal(r.calls[0].taskId, 't3');
    assert.equal(r.calls[0].terminal, 'cancelled');
    assert.equal(r.calls[0].resultCount, 2);
    assert.equal(r.summary.duplicates.terminalWithoutCall, 0);
  }
});

test('server-async status cannot substitute for a missing task_finished', () => {
  for (const xs of [rows, [stopped, accepted, call]]) {
    const r = ledger(xs);
    assert.equal(r.calls[0].state, 'accepted-no-terminal');
    assert.equal(r.calls[0].success, true);
    assert.equal(r.calls[0].terminal, null);
  }
});

test('a server-async boolean alone cannot invent acceptance or a terminal', () => {
  for (const success of [false, true]) {
    const update = { ...stopped, data: { ...stopped.data, success, async_status: success ? 'done' : 'stopped' } };
    const r = ledger([call, update], [terminal]);
    assert.equal(r.calls[0].state, 'result-no-status');
    assert.equal(r.calls[0].success, null);
    assert.equal(r.calls[0].async, false);
    assert.equal(r.calls[0].taskId, '');
    assert.equal(r.calls[0].terminal, null);
    assert.equal(r.summary.duplicates.terminalWithoutCall, 1);
  }
});

test('unmarked or partially marked contradictions still conflict; raw identity stays UNKNOWN', () => {
  for (const patch of [{ journaled_by: undefined, async_status: undefined },
    { journaled_by: 'server' }, { async_status: undefined }, { async_status: '' }]) {
    const update = { ...stopped, data: { ...stopped.data, ...patch } };
    assert.equal(ledger([call, accepted, update], [terminal]).calls[0].state, 'result-conflict');
  }
  const raw = build(text(rows), text([terminal]));
  assert.equal(raw.calls.length, 3);
  assert.ok(raw.calls.every(c => c.identityStatus === 'UNKNOWN' && c.state === 'identity-unknown'));
  assert.equal(raw.summary.duplicates.terminalWithoutCall, 1);
});
