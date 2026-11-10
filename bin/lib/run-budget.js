'use strict';
/**
 * Monotonic planning only: does not interrupt save, kill processes, or assert success.
 * watchLimit is measured from stimulus start; totalLimit from run start.
 * Reserve and operation caps are explicit policies, not changes to the frozen contract.
 */
function createRunBudget({clock, runStart, totalLimitMs, stopReserveMs, watchLimitMs}) {
  if (typeof clock !== 'function' || ![runStart,totalLimitMs,stopReserveMs,watchLimitMs].every(Number.isFinite)
      || totalLimitMs <= 0 || watchLimitMs <= 0 || stopReserveMs < 0 || stopReserveMs >= totalLimitMs) {
    throw new TypeError('invalid budget');
  }
  const totalDeadline = runStart + totalLimitMs;
  let stimulusStart = null;
  const left = () => Math.max(0, totalDeadline - clock());
  return {
    startStimulus() { if (stimulusStart !== null) throw new Error('stimulus already started'); stimulusStart = clock(); },
    watchDecision(nextOperationMaxMs = 0) {
      if (stimulusStart === null || !Number.isFinite(nextOperationMaxMs) || nextOperationMaxMs < 0) throw new TypeError('invalid watch operation');
      const now = clock();
      const watchRemaining = Math.max(0, stimulusStart + watchLimitMs - now);
      const totalRemaining = Math.max(0, totalDeadline - now);
      const available = Math.max(0, Math.min(watchRemaining, totalRemaining - stopReserveMs));
      return { allow: available > nextOperationMaxMs, watchRemaining, totalRemaining, available, stopReserveMs };
    },
    async runOptionalOperation(maxMs, keepMs, operation) {
      if (!Number.isFinite(maxMs) || maxMs < 0 || !Number.isFinite(keepMs) || keepMs < 0 || typeof operation !== 'function') throw new TypeError('invalid optional operation');
      const remaining = left();
      if (remaining < maxMs + keepMs) return { started: false, remaining };
      return { started: true, value: await operation(), remaining };
    },
    async runWatchOperation(maxMs, operation) {
      if (typeof operation !== 'function') throw new TypeError('operation required');
      const decision = this.watchDecision(maxMs);
      if (!decision.allow) return { started: false, decision };
      return { started: true, value: await operation(), decision };
    },
    snapshot() { const now=clock(); return { totalElapsed: now-runStart, totalRemaining: left(), watchElapsed: stimulusStart === null ? null : now-stimulusStart, totalExceeded: now > totalDeadline }; },
  };
}
module.exports = {createRunBudget};
