'use strict';
// 覆盖 verified 的对抗性测试（批次卡 003 规格）：缺任何一条反例都不算通过。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('./coverage');

const STREAMS = C.STREAMS;

/** 造一份"完整且干净"的证据；用 overrides 逐项破坏。 */
function evidence(overrides) {
  const o = overrides || {};
  const start = {};
  const end = {};
  const segments = {};
  const gaps = {};
  const fileIds = {};
  for (const s of STREAMS) {
    start[s] = 100;
    end[s] = 200;
    const segFrom = o.startOffset === undefined ? 100 : o.startOffset;
    segments[s] = { segments: [{ from: segFrom, to: end[s] }], broken: 0, halfLine: false };
    gaps[s] = 0;
    fileIds[s] = { start: 'inode-1', end: 'inode-1' };
  }
  return {
    bindings: {
      world_id: 'w1',
      server_session: 's1',
      companionId: 'c1',
      requestId: 'r1',
      ...(o.bindings || {}),
    },
    window: {
      stimulusSentAt: '2026-11-10T00:00:00Z',
      stopEnqueuedAt: '2026-11-10T00:01:00Z',
      start,
      end,
      completeness: o.completeness === undefined ? 'verified-for-observed-window' : o.completeness,
      ...(o.window || {}),
    },
    segments: o.segments === null ? undefined : { ...segments, ...(o.segments || {}) },
    gaps: { ...gaps, ...(o.gaps || {}) },
    lifecycle: { closed: o.closed === undefined ? true : o.closed, replays: o.replays || 0, fileIds: { ...fileIds, ...(o.fileIds || {}) } },
  };
}

test('正例：完整且干净 → verified（冻结、带 scope）', () => {
  const cov = C.makeVerifiedCoverage(evidence());
  assert.equal(C.isVerifiedCoverage(cov), true);
  assert.equal(C.coverageLevel(cov), 'verified');
  assert.equal(cov.contentIntegrity, 'verified');
  assert.equal(cov.windowCompleteness, 'verified-for-observed-window');
  assert.equal(cov.scope, 'content-immutable-since-read');
  assert.equal(Object.isFrozen(cov), true);
  assert.deepEqual(cov.files.sort(), STREAMS.slice().sort());
});

test('手写 verified 被拒：普通对象不具备品牌', () => {
  assert.equal(C.isVerifiedCoverage({ level: 'verified', contentIntegrity: 'verified' }), false);
  assert.equal(C.coverageLevel({ level: 'verified' }), 'limited');
});

test('复用旧 offset 冒充本次 → 拒绝', () => {
  assert.throws(() => C.makeVerifiedCoverage(evidence({ startOffset: 50 })), /首段未从窗口起点开始/);
});

test('跨窗拼接两段当一段 → 拒绝', () => {
  const e = evidence();
  e.segments.tools = { segments: [{ from: 100, to: 150 }, { from: 160, to: 200 }], broken: 0, halfLine: false };
  assert.throws(() => C.makeVerifiedCoverage(e), /不连续/);
});

test('半行截断 → 拒绝', () => {
  const e = evidence();
  e.segments.ai = { segments: [{ from: 100, to: 200 }], broken: 0, halfLine: true };
  assert.throws(() => C.makeVerifiedCoverage(e), /半行未完成段/);
});

test('有 gap → 拒绝（0 才放行）', () => {
  assert.throws(() => C.makeVerifiedCoverage(evidence({ gaps: { events: 3 } })), /gaps 不为 0/);
});

test('同 event_id 重放 → 拒绝', () => {
  assert.throws(() => C.makeVerifiedCoverage(evidence({ replays: 1 })), /重放/);
});

test('只有部分流被消费 → 拒绝', () => {
  const e = evidence();
  delete e.segments.instrumentation;
  assert.throws(() => C.makeVerifiedCoverage(e), /流未消费/);
});

test('日志换文件（fileId 变化）→ 拒绝', () => {
  assert.throws(() => C.makeVerifiedCoverage(evidence({ fileIds: { rdd: { start: 'inode-1', end: 'inode-2' } } })), /换文件/);
});

test('事后复读指纹不一致 → 拒绝', () => {
  const e = evidence();
  e.segments.context = { segments: [{ from: 100, to: 200, fingerprintMatch: false }], broken: 0, halfLine: false };
  assert.throws(() => C.makeVerifiedCoverage(e), /指纹不一致/);
});

test('绑定键缺一 → unknown（不是 rejected，也不能 verified）', () => {
  const e = evidence();
  delete e.bindings.requestId;
  assert.throws(() => C.makeVerifiedCoverage(e), (err) => err.code === 'COVERAGE_UNKNOWN');
});

test('窗口未声明完整 → 只能 content-only，不冒充 verified', () => {
  const cov = C.makeVerifiedCoverage(evidence({ completeness: 'partial' }));
  assert.equal(C.coverageLevel(cov), 'content-only');
  assert.equal(cov.windowCompleteness, 'unproven');
});

test('生命周期未闭合 → 拒绝', () => {
  assert.throws(() => C.makeVerifiedCoverage(evidence({ closed: false })), /生命周期未闭合/);
});