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
  type, session: 'run-1', ...(env || {}), data: { companion_id: 'c', session_id: 's', tool: 'x', tool_call_id: '1', ...data },
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
  return { r, lg, ev: actionEvidence(lg, tools, null, { level: 'limited', windowStart: 'w', anchorBytes: 64 }) };
}

test('SUPPORTED 正例：完整流 + 独立核验 → 除覆盖等级外无其它问题', (t) => {
  const { ev } = chain(t, line('tool_call', {}) + '\n' + line('tool_result', { result: { success: true } }));
  // PRESENT 目前不可达（verified 无合法签发路径），正例表达为"没有别的问题"。
  assert.deepEqual(ev.reasons, ['coverage-limited']);
});

test('SUPPORTED 迟到：入档顺序晚于消息时间，仍按追加顺序还原（顺序无关）', (t) => {
  // result 的业务时间戳更早，却在后面才追加写入 —— 这正是"迟到"的形态。
  const early = line('tool_call', {}, { timestamp: '2026-11-09T05:00:00Z' });
  const late = line('tool_result', { result: { success: true } }, { timestamp: '2026-11-09T04:59:00Z' });
  const { ev } = chain(t, early + '\n' + late);
  assert.deepEqual(ev.reasons, ['coverage-limited'], '迟到不改变还原结果；PRESENT 仍因覆盖等级不可达');
});

test('SUPPORTED 日志缺口：读取器的跳过量能传到消费者并判 UNKNOWN', (t) => {
  const big = line('tool_call', { tool_call_id: 'A' }) + '\n' + line('tool_result', { tool_call_id: 'A', result: { success: true } }) + '\n'
    + line('tool_call', { tool_call_id: 'B' }) + '\n' + line('tool_result', { tool_call_id: 'B', result: { success: true } }) + '\n';
  const { r, lg, ev } = chain(t, big, 200); // 窗口比文件小 → 前段被跳过
  assert.ok(r.skipped > 0, '读取器必须报出跳过的字节数');
  // 2026-11-09 起：缺口作为第三个参数传进消费者，必须显式表现为 log-gap 理由（UNKNOWN）。
  const withGap = actionEvidence(lg, (r.lines || []).join('\n'), { 'tools.jsonl': { reason: 'window-skip', skipped: r.skipped } });
  assert.equal(withGap.status, 'UNKNOWN');
  assert.ok(withGap.reasons.includes('log-gap'), '必须给出 log-gap 理由，而不是"碰巧 UNKNOWN"');
  assert.ok(!ev.reasons.includes('log-gap'), '不传缺口时不许多出理由（保持向后兼容）');
});

test('SUPPORTED 伪造信封：只有信封身份、没有独立来源 → UNKNOWN', (t) => {
  const text = line('tool_call', {}, { world_id: 'faked', server_session: 'faked' }) + '\n'
    + line('tool_result', { result: { success: true } }, { world_id: 'faked', server_session: 'faked' });
  const { ev } = chain(t, text, undefined, () => null);
  assert.equal(ev.status, 'UNKNOWN');
  assert.ok(ev.reasons.includes('identity-coverage-unknown-or-incomplete'));
});

test('SUPPORTED 重启复用同一 session+call 号：靠进程运行号分成两条', (t) => {
  // 两段"重启"：world/session/companion/callId 全同，只有信封 session（进程 UUID）不同。
  const seg = (run) => line('tool_call', {}, { session: run }) + '\n' + line('tool_result', { result: { success: true } }, { session: run }) + '\n';
  const { lg } = chain(t, seg('run-1') + seg('run-2'));
  assert.equal(lg.summary.calls, 2, '不同进程运行号必须分成 2 条，不能并成 1 条假完成');
  // 同一运行号重复写入仍应合并（防重复投递）。
  const same = chain(t, seg('run-1') + seg('run-1'));
  assert.equal(same.lg.summary.calls, 1);
});
console.log('reader→ledger→consumer 身份链路断言完成（3 SUPPORTED / 2 EXPECTED-FAIL）');

test('有限监测（limited）即使身份全知、无缺口也不得 PRESENT', (t) => {
  const { lg } = chain(t, line('tool_call', {}) + '\n' + line('tool_result', { result: { success: true } }));
  const text = line('tool_call', {}) + '\n' + line('tool_result', { result: { success: true } });
  const ev = actionEvidence(lg, text, null, { level: 'limited', windowStart: 'w', anchorBytes: 64 });
  assert.equal(ev.status, 'UNKNOWN');
  assert.ok(ev.reasons.includes('coverage-limited'));
});