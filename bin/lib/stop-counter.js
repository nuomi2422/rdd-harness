'use strict';
/**
 * stop-counter.js —— 停后派发计数（2026-11-10，R-20261110-02 六点返工版）。
 *
 * 语义分离（关键）：
 *   - **窗口归属（attributable）**：scope(world/session/companion) 齐全 + 本次 stop 回执关联存在
 *     + 无坏行/半行/未知状态。只有 attributable 时，"0 条"才是合法完整零。
 *   - **违规（violations）**：窗口内、身份已归属、status=dispatched 的请求（按 requestId+attempt 去重）。
 *   - failed / 缺 status / 坏 JSON / 半行 只作诊断，**不占用去重位、不吞后续 dispatched**，
 *     没有归属于本窗的违规时不得签 0。
 *
 * 身份读取（R-02 第 2 点）：真实事件顶层有 world_id/server_session，companionId 在 data。
 */
function createStopCounter(pull, stopAt, scope, correlation) {
  const cutoffMs = Date.parse(stopAt);
  const errors = [];
  if (!Number.isFinite(cutoffMs)) errors.push('invalid-cutoff');
  const s = scope || {};
  const c = correlation || {};
  const scopeGiven = !!(s.worldId && s.serverSession && s.companionId);
  if (!scopeGiven) errors.push('scope-incomplete');
  // R-02 第 3 点：stopSeq 是自造协议，生产不发。只接受真实回执关联或时间基准。
  const corrGiven = !!(c.commandCorrelationId || c.receiptAt);
  if (!corrGiven) errors.push('no-stop-correlation');

  let rawCount = 0;
  let unboundCount = 0;
  const seenRequest = new Set();
  const violations = [];
  const foreign = [];
  const unbound = [];
  const failed = [];
  const unknowns = [];

  const idOf = (event) => {
    const d = event.data || {};
    return {
      world: event.world_id || d.world_id || d.worldId || null,
      session: event.server_session || d.server_session || d.serverSession || null,
      companion: d.companionId || d.companion_id || event.companionId || null,
    };
  };

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
      const ids = idOf(event);
      const requestId = d.requestId || d.request_id || null;
      if (!requestId) { unbound.push({ at, reason: 'no-request-id' }); unboundCount += 1; continue; }
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
      if (ids.companion !== s.companionId || ids.world !== s.worldId || ids.session !== s.serverSession) {
        foreign.push({ at, requestId, ids });
        continue;
      }
      // 回执关联：命令关联键优先；事件若带命令键必须一致；仅时间窗时如实标注。
      const evCmd = d.command_correlation_id || d.commandCorrelationId || null;
      if (evCmd && c.commandCorrelationId && evCmd !== c.commandCorrelationId) {
        unbound.push({ at, requestId, reason: 'command-correlation-mismatch' });
        continue;
      }
      if (!corrGiven) {
        unbound.push({ at, requestId, reason: 'no-stop-correlation' });
        if (!seenRequest.has(requestId)) { seenRequest.add(requestId); unboundCount += 1; }
        continue;
      }

      const status = d.status || null;
      const attempt = d.attempt != null ? d.attempt : null;
      if (status === 'failed') { failed.push({ at, requestId, attempt }); continue; }
      if (status !== 'dispatched') { unknowns.push({ at, requestId, status }); continue; }
      const dedupeKey = requestId + '#' + (attempt == null ? '-' : attempt);
      if (seenRequest.has(dedupeKey)) continue;
      seenRequest.add(dedupeKey);
      violations.push({
        at, requestId, attempt, status,
        correlatedBy: evCmd ? 'command-correlation' : (c.commandCorrelationId ? 'command-correlation' : 'receipt-window'),
      });
    }
    // 兼容旧调用：返回含未归属的物理计数（仅诊断，不可当归属证据）。
    return violations.length + unboundCount;
  }

  return {
    collect,
    snapshot: () => {
      // 缺 status 的请求让"窗口可归属"不成立（不能把未知当干净零）。
      const attributable = scopeGiven && corrGiven && !errors.length && unknowns.length === 0;
      const status = violations.length ? 'PRESENT' : (attributable ? 'NONE' : 'UNKNOWN');
      return {
        violationCount: violations.length,
        violations,
        failed: failed.length,
        foreign: foreign.length,
        unbound: unbound.length,
        unknownStatus: unknowns.length,
        status,
        attributable,
        // 兼容字段：bound 只在"窗口可归属且确有违规"时为真；零请求用 attributable 表达。
        bound: attributable && violations.length > 0,
        correlationBound: corrGiven,
        errors: [...new Set(errors)],
        rawCount,
        diagnostic: { unbound, foreign, failed, unknowns },
      };
    },
  };
}
module.exports = { createStopCounter };
