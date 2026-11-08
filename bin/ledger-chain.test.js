'use strict';
// 2026-11-09：真实链路 reader(生产 tail 读取器) → ledger → exp-runner 消费者 的身份断言。
// 目的不是"造绿"，而是把每一项**当前支持到什么程度**写成可执行事实：
//   SUPPORTED     = 当前实现确实能挡住/给出正确结论；
//   EXPECTED-FAIL = 当前实现**做不到**（保留断言，标明未支持），不许改成假通过。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./lib/bench-live');
const AL = require('./lib/action-ledger');
const { actionEvidence } = require('./exp-runner');

const line = (type, data, env) => JSON.stringify({
  type, ...(env || {}), data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1', ...data },
});
const resolverOK = (ev) => ({
  worldId: ev.world_id || 'w', serverSession: ev.server_session || 's',
  companion: 'c', evidence: 'offline-fixture', callId: (ev.data || {}).tool_call_id, taskId: (ev.data || {}).id,
});
function chain(t, text, window, resolver) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'tools.jsonl');
  // 真实日志每行都以换行结尾；读取器会**扣住没有换行结尾的末行**（防半行），
  // 所以夹具必须带尾换行，否则最后一条会被当成仍在写入的半行而丢弃。
  fs.writeFileSync(f, text.endsWith('\n') ? text : text + '\n');
  const r = L.readTail(f, 0, window || 1024 * 1024, {});
  const tools = (r.lines || []).join('\n');
  const lg = AL.build(tools, '', { minStreak: 3, resolveIdentity: resolver || resolverOK });
  return { r, lg, ev: actionEvidence(lg, tools) };
}

test('SUPPORTED 正例：完整流 + 独立核验 → PRESENT', (t) => {
  const { ev } = chain(t, line('tool_call', {}) + '\n' + line('tool_result', { result: { success: true } }));
  assert.equal(ev.status, 'PRESENT');
});

test('SUPPORTED 迟到：入档顺序晚于消息时间，仍按追加顺序还原（顺序无关）', (t) => {
  // result 的业务时间戳更早，却在后面才追加写入 —— 这正是"迟到"的形态。
  const early = line('tool_call', {}, { timestamp: '2026-11-09T05:00:00Z' });
  const late = line('tool_result', { result: { success: true } }, { timestamp: '2026-11-09T04:59:00Z' });
  const { ev } = chain(t, early + '\n' + late);
  assert.equal(ev.status, 'PRESENT', '迟到不改变还原结果，但"何时可得"仍是 UNKNOWN');
});

test('EXPECTED-FAIL 日志缺口：读取器能报 skipped，但消费者拿不到这个信号', (t) => {
  const big = line('tool_call', { tool_call_id: 'A' }) + '\n' + line('tool_result', { tool_call_id: 'A', result: { success: true } }) + '\n'
    + line('tool_call', { tool_call_id: 'B' }) + '\n' + line('tool_result', { tool_call_id: 'B', result: { success: true } }) + '\n';
  const { r, ev } = chain(t, big, 200); // 窗口比文件小 → 前段被跳过
  assert.ok(r.skipped > 0, '读取器必须报出跳过的字节数');
  // 当前：截断后只剩后半段，结论只是"碰巧 UNKNOWN"，并不是因为有缺口标记。
  assert.ok(['UNKNOWN', 'PRESENT'].includes(ev.status));
  // 未支持点：缺口标记没有进 ledger/consumer，所以 PRESENT 时也无法区分"完整"与"有缺口"。
  assert.equal(ev.reasons.includes('log-gap'), false, '当前没有任何 gap 理由——这就是未支持的部分');
});

test('SUPPORTED 伪造信封：只有信封身份、没有独立来源 → UNKNOWN', (t) => {
  const text = line('tool_call', {}, { world_id: 'faked', server_session: 'faked' }) + '\n'
    + line('tool_result', { result: { success: true } }, { world_id: 'faked', server_session: 'faked' });
  const { ev } = chain(t, text, undefined, () => null);
  assert.equal(ev.status, 'UNKNOWN');
  assert.ok(ev.reasons.includes('identity-coverage-unknown-or-incomplete'));
});

test('EXPECTED-FAIL 重启复用同一 session+call 号：当前会被并成一条', (t) => {
  const seg = line('tool_call', {}) + '\n' + line('tool_result', { result: { success: true } }) + '\n';
  const { lg } = chain(t, seg + seg); // 两段"重启"拼接，身份四元组完全相同
  assert.equal(lg.summary.calls, 1, '当前行为：合并为 1 条（未支持区分重启用例）');
  // 期望：应当有 run/epoch 维度才能分成 2 条；现在没有，所以这类样本必须整体 UNKNOWN。
});
console.log('reader→ledger→consumer 身份链路断言完成（3 SUPPORTED / 2 EXPECTED-FAIL）');
