'use strict';
/**
 * curiosity.js —— G8 好奇心：问完去做一次观测（K8–K10）
 *
 * 为什么单独一个文件：上一版把函数塞进 batch-bridge.js 时，字符串替换两次改崩主文件，
 * 只能 `git checkout` 回退。**新能力放新模块，主文件只加一行 require** —— 崩溃半径最小。
 *
 * 用法（由 batch-bridge 分发）：
 *   node bin/batch-bridge.js curiosity-act
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MCP_CALL = 'D:\\rdd\\workspace\\rdd-selfcompile\\scripts\\mcp-call.js';

/** 调 MCP 工具并拿原文（look_around 返回纯文本，不是 JSON）。 */
function mcpRaw(tool, args) {
  const f = path.join(os.tmpdir(), `mcp-raw-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(args || {}), 'utf8');
  try {
    const got = spawnSync(process.execPath, [MCP_CALL, tool, 'RDD', '@' + f], { encoding: 'utf8' });
    const out = ((got.stdout || '') + (got.stderr || '')).trim();
    return got.status === 0 ? out : null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

/**
 * K8–K10：把最近一条 ASKED 推进一步。
 * @param {object} deps { readEvents, appendEvent }
 */
function act(deps) {
  const events = deps.readEvents();
  const asked = events.filter((e) => e.kind === 'curiosity' && e.state === 'ASKED');
  if (!asked.length) return { ok: true, code: 'NOTHING_TO_DO', exit: 0 };

  const quest = asked[asked.length - 1];
  const done = events.some((e) => e.kind === 'curiosity' && e.questId === quest.questId
    && (e.state === 'OBSERVED' || e.state === 'OBSERVE_FAILED'));
  if (done) return { ok: true, code: 'ALREADY_DONE', questId: quest.questId, exit: 0 };

  const text = mcpRaw('look_around', {});
  if (!text) {
    deps.appendEvent({
      kind: 'curiosity', requestId: quest.requestId, questId: quest.questId,
      trigger: quest.trigger, target: quest.target, question: quest.question,
      state: 'OBSERVE_FAILED', source: 'live',
    });
    // K9：观测失败不许编造 observation
    return { ok: false, code: 'OBSERVE_FAILED', questId: quest.questId, exit: 2 };
  }
  deps.appendEvent({
    kind: 'curiosity', requestId: quest.requestId, questId: quest.questId,
    trigger: quest.trigger, target: quest.target, question: quest.question,
    state: 'OBSERVED', source: 'live', observation: String(text).slice(0, 400),
  });
  return { ok: true, code: 'OBSERVED', questId: quest.questId, observation: String(text).slice(0, 120), exit: 0 };
}


/** 调 MCP 工具并解析 JSON（goto/get_self_status 都返回 JSON）。 */
function mcpJson(tool, args) {
  const txt = mcpRaw(tool, args);
  if (!txt) return null;
  try { return JSON.parse(txt.split(/\r?\n/).filter(Boolean).pop()); } catch { return null; }
}

/**
 * K11–K13：从最近一条 OBSERVED 出发，走过去再看（当前白名单只有 goto）。
 */
function move(deps) {
  const events = deps.readEvents();
  const observed = events.filter((e) => e.kind === 'curiosity' && e.state === 'OBSERVED');
  if (!observed.length) return { ok: true, code: 'NOTHING_TO_DO', exit: 0 };
  const quest = observed[observed.length - 1];
  const done = events.some((e) => e.kind === 'curiosity' && e.questId === quest.questId
    && (e.state === 'MOVED' || e.state === 'MOVE_FAILED'));
  if (done) return { ok: true, code: 'ALREADY_DONE', questId: quest.questId, exit: 0 };

  const st = mcpJson('get_self_status', {});
  const pos = st && st.position;
  if (!pos) {
    deps.appendEvent({ kind: 'curiosity', requestId: quest.requestId, questId: quest.questId,
      trigger: quest.trigger, target: quest.target, state: 'MOVE_FAILED', reason: 'no_position', source: 'live' });
    return { ok: false, code: 'MOVE_FAILED', reason: 'no_position', exit: 2 };
  }
  const to = { x: Math.round(pos.x) + 8, y: Math.round(pos.y), z: Math.round(pos.z) + 8 };
  const started = mcpJson('goto', { x: to.x, y: to.y, z: to.z });
  const taskId = started && started.data && (started.data.task_id || started.data.taskId);
  if (!started || started.success !== true) {
    deps.appendEvent({ kind: 'curiosity', requestId: quest.requestId, questId: quest.questId,
      trigger: quest.trigger, target: quest.target, state: 'MOVE_FAILED', reason: 'dispatch', source: 'live' });
    return { ok: false, code: 'MOVE_FAILED', reason: 'dispatch', exit: 2 };
  }
  const end = Date.now() + 5000;
  while (Date.now() < end) { /* 等它走一段 */ }
  const stopped = mcpJson('task_stop', taskId ? { task_id: taskId } : {});
  deps.appendEvent({
    kind: 'curiosity', requestId: quest.requestId, questId: quest.questId,
    trigger: quest.trigger, target: quest.target, state: 'MOVED', source: 'live',
    from: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
    to, task_id: taskId || '', stop_message: String((stopped && stopped.message) || '').slice(0, 160),
  });
  return { ok: true, code: 'MOVED', questId: quest.questId, from: [pos.x, pos.y, pos.z], to: [to.x, to.y, to.z], exit: 0 };
}

/** K14：把好奇心的来龙去脉摊开（只读，不改状态）。 */
function list(deps, limit) {
  const events = deps.readEvents().filter((e) => e.kind === 'curiosity');
  const byQuest = new Map();
  for (const e of events) {
    if (!e.questId) continue;
    const q = byQuest.get(e.questId) || { questId: e.questId, target: e.target, question: e.question, states: [], last: 0 };
    q.states.push(e.state);
    q.last = Math.max(q.last, e.at || 0);
    byQuest.set(e.questId, q);
  }
  const rows = [...byQuest.values()].sort((a, b) => b.last - a.last).slice(0, limit || 10);
  return { ok: true, total: byQuest.size, rows };
}

/**
 * K15：给一条好奇收尾，写下「结论」（finding）。
 * 只是记账 —— **不写经验库**（那一步等主人点头）。
 */
function closeQuest(deps, finding) {
  const text = String(finding || '').trim();
  if (!text) return { ok: false, code: 'FINDING_REQUIRED', exit: 2 };
  const events = deps.readEvents();
  const live = events.filter((e) => e.kind === 'curiosity'
    && ['OBSERVED', 'MOVED'].includes(e.state));
  if (!live.length) return { ok: true, code: 'NOTHING_TO_DO', exit: 0 };
  const quest = live[live.length - 1];
  if (events.some((e) => e.kind === 'curiosity' && e.questId === quest.questId && e.state === 'CONCLUDED')) {
    return { ok: true, code: 'ALREADY_DONE', questId: quest.questId, exit: 0 };
  }
  deps.appendEvent({
    kind: 'curiosity', requestId: quest.requestId, questId: quest.questId,
    trigger: quest.trigger, target: quest.target, question: quest.question,
    state: 'CONCLUDED', finding: text.slice(0, 400), source: 'live',
  });
  return { ok: true, code: 'CONCLUDED', questId: quest.questId, finding: text.slice(0, 120), exit: 0 };
}
module.exports = { act, move, list, closeQuest, mcpRaw, mcpJson };
