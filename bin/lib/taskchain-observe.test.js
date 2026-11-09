'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const T = require('./taskchain-observe');

const snap = (c) => JSON.stringify({ type: 'taskchain_snapshot', data: { taskChain: c } });

test('正常快照：版本单调、统计链与结算条目', () => {
  const rows = [snap({chainInstanceId:'c1',goalId:'g1',stateVersion:1,staleResultsIgnored:0,ownerEpoch:0,settledStages:{a:'x'},currentPrimaryId:'p1',currentSubtaskId:'s1'}),
    snap({chainInstanceId:'c1',goalId:'g1',stateVersion:2,staleResultsIgnored:3,ownerEpoch:0,settledStages:{a:'x',b:'y'},currentPrimaryId:'p2',currentSubtaskId:'s2'})].join('\n');
  const r = T.build({ 'rdd.jsonl': rows });
  assert.equal(r.status, 'PRESENT');
  assert.equal(r.snapshots, 2);
  assert.equal(r.verRegressions, 0);
  assert.equal(r.staleResultsIgnored, 3);
  assert.equal(r.settledCount, 2);
  assert.equal(r.currentSubtask, 's2');
});

test('版本回退要计数（不掩盖）', () => {
  const rows = [snap({chainInstanceId:'c1',stateVersion:5}), snap({chainInstanceId:'c1',stateVersion:3})].join('\n');
  assert.equal(T.build({ 'rdd.jsonl': rows }).verRegressions, 1);
});

test('缺字段 → PARTIAL；无快照 → UNKNOWN', () => {
  assert.equal(T.build({ 'rdd.jsonl': snap({goalId:'g'}) }).status, 'PARTIAL');
  assert.equal(T.build({}).status, 'UNKNOWN');
});

test('真实尾部：能出链/版本/旧回执计数（无数据 skip）', () => {
  const DIR = process.env.RDD_MONITOR || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
  const p = path.join(DIR, 'rdd.jsonl');
  if (!fs.existsSync(p)) return;
  const r = T.build({ 'rdd.jsonl': fs.readFileSync(p, 'utf8') });
  console.log('[真实任务链] ' + JSON.stringify({ status: r.status, snapshots: r.snapshots, chains: r.chains, ver: [r.verMin, r.verMax], stale: r.staleResultsIgnored }));
  assert.ok(['PRESENT','PARTIAL','UNKNOWN'].includes(r.status));
});
test('版本缺口要计数（快照可能丢失）', () => {
  const rows = [snap({chainInstanceId:'c1',stateVersion:1}), snap({chainInstanceId:'c1',stateVersion:4})].join('\n');
  assert.equal(T.build({ 'rdd.jsonl': rows }).verGaps, 2);
});

test('时间乱序要计数（不掩盖）', () => {
  const rows = [
    JSON.stringify({ type: 'taskchain_snapshot', timestamp: '2026-11-09T05:00:10Z', data: { taskChain: { chainInstanceId: 'c', stateVersion: 1 } } }),
    JSON.stringify({ type: 'taskchain_snapshot', timestamp: '2026-11-09T05:00:00Z', data: { taskChain: { chainInstanceId: 'c', stateVersion: 2 } } }),
  ].join('\n');
  assert.equal(T.build({ 'rdd.jsonl': rows }).tsRegressions, 1);
});

test('stale=0 必须带"不能推断机制未触发"的说明', () => {
  const rows = [snap({chainInstanceId:'c',stateVersion:1,staleResultsIgnored:0})].join('\n');
  const r = T.build({ 'rdd.jsonl': rows });
  assert.equal(r.staleResultsIgnored, 0);
  assert.match(String(r.staleZeroNote), /不能推断/);
});

test('多会话/多链要如实计数（跨世界身份不硬拼）', () => {
  const rows = [
    JSON.stringify({ type: 'taskchain_snapshot', session: 's1', data: { taskChain: { chainInstanceId: 'c1', stateVersion: 1 } } }),
    JSON.stringify({ type: 'taskchain_snapshot', session: 's2', data: { taskChain: { chainInstanceId: 'c2', stateVersion: 1 } } }),
  ].join('\n');
  const r = T.build({ 'rdd.jsonl': rows });
  assert.equal(r.chains, 2);
  assert.equal(r.sessions, 2);
});
test('版本跳跃分 fast/slow：同瞬间的不算可疑', () => {
  const mk = (ts, ver) => JSON.stringify({ type: 'taskchain_snapshot', timestamp: ts, data: { taskChain: { chainInstanceId: 'c', stateVersion: ver } } });
  const fast = [mk('2026-11-09T05:00:00.000Z', 1), mk('2026-11-09T05:00:00.050Z', 3)].join('\n');
  const rf = T.build({ 'rdd.jsonl': fast });
  assert.equal(rf.fastGaps, 1);
  assert.equal(rf.slowGaps, 0);
  const slow = [mk('2026-11-09T05:00:00.000Z', 1), mk('2026-11-09T05:01:00.000Z', 4)].join('\n');
  const rs = T.build({ 'rdd.jsonl': slow });
  assert.equal(rs.slowGaps, 1);
});
