'use strict';
/**
 * stop-effective.js —— 等 owner_stop **生效回执**（R-03 第 3 点：必须与本次命令关联）。
 *
 * 真实链路（已核源码）：
 *   NumenGateway 命令路径生成 commandId 并发布 ai/command_dispatch{companion_id, command, correlation_id}
 *   → EntityAgentLoop 发布 ai/owner_stop{companion_id, command_correlation_id, drained, overflow_dropped}
 * 因此本次 stop 的关联 = **两条事件同键**，而不是时间窗。时间只用于排序。
 *
 * 缺 dispatch 或 owner_stop、或键不一致 → 返回 UNKNOWN（调用方不得用入队时刻冒充生效）。
 */
const OWNER_STOP = '"type":"owner_stop"';
const COMMAND_DISPATCH = '"type":"command_dispatch"';

function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行由调用方缺口覆盖 */ }
  }
  return out;
}

/** 找本次 /stop 的 command_dispatch 回执（同 companion、时间不早于入队）。 */
function findStopCommand(lines, companionId, sinceIso) {
  const sinceMs = Date.parse(sinceIso);
  let hit = null;
  for (const ev of parseLines(lines)) {
    if (!ev || ev.type !== 'command_dispatch') continue;
    const d = ev.data || {};
    if (d.companion_id !== companionId) continue;
    const cmd = String(d.command || '').toLowerCase();
    if (cmd !== 'stop' && cmd !== '/stop') continue;
    const atMs = Date.parse(ev.timestamp);
    if (!Number.isFinite(atMs) || (Number.isFinite(sinceMs) && atMs < sinceMs)) continue;
    if (!d.correlation_id) continue;
    // R-04：这是"观测到的候选"，只作诊断；没有本次入队返回的键就不能升 EFFECTIVE。
    hit = { diagnostic: true, at: ev.timestamp, correlationId: d.correlation_id, eventSeq: ev.event_seq == null ? null : ev.event_seq };
  }
  return hit;
}

/** 找与本次命令同键的 owner_stop 回执（scope 提供时 world/server 也必须严格匹配）。 */
function scanOwnerStop(lines, companionId, sinceIso, expectedCommandId, scope) {
  const sinceMs = Date.parse(sinceIso);
  let hit = null;
  for (const ev of parseLines(lines)) {
    if (!ev || ev.type !== 'owner_stop') continue;
    const d = ev.data || {};
    const atMs = Date.parse(ev.timestamp);
    if (!Number.isFinite(atMs) || (Number.isFinite(sinceMs) && atMs < sinceMs)) continue;
    // R-03：同伴必须严格匹配；事件缺 companion_id 时不能默认归给本次同伴。
    if (!companionId || !d.companion_id || d.companion_id !== companionId) continue;
    if (d.drained === undefined && d.overflow_dropped === undefined) continue;
    const key = d.command_correlation_id || d.commandCorrelationId || null;
    // R-03：必须与本次命令同键；只按时间/seq 不算本次关联。
    if (!expectedCommandId || !key || key !== expectedCommandId) continue;
    // R-04：scope 提供时，事件的世界/服务器也必须严格匹配；缺失或不符 → 不接受（不猜）。
    // R-06：冲突/同源校验——top 与 data 不一致、stamp_conflict、非法/缺失身份一律不接受。
    if (ev.stamp_conflict === true) continue;
    if (ev.world_id && d.world_id && ev.world_id !== d.world_id) continue;
    if (ev.server_session && d.server_session && ev.server_session !== d.server_session) continue;
    if (d.identity_status && d.identity_status !== 'OK') continue;
    if (scope) {
      const w = ev.world_id || d.world_id || null;
      const s = ev.server_session || d.server_session || null;
      const topEpoch = ev.world_epoch != null ? ev.world_epoch : (ev.stamp_epoch != null ? ev.stamp_epoch : null);
      const dataEpoch = d.stamp_epoch != null ? d.stamp_epoch : null;
      // top 与 data 同时存在必须一致；不一致 = 冲突，不接受。
      if (topEpoch != null && dataEpoch != null && Number(topEpoch) !== Number(dataEpoch)) continue;
      const ep = topEpoch != null ? topEpoch : dataEpoch;
      if (!w || !s || w !== scope.worldId || s !== scope.serverSession) continue;
      // epoch 只是本地代次：scope 要求时必须是安全非负整数且相等（缺/null/空串/布尔/字符串一律 UNKNOWN）。
      if (scope.epoch != null) {
        if (typeof ep !== 'number' || !Number.isSafeInteger(ep) || ep < 0) continue;
        if (ep !== scope.epoch) continue;
      }
    }
    hit = {
      at: ev.timestamp, drained: d.drained, overflowDropped: d.overflow_dropped,
      commandCorrelationId: key, eventSeq: ev.event_seq == null ? null : ev.event_seq,
    };
  }
  return hit;
}

async function waitForStopEffective({ readText, companionId, enqueueAtIso, expectedCommandId, scope, timeoutMs = 15000, pollMs = 250, sleep, now }) {
  const deadline = now() + timeoutMs;
  let last = [];
  for (;;) {
    const lines = String(readText() || '').split(/\r?\n/);
    last = lines;
    const hit = scanOwnerStop(lines, companionId, enqueueAtIso, expectedCommandId, scope);
    if (hit) return { state: 'EFFECTIVE', ...hit };
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  return { state: 'TIMEOUT', effectiveAt: null, reason: expectedCommandId ? 'no-owner-stop-with-matching-command-id' : 'no-command-correlation' };
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

module.exports = { findStopCommand, scanOwnerStop, waitForStopEffective, dispatchesBetween };
