'use strict';
/** 2026-11-07: 时间锁运行时适用范围（P9 TL-2026-10-07-01）。仅支持 dsh/opencode；其它一律退回旧行为。 */
const SUPPORTED = new Set(['dsh', 'opencode']);

function normalizeRuntime(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return SUPPORTED.has(v) ? v : null;
}

/** true=当前运行时不适用该锁（可跳过到期阻断）。结构坏/未声明/未知值 => false（旧行为）。 */
function excludedForRuntime(lock, rawRuntime) {
  const rt = normalizeRuntime(rawRuntime);
  if (!rt) return false;
  const applies = lock && lock.appliesTo;
  if (!Array.isArray(applies) || applies.length === 0) return false;
  const norm = applies.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : ''));
  if (norm.some((x) => !SUPPORTED.has(x))) return false;
  return !norm.includes(rt);
}

module.exports = { normalizeRuntime, excludedForRuntime, SUPPORTED };
