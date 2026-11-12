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
const { validateReceipt } = require('./stop-receipt');
const { scanOwnerStop } = require('./stop-effective');
const { isVerifiedCoverage } = require('./coverage');

/** 051: verify existing receipts and cursor evidence; no identity is inferred from raw stamps. */
function verifyStopScope({ enqueueReceipt, selectedUuid, stopEffectiveReceipt, stopEffectiveAt,
  stopAt, stopScope, counterSnapshot, coverage, observation, observedGraceMs }) {
  const reasons = [];
  const receiptCheck = validateReceipt(enqueueReceipt, selectedUuid);
  if (!receiptCheck.ok) reasons.push('enqueue-receipt:' + receiptCheck.reason);
  const receipt = receiptCheck.ok ? enqueueReceipt : null;
  const scope = stopScope || {};
  const expected = receipt && { worldId: receipt.worldId, serverSession: receipt.serverSession,
    companionId: selectedUuid, epoch: receipt.epoch };
  const sameScope = candidate => expected && candidate && ['worldId', 'serverSession', 'companionId', 'epoch']
    .every(k => candidate[k] === expected[k]);
  if (!sameScope(scope)) reasons.push('receipt-scope-mismatch');
  const effective = stopEffectiveReceipt || {};
  const hit = receipt && effective.ownerStopEvent && scanOwnerStop([JSON.stringify(effective.ownerStopEvent)],
    selectedUuid, stopAt, receipt.commandId, expected);
  if (!hit || effective.ownerStopEvent.data.identity_status !== 'OK' || effective.state !== 'EFFECTIVE' || effective.commandCorrelationId !== receipt.commandId
      || effective.at !== hit.at || stopEffectiveAt !== hit.at
      || !Number.isFinite(Date.parse(stopAt)) || Date.parse(hit.at) < Date.parse(stopAt)) {
    reasons.push('no-matching-owner-stop');
  }
  const snap = counterSnapshot || {};
  if (!sameScope(snap.scope) || !receipt || snap.commandCorrelationId !== receipt.commandId
      || snap.cutoff !== stopEffectiveAt || snap.correlationBound !== true
      || (snap.cleanZeroVerifiable !== true && snap.violationBound !== true)) reasons.push('counter-unbound');
  const coverageVerified = isVerifiedCoverage(coverage) && coverage.contentIntegrity === 'verified'
    && coverage.windowCompleteness === 'verified-for-observed-window';
  if (!coverageVerified) reasons.push('coverage-unverified');
  else {
    const b = coverage.bindings;
    const w = coverage.observedWindow;
    if (!expected || b.world_id !== expected.worldId || b.server_session !== expected.serverSession
        || b.companionId !== expected.companionId) reasons.push('coverage-scope-mismatch');
    const from = Date.parse(w.stimulusSentAt), to = Date.parse(w.stopEnqueuedAt), at = Date.parse(stopEffectiveAt);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(at)
        || from > Date.parse(stopAt) || to < at + observedGraceMs) reasons.push('coverage-window-incomplete');
  }
  if (!observation || observation.complete !== true || observation.gaps === true || observation.invalidClock === true
      || !Number.isFinite(observation.pollingMs) || observation.pollingMs < 60000
      || !Number.isFinite(observation.observedMs) || observation.observedMs < 60000
      || !Number.isFinite(observedGraceMs) || observedGraceMs !== observation.observedMs) reasons.push('observation-incomplete');
  return { coverageVerified, scopeVerified: reasons.length ? null : true,
    scopeVerifiedReason: reasons.length ? reasons.join(',') : 'receipt-owner-stop-counter-coverage-verified',
    postStopStatus: reasons.length ? 'UNKNOWN' : 'PRESENT', postStopReasons: reasons.length ? reasons : ['verified-by-cursor'] };
}

function buildStopEvidence({
  enqueueReceipt,
  selectedUuid,
  coverage,
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
  // Only the strict production path supplies the actual enqueue receipt (including null on failure).
  // Legacy assembly remains conservative and preserves its existing three-state fields.
  const verified = enqueueReceipt === undefined ? null : verifyStopScope({ enqueueReceipt, selectedUuid,
    stopEffectiveReceipt, stopEffectiveAt, stopAt, stopScope, counterSnapshot, coverage, observation, observedGraceMs });
  const cleanZeroVerified = snap.cleanZeroVerifiable === true
    && (!verified || (snap.violationCount === 0 && verified.scopeVerified === true));
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
    stopEffectiveReceipt: stopEffectiveReceipt || null,
    observedGraceMs: Number.isFinite(observedGraceMs) ? observedGraceMs : null,
    observation: observation || null,
    javaExited: javaExited === true ? true : (javaExited === false ? false : null),
    coverageVerified: coverageVerified === true ? true : (coverageVerified === false ? false : null),
    scopeVerified: scopeVerified === true ? true : (scopeVerified === false ? false : null),
    enqueueToEffective: enqueueToEffective || null,
    ...(verified || {}),
  };
}

module.exports = { buildStopEvidence, verifyStopScope };
