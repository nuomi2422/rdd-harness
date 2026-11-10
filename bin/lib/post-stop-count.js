'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Inspect llm_request lines at/after ISO cutoff across context streams.
 * Returns count:null when the source set cannot be trusted (missing dir, bad lines,
 * untrusted future clock); rawCount is diagnostic only, never a logical request count.
 */
function inspectContextRequestsSince(dir, iso, nowMs = Date.now()) {
  const reasons = [];
  const cutoffMs = Date.parse(iso);
  if (!Number.isFinite(cutoffMs)) reasons.push('invalid-cutoff');
  if (!fs.existsSync(dir)) return { count: null, status: 'UNKNOWN', reasons: ['missing-dir'], rawCount: 0 };
  const files = fs.readdirSync(dir).filter(f => /^context.*\.jsonl$/.test(f));
  if (files.length === 0) return { count: null, status: 'UNKNOWN', reasons: ['no-context-stream'], rawCount: 0 };
  let count = 0, rawCount = 0;
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { reasons.push('read-failed:' + f); continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { reasons.push('unparsable-line:' + f); continue; }
      if (obj.type !== 'llm_request') continue;
      rawCount++;
      const ts = obj.timestamp;
      if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) { reasons.push('untrusted-timestamp:' + f); continue; }
      if (Date.parse(ts) > nowMs + 300000) reasons.push('future-clock:' + f);
      if (Number.isFinite(cutoffMs) && Date.parse(ts) >= cutoffMs) count++;
    }
  }
  // A global timestamp scan cannot establish companion/world/session ownership,
  // continuity across rotations, or a complete observation window. Never sign a
  // scoped logical count from this diagnostic scan, even when all JSON parses.
  reasons.push('scope-and-window-unverified');
  return { count: null, status: 'UNKNOWN', reasons: [...new Set(reasons)].sort(), rawCount, diagnosticAfterCutoff: count };
}

function countContextRequestsSince(dir, iso) { return inspectContextRequestsSince(dir, iso).count; }

module.exports = { inspectContextRequestsSince, countContextRequestsSince };
