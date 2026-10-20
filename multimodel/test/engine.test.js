'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { EvidenceLog, alignEvidence, validateEnvelope } = require('../lib/evidence.js');
const { decide, FLAGS } = require('../lib/verdict.js');
const { RunStateMachine, STATE } = require('../lib/statemachine.js');

function logWith(entries) {
  const log = new EvidenceLog({
    runId: 'run-x', attemptId: 'attempt-01', worldSessionId: 'ws-1',
    instanceId: 'sbx-1', worldId: 'world-1', dimension: 'minecraft:overworld',
    companionId: 'companion-1', ownerEpoch: 3,
  });
  for (const e of entries) log.add(e.kind, e.source, e.payload || {}, e.opts || {});
  return log;
}

test('正常证据：身份齐、新鲜、tick 对齐 → ok', () => {
  const log = logWith([{ kind: 'inventory.snapshot', source: 'worldstate', opts: { serverTick: 100, sourceSeq: 1 } }]);
  const r = alignEvidence(log.entries, {
    attemptId: 'attempt-01', worldSessionId: 'ws-1', dimension: 'minecraft:overworld',
    companionId: 'companion-1', ownerEpoch: 3, maxEvidenceAgeMs: 60000, maxAlignmentSkewTicks: 20,
  });
  assert.equal(r.ok, true);
  assert.equal(r.fatal.length, 0);
});

test('过期证据 → BLOCKING EVIDENCE_STALE（不是 fatal，但阻断 PASS）', () => {
  const old = new Date(Date.now() - 10000).toISOString();
  const log = logWith([{ kind: 'inventory.snapshot', source: 'worldstate', opts: { serverTick: 100, capturedAt: old } }]);
  const r = alignEvidence(log.entries, { maxEvidenceAgeMs: 2000 });
  assert.equal(r.ok, false);
  assert.ok(r.blocking.some((i) => i.code === 'EVIDENCE_STALE'));
});

test('证据主体不是目标同伴 → fatal SUBJECT_MISMATCH（玩家背包不能凑数）', () => {
  const log = logWith([{ kind: 'inventory.snapshot', source: 'worldstate', opts: { serverTick: 100, companionId: 'player-1' } }]);
  const r = alignEvidence(log.entries, { companionId: 'companion-1' });
  assert.equal(r.ok, false);
  assert.ok(r.fatal.some((i) => i.code === 'SUBJECT_MISMATCH'));
});

test('跨 worldSession 的旧证据 → fatal SESSION_MISMATCH', () => {
  const log = logWith([{ kind: 'frame.before_verdict', source: 'camera', opts: { serverTick: 100, worldSessionId: 'ws-old' } }]);
  const r = alignEvidence(log.entries, { worldSessionId: 'ws-1' });
  assert.ok(r.fatal.some((i) => i.code === 'SESSION_MISMATCH'));
});

test('维度不一致 → fatal DIMENSION_MISMATCH', () => {
  const log = logWith([{ kind: 'frame.x', source: 'camera', opts: { serverTick: 100, dimension: 'minecraft:nether' } }]);
  const r = alignEvidence(log.entries, { dimension: 'minecraft:overworld' });
  assert.ok(r.fatal.some((i) => i.code === 'DIMENSION_MISMATCH'));
});

test('ownerEpoch 落后 → fatal EPOCH_STALE（控制权切换后旧回答不可提交）', () => {
  const log = logWith([{ kind: 'inventory.snapshot', source: 'worldstate', opts: { serverTick: 100, ownerEpoch: 1 } }]);
  const r = alignEvidence(log.entries, { ownerEpoch: 4 });
  assert.ok(r.fatal.some((i) => i.code === 'EPOCH_STALE'));
});

test('before/after 反序 → BLOCKING CAUSAL_ORDER', () => {
  const log = logWith([
    { kind: 'action.before', source: 'runtime_events', opts: { serverTick: 120, eventId: 'ev-a' } },
    { kind: 'action.after', source: 'runtime_events', opts: { serverTick: 110, eventId: 'ev-b' } },
  ]);
  const r = alignEvidence(log.entries, { pairs: [{ actionId: 'a1', beforeEventId: 'ev-a', afterEventId: 'ev-b' }] });
  assert.ok(r.blocking.some((i) => i.code === 'CAUSAL_ORDER'));
});

test('sourceSeq 缺口只记 INFO，不阻断（丢失区间显式记录，不补造）', () => {
  const log = logWith([
    { kind: 'e1', source: 'runtime_events', opts: { sourceSeq: 1 } },
    { kind: 'e2', source: 'runtime_events', opts: { sourceSeq: 5 } },
  ]);
  const r = alignEvidence(log.entries, {});
  assert.ok(r.issues.some((i) => i.code === 'SEQ_GAP' && i.severity === 'info'));
  assert.equal(r.ok, true);
});

test('信封校验：worldstate/camera 必须有 serverTick；占位 sha256 不算哈希', () => {
  assert.equal(validateEnvelope({ schemaVersion: 1, eventId: 'e', runId: 'r', attemptId: 'a', worldSessionId: 'w', instanceId: 'i', worldId: 'wi', dimension: 'd', ownerEpoch: 1, source: 'worldstate', capturedAt: new Date().toISOString(), kind: 'k' }).ok, false);
  assert.equal(validateEnvelope({ schemaVersion: 1, eventId: 'e', runId: 'r', attemptId: 'a', worldSessionId: 'w', instanceId: 'i', worldId: 'wi', dimension: 'd', ownerEpoch: 1, source: 'camera', capturedAt: new Date().toISOString(), kind: 'k', serverTick: 1, sha256: '<actual-content-hash>' }).ok, false);
});

// ───────────────────────── verdict ─────────────────────────

function baseInput(over) {
  return Object.assign({
    environment: { healthy: true },
    assertions: [{ id: 'a1', required: true, result: true }],
    invariants: [],
    evidence: { ok: true, fatal: [], blocking: [], issues: [] },
    observation: { visualRequired: false },
    claims: [],
    engineering: { gatesPassed: true },
    archive: { ok: true },
  }, over || {});
}

test('全部成立 → PASS（且四面都齐）', () => {
  const r = decide(baseInput());
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.flags, []);
});

test('模型口头成功 + 断言未达标 → 绝不 PASS', () => {
  const r = decide(baseInput({
    assertions: [{ id: 'a1', required: true, result: false }],
    claims: [{ actor: 'deepseek-v4.1-flash', kind: 'success', supported: false }],
  }));
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.flags.includes(FLAGS.UNSUPPORTED_SUCCESS_CLAIM));
});

test('只有口头成功、断言 unknown → INCONCLUSIVE（不是 PASS，也不许直接判幻觉）', () => {
  const r = decide(baseInput({
    assertions: [{ id: 'a1', required: true, result: 'unknown' }],
    claims: [{ actor: 'gpt-6-astra', kind: 'success', supported: false }],
  }));
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.ok(r.flags.includes(FLAGS.UNSUPPORTED_SUCCESS_CLAIM));
});

test('硬不变量被可信证据违反 → FAIL，且后来的断流抹不掉', () => {
  const r = decide(baseInput({
    invariants: [{ id: 'no-injection', violated: true, trusted: true }],
    evidence: { ok: false, fatal: [], blocking: [{ code: 'EVIDENCE_STALE', detail: '断了' }], issues: [] },
  }));
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.flags.includes(FLAGS.HARD_INVARIANT_VIOLATION));
});

test('双源冲突 → INCONCLUSIVE + EVIDENCE_CONFLICT（禁止 PASS）', () => {
  const r = decide(baseInput({ conflict: { detected: true, detail: '状态说 3、画面说 0' } }));
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.ok(r.flags.includes(FLAGS.EVIDENCE_CONFLICT));
});

test('环境故障 → ERROR，且不计入任务失败率', () => {
  const r = decide(baseInput({ environment: { healthy: false, detail: '相机采集器崩了' } }));
  assert.equal(r.verdict, 'ERROR');
  assert.equal(r.countsTowardTaskFailureRate, false);
  assert.equal(r.countsTowardAvailability, true);
});

test('开跑前缺能力/预算 → BLOCKED + 正确 flag', () => {
  const cap = decide(baseInput({ blocked: { reasons: [{ code: 'CAPABILITY_DISABLED', flag: FLAGS.CAPABILITY_MISSING, detail: 'x' }] } }));
  assert.equal(cap.verdict, 'BLOCKED');
  assert.ok(cap.flags.includes(FLAGS.CAPABILITY_MISSING));
  const bud = decide(baseInput({ blocked: { reasons: [{ code: 'BUDGET_ROLE_CALL_LIMIT', flag: FLAGS.BUDGET_EXHAUSTED, detail: 'y' }] } }));
  assert.ok(bud.flags.includes(FLAGS.BUDGET_EXHAUSTED));
  assert.equal(bud.nextAction, 'SAFE_PAUSE');
});

test('环境与观测健康但到截止没达标 → FAIL', () => {
  const r = decide(baseInput({ deadlineExceeded: true }));
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.flags.includes(FLAGS.DEADLINE_EXCEEDED));
});

test('工程门没过 → 即使任务断言成立也不能 PASS', () => {
  const r = decide(baseInput({ engineering: { gatesPassed: false, reasons: ['P6 测试失败'] } }));
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.flags.includes(FLAGS.ENGINEERING_GATE));
});

test('视觉必需但画面不可用 → INCONCLUSIVE + VISION_UNKNOWN', () => {
  const r = decide(baseInput({
    observation: { visualRequired: true, visionAvailable: false, frames: [], missingKeyframes: ['before_verdict'] },
    assertions: [{ id: 'v', required: true, result: 'unknown' }],
  }));
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.ok(r.flags.includes(FLAGS.VISION_UNKNOWN));
});

// ───────────────────────── state machine ─────────────────────────

test('COMPLETED 只表示结束，不表示 PASS；verdict 单独算', () => {
  const sm = new RunStateMachine({ runId: 'r1' });
  sm.transition('SPEC_VALIDATED', { reasonCode: 'CARD_FROZEN' });
  sm.transition('PREFLIGHT', { reasonCode: 'OK' });
  sm.transition('ENV_STARTING', { reasonCode: 'OK' });
  sm.transition('WORLD_READY', { reasonCode: 'OK' });
  sm.transition('CAPABILITIES_READY', { reasonCode: 'OK' });
  sm.transition('CONTROL_READY', { reasonCode: 'OK' });
  sm.transition('OBSERVATION_READY', { reasonCode: 'OK' });
  sm.transition('EXECUTING', { reasonCode: 'OK' });
  sm.transition('VERIFYING', { reasonCode: 'OK' });
  sm.transition('FINALIZING', { reasonCode: 'OK' });
  sm.transition('COMPLETED', { reasonCode: 'FINALIZED' });
  assert.equal(sm.state, STATE.COMPLETED);
  assert.ok(!('verdict' in sm));
});

test('非法迁移与缺 reasonCode 都必须抛错', () => {
  const sm = new RunStateMachine({ runId: 'r1' });
  assert.throws(() => sm.transition('EXECUTING', { reasonCode: 'X' }), /非法迁移/);
  assert.throws(() => sm.transition('SPEC_VALIDATED', {}), /reasonCode/);
});

test('每次迁移都留痕（from/to/reasonCode/ownerEpoch）', () => {
  const sm = new RunStateMachine({ runId: 'r1', ownerEpoch: 2 });
  sm.transition('SPEC_VALIDATED', { reasonCode: 'CARD_FROZEN', ownerEpoch: 3 });
  const last = sm.history[sm.history.length - 1];
  assert.equal(last.from, 'CREATED');
  assert.equal(last.to, 'SPEC_VALIDATED');
  assert.equal(last.reasonCode, 'CARD_FROZEN');
  assert.equal(last.ownerEpoch, 3);
});
