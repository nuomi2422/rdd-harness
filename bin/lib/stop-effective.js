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
    hit = { at: ev.timestamp, correlationId: d.correlation_id, eventSeq: ev.event_seq == null ? null : ev.event_seq };
  }
  return hit;
}

/** 找与本次命令同键的 owner_stop 回执。 */
function scanOwnerStop(lines, companionId, sinceIso, expectedCommandId) {
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
    hit = {
      at: ev.timestamp, drained: d.drained, overflowDropped: d.overflow_dropped,
      commandCorrelationId: key, eventSeq: ev.event_seq == null ? null : ev.event_seq,
    };
  }
  return hit;
}

async function waitForStopEffective({ readText, companionId, enqueueAtIso, expectedCommandId, timeoutMs = 15000, pollMs = 250, sleep, now }) {
  const deadline = now() + timeoutMs;
  let last = [];
  for (;;) {
    const lines = String(readText() || '').split(/\r?\n/);
    last = lines;
    const hit = scanOwnerStop(lines, companionId, enqueueAtIso, expectedCommandId);
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
