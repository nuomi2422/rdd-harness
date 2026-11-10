'use strict';
/**
 * stop-counter.js —— 停后派发计数（2026-11-10 P1-B，思考者 R-20261110-01）。
 *
 * 旧实现只按 type+时间计数：别的同伴、别的世界、别的会话、failed/重复回执都可能混进来，
 * 于是"0 条"被当成"已证无泄漏"。现在：
 *   1. **归属**：只数本次 stop 关联的 world/server/companion；事件缺身份或与 scope 不符 → 不计入，
 *      但记 unbound/foreign 证据（不静默丢）；
 *   2. **去重**：以 requestId 为逻辑请求、attemptId 为尝试；同一逻辑请求多次尝试只算 1 条派发；
 *   3. **状态**：failed 计诊断不计"已派发"；时间戳/JSON 坏行记 error；
 *   4. **未知**：没有任何带身份的事件、或 scope 缺键 → bound=false，消费者必须判 UNKNOWN，不能当 0。
 */
function createStopCounter(pull, stopAt, scope, correlation) {
  const cutoffMs = Date.parse(stopAt);
  const errors = [];
  if (!Number.isFinite(cutoffMs)) errors.push('invalid-cutoff');
  const s = scope || {};
  const c = correlation || {};
  const scopeGiven = !!(s.worldId && s.serverSession && s.companionId);
  if (!scopeGiven) errors.push('scope-incomplete');
  // 2026-11-10 P1-B：必须绑定"本次 stop"的回执关联（stopSeq/stopId），
  // 否则旧 stop 之后到达的旧请求也会被当成"本窗停后派发"。
  const corrGiven = !!(c.stopSeq || c.stopId);
  if (!corrGiven) errors.push('no-stop-correlation');

  let rawCount = 0;
  let unboundCount = 0;
  const seenRequest = new Set();
  const seenAttempt = new Set();
  const boundRequests = [];      // 已归属、已去重、status 非 failed
  const foreign = [];            // 有身份但不匹配（别的同伴/世界/会话）
  const unbound = [];            // 缺身份，无法归属
  const failed = [];             // 已归属但 status=failed

  const idOf = (d) => ({
    world: d.world_id || d.worldId || null,
    session: d.server_session || d.serverSession || null,
    companion: d.companionId || d.companion_id || null,
  });

  function collect() {
    const chunk = pull('context.jsonl');
    pull('ai.jsonl');
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { errors.push('invalid-json'); continue; }
      if (!event || event.type !== 'llm_request') continue;
      rawCount += 1;
      const at = event.timestamp;
      if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) { errors.push('invalid-timestamp'); continue; }
      if (Number.isFinite(cutoffMs) && Date.parse(at) < cutoffMs) continue;

      const d = event.data || {};
      const ids = idOf(d);
      const requestId = d.requestId || d.request_id || null;
      if (!requestId) {
        // 无 requestId 的旧事件：reader 已保证每字节只消费一次，这里按物理行计一次诊断数。
        unbound.push({ at, reason: 'no-request-id' });
        unboundCount += 1;
        continue;
      }
      if (!ids.companion || !ids.world || !ids.session) {
        unbound.push({ at, requestId, ids, reason: 'no-identity' });
        if (!seenRequest.has(requestId)) { seenRequest.add(requestId); unboundCount += 1; }
        continue;
      }
      if (!scopeGiven) {
        unbound.push({ at, requestId, ids, reason: 'scope-incomplete' });
        if (!seenRequest.has(requestId)) { seenRequest.add(requestId); unboundCount += 1; }
        continue;
      }
      const match = ids.companion === s.companionId && ids.world === s.worldId && ids.session === s.serverSession;
      if (!match) { foreign.push({ at, requestId, ids }); continue; }

      // 回执关联：必须同时具备"本次 stop 有回执键"和"事件带同一回执键"，否则不能归属。
      const evStop = d.stopSeq || d.stopId || null;
      if (!corrGiven || !evStop) {
        unbound.push({ at, requestId, reason: 'no-stop-correlation' });
        if (!seenRequest.has(requestId)) { seenRequest.add(requestId); unboundCount += 1; }
        continue;
      }
      if (String(evStop) !== String(c.stopSeq || c.stopId)) { unbound.push({ at, requestId, reason: 'stop-correlation-mismatch' }); continue; }
      const attemptId = d.attemptId || d.attempt_id || null;
      if (attemptId) {
        if (seenAttempt.has(attemptId)) continue;
        seenAttempt.add(attemptId);
      }
      if (seenRequest.has(requestId)) continue;
      seenRequest.add(requestId);

      // 2026-11-10 P1-B：只有明确 dispatched 才算"停后派发"；failed/其它/缺 status 全部只进诊断。
      const status = d.status || null;
      if (status !== 'dispatched') { failed.push({ at, requestId, status }); continue; }
      boundRequests.push({ at, requestId, attemptId });
    }
    // 兼容：无 scope/correlation 的旧调用仍返回"去重后的物理请求数"（诊断用途）；
    // 消费者必须用 snapshot().boundCount 才能签 PASS，不能拿这个返回值当归属证据。
    return boundRequests.length + unboundCount;
  }

  return {
    collect,
    snapshot: () => ({
      boundCount: boundRequests.length,
      boundRequests,
      failed: failed.length,
      foreign: foreign.length,
      unbound: unbound.length,
      status: boundRequests.length ? 'PRESENT' : (scopeGiven && corrGiven && !unbound.length && !foreign.length && !errors.length ? 'NONE' : 'UNKNOWN'),
      bound: scopeGiven && corrGiven && boundRequests.length > 0,
      correlationBound: corrGiven,
      errors: [...new Set(errors)],
      rawCount,
      diagnostic: { unbound, foreign, failed },
    }),
  };
}
module.exports = { createStopCounter };
