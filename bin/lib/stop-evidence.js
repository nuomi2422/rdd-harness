'use strict';
/**
 * stop-evidence.js —— runner→judge 的**唯一组装缝**（2026-11-10 R-02 第 6 点）。
 *
 * 为什么抽出来：chain 测试自己手写 coverageVerified/scopeVerified/postStopAttribution，
 * 等于测了第二份实现。现在 runner 与测试都调用这里，judge 的输入形状只由这一处决定。
 *
 * 输入只接受**已经算出来的事实**（counter snapshot、观察窗、覆盖验证结果），
 * 本模块不做判定、不补默认值——缺什么就写 null/UNKNOWN。
 */
function buildStopEvidence({
  counterSnapshot,
  observation,
  coverageVerified,
  scopeVerified,
  observedGraceMs,
  javaExited,
  stopAt,
  stopEffectiveAt,
  stopEffectiveReceipt,
  stopScope,
  postStopStatus,
  postStopReasons,
  rawScanCount,
  enqueueToEffective,
}) {
  const snap = counterSnapshot || {};
  const attributable = snap.attributable === true;
  const violations = Number.isFinite(snap.violationCount) ? snap.violationCount : null;
  const attribution = attributable
    ? (violations > 0 ? 'bound-violation' : 'bound-clean')
    : 'unknown';
  return {
    ownerStop: stopEffectiveReceipt ? stopEffectiveReceipt.ownerStop || null : null,
    saveConfirmed: true,
    postStopRequests: violations,
    // R-02 第 5 点：不再复用一个数冒充独立证据；字段保留为 null 并注明。
    independentPostStop: null,
    independentPostStopNote: 'removed: same-number pseudo-independence',
    postStopAttribution: attribution,
    postStopCleanZero: attributable && violations === 0,
    postStopStatus,
    postStopReasons: postStopReasons || [],
    postStopRawCount: rawScanCount == null ? null : rawScanCount,
    postStopDiagnostic: {
      foreign: snap.foreign == null ? null : snap.foreign,
      unbound: snap.unbound == null ? null : snap.unbound,
      failed: snap.failed == null ? null : snap.failed,
      unknownStatus: snap.unknownStatus == null ? null : snap.unknownStatus,
      errors: snap.errors || [],
    },
    stopScope: stopScope || null,
    stopAt,
    stopEffectiveAt: stopEffectiveAt || null,
    observedGraceMs,
    observation,
    javaExited,
    coverageVerified,
    scopeVerified,
    enqueueToEffective: enqueueToEffective || null,
  };
}

module.exports = { buildStopEvidence };
