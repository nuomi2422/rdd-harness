'use strict';
/** Consume only bytes emitted by the existing incremental reader. Raw counts are diagnostic;
 * neither a count nor a matching timestamp proves scope, full coverage, or a logical request. */
function createStopCounter(pull, stopAt) {
  let rawCount = 0;
  const errors = [];
  const cutoffMs = Date.parse(stopAt);
  if (!Number.isFinite(cutoffMs)) errors.push('invalid-cutoff');
  function collect() {
    const chunk = pull('context.jsonl');
    pull('ai.jsonl');
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { errors.push('invalid-json'); continue; }
      if (event.type !== 'llm_request') continue;
      if (typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) {
        errors.push('invalid-timestamp'); continue;
      }
      if (Number.isFinite(cutoffMs) && Date.parse(event.timestamp) >= cutoffMs) rawCount++;
    }
    return rawCount;
  }
  return { collect, snapshot: () => ({ rawCount, errors: [...new Set(errors)] }) };
}
module.exports = { createStopCounter };
