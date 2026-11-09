'use strict';
// 黄金样本：模拟"部署后应有"的数据形状，钉住读端该给出什么数字。
// 目的：部署后拿真实数据对这张表，不一致就说明字段/链路没接上，而不是靠人感觉。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCard } = require('../evidence-card');
const V = require('./evidence-verdict');

const L = (o) => JSON.stringify({ session: 'run-1', ...o });

function makeSample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'));
  const call = (id) => L({ type: 'tool_call', timestamp: '2026-11-09T06:00:00Z', data: { companion_id: 'c', session_id: 's', tool: 'goto', tool_call_id: id } });
  const result = (id) => L({ type: 'tool_result', timestamp: '2026-11-09T06:00:02Z', data: { companion_id: 'c', session_id: 's', tool: 'goto', tool_call_id: id, result: { success: true } } });
  fs.writeFileSync(path.join(dir, 'tools.jsonl'), [call('1'), result('1'), call('2'), result('2')].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  const finalReq = (turn, why) => L({ type: 'final_request', timestamp: '2026-11-09T06:00:03Z', data: {
    companion_id: 'c', requestKind: 'execute', turn, rationalePresent: why, whyPresent: why, whyStatus: why ? 'PRESENT' : 'ABSENT',
    risksPresent: why, sourcePresent: why, conditionsPresent: false, rationaleSource: why ? 'planner_tool:rdd_patch:1' : '' } });
  fs.writeFileSync(path.join(dir, 'context.jsonl'), [finalReq(1, true), finalReq(2, true)].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'rdd.jsonl'), L({ type: 'primary_settled_by_fact', timestamp: '2026-11-09T06:00:05Z',
    data: { companionId: 'c', primary: 'p', verified: true, verify_final_goal: true, unmet: [] } }) + '\n');
  return dir;
}

test('黄金样本：动作可读、why 2/2 交付、结算按最终目标核验 1/1，但总判定仍 UNKNOWN（身份未证）', (t) => {
  const dir = makeSample();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const card = buildCard(dir);
  assert.equal(card.actions.status, 'RAW_PRESENT');
  // 无身份时账本不合并行：2 次调用 + 2 条回执 = 4 条独立记录（这是真实代价，不是 bug）
  assert.equal(card.actions.calls, 4, '无身份时 call 与 result 不会被合并');
  assert.equal(card.actions.attributable, 'UNKNOWN');
  assert.equal(card.finalRequest.status, 'PRESENT');
  assert.equal(card.finalRequest.delivered, '2/2');
  assert.equal(card.settle.status, 'PRESENT');
  assert.equal(card.settle.coverage.judged, '1/1');
  const v = V.buildVerdict(card, null);
  assert.equal(v.verdict, 'UNKNOWN', '身份未证时不得因数据齐全而 PRESENT');
  assert.ok(v.reasons.includes('identity-not-attributable'));
});
