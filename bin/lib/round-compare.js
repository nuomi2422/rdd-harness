'use strict';
/**
 * round-compare.js —— 逐轮对照表（151/2026-10-30 循环用）。
 *
 * 为什么要有它：每轮手写「同伴调用 45 次 / runner 19 次 / task_status 13 次 / 石镐 +186s」
 * 既慢又容易抄错（第一次就把 runner 的背包轮询算成了 AI 的重复劳动）。
 * 这里把口径钉死在一处：按 callId 前缀拆 mcp-（外部/runner）与 call_（同伴）。
 *
 * 只读 evidence，不改任何东西：
 *   runs/<id>/envelope.json + evidence/tools.jsonl + evidence/records.jsonl
 */
const fs = require('fs');
const path = require('path');

function readJsonl(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function callerOf(id) {
  const s = String(id || '');
  // 2026-10-30 实测：同伴的 callId 不是固定前缀 —— r4/r5 是 `call_…`，r6 变成 `chatcmpl-tool-…`。
  // 唯一稳定的是"runner 自己的 MCP 调用以 mcp- 开头"，所以按"不是 mcp- 就是同伴"来分。
  if (s.startsWith('mcp-')) return 'runner';
  if (!s) return 'other';
  return 'companion';
}

/** @param {string} runDir */
function summarize(runDir) {
  const envPath = path.join(runDir, 'envelope.json');
  if (!fs.existsSync(envPath)) return null;
  const env = JSON.parse(fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, ''));
  const tools = readJsonl(path.join(runDir, 'evidence', 'tools.jsonl'));
  const recs = readJsonl(path.join(runDir, 'evidence', 'records.jsonl'));

  const calls = tools.filter((e) => e.type === 'tool_call');
  const results = tools.filter((e) => e.type === 'tool_result');
  let companion = 0, runner = 0, other = 0;
  const companionTools = {};
  for (const c of calls) {
    const who = callerOf(c.data && c.data.tool_call_id);
    const tool = (c.data && c.data.tool) || '?';
    if (who === 'companion') { companion++; companionTools[tool] = (companionTools[tool] || 0) + 1; }
    else if (who === 'runner') runner++;
    else other++;
  }
  const fails = results.filter((r) => r.data && r.data.success === false).length;
  const milestones = recs.filter((r) => r.kind === 'milestone')
    .map((r) => ({ item: r.data.item, stage: r.data.stage, at: r.at }));
  const t0 = calls.length ? Date.parse(calls[0].timestamp) : NaN;
  for (const m of milestones) m.dt = Number.isFinite(t0) ? Math.round((Date.parse(m.at) - t0) / 1000) : null;

  return {
    runId: env.runId || path.basename(runDir),
    mode: env.mode && env.mode.kind,
    llm: (env.watch || {}).llmRequests,
    toolCalls: (env.watch || {}).toolCalls,
    watchSeconds: (env.timings || {}).watchSeconds,
    stopReason: (env.watch || {}).stopReason,
    oakLogAfter: (env.watch || {}).oakLogAfter,
    deaths: env.deaths && env.deaths.count,
    interventions: env.interventions && env.interventions.count,
    companion, runner, other, fails,
    taskStatus: companionTools.task_status || 0,
    companionTools,
    milestones,
    build: env.jarsAtLaunch ? 'evidence' : '',
  };
}

function render(rows) {
  const L = [];
  L.push('| 轮次 | 型号 | LLM | 同伴调用 | runner | task_status | 失败 | 里程碑(秒) | oak | 死亡 | 干预 | 停止 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const ms = r.milestones.map((m) => m.stage + '@+' + m.dt + 's').join('<br>') || '—';
    L.push('| ' + r.runId + ' | ' + (r.mode || '?') + ' | ' + r.llm + ' | ' + r.companion + ' | ' + r.runner
      + ' | ' + r.taskStatus + ' | ' + r.fails + ' | ' + ms + ' | ' + r.oakLogAfter + ' | ' + r.deaths
      + ' | ' + r.interventions + ' | ' + (r.stopReason || '?') + ' |');
  }
  return L.join('\n');
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const tmp = path.join(__dirname, '..', 'runs', '.tmp-round-compare');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'envelope.json'), JSON.stringify({
    runId: 'exp-selftest', mode: { kind: 'campaign' },
    watch: { llmRequests: 7, toolCalls: 4, oakLogAfter: 2, stopReason: 'wall 60s' },
    timings: { watchSeconds: 60 }, deaths: { count: 0 }, interventions: { count: 0 },
  }));
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(path.join(tmp, 'evidence', 'tools.jsonl'),
    line({ type: 'tool_call', timestamp: '2026-10-30T00:00:00Z', data: { tool: 'craft', tool_call_id: 'call_1' } })
    + line({ type: 'tool_call', timestamp: '2026-10-30T00:00:10Z', data: { tool: 'task_status', tool_call_id: 'call_2' } })
    + line({ type: 'tool_call', timestamp: '2026-10-30T00:00:20Z', data: { tool: 'rdd_get_inventory', tool_call_id: 'mcp-1' } })
    + line({ type: 'tool_result', timestamp: '2026-10-30T00:00:21Z', data: { tool: 'craft', success: false } }));
  fs.writeFileSync(path.join(tmp, 'evidence', 'records.jsonl'),
    line({ at: '2026-10-30T00:00:30Z', kind: 'milestone', data: { item: 'minecraft:wooden_pickaxe', stage: 'S1_wood' } }));

  const s = summarize(tmp);
  ok(s.companion === 2, '① 同伴调用 2（实得 ' + s.companion + '）');
  ok(s.runner === 1, '② runner 调用 1（实得 ' + s.runner + '）');
  ok(s.taskStatus === 1, '③ task_status 归属同伴（实得 ' + s.taskStatus + '）');
  ok(s.fails === 1, '④ 失败 1（实得 ' + s.fails + '）');
  ok(s.milestones.length === 1 && s.milestones[0].dt === 30, '⑤ 里程碑相对秒数（实得 ' + JSON.stringify(s.milestones) + '）');
  const html = render([s]);
  ok(html.includes('exp-selftest') && html.includes('S1_wood@+30s'), '⑥ 表格渲染含轮次与里程碑');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails.length ? 'round-compare selftest FAIL: ' + fails.join(' | ')
    : 'round-compare selftest PASS（6 组：调用者拆分/失败/里程碑/渲染）');
  return fails.length ? 1 : 0;
}

module.exports = { summarize, render, selftest };

if (require.main === module) {
  if (process.argv[2] === 'selftest') process.exit(selftest());
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('usage: round-compare.js <runDir...> | selftest'); process.exit(2); }
  const rows = dirs.map((d) => summarize(path.resolve(d))).filter(Boolean);
  console.log(render(rows));
}
