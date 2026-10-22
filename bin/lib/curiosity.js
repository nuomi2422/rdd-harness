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

module.exports = { act, mcpRaw };
