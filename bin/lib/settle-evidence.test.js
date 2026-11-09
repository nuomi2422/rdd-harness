'use strict';
// 结算核验判据：走真实 monitor 文件（rdd.jsonl）读取路径。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SE = require('./settle-evidence');
const L = require('./bench-live');

const ev = (type, over) => JSON.stringify({ type, data: Object.assign({ companionId: 'c', primary: 'p' }, over || {}) });

test('真实入口：rdd.jsonl 原样行 → 结算核验覆盖率可数', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'rdd.jsonl');
  fs.writeFileSync(f, [
    ev('primary_settled_by_fact', { verified: true, verify_final_goal: true, unmet: [] }),
    ev('primary_settled_by_fact', { verified: true, verify_final_goal: false, unmet: [] }),
    ev('primary_settle_rejected', { verified: false, verify_final_goal: true, unmet: ['final:goal-b'] }),
  ].join('\n') + '\n');
  const r = L.readTail(f, 0, 1024 * 1024, {});
  const res = SE.build((r.lines || []).join('\n'));
  assert.equal(res.settled.total, 2);
  assert.equal(res.coverage.judged, '1/2', '两条可判定里只有一条按最终目标核验');
  assert.equal(res.status, 'PARTIAL');
  assert.ok(res.rejected.finals.includes('final:goal-b'));
});

test('旧日志（无 verified 字段）记 legacy，不冤枉成失败', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'rdd.jsonl');
  fs.writeFileSync(f, ev('primary_settled_by_fact', { reason: 'old-format' }) + '\n');
  const r = L.readTail(f, 0, 1024 * 1024, {});
  const res = SE.build((r.lines || []).join('\n'));
  assert.equal(res.settled.legacy, 1);
  assert.equal(res.status, 'UNKNOWN', '没有可判定事件 → UNKNOWN，不是 PASS 也不是 FAIL');
});
test('跨同伴：一个核验过、一个没核验 → 整体不得 PRESENT，分组可见', () => {
  const rows = [
    ev('primary_settled_by_fact', { companionId: 'c1', verified: true, verify_final_goal: true, unmet: [] }),
    ev('primary_settled_by_fact', { companionId: 'c2', verified: true, verify_final_goal: false, unmet: [] }),
  ].join('\n');
  const res = SE.build(rows);
  assert.equal(res.status, 'PARTIAL');
  assert.equal(res.byCompanion.c1.verifyFinalGoal, 1);
  assert.equal(res.byCompanion.c2.verifyFinalGoal, 0);
});
