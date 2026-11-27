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
test('slow 缺口期间有其它 rdd 行 → 判节流；无其它行 → 判空白', () => {
  const mk = (ts, ver) => JSON.stringify({ type: 'taskchain_snapshot', timestamp: ts, data: { taskChain: { chainInstanceId: 'c', stateVersion: ver } } });
  const other = (ts) => JSON.stringify({ type: 'fact_snapshot', timestamp: ts, data: {} });
  const active = [mk('2026-11-09T05:00:00.000Z', 1), other('2026-11-09T05:00:20.000Z'), mk('2026-11-09T05:00:40.000Z', 4)].join('\n');
  const ra = T.build({ 'rdd.jsonl': active });
  assert.equal(ra.slowGaps, 1);
  assert.equal(ra.slowGapActive, 1);
  assert.equal(ra.slowGapBlank, 0);
  const blank = [mk('2026-11-09T05:00:00.000Z', 1), mk('2026-11-09T05:00:40.000Z', 4)].join('\n');
  const rb = T.build({ 'rdd.jsonl': blank });
  assert.equal(rb.slowGapBlank, 1);
});
test('expansion failures are surfaced instead of hiding behind awaiting expansion', () => {
  const rows = [
    JSON.stringify({ type: 'taskchain_snapshot', timestamp: '2026-11-09T05:00:00Z', data: { taskChain: { chainInstanceId: 'c', stateVersion: 1, primaryStatus: 'PENDING' } } }),
    JSON.stringify({ type: 'expansion_failed', timestamp: '2026-11-09T05:00:01Z', data: { primary: 'p1', reason: 'no usable subtasks' } }),
    JSON.stringify({ type: 'expansion_exhausted', timestamp: '2026-11-09T05:00:02Z', data: { primary: 'p1', attempts: 3 } }),
  ].join('\n');
  const r = T.build({ 'rdd.jsonl': rows });
  assert.equal(r.expansionFailures, 1);
  assert.equal(r.expansionExhausted, 1);
  assert.equal(r.lastExpansionFailure.primary, 'p1');
  assert.match(r.lastExpansionFailure.reason, /no usable subtasks/);
});

test('当前主支若已在 settledStages → 冲突标记（B2 历史完成 vs 当前）', () => {
  const mk = (settled, prim) => JSON.stringify({ type: 'taskchain_snapshot', data: { taskChain: { chainInstanceId: 'c', stateVersion: 1, settledStages: settled, currentPrimaryId: prim } } });
  const conflict = T.build({ 'rdd.jsonl': mk({ 'p1': 'done' }, 'p1') });
  assert.equal(conflict.currentPrimarySettled, true);
  const ok = T.build({ 'rdd.jsonl': mk({ 'p1': 'done' }, 'p2') });
  assert.equal(ok.currentPrimarySettled, false);
});
test('不同链各自编号：跨链的版本跳变不算回退/缺口', () => {
  const mk = (chain, ver) => JSON.stringify({ type: 'taskchain_snapshot', data: { taskChain: { chainInstanceId: chain, stateVersion: ver } } });
  const rows = [mk('c1', 48), mk('c1', 49), mk('c2', 34), mk('c2', 35)].join('\n');
  const r = T.build({ 'rdd.jsonl': rows });
  assert.equal(r.verRegressions, 0, '49→34 是换链，不是回退');
  assert.equal(r.verGaps, 0);
  assert.equal(r.chains, 2);
  assert.deepEqual(r.chainsDetail.map((c) => c.chain).sort(), ['c1', 'c2']);
});

test('坏 JSON 显式报缺口，不再静默跳过', () => {
  const r = T.build({ 'rdd.jsonl': snap({ chainInstanceId: 'c', stateVersion: 1 }) + '\n{broken\n' });
  assert.equal(r.malformedLines, 1);
  assert.equal(r.status, 'PARTIAL');
  assert.deepEqual(r.gaps, [{ code: 'MALFORMED_LINE', file: 'rdd.jsonl', line: 2 }]);
});

test('当前状态与版本比较按时间序，不按物理尾行', () => {
  const mk = (ts, ver, sub) => JSON.stringify({ type: 'taskchain_snapshot', timestamp: ts, data: { taskChain: { chainInstanceId: 'c', stateVersion: ver, currentSubtaskId: sub } } });
  const r = T.build({ 'rdd.jsonl': [mk('2026-11-09T05:00:10Z', 3, 'new'), mk('2026-11-09T05:00:00Z', 1, 'old')].join('\n') });
  assert.equal(r.tsRegressions, 1);
  assert.equal(r.verRegressions, 0);
  assert.equal(r.verGaps, 1);
  assert.equal(r.currentSubtask, 'new');
  assert.equal(r.currentBasis, 'latest_timestamp');
});

test('无时间戳时保留物理顺序但显式标注当前状态依据', () => {
  const r = T.build({ 'rdd.jsonl': [snap({ chainInstanceId: 'c', stateVersion: 1, currentSubtaskId: 'a' }), snap({ chainInstanceId: 'c', stateVersion: 2, currentSubtaskId: 'b' })].join('\n') });
  assert.equal(r.currentSubtask, 'b');
  assert.equal(r.currentBasis, 'physical_order_no_timestamp');
  assert.equal(r.missingFields.timestamp, 2);
});
