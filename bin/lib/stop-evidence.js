'use strict';
/**
 * stop-evidence.js —— runner→judge 的唯一组装缝（R-02 #6 / R-03 #5）。
 *
 * 原则：
 *   - **不补默认值**：saveConfirmed/ownerStop/coverageVerified/scopeVerified 都由调用方
 *     给真实值；没给就写 null/undefined，由 judge 判 UNKNOWN。
 *   - **不覆盖真实回执**：ownerStop 原样透传。
 *   - 三态契约：violationBound（已归属违规）/ cleanZeroVerified（可证合法零）/ unknown。
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
  saveConfirmed,
  ownerStop,
}) {
  const snap = counterSnapshot || {};
  const violationBound = snap.violationBound === true;
  const cleanZeroVerified = snap.cleanZeroVerifiable === true;
  const attribution = violationBound ? 'bound-violation' : (cleanZeroVerified ? 'bound-clean' : 'unknown');
  return {
    saveConfirmed: saveConfirmed === true ? true : (saveConfirmed === false ? false : null),
    ownerStop: ownerStop === undefined ? null : ownerStop,
    postStopRequests: Number.isFinite(snap.violationCount) ? snap.violationCount : null,
    violationBound,
    cleanZeroVerified,
    independentPostStop: null,
    independentPostStopNote: 'removed: same-number pseudo-independence',
    postStopAttribution: attribution,
    postStopStatus: postStopStatus == null ? null : postStopStatus,
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
    observedGraceMs: Number.isFinite(observedGraceMs) ? observedGraceMs : null,
    observation: observation || null,
    javaExited: javaExited === true ? true : (javaExited === false ? false : null),
    coverageVerified: coverageVerified === true ? true : (coverageVerified === false ? false : null),
    scopeVerified: scopeVerified === true ? true : (scopeVerified === false ? false : null),
    enqueueToEffective: enqueueToEffective || null,
  };
}

module.exports = { buildStopEvidence };
