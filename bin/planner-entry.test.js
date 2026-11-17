'use strict';
// P18 regression: a bounded tail read must not report "never planned" when the
// planner event may simply sit before the window. Full coverage keeps old verdicts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pe = require('./lib/planner-entry.js');

const SINCE = new Date('2026-11-16T20:00:00.000Z');
function ev(type, at, data) { return JSON.stringify({ timestamp: at, type, data: data || {} }) + '\n'; }
function dir(lines) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-entry-'));
  fs.writeFileSync(path.join(d, 'rdd.jsonl'), lines.join(''));
  return d;
}
function scan(d, maxBytes) {
  return pe.scan(SINCE, { dir: d, maxBytes });
}

test('full file bind-only still reports BYPASSED', () => {
  const d = dir([ev('taskchain_snapshot', '2026-11-16T20:33:12.705Z', { reason: 'task_bound', taskChain: { description: 'old task' } })]);
  const r = scan(d);
  assert.equal(r.verdict, 'BYPASSED');
  assert.equal(r.ok, false);
});

test('full file without chain still reports NO_CHAIN', () => {
  const r = scan(dir([ev('rdd_loop', '2026-11-16T20:10:00.000Z')]));
  assert.equal(r.verdict, 'NO_CHAIN');
});

test('truncated window with bind-only in window is UNKNOWN, never BYPASSED', () => {
  // Planner input sits before the window; only its absence is observed.
  const head = ev('supervisor_input', '2026-11-16T20:33:04.996Z', { source: 'rdd_restart_mainline' });
  const tail = ev('taskchain_snapshot', '2026-11-16T20:33:12.705Z', { reason: 'task_bound', taskChain: { description: 'cfd7' } });
  const d = dir([head, tail]);
  const r = scan(d, tail.length);
  assert.notEqual(r.verdict, 'BYPASSED');
  assert.equal(r.verdict, 'UNKNOWN');
  assert.equal(r.ok, false);
  assert.equal(r.coverage.truncated, true);
  assert.match(r.note, /尾|无法判定/);
});

test('truncated window that does contain the planner event is PLANNED', () => {
  const head = ev('taskchain_snapshot', '2026-11-16T20:30:00.000Z', { reason: 'task_bound' });
  const tail = ev('supervisor_input', '2026-11-16T20:33:04.996Z', { source: 'rdd_supervisor_submit' })
    + ev('goal_staged', '2026-11-16T20:33:09.000Z', { stages: 9 });
  const d = dir([head, tail]);
  const r = scan(d, tail.length);
  assert.equal(r.verdict, 'PLANNED');
  assert.equal(r.ok, true);
});

test('truncated window with no observable chain is UNKNOWN, not NO_CHAIN', () => {
  const head = ev('rdd_loop', '2026-11-16T20:10:00.000Z');
  const tail = ev('rdd_loop', '2026-11-16T20:40:00.000Z');
  const d = dir([head, tail]);
  const r = scan(d, tail.length);
  assert.equal(r.verdict, 'UNKNOWN');
  assert.equal(r.coverage.truncated, true);
});

test('missing file stays NO_DATA and a broken line never throws', () => {
  const missing = pe.scan(SINCE, { dir: path.join(os.tmpdir(), 'planner-entry-missing-' + Date.now()) });
  assert.equal(missing.verdict, 'NO_DATA');
  const d = dir(['{not json}\n' + ev('supervisor_input', '2026-11-16T20:33:04.996Z', { source: 'rdd_supervisor_submit' })]);
  assert.equal(scan(d).verdict, 'PLANNED');
});

test('UTF-8 boundary split does not corrupt the verdict', () => {
  const head = ev('note', '2026-11-16T20:10:00.000Z', { text: '中文边界' });
  const tail = ev('supervisor_input', '2026-11-16T20:33:04.996Z', { source: 'rdd_supervisor_submit' });
  const d = dir([head, tail]);
  // Cut one byte into the multi-byte character so the first line is partial.
  const r = scan(d, tail.length + 2);
  assert.equal(r.verdict, 'PLANNED');
  assert.equal(r.coverage.truncated, true);
});
