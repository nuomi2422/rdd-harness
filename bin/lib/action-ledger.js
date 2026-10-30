'use strict';
/**
 * action-ledger.js —— 151 §3「统一动作证据」：从 tools.jsonl + events.jsonl 还原每次调用走到哪一步。
 *
 * 只读日志，不改行为。六条口径（每一条都对应审计里踩过的一次误判）：
 *   1. 一次调用一个身份：以 `tool_call_id` 为准；同一个 id 的多条 result 只算一次
 *      —— 服务端与客户端各写一条（`journaled_by:"client"`）时，重复投递不得重复计数。
 *   2. 受理 ≠ 完成：异步工具回 `data.async:true` 只到 `accepted`，完成任务要等 `task_finished`。
 *   3. 终态只认 `task_finished`；等不到就是 `accepted-no-terminal`（UNKNOWN），**不是成功**。
 *   4. 有调用没有 result = `no-result`（观测缺口），**既不是失败也不是成功**。
 *   5. 累计失败 ≠ 连续失败：streak 遇成功清零，单独计；两者都给。
 *   6. 缺字段一律 UNKNOWN，并给 coverage（多少条真带 callId / taskId / 终态）。
 *
 * 真实行形状（r39）：
 *   {"type":"tool_call","data":{"tool":"goto","tool_call_id":"call_04ee…","companion_id":"…"}}
 *   {"type":"tool_result","data":{"tool":"goto","tool_call_id":"call_04ee…","result":"{\"success\":true,\"data\":{\"async\":true,\"task_id\":\"t1\"}}"}}
 *   {"type":"tool_result","data":{"tool":"goto","tool_call_id":"call_04ee…","journaled_by":"client","success":true,…}}  ← 同一 id 的第二条
 *   {"type":"task_finished","data":{"id":"t1","task":"goto","status":"stopped","message":"cancelled before reaching target"}}
 */

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** 解析 jsonl 文本；坏行不抛错，只计数（日志尾巴被截断是常态）。 */
function parseLines(text) {
  const out = [];
  let bad = 0;
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const o = safeJson(t);
    if (o && typeof o === 'object') out.push(o); else bad++;
  }
  return { events: out, bad };
}

/** result 字段可能是 JSON 字符串，也可能已经是对象。 */
function resultPayload(data) {
  if (!data) return null;
  if (data.result && typeof data.result === 'object') return data.result;
  if (typeof data.result === 'string') {
    const p = safeJson(data.result);
    if (p && typeof p === 'object') return p;
  }
  // 有些行把 success 直接放在 data 上（客户端 journal 行）
  if (typeof data.success === 'boolean') return { success: data.success };
  return null;
}

function payloadSuccess(p) {
  return p && typeof p.success === 'boolean' ? p.success : null;
}

function payloadAsync(p) {
  const d = p && p.data && typeof p.data === 'object' ? p.data : null;
  return !!(d && d.async === true);
}

function payloadTaskId(p) {
  const d = p && p.data && typeof p.data === 'object' ? p.data : null;
  return d && (typeof d.task_id === 'string' || typeof d.task_id === 'number') ? String(d.task_id) : '';
}

/** task_finished 的 status -> 终态 */
function terminalOf(data) {
  const st = String((data && data.status) || '').toLowerCase();
  const msg = String((data && data.message) || '');
  if (/timeout|timed out|超时/i.test(st) || /timed out after/i.test(msg)) return 'timeout';
  if (/cancel|stop|叫停|中断/i.test(st) || /cancelled|aborted|stopped before/i.test(msg)) return 'cancelled';
  if (/fail|error|失败/i.test(st)) return 'failed';
  if (/complete|done|success|finished|完成/i.test(st)) return 'completed';
  return st ? 'terminal:' + st : 'terminal:unknown';
}

/**
 * @param {string} toolsText tools.jsonl 全文
 * @param {string} eventsText events.jsonl 全文
 * @param {{minStreak?:number}} [opts]
 * @returns {{calls:Array, summary:object, blockers:Array, parse:object}}
 */
function build(toolsText, eventsText, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const minStreak = Number.isFinite(o.minStreak) ? o.minStreak : 3;
  const tp = parseLines(toolsText);
  const ep = parseLines(eventsText);

  const calls = new Map(); // callId -> call
  let resultsWithoutCall = 0;
  let duplicateResults = 0;
  let callsWithoutId = 0;

  const ensure = (id, base) => {
    if (!calls.has(id)) {
      calls.set(id, Object.assign({
        callId: id || null,
        tool: '',
        companion: '',
        requestedAt: null,
        state: 'requested',
        success: null,
        async: false,
        taskId: '',
        resultCount: 0,
        duplicates: 0,
        terminal: null,
        terminalAt: null,
        terminalMessage: '',
        payload: null,
      }, base || {}));
    }
    return calls.get(id);
  };

  for (const ev of tp.events) {
    const type = ev.type;
    const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
    const id = typeof d.tool_call_id === 'string' ? d.tool_call_id : '';
    if (type === 'tool_call') {
      if (!id) { callsWithoutId++; continue; }
      const c = ensure(id);
      c.tool = c.tool || String(d.tool || '');
      c.companion = c.companion || String(d.companion_id || '');
      c.requestedAt = c.requestedAt || ev.timestamp || null;
      continue;
    }
    if (type === 'tool_result') {
      if (!id) { callsWithoutId++; continue; }
      const existed = calls.has(id);
      const c = ensure(id);
      c.resultCount += 1;
      if (!c.tool) c.tool = String(d.tool || '');
      const p = resultPayload(d);
      // 重复投递：同一 id 第二条起只计数，不覆盖已判定的结果；
      // 但「先到的是无 success 的原始行、后到的是带 success 的客户端行」这种要升级。
      if (existed && c.state !== 'requested' && (payloadSuccess(p) === null || c.success !== null)) {
        c.duplicates += 1;
        duplicateResults += 1;
        continue;
      }
      c.payload = p || c.payload;
      c.success = payloadSuccess(p);
      c.async = payloadAsync(p);
      c.taskId = payloadTaskId(p) || c.taskId;
      if (c.success === false) c.state = 'failed';
      else if (c.async) c.state = 'accepted-no-terminal';         // 受理，不是完成
      else if (c.success === true) c.state = 'completed';
      else c.state = 'result-no-status';                        // 有回执但回执里没有 success（例如 scan 的实体清单）
      if (!existed) resultsWithoutCall += 1;
    }
  }

  // 收尾：没有任何 result 的调用 = 观测缺口
  for (const c of calls.values()) {
    if (c.state === 'requested') c.state = 'no-result';
  }

  // 异步终态：task_finished.data.id 对上 result.data.task_id
  const byTask = new Map();
  for (const c of calls.values()) if (c.taskId) byTask.set(c.taskId, c);
  let terminalsWithoutCall = 0;
  for (const ev of ep.events) {
    const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
    if (ev.type !== 'task_finished') continue;
    const id = d.id === undefined || d.id === null ? '' : String(d.id);
    const c = id ? byTask.get(id) : null;
    if (!c) { terminalsWithoutCall++; continue; }
    c.terminal = terminalOf(d);
    c.terminalAt = ev.timestamp || null;
    c.terminalMessage = String(d.message || '').slice(0, 200);
    c.state = c.terminal; // completed / failed / cancelled / terminal:*
  }

  const list = [...calls.values()].sort((a, b) => String(a.requestedAt || '').localeCompare(String(b.requestedAt || '')));

  // 统计
  const states = {};
  const byTool = {};
  for (const c of list) {
    states[c.state] = (states[c.state] || 0) + 1;
    const t = c.tool || 'unknown';
    const b = byTool[t] || (byTool[t] = { calls: 0, completed: 0, failed: 0, cancelled: 0, timeout: 0, acceptedNoTerminal: 0, noResult: 0, resultNoStatus: 0, other: 0 });
    b.calls += 1;
    if (c.state === 'completed') b.completed += 1;
    else if (c.state === 'failed') b.failed += 1;
    else if (c.state === 'cancelled') b.cancelled += 1;
    else if (c.state === 'timeout') b.timeout += 1;
    else if (c.state === 'accepted-no-terminal') b.acceptedNoTerminal += 1;
    else if (c.state === 'no-result') b.noResult += 1;
    else if (c.state === 'result-no-status') b.resultNoStatus += 1;
    else b.other += 1;
  }

  // 连续失败（遇成功清零）vs 累计失败：两把不同的尺子
  const streakNow = {};
  const streakMax = {};
  let failuresTotal = 0;
  const blockers = [];
  const blocked = new Set();
  for (const c of list) {
    const t = c.tool || 'unknown';
    if (c.state === 'completed') { streakNow[t] = 0; continue; }
    if (c.state === 'failed') {
      failuresTotal += 1;
      streakNow[t] = (streakNow[t] || 0) + 1;
      streakMax[t] = Math.max(streakMax[t] || 0, streakNow[t]);
      if (streakNow[t] >= minStreak && !blocked.has(t)) {
        blocked.add(t);
        blockers.push({ tool: t, consecutive_failures: streakNow[t], at: c.requestedAt, callId: c.callId });
      }
    }
    // cancelled / accepted 未终态 / no-result：不改 streak（既不算失败，也不清零）——但都单独计数
  }

  const withCallId = list.filter((c) => !!c.callId).length;
  const withTaskId = list.filter((c) => !!c.taskId).length;
  const withTerminal = list.filter((c) => !!c.terminal).length;
  const acceptedOnly = list.filter((c) => c.state === 'accepted-no-terminal').length;

  const summary = {
    calls: list.length,
    states,
    byTool,
    // 「受理没算完成」的显式计数，避免把 accepted 当 completed 汇报
    acceptedOnly,
    failuresTotal,
    streakMax,
    streakNow,
    duplicates: { results: duplicateResults, resultWithoutCall: resultsWithoutCall, terminalWithoutCall: terminalsWithoutCall, callWithoutId: callsWithoutId },
    coverage: {
      callId: withCallId + '/' + list.length,
      taskId: withTaskId + '/' + list.length,
      terminal: withTerminal + '/' + list.length,
      acceptedNoTerminal: acceptedOnly + '/' + list.length,
    },
    badLines: { tools: tp.bad, events: ep.bad },
  };

  return { calls: list, summary, blockers, parse: { tools: tp.bad, events: ep.bad } };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };

  const L = (o) => JSON.stringify(o);
  const tools = [
    // ① 同步工具：一次调用一个结果 → completed
    L({ type: 'tool_call', timestamp: '2026-10-30T03:51:14.089Z', data: { tool: 'rdd_get_inventory', tool_call_id: 'mcp-6' } }),
    L({ type: 'tool_result', timestamp: '2026-10-30T03:51:14.089Z', data: { tool: 'rdd_get_inventory', tool_call_id: 'mcp-6', result: '{"success":true,"message":"ok"}' } }),
    // ② 异步工具：受理 + 同 id 的第二条客户端 journal（重复投递）+ task_finished(cancelled)
    L({ type: 'tool_call', timestamp: '2026-10-30T03:51:17.486Z', data: { tool: 'goto', tool_call_id: 'call_04ee' } }),
    L({ type: 'tool_result', timestamp: '2026-10-30T03:51:17.540Z', data: { tool: 'goto', tool_call_id: 'call_04ee', result: '{"success":true,"message":"已受理,后台执行中","data":{"async":true,"task_id":"t1"}}' } }),
    L({ type: 'tool_result', timestamp: '2026-10-30T03:51:17.607Z', data: { tool: 'goto', tool_call_id: 'call_04ee', journaled_by: 'client', success: true, result: '{"success":true,"data":{"async":true,"task_id":"t1"}}' } }),
    // ③ 只有调用、没有结果 → 观测缺口
    L({ type: 'tool_call', timestamp: '2026-10-30T03:51:19.000Z', data: { tool: 'attack', tool_call_id: 'mcp-7' } }),
    // ④ 明确失败
    L({ type: 'tool_call', timestamp: '2026-10-30T03:51:20.000Z', data: { tool: 'collect', tool_call_id: 'call_x1' } }),
    L({ type: 'tool_result', timestamp: '2026-10-30T03:51:20.100Z', data: { tool: 'collect', tool_call_id: 'call_x1', result: '{"success":false,"message":"no reachable block"}' } }),
  ].join('\n');
  const events = [
    L({ type: 'task_finished', timestamp: '2026-10-30T03:51:19.788Z', data: { id: 't1', task: 'goto', status: 'stopped', message: 'cancelled before reaching target' } }),
  ].join('\n');

  const r = build(tools, events);
  const byId = (id) => r.calls.find((c) => c.callId === id);

  ok(byId('mcp-6').state === 'completed', '① 同步成功 → completed（实得 ' + byId('mcp-6').state + '）');
  ok(byId('call_04ee').state === 'completed' || byId('call_04ee').state === 'cancelled',
    '② 异步受理 + task_finished → 终态（实得 ' + byId('call_04ee').state + '）');
  ok(byId('call_04ee').terminal === 'cancelled', '②b task_finished(stopped/cancelled) → cancelled（实得 ' + byId('call_04ee').terminal + '）');
  ok(byId('mcp-7').state === 'no-result', '③ 无回执 → no-result（实得 ' + byId('mcp-7').state + '）');
  ok(byId('call_x1').state === 'failed', '④ 失败 → failed');
  ok(r.summary.duplicates.results === 1, '⑤ 同 id 第二条 result 只计重复、不重复计数（实得 ' + r.summary.duplicates.results + '）');
  ok(r.summary.calls === 4, '⑥ 调用去重后 4 条（实得 ' + r.summary.calls + '）');
  ok(r.summary.acceptedOnly === 0, '⑦ 本例异步都已到终态，acceptedOnly=0（实得 ' + r.summary.acceptedOnly + '）');
  ok(r.summary.coverage.terminal === '1/4', '⑧ 终态覆盖 1/4（实得 ' + r.summary.coverage.terminal + '）');
  ok(r.summary.coverage.callId === '4/4', '⑧b callId 覆盖 4/4（实得 ' + r.summary.coverage.callId + '）');

  // ⑨ 受理但没终态：不得算完成
  const tools9 = [
    L({ type: 'tool_call', timestamp: '2026-10-30T03:52:00.000Z', data: { tool: 'goto', tool_call_id: 'call_async_only' } }),
    L({ type: 'tool_result', timestamp: '2026-10-30T03:52:00.100Z', data: { tool: 'goto', tool_call_id: 'call_async_only', result: '{"success":true,"data":{"async":true,"task_id":"t9"}}' } }),
  ].join('\n');
  const r9 = build(tools9, '');
  ok(r9.calls[0].state === 'accepted-no-terminal', '⑨ 只有受理 → accepted-no-terminal（实得 ' + r9.calls[0].state + '）');
  ok(r9.summary.byTool.goto.completed === 0 && r9.summary.acceptedOnly === 1,
    '⑨b accepted 不计入 completed（completed=' + r9.summary.byTool.goto.completed + ' acceptedOnly=' + r9.summary.acceptedOnly + '）');

  // ⑩ 连续 vs 累计：失败-失败-成功-失败 → 累计 3、最大连续 2
  const mkFail = (id, t, okFlag) => [
    L({ type: 'tool_call', timestamp: t, data: { tool: 'collect', tool_call_id: id } }),
    L({ type: 'tool_result', timestamp: t, data: { tool: 'collect', tool_call_id: id, result: JSON.stringify({ success: okFlag }) } }),
  ].join('\n');
  const tools10 = [
    mkFail('f1', '2026-10-30T04:00:01.000Z', false),
    mkFail('f2', '2026-10-30T04:00:02.000Z', false),
    mkFail('s1', '2026-10-30T04:00:03.000Z', true),
    mkFail('f3', '2026-10-30T04:00:04.000Z', false),
  ].join('\n');
  const r10 = build(tools10, '');
  ok(r10.summary.failuresTotal === 3, '⑩ 累计失败 3（实得 ' + r10.summary.failuresTotal + '）');
  ok(r10.summary.streakMax.collect === 2, '⑩b 最大连续失败 2，不是 3（实得 ' + r10.summary.streakMax.collect + '）');
  ok(r10.blockers.length === 0, '⑩c 没有 3 连败就不该报 blocker（实得 ' + r10.blockers.length + '）');

  // ⑪ 真的三连败 → 报一次 blocker
  const tools11 = [1, 2, 3].map((i) => mkFail('g' + i, '2026-10-30T04:01:0' + i + '.000Z', false)).join('\n');
  const r11 = build(tools11, '');
  ok(r11.blockers.length === 1 && r11.blockers[0].tool === 'collect' && r11.blockers[0].consecutive_failures === 3,
    '⑪ 三连败 → 1 条 blocker（实得 ' + JSON.stringify(r11.blockers) + '）');

  // ⑫ 坏行不炸
  const r12 = build('not json\n{"type":"tool_call","data":{"tool":"x"}}\n', '');
  ok(r12.parse.tools >= 1 && r12.summary.duplicates.callWithoutId === 1,
    '⑫ 坏行/缺 callId 只计数不抛错（实得 bad=' + r12.parse.tools + ' noId=' + r12.summary.duplicates.callWithoutId + '）');

  console.log(fails.length
    ? 'action-ledger selftest FAIL: ' + fails.join(' | ')
    : 'action-ledger selftest PASS（12 组：同步/异步受理/无回执/失败/重复投递/连续vs累计/坏行）');
  return fails.length ? 1 : 0;
}

module.exports = { build, parseLines, terminalOf, selftest };

if (require.main === module) {
  if (process.argv[2] === 'selftest') process.exit(selftest());
  console.error('usage: action-ledger.js selftest');
  process.exit(2);
}
