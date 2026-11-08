'use strict';

// P22 的纯判定：未来记录先排除，毫秒精度检查 30 分钟闭区间。
// 用法：evaluateDigestLedger(JSONL文本, 当前时间毫秒)；坏行不能作为证据。
function evaluateDigestLedger(text, now) {
  let newest = null;
  if (typeof text !== 'string' || !Number.isFinite(now)) return { pass: false, ageMs: null };
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim()) continue;
    try {
      const entry = JSON.parse(row);
      const at = entry && typeof entry.at === 'string' ? Date.parse(entry.at) : NaN;
      if (Number.isFinite(at) && at <= now && (newest === null || at > newest)) newest = at;
    } catch { /* 坏行不能作为证据 */ }
  }
  const ageMs = newest === null ? null : now - newest;
  return { pass: ageMs !== null && ageMs <= 30 * 60 * 1000, ageMs };
}

module.exports = { evaluateDigestLedger };
