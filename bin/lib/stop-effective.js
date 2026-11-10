'use strict';
/**
 * stop-effective.js —— 等 owner_stop **生效回执**，并区分"入队→生效"这段窗口（2026-11-10）。
 *
 * 为什么需要：cov4 实测停止入队 → 1.47 秒后才生效；这段时间里旧响应落地、开了新回合、
 * 并在闩生效前 17ms 发出请求。旧的截止时刻用**入队**时间，于是把"闩生效前的正常竞态"
 * 判成"停后仍在派发"；而把截止改成"生效"又可能把慢停止的真实泄漏洗白。
 *
 * 本模块只做两件事，不改判据：
 *   1. 轮询 ai.jsonl 等 owner_stop 回执（同 companion、带 drained/overflow 字段）；
 *   2. 把 enqueue→effective 之间的派发单独数出来（进报告，不进 S4 通过条件）。
 * 超时/找不到回执 → state='TIMEOUT'，调用方必须记 UNKNOWN，不许当成功。
 */

const OWNER_STOP = '"type":"owner_stop"';

function scanOwnerStop(lines, companionId, sinceIso) {
  let hit = null;
  for (const line of lines) {
    if (!line || !line.includes(OWNER_STOP)) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || ev.timestamp === undefined) continue;
    const atMs = Date.parse(ev.timestamp);
    const sinceMs = Date.parse(sinceIso);
    // 日志里的时间戳精度不一（有的带毫秒有的不带），必须按时间比较，不能按字符串比。
    if (!Number.isFinite(atMs) || (Number.isFinite(sinceMs) && atMs < sinceMs)) continue;
    const d = ev.data || {};
    if (companionId && d.companion_id && d.companion_id !== companionId) continue;
    if (d.drained === undefined && d.overflow_dropped === undefined) continue;
    hit = { at: ev.timestamp, drained: d.drained, overflowDropped: d.overflow_dropped };
  }
  return hit;
}

/** 数 enqueue→effective 之间的 llm_request 派发（只用于报告，不参与判定）。 */
function dispatchesBetween(lines, sinceIso, untilIso) {
  const out = [];
  for (const line of lines) {
    if (!line || !line.includes('"type":"llm_request"')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const at = ev && ev.timestamp;
    const atMs = Date.parse(at);
    const sinceMs = Date.parse(sinceIso);
    const untilMs = Date.parse(untilIso);
    if (!Number.isFinite(atMs)) continue;
    if (Number.isFinite(sinceMs) && atMs < sinceMs) continue;
    if (Number.isFinite(untilMs) && atMs > untilMs) continue;
    const d = ev.data || {};
    out.push({ requestId: d.requestId || null, at, status: d.status || null });
  }
  return out;
}

async function waitForStopEffective({ readText, companionId, enqueueAtIso, timeoutMs = 15000, pollMs = 250, sleep, now }) {
  const deadline = now() + timeoutMs;
  let last = [];
  for (;;) {
    last = String(readText() || '').split(/\r?\n/);
    const hit = scanOwnerStop(last, companionId, enqueueAtIso);
    if (hit) return { state: 'EFFECTIVE', ...hit };
    if (now() >= deadline) {
      return { state: 'TIMEOUT', waitedMs: timeoutMs, effectiveAt: null };
    }
    await sleep(pollMs);
  }
}

module.exports = { scanOwnerStop, dispatchesBetween, waitForStopEffective };
