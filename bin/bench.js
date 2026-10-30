#!/usr/bin/env node
'use strict';
/**
 * bench.js —— 实验台 v0（86 号）：验证环节的共享实验室
 *
 * 为什么存在：
 *   验证慢的三个乘数 = 回路长度 x 材料干净度 x 判决自动化。
 *   这份脚本把「大家一起维护的账本」落成一个文件（experiments/workbench.json）：
 *   探针目录、tips（坑/好东西/探针提议/工具改动）、预筛信号、冻结判决、排队、母版。
 *   任何 AI 都能加一条，下一个人先读这一份，而不是从聊天记录考古。
 *
 * 硬规则（防验证通胀，写死在代码里）：
 *   - tip 必须给「假象 + 真因 + 护栏」，缺一拒收；
 *   - signal 只要一句话（预筛、松判据），但它不是判决；
 *   - verdict 必须给 --card（V-YYYYMMDD-NN）+ --judge（可复跑命令）+ --result（三态），
 *     没有冻结判据/没有卡 → 拒收。没冻判据的实验只出信号，不出判决。
 *
 * 用法：
 *   node bench.js catalog
 *   node bench.js tip list [--status all|open|fixed]
 *   node bench.js tip add --kind pitfall|win|probe|tool --symptom "..." --fake "..." --cause "..." --guard "..." [--link "V-..."] [--by "session"]
 *   node bench.js signal add <expId> --note "..." [--run <runId>] [--by ...]
 *   node bench.js signal list
 *   node bench.js verdict add <expId> --card V-20261026-12 --judge "node exp-craft-ab.js a b" --result INCONCLUSIVE --why "..." [--by ...]
 *   node bench.js verdict list
 *   node bench.js queue add --label x --tier screen|confirm --goal "..." [--window "2min-night"]
 *   node bench.js queue list [--tier ...]
 *   node bench.js queue next [--tier ...]
 *   node bench.js master list
 *   node bench.js master add --name exp-clean3 --sha <sha256> [--notes "..."]
 *   node bench.js probe list [--status all|requested|custom|builtin]
 *   node bench.js probe add --id <snake_id> --title "..." --source "world_probe.xxx|tools.jsonl|monitor/..." --fields a,b,c --note "..." [--status requested|custom] [--by ...]
 *   node bench.js brief [<runDir>] [--json]     ← 下一个 AI 开工包：坑+前面结论+排队+母版+探针（带 runDir 再附该轮 health+时序摘要）
 *   node bench.js timeline <runDir> [--limit N] [--tag chain,ctx,chat]
 *                                                ← 完整时序一条命令读全（阶段/目标/回合/调用/结果/任务链/死亡）
 *                                                  --tag 显式打开被默认折叠的流（chain=任务链帧 ctx=numen/supervisor 上下文
 *                                                  chat=对话 llm=请求与预算 snap=事实/资产快照 all=全部）
 *   node bench.js health <runDir>
 *   node bench.js live [status|start|stop|on|off|only <views>|interval <s>|show [view]|selftest]
 *                                                ← 常驻视图开关（引擎 bin/bench-watch.js，视图落在 experiments/live/）
 *   node bench.js selftest
 *
 * 退出码：0 成功 / 1 校验失败或 health 不健康 / 2 用法错 / 3 读盘错
 */
const fs = require('fs');
const path = require('path');
const A0 = require('./lib/a0-evidence.js');

const HARNESS = path.resolve(__dirname, '..');
const FILE = process.env.BENCH_FILE || path.join(HARNESS, 'experiments', 'workbench.json');
const now = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); };

function die(code, msg) { console.error(msg); process.exit(code); }
function load() {
  if (!fs.existsSync(FILE)) die(3, 'missing ' + FILE);
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { die(3, 'bad json: ' + e.message); }
}
function save(w) {
  w.updated_at = now();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(w, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}
function arg(argv, k) { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; }
function has(argv, k) { return argv.includes(k); }
function need(argv, k, label) { const v = arg(argv, k); if (!v || !String(v).trim()) die(2, 'missing ' + (label || k)); return String(v).trim(); }
function who(argv) { return arg(argv, '--by') || 'unknown'; }

// ── 使用证据（2026-10-29 施工单第 4 阶段） ─────────────────────────────────
/**
 * 为什么存在：registry 有目录、bench 有 brief，但「外部 AI 到底读没读」以前只能靠人回忆。
 * 这里只记**最小、非敏感**的调用证据：时间 / session / 命令 / run / card / 结果。
 * 不记 prompt 正文、不记源码内容、不记 token。
 *
 * ★ 测量边界：
 *   - session 来自 DSH_SESSION_ID 环境变量（DSH 的 shell 会注入）或 --session；拿不到就写 unknown，
 *     不编一个「已采用率」。
 *   - 这是「命令被执行过」的证据，不等于「AI 读了并照做」；后者要看会话里有没有据此行动。
 *   - 并发写：append-only 追加单行；不重写账本，避免覆盖并行会话。
 */
const USAGE_FILE = process.env.BENCH_USAGE_FILE || path.join(HARNESS, 'experiments', 'usage.jsonl');
function sessionOf(argv) {
  return (argv && arg(argv, '--session')) || process.env.DSH_SESSION_ID || process.env.CLAUDE_SESSION_ID || 'unknown';
}
function sourceOf() {
  if (process.env.DSH_SESSION_ID) return 'dsh';
  if (process.env.CLAUDE_SESSION_ID) return 'claude';
  return 'unknown';
}
function logUsage(argv, cmd, opts) {
  opts = opts || {};
  const row = {
    at: now(),
    session: sessionOf(argv),
    source: opts.source || sourceOf(),
    cmd,
    run: opts.run || null,
    card: opts.card || null,
    status: opts.status || 'ok',
  };
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.appendFileSync(USAGE_FILE, JSON.stringify(row) + '\n');
    return true;
  } catch (e) {
    if (!opts.quiet) console.error('[usage] 写不进使用账本（' + USAGE_FILE + '）：' + e.message);
    return false;
  }
}
function readUsage(limit) {
  if (!fs.existsSync(USAGE_FILE)) return [];
  const rows = [];
  for (const l of fs.readFileSync(USAGE_FILE, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { rows.push(JSON.parse(l)); } catch { /* 坏行跳过：并行写坏一行不该毁全账 */ }
  }
  return limit > 0 ? rows.slice(-limit) : rows;
}
function usage(argv) {
  const limit = parseInt(arg(argv, '--limit') || '20', 10);
  const rows = readUsage(limit);
  if (has(argv, '--json')) { console.log(JSON.stringify({ file: USAGE_FILE, total: readUsage(0).length, rows }, null, 2)); return; }
  console.log('# 实验台使用证据（append-only）');
  console.log('账本: ' + USAGE_FILE + '  总行数 ' + readUsage(0).length + '  （只显示最近 ' + rows.length + '）');
  for (const r of rows) {
    console.log(r.at + '  ' + (r.source || '?') + '/' + (r.session || 'unknown') + '  ' + r.cmd +
      (r.run ? '  run=' + r.run : '') + (r.card ? '  card=' + r.card : '') + '  ' + (r.status || '?'));
  }
  console.log('\n边界：session 取自 DSH_SESSION_ID（或 --session）；拿不到写 unknown。');
  console.log('      「命令被执行」≠「AI 读了并照做」；selftest 的调用不计入业务使用（走临时账本）。');
}


function catalog() {
  const w = load();
  console.log('# 实验台 catalog');
  console.log('file: ' + FILE + '  (schema ' + w.schema + ', updated ' + w.updated_at + ')');
  console.log('\n## 探针（' + w.probes.length + '）');
  for (const p of w.probes) console.log('- ' + p.id + '  ' + p.title + '  [' + p.kind + ']');
  console.log('\n## tips（' + w.tips.length + '）  signals（' + w.signals.length + '）  verdicts（' + w.verdicts.length + '）');
  console.log('## queue（' + w.queue.length + '）  masters（' + w.masters.length + '）');
}

function tipList(argv) {
  const w = load();
  const status = arg(argv, '--status') || 'all';
  const rows = w.tips.filter(t => status === 'all' || t.status === status);
  for (const t of rows) console.log(t.id + '  [' + t.kind + '/' + t.status + ']  ' + t.symptom + '\n    假象: ' + t.fake + '\n    真因: ' + t.cause + '\n    护栏: ' + t.guard + (t.link ? '\n    链接: ' + t.link : ''));
  console.log('\n共 ' + rows.length + ' 条');
}

function tipAdd(argv) {
  const w = load();
  const kind = need(argv, '--kind', '--kind (pitfall|win|probe|tool)');
  if (!['pitfall', 'win', 'probe', 'tool'].includes(kind)) die(2, 'bad --kind: ' + kind);
  const symptom = need(argv, '--symptom');
  const fake = need(argv, '--fake');
  const cause = need(argv, '--cause');
  const guard = need(argv, '--guard');
  const day = stamp();
  const n = w.tips.filter(t => t.id.startsWith('TIP-' + day + '-')).length + 1;
  const id = 'TIP-' + day + '-' + pad(n);
  const row = { id, kind, symptom, fake, cause, guard, status: arg(argv, '--status') || 'open', link: arg(argv, '--link') || '', added_by: who(argv), added_at: now() };
  w.tips.push(row);
  save(w);
  console.log('added ' + id);
}

function signalAdd(argv) {
  const w = load();
  // argv slice: node bench.js signal add <expId> -> ["signal","add","<expId>",...]
  const pos = argv.filter(a => !a.startsWith('--'));
  const ex = pos[2] || null;
  if (!ex) die(2, 'usage: bench.js signal add <expId> --note "..."');
  const note = need(argv, '--note');
  const row = { exp_id: ex, note, run: arg(argv, '--run') || '', by: who(argv), at: now() };
  w.signals.push(row); save(w);
  console.log('signal added for ' + ex);
}

function signalList() {
  const w = load();
  for (const s of w.signals) console.log(s.at + '  ' + s.exp_id + '  ' + s.note + (s.run ? '  [' + s.run + ']' : '') + '  by ' + s.by);
  console.log('\n共 ' + w.signals.length + ' 条预筛信号');
}

function verdictAdd(argv) {
  const w = load();
  const pos = argv.filter(a => !a.startsWith('--'));
  const ex = pos[2] || null;
  if (!ex) die(2, 'usage: bench.js verdict add <expId> --card V-YYYYMMDD-NN --judge "<cmd>" --result PASS|FAIL|INCONCLUSIVE --why "..."');
  const card = need(argv, '--card', '--card V-YYYYMMDD-NN');
  if (!/^V-\d{8}-\d{2}$/.test(card)) die(1, 'verdict rejected: --card must match V-YYYYMMDD-NN (frozen criteria card)');
  const judge = need(argv, '--judge', '--judge (rerunnable command)');
  const result = need(argv, '--result', '--result');
  if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(result)) die(2, 'bad --result: ' + result);
  const why = need(argv, '--why');
  const row = { exp_id: ex, card, judge, result, why, by: who(argv), at: now() };
  w.verdicts.push(row); save(w);
  console.log('verdict added: ' + result + ' (' + card + ')');
}

function verdictList() {
  const w = load();
  for (const v of w.verdicts) console.log(v.at + '  ' + v.exp_id + '  ' + v.result + '  card=' + v.card + '\n    judge: ' + v.judge + '\n    why: ' + v.why);
  console.log('\n共 ' + w.verdicts.length + ' 条判决');
}

function queueAdd(argv) {
  const w = load();
  const label = need(argv, '--label');
  const tier = need(argv, '--tier', '--tier screen|confirm');
  if (!['screen', 'confirm'].includes(tier)) die(2, 'bad --tier: ' + tier);
  const goal = need(argv, '--goal');
  const row = { label, tier, goal, window: arg(argv, '--window') || 'standard', status: 'pending', added_at: now() };
  w.queue.push(row); save(w);
  console.log('queued ' + label + ' [' + tier + ']');
}

function queueList(argv) {
  const w = load();
  const tier = arg(argv, '--tier');
  const rows = w.queue.filter(q => !tier || q.tier === tier);
  for (const q of rows) console.log((q.status === 'pending' ? '[ ] ' : '[x] ') + q.label + '  [' + q.tier + '/' + q.window + ']  ' + q.goal);
  console.log('\n共 ' + rows.length + ' 条');
}

function queueNext(argv) {
  const w = load();
  const tier = arg(argv, '--tier');
  const q = w.queue.find(x => x.tier === (tier || 'screen') && x.status === 'pending');
  if (!q) { console.log('none pending (' + (tier || 'screen') + ')'); process.exit(0); }
  console.log(JSON.stringify(q, null, 2));
}

function masterAdd(argv) {
  const w = load();
  const name = need(argv, '--name');
  const sha = need(argv, '--sha');
  w.masters.push({ name, sha, notes: arg(argv, '--notes') || '', added_at: now() });
  save(w);
  console.log('master added: ' + name);
}
function masterList() {
  const w = load();
  for (const m of w.masters) console.log(m.name + '  ' + m.sha.slice(0, 16) + '...  ' + m.notes);
  console.log('\n共 ' + w.masters.length + ' 个母版');
}

/** 探针登记：AI 自己往账本里加「我要读的数据」的一等协议（87 号 §3.2 的 probes 数组，v0.1）。 */
function probeAdd(argv) {
  const w = load();
  const id = need(argv, '--id');
  if (!/^[a-z][a-z0-9_]*$/.test(id)) die(2, 'bad --id (snake_case required): ' + id);
  if (w.probes.some(p => p.id === id)) die(1, 'probe exists: ' + id + '（id 只增不改，换新 id）');
  const title = need(argv, '--title');
  const source = need(argv, '--source');
  const fields = need(argv, '--fields');
  const note = need(argv, '--note');
  const status = arg(argv, '--status') || 'requested';
  if (!['requested', 'custom'].includes(status)) die(2, 'bad --status: ' + status + '（CLI 只许 requested|custom；builtin 走 worldstate + 82 号）');
  w.probes.push({ id, title, kind: status, source, fields: fields.split(',').map(s => s.trim()).filter(Boolean), note, status, added_by: who(argv), added_at: now() });
  save(w);
  console.log('probe added: ' + id + ' [' + status + '] —— 实现走 82 号（worldstate）或接线进 timeline/brief 的数据面');
}
function probeList(argv) {
  const w = load();
  const status = arg(argv, '--status') || 'all';
  const rows = w.probes.filter(p => status === 'all' || p.status === status || p.kind === status);
  for (const p of rows) console.log(p.id + '  [' + (p.kind || 'builtin') + '/' + (p.status || 'builtin') + ']  ' + p.title + '\n    source: ' + p.source + '\n    fields: ' + (p.fields || []).join(',') + (p.note ? '\n    note: ' + p.note : ''));
  console.log('\n共 ' + rows.length + ' 个（全部 ' + w.probes.length + '）');
}

/** 时序直读器：一轮 run 的全部证据流合成一条按时间排序的线，不用再逐个文件慢慢分析（v0.1）。 */
function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

/**
 * ★ 2026-10-28（还 #381 债②）：原来这里有一个硬 SKIP，把 taskchain_snapshot / numen_context
 * 等五类「周期快照」直接扔掉 —— 于是 timeline 号称「完整时序」，实际看不到任务链和上下文。
 * 现在改成「默认折叠 + --tag 显式打开」：帧还在，但默认不刷屏。
 */
const TAG_BY_TYPE = {
  taskchain_snapshot: 'chain', requirement_manifest: 'chain', requirement_gaps_changed: 'chain',
  goal_kickoff: 'chain', subtask_stalled: 'chain', subtask_resumed: 'chain', subtask_stall_escalated: 'chain',
  chain_recovering: 'chain', loss_impact_recomputed: 'chain', recovery_named_from_needs: 'chain',
  manifest_rebuilt_for_recompute: 'chain', carrier_alarm: 'alarm', llm_activity_stale: 'chain',
  side_task_skipped_occurrence: 'chain', side_task_due: 'chain',
  numen_context: 'ctx', supervisor_input: 'ctx', supervisor_context: 'ctx', supervisor_output: 'ctx',
  runtime_state: 'ctx', planning_input_verbatim: 'ctx',
  fact_snapshot: 'snap', asset_snapshot: 'snap', asset_retention: 'snap',
  llm_request: 'llm', llm_response: 'llm', llm_usage: 'llm', retrieval_snapshot: 'llm',
  budget_gate: 'llm', budget_settle: 'llm', budget_reserve: 'llm',
};
/** 默认折叠（要看必须 --tag）；其余类型默认显示，和以前一致。 */
const NOISY_TYPES = new Set([
  'taskchain_snapshot', 'numen_context', 'fact_snapshot', 'asset_snapshot', 'asset_retention',
  'runtime_state', 'supervisor_input', 'supervisor_context',
  'llm_request', 'llm_response', 'llm_usage', 'retrieval_snapshot', 'budget_gate', 'budget_settle', 'budget_reserve',
]);

/** 把 rdd.jsonl 的事件压成一行可读；长 JSON 不刷屏。 */
function chainText(type, d) {
  d = d || {};
  if (type === 'taskchain_snapshot') {
    let c = d.taskChain;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
    c = c || {};
    return 'v=' + (c.stateVersion == null ? '?' : c.stateVersion) + ' status=' + (c.primaryStatus || '?') +
      ' stage=' + (c.currentSubtaskId || '?') + ' reason=' + (d.reason || '?');
  }
  if (type === 'numen_context') {
    const m = String(d.context || '').match(/<current_task>([\s\S]*?)<\/current_task>/);
    return m ? 'current_task=' + m[1].replace(/\s+/g, ' ').slice(0, 100) : String(d.context || '').replace(/\s+/g, ' ').slice(0, 90);
  }
  if (type === 'supervisor_output') return '规划回话: ' + String(d.message || '').replace(/\s+/g, ' ').slice(0, 120);
  if (type === 'requirement_manifest') return 'requirements=' + (d.requirements == null ? '?' : d.requirements) + ' critical=' + (d.critical == null ? '?' : d.critical);
  if (type === 'requirement_gaps_changed') return String(d.gaps || '').slice(0, 130);
  return JSON.stringify(d).slice(0, 120);
}

function buildTimeline(runDir) {
  const envPath = path.join(runDir, 'envelope.json');
  if (!fs.existsSync(envPath)) die(3, 'no envelope.json: ' + runDir);
  const env = JSON.parse(fs.readFileSync(envPath, 'utf8'));
  const ev = path.join(runDir, 'evidence');
  const T = env.timings || {};
  const t0 = Date.parse(T.launchStart || T.mcpReady || T.stimulusSentAt || '') || Date.now();
  const rel = (ts) => (ts == null || isNaN(Date.parse(ts))) ? null : ((Date.parse(ts) - t0) / 1000);
  const fmt = (s) => (s == null) ? 'T+????s' : (s >= 0 ? 'T+' : 'T-') + Math.abs(s).toFixed(1) + 's';
  const evs = [];
  const push = (ts, tag, text, type) => { const s = rel(ts); if (s != null) evs.push({ s, tag, type: type || null, text: String(text).replace(/\s+/g, ' ').slice(0, 140) }); };
  for (const k of ['launchStart', 'mcpReady', 'stimulusSentAt', 'watchEnd', 'gameExited']) {
    if (!T[k]) continue;
    const label = k === 'mcpReady' ? ' —— MCP 就绪' : k === 'stimulusSentAt' ? ' —— 派目标' : k === 'watchEnd' ? ' —— 观察结束' : k === 'gameExited' ? ' —— 游戏退出' : ' —— 启动';
    push(T[k], 'phase', k + label);
  }
  const ctxEvents = readJsonl(path.join(ev, 'context.jsonl'));
  const ctx = ctxEvents.find(e => e.type === 'user_prompt');
  if (ctx && ctx.data) push(ctx.timestamp, 'goal', '目标: ' + (ctx.data.text || '') + ' (' + (ctx.data.chars || 0) + ' 字)');
  for (const e of readJsonl(path.join(ev, 'ai.jsonl'))) {
    const d = e.data || {};
    if (e.type === 'turn') push(e.timestamp, 'turn', '回合 ' + d.turn + '  tools=' + d.tools + '  msgs=' + d.convo_msgs);
    else if (e.type === 'assistant') push(e.timestamp, 'chat', '她说: ' + (d.text || ''));   // ★ 对话进时序
  }
  // ★ 2026-10-28：上下文流压成一行（默认折叠，--tag llm 打开）——以前这里整条流都没人读
  for (const e of ctxEvents) {
    const d = e.data || {};
    if (e.type === 'llm_request') {
      const n = ((d.request || {}).messages || []).length;
      push(e.timestamp, 'llm', '请求 ' + (d.actor || '?') + '/' + (d.phase || '?') + '  msgs=' + n + '  prompt=' + (d.promptTokens == null ? '?' : d.promptTokens) + '  model=' + (d.model || '?'), e.type);
    } else if (e.type === 'llm_response') {
      const r = d.response || {};
      push(e.timestamp, 'llm', '回应 ' + (d.actor || '?') + '/' + (d.phase || '?') + '  ' + (r.content || '').slice(0, 90), e.type);
    } else if (e.type === 'retrieval_snapshot') {
      push(e.timestamp, 'llm', '检索 entries=' + (d.entries == null ? '?' : d.entries) + ' status=' + (d.status || '?') + ' chars=' + (d.chars == null ? '?' : d.chars), e.type);
    }
  }
  const nameById = {};
  let calls = 0, oks = 0, fails = 0;
  for (const e of readJsonl(path.join(ev, 'tools.jsonl'))) {
    const d = e.data || {};
    if (e.type === 'tool_call') { calls++; nameById[d.tool_call_id] = d.tool; push(e.timestamp, 'call', (d.tool || '?') + '  ' + (d.tool_call_id || '')); }
    else if (e.type === 'tool_result') {
      let ok = null, msg = '';
      try { const r = JSON.parse(d.result || '{}'); ok = r.success; msg = r.message || ''; } catch { ok = null; msg = String(d.result || '').slice(0, 90); }
      if (ok === true) oks++; else if (ok === false) fails++;
      push(e.timestamp, ok === false ? 'fail' : 'result', (nameById[d.tool_call_id] || '?') + (ok === false ? '  FAIL' : ok === true ? '  OK' : '  ?') + (msg ? '  ' + msg : ''));
    }
  }
  for (const e of readJsonl(path.join(ev, 'events.jsonl'))) push(e.timestamp, e.type === 'task_finished' ? 'done' : 'event', ((e.data && (e.data.message || e.data.description)) || e.type));
  const rddEvents = readJsonl(path.join(ev, 'rdd.jsonl'));
  for (const e of rddEvents) {
    let tag = TAG_BY_TYPE[e.type] || 'chain';
    let text = e.type + '  ' + chainText(e.type, e.data);
    // A3（95 号）：situation_event 按 data.layer 分成 [fact]/[cap]/[prog]/[tool]，
    // 不把四层混成一个 tag（判据⑦）。
    if (e.type === 'situation_event' && e.data && e.data.layer) {
      const l = e.data.layer;
      tag = l === 'progress' ? 'prog' : (l === 'capability' ? 'cap' : (l === 'tool' ? 'tool' : 'fact'));
      text = l + ':' + (e.data.kind || '?') + '  subject=' + String(e.data.subject || '?').slice(0, 8)
        + (e.data.suppressed ? '  suppressed=' + e.data.suppressed : '')
        + (e.data.pos ? '  pos=' + e.data.pos : '');
    }
    push(e.timestamp, tag, text, e.type);
  }
  let deaths = 0, deathsScanned = false;
  // A1（93 号）：run 归档里已有 deaths（PRESENT/NONE，带 seq/kind）时不再扫全局 instrumentation ——
  // 否则同一次死亡会出两行 [death]（一行来自归档、一行来自旧扫描）。老 run 没有 deaths 键才走旧扫描。
  const hasA1Deaths = env.deaths && (env.deaths.status === 'PRESENT' || env.deaths.status === 'NONE');
  if (hasA1Deaths) {
    deaths = env.deaths.count || 0;
    deathsScanned = true;
  } else {
    const numenDir = process.env.RDD_NUMEN_DIR || 'D:\\rdd\\mc\\The Best of Twilight Forest\\config\\numen';
    if (numenDir) {
      deathsScanned = true;
      const inst = path.join(numenDir, 'monitor', 'instrumentation.jsonl');
      const winS = Date.parse(T.stimulusSentAt || '') || null;
      const winE = Date.parse(T.watchEnd || '') || null;
      if (fs.existsSync(inst) && winS != null) {
        for (const e of readJsonl(inst)) {
          const t = Date.parse(e.timestamp);
          if (!(t >= winS && (winE == null || t <= winE + 60000))) continue;
          if (/death|died|死亡|was slain|killed by/i.test(e.type || '') || /death|died|死亡|was slain|killed by/i.test(JSON.stringify(e.data || {}))) {
            deaths++;
            push(e.timestamp, 'death', ((e.data && (e.data.message || e.data.cause)) || e.type || 'death'), e.type);
          }
        }
      }
    }
  }
  // ★ A0（90 号）：会话边界 / world-view 四相位 / 人工介入 / 投送四阶段。
  //   行只来自 envelope 的 A0 块（run 时采好），这里不重扫日志、不造事件；
  //   envelope 没有 a0 块时整段不出现（老 run 不伪造）。
  // A3（95 号）：capability / tool 两层（run 归档后处理，realtime=false —— 别当成实时事件）
  const st = env.situations;
  if (st && st.status === 'PRESENT' && Array.isArray(st.entries)) {
    for (const e of st.entries) {
      const tag = e.layer === 'capability' ? 'cap' : 'tool';
      push(e.at, tag, (e.kind || '?') + '  subject=' + String(e.subject || '?')
        + (e.count ? '  count=' + e.count : '')
        + (e.reason ? '  ' + String(e.reason).slice(0, 60) : ''));
    }
  }
  for (const row of A0.timelineEntries(env)) push(row.at, row.tag, row.text);
  // 最终裁决（verdict.json 是机械裁判的落盘，读不到就不写这一行）
  try {
    const vp = path.join(runDir, 'verdict.json');
    if (fs.existsSync(vp)) {
      const v = JSON.parse(fs.readFileSync(vp, 'utf8'));
      push(env.finishedAt || T.gameExited, 'verdict', '裁决 ' + (v.overall || '?') + (v.reason ? '  ' + v.reason : ''));
    }
  } catch { /* 坏 verdict 不阻断时序 */ }
  evs.sort((a, b) => a.s - b.s);
  const watch = env.watch || {};
  const winEnd = rel(T.gameExited || T.watchEnd), winStart = rel(T.launchStart);
  // ★ 链状态：取最后一帧 taskchain_snapshot（帧本身默认折叠，--tag chain 看全帧）
  let lastChain = null, chainFrames = 0;
  for (const e of rddEvents) {
    if (e.type !== 'taskchain_snapshot') continue;
    chainFrames++;
    let c = (e.data || {}).taskChain;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = null; } }
    if (c) lastChain = c;
  }
  const tagCount = {};
  for (const e of evs) tagCount[e.tag] = (tagCount[e.tag] || 0) + 1;
  const summary = {
    run: env.runId || path.basename(runDir), label: env.label || '',
    master: ((env.master || {}).manifest || {}).sha256 ? String(env.master.manifest.sha256).slice(0, 8) : null,
    window_s: (winEnd != null && winStart != null) ? +(winEnd - winStart).toFixed(1) : null,
    stopReason: watch.stopReason || null,
    toolCalls: watch.toolCalls != null ? watch.toolCalls : calls, llmRequests: watch.llmRequests != null ? watch.llmRequests : null,
    evidence_calls: calls, evidence_ok: oks, evidence_fail: fails,
    deaths, deathsScanned, drift: env.world ? env.world.drift : null,
    goal: (ctx && ctx.data && ctx.data.text) || watch.description || null,
    chain: lastChain ? {
      goalId: lastChain.goalId || null,
      status: lastChain.primaryStatus || null,
      version: lastChain.stateVersion == null ? null : lastChain.stateVersion,
      stage: lastChain.currentSubtaskId || null,
      description: lastChain.description || null,
      primaryIndex: lastChain.primaryIndex == null ? null : lastChain.primaryIndex + 1,
      primaryTotal: Array.isArray(lastChain.primaries) ? lastChain.primaries.length : null,
    } : null,
    chainFrames, tagCount,
    a0: env.a0 ? {
      version: env.a0.version || null,
      session: (env.session || {}).status || 'UNKNOWN',
      firstMsgs: (env.session || {}).first_request_message_count == null ? null : env.session.first_request_message_count,
      clearAt: (env.session || {}).clear_boundary_at || null,
      interventions: (env.interventions || {}).status || 'UNKNOWN',
      interventionCount: (env.interventions || {}).count == null ? null : env.interventions.count,
      delivery: (env.context_delivery || {}).status || 'UNKNOWN',
      rendered: env.context_delivery && env.context_delivery.rendered ? env.context_delivery.rendered.refs.length : null,
      delivered: env.context_delivery && env.context_delivery.delivered ? env.context_delivery.delivered.refs.length : null,
      dropped: env.context_delivery && env.context_delivery.dropped ? env.context_delivery.dropped.count : null,
      truncated: env.context_delivery && env.context_delivery.truncated ? env.context_delivery.truncated.refs.length : null,
    } : null,
  };
  return { env, summary, evs, fmt };
}

function timeline(argv) {
  const pos = argv.filter(a => !a.startsWith('--'));
  const rd = pos[1];
  if (!rd) die(2, 'usage: bench.js timeline <runDir> [--limit N] [--tag chain,ctx,chat,llm,snap,all]');
  const limit = parseInt(arg(argv, '--limit') || '400', 10);
  const tagArg = arg(argv, '--tag');
  const tags = tagArg ? tagArg.split(',').map(s => s.trim()).filter(Boolean) : null;
  if (tags && !tags.length) die(2, 'bad --tag');
  const { summary, evs, fmt } = buildTimeline(path.resolve(rd));
  const all = !!tags && tags.includes('all');
  const want = tags ? new Set(tags) : null;
  const shownEvs = evs.filter((e) => {
    if (all) return true;
    if (want) return want.has(e.tag);
    return !NOISY_TYPES.has(e.type);   // 默认折叠周期快照，屏幕留给可读事件
  });
  console.log('# 时序 · ' + summary.run + (summary.label ? ' (' + summary.label + ')' : ''));
  console.log('母版=' + (summary.master || '?') + '  窗口=' + (summary.window_s != null ? summary.window_s + 's' : '?') + '  停因=' + summary.stopReason + '  调用=' + summary.evidence_calls + '（OK ' + summary.evidence_ok + ' / FAIL ' + summary.evidence_fail + '）  回合=' + summary.llmRequests + '  死亡=' + summary.deaths + (summary.deathsScanned ? '' : '（未扫描：设 RDD_NUMEN_DIR=<numen 配置目录> 可并入死亡时点）') + '  drift=' + summary.drift);
  if (summary.goal) console.log('目标: ' + summary.goal);
  if (summary.chain) {
    const c = summary.chain;
    console.log('任务链: goal=' + c.goalId + '  status=' + c.status + '  v=' + c.version + '  stage=' + c.stage +
      '  主目标 ' + (c.primaryIndex == null ? '?' : c.primaryIndex) + '/' + (c.primaryTotal == null ? '?' : c.primaryTotal) +
      '（' + summary.chainFrames + ' 帧快照，最后 1 帧）');
  } else {
    console.log('任务链: 本轮没有 taskchain_snapshot（未观测到，不是「没任务」）');
  }
  if (summary.a0) {
    const a = summary.a0;
    console.log('A0 证据: 会话=' + a.session + '（首请求msgs=' + (a.firstMsgs == null ? '?' : a.firstMsgs) + '）'
      + '  介入=' + a.interventions + '(' + (a.interventionCount == null ? '?' : a.interventionCount) + ')'
      + '  投送[recalled=聚合 rendered=' + (a.rendered == null ? '?' : a.rendered)
      + ' delivered=' + (a.delivered == null ? '?' : a.delivered)
      + ' dropped=' + (a.dropped == null ? '?' : a.dropped)
      + ' truncated=' + (a.truncated == null ? '?' : a.truncated) + ']  ' + a.version);
  } else {
    console.log('A0 证据: 本轮 envelope 没有 a0 块（老 run 或 A0 采集失败——都不是「干净」，是「未取证」）');
  }
  const folded = Object.entries(summary.tagCount).filter(([t]) => ['chain', 'ctx', 'llm', 'snap'].includes(t));
  if (!tags && folded.length) console.log('已折叠: ' + folded.map(([t, n]) => t + ' ' + n).join(' / ') + '  —— 用 --tag chain,ctx,llm,snap 打开');
  const shown = shownEvs.slice(0, Math.max(0, limit));
  for (const e of shown) console.log(fmt(e.s).padStart(12) + '  [' + e.tag + '] ' + e.text);
  if (shownEvs.length > shown.length) console.log('…（共 ' + shownEvs.length + ' 条，已显示 ' + shown.length + '；--limit 调整）');
  console.log('共 ' + shownEvs.length + ' 条事件' + (tags ? '（--tag ' + tags.join(',') + '）' : '（默认视图）'));
}

// ── 开工包首屏（2026-10-29 施工单第 3 阶段） ──────────────────────────────
/**
 * 为什么存在：brief 以前只有「坑 + 旧结论 + 探针」，没有「本轮目标 / live 新鲜度 / core 入口 / 限制」。
 * 外部 AI 于是要么漏读 bench，要么读完还得自己 grep monitor。这里把开工要的东西一次给全。
 *
 * ★ 不填造：没有样本就写 unknown / stale；registry 的 98 项不冒充「每轮工具定义数」。
 */
const CHECKPOINT_MD = process.env.RDD_CHECKPOINT || path.join('D:\\rdd', 'docs', 'rdd-docs', 'rdd架构', '_memory', 'CHECKPOINT.md');

function fmtAgeSec(s) {
  if (s == null || !isFinite(s)) return 'unknown';
  if (s < 90) return Math.round(s) + 's';
  if (s < 5400) return (s / 60).toFixed(0) + 'm';
  return (s / 3600).toFixed(1) + 'h';
}

function readCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_MD)) return null;
  const text = fs.readFileSync(CHECKPOINT_MD, 'utf8');
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^- \*\*(.+?)\*\*[:：]\s*(.*)$/.exec(line);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  const at = (/写入时间[:：]\s*(.+)/.exec(text) || [])[1] || null;
  return { file: CHECKPOINT_MD, writtenAt: at ? at.trim() : null, fields };
}

/** 只看 live/ 的落盘事实与 pid 存活；不信任 status.json 的 running 字段。 */
function liveEntryState() {
  const dir = path.join(HARNESS, 'experiments', 'live');
  const sp = path.join(dir, 'status.json');
  const out = { known: false, alive: false, enabled: null, pid: null, last_tick_at: null, age_s: null, ticks: null, views: [], observer_age_s: null, problems: [] };
  if (!fs.existsSync(sp)) { out.problems.push('没跑过 bench live（没有 status.json）'); return out; }
  let st;
  try { st = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (e) { out.problems.push('status.json 读不了：' + e.message); return out; }
  out.known = true;
  out.pid = st.pid;
  out.alive = pidAlive(st.pid);
  out.enabled = st.enabled;
  out.ticks = st.ticks;
  const t = Date.parse(st.last_tick_at) || (typeof st.last_tick_at === 'number' ? st.last_tick_at : NaN);
  out.last_tick_at = isNaN(t) ? null : new Date(t).toISOString();
  out.age_s = isNaN(t) ? null : Math.max(0, (Date.now() - t) / 1000);
  for (const v of ['snapshot', 'chain', 'chat', 'context']) {
    const p = path.join(dir, v + '.md');
    if (!fs.existsSync(p)) { out.views.push({ name: v, age_s: null, missing: true }); continue; }
    out.views.push({ name: v, age_s: (Date.now() - fs.statSync(p).mtimeMs) / 1000 });
  }
  const ob = st.files && st.files['observer.jsonl'];
  if (ob && ob.lastEventAt) out.observer_age_s = Math.max(0, (Date.now() - ob.lastEventAt) / 1000);
  if (out.known && !out.alive) out.problems.push('status.json 说 running=' + st.running + '，但 pid=' + st.pid + ' 已退出');
  if (out.age_s != null && out.age_s > 120) out.problems.push('最后 tick 在 ' + fmtAgeSec(out.age_s) + ' 前');
  if (out.observer_age_s != null && out.observer_age_s > 600) out.problems.push('Observer 样本 ' + fmtAgeSec(out.observer_age_s) + ' 前（stale，不能当健康观察源）');
  return out;
}

/** 从 live/snapshot.md 抠「当前任务链」几行；没有就返回 null，不编。 */
function liveChainLines() {
  const p = path.join(HARNESS, 'experiments', 'live', 'snapshot.md');
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => /^## 当前任务链/.test(l));
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length && out.length < 4; j++) {
    if (/^## /.test(lines[j])) break;
    if (lines[j].trim()) out.push(lines[j].trim());
  }
  return out.length ? out : null;
}

function entryPackage(argv) {
  const TL = require('./lib/tool-layers.js');
  const view = TL.load();
  const cp = readCheckpoint();
  const goalArg = arg(argv, '--goal');
  const goal = goalArg || (cp && cp.fields['主线目标']) || null;
  const goalSource = goalArg ? '--goal 参数' : (cp && cp.fields['主线目标'] ? 'CHECKPOINT' + (cp.writtenAt ? '（写入 ' + cp.writtenAt + '）' : '') : 'none');
  const boundary = arg(argv, '--boundary') || '未声明（brief 不知道本轮主人边界；按最保守走，不要顺手扩大范围）';
  const next = arg(argv, '--next') || (cp && cp.fields['下一步']) || null;
  const live = liveEntryState();
  live.chain = liveChainLines();
  const limits = [
    'registry ' + view.counts.registry + ' 项是**目录数量**，不是每轮模型收到的工具定义数；实际请求暴露面本机未核实（unverified）',
    'mf-kit / mf-observer 只连原版协议服，不能证明 NeoForge live 行为；Observer 是独立只读眼，不是外部 AI 身体',
  ];
  if (!live.known) limits.push('live 没有任何样本 → unknown（不是 0）；先 bench live status，别把「没观测到」写成「没发生」');
  else if (!live.alive) limits.push('live 进程已退出（最后 tick ' + fmtAgeSec(live.age_s) + ' 前）→ 现场是 stale 快照，不是实时');
  else if (live.age_s != null && live.age_s > 120) limits.push('live 最后 tick ' + fmtAgeSec(live.age_s) + ' 前 → 数据已 stale');
  if (live.observer_age_s != null && live.observer_age_s > 600) limits.push('Observer 样本 ' + fmtAgeSec(live.observer_age_s) + ' 前且身体字段可能为 ?（stale）');
  return { goal, goalSource, boundary, next, core: view.coreOverlay, live, limits, layerCounts: view.counts };
}

/** 开工包：下一个 AI 一条命令拿到「要注意什么 + 前面结论 + 排队 + 母版 + 探针 +（可选）本轮 health 与时序摘要」（v0.1）。 */
function brief(argv) {
  const runDirArg = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  const asJson = has(argv, '--json');
  const w = load();
  const ep = entryPackage(argv);
  const openTips = w.tips.filter(t => t.status === 'open');
  const pending = w.queue.filter(q => q.status === 'pending');
  const reqProbes = w.probes.filter(p => p.kind === 'requested' || p.kind === 'custom');
  const builtin = w.probes.filter(p => !reqProbes.includes(p));
  const recentRuns = [];
  try {
    const runsRoot = path.join(HARNESS, 'runs');
    if (fs.existsSync(runsRoot)) {
      const dirs = fs.readdirSync(runsRoot).map(n => path.join(runsRoot, n)).filter(p => fs.statSync(p).isDirectory()).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 5);
      for (const d of dirs) {
        const ep = path.join(d, 'envelope.json');
        if (!fs.existsSync(ep)) continue;
        try {
          const env = JSON.parse(fs.readFileSync(ep, 'utf8'));
          const watch = env.watch || {};
          recentRuns.push({ run: env.runId || path.basename(d), label: env.label || '', phase: env.phase || '', stopReason: watch.stopReason || null, goal: watch.description || '', at: env.createdAt || '' });
        } catch {}
      }
    }
  } catch {}
  let runBlock = null;
  if (runDirArg) {
    const rd = path.resolve(runDirArg);
    const h = computeHealth(rd);
    const { summary, evs, fmt } = buildTimeline(rd);
    const line = (e) => fmt(e.s) + ' [' + e.tag + '] ' + e.text;
    runBlock = { health: h, summary, head: evs.slice(0, 8).map(line), tail: evs.slice(-8).map(line), events: evs.length };
  }
  if (asJson) { console.log(JSON.stringify({ updated_at: w.updated_at, entry: ep, openTips, verdicts: w.verdicts, pending, masters: w.masters, requestedProbes: reqProbes, builtinProbeIds: builtin.map(p => p.id), recentRuns, run: runBlock }, null, 2)); return; }
  console.log('# 实验台 brief —— 外部编码 AI 的开工包（先读这份，再动手）');
  console.log('开工: ' + now() + '   读的人: ' + sourceOf() + '/' + sessionOf(argv));
  console.log('账本: ' + FILE + '  更新于 ' + w.updated_at);
  console.log('\n## 0 · 本轮目标与边界');
  console.log('目标: ' + (ep.goal || 'unknown（没写 CHECKPOINT，也没给 --goal）'));
  console.log('来源: ' + ep.goalSource);
  console.log('边界: ' + ep.boundary);
  if (ep.next) console.log('CHECKPOINT 下一步: ' + ep.next);
  console.log('\n## 0.1 · core 入口（默认只用这 ' + ep.core.length + ' 项；其余用 `node bin/bench.js layers` 按需展开）');
  for (const c of ep.core) console.log('- ' + (c.cmd || c.id) + '\n  ' + (c.why || ''));
  console.log('\n## 0.2 · 现场（live）');
  const L = ep.live;
  if (!L.known) {
    console.log('状态: unknown —— ' + L.problems.join('；'));
  } else {
    const state = !L.alive ? 'STALE（进程已退出）' : (L.age_s != null && L.age_s > 120 ? 'STALE（' + fmtAgeSec(L.age_s) + ' 没更新）' : 'LIVE');
    console.log('状态: ' + state + '  pid=' + L.pid + '  enabled=' + L.enabled + '  ticks=' + L.ticks + '  最后 tick=' + L.last_tick_at + '（' + fmtAgeSec(L.age_s) + ' 前）');
    console.log('视图: ' + L.views.map((v) => v.name + '=' + (v.missing ? 'missing' : fmtAgeSec(v.age_s) + '前')).join('  '));
    console.log('Observer: ' + (L.observer_age_s == null ? 'unknown' : fmtAgeSec(L.observer_age_s) + ' 前' + (L.observer_age_s > 600 ? '（STALE）' : '')));
    if (L.chain) console.log('任务链（live/snapshot.md，新鲜度见上）:\n  ' + L.chain.join('\n  '));
    for (const p of L.problems) console.log('⚠ ' + p);
    if (!L.alive || (L.age_s != null && L.age_s > 120)) {
      console.log('→ 修复: node bin/bench.js live start（15s 后重读；常驻视图死了不等于游戏没数据）');
    }
  }
  console.log('\n## 0.3 · 要进游戏才做的前置（纯文档/单测任务跳过）');
  console.log('1) 读 harness/进游戏前必读-游戏内能力清单.md；2) preflight → BLOCK=0；3) 先把判据写死建验证卡（实机验证/YYYY-MM.md）；');
  console.log('4) 起游戏只走 start-rdd.ps1 或 run-mutation.ps1；5) 进游戏前把 card/runId 绑到本轮，收工用 bench health <runDir>。');
  console.log('\n## 0.4 · 已知限制（别把 unknown 当 0）');
  for (const x of ep.limits) console.log('- ' + x);
  console.log('\n## 账本概况');
  console.log('tips ' + w.tips.length + '（open ' + openTips.length + '）  verdicts ' + w.verdicts.length + '  queue pending ' + pending.length + '  masters ' + w.masters.length + '  probes ' + w.probes.length + '（待实现 ' + reqProbes.length + '）');
  if (runBlock) {
    console.log('\n## 本轮 run：' + runBlock.health.run);
    console.log('health: healthy=' + runBlock.health.healthy + (runBlock.health.problems.length ? '  problems: ' + runBlock.health.problems.join('; ') : ''));
    const s = runBlock.summary;
    console.log('窗口=' + s.window_s + 's  停因=' + s.stopReason + '  调用=' + s.evidence_calls + '（FAIL ' + s.evidence_fail + '）  死亡=' + s.deaths + '  drift=' + s.drift + '  母版=' + s.master);
    if (s.goal) console.log('目标: ' + s.goal);
    console.log('时序头:\n  ' + runBlock.head.join('\n  '));
    console.log('时序尾:\n  ' + runBlock.tail.join('\n  '));
    console.log('完整时序: node bench.js timeline <runDir>   （共 ' + runBlock.events + ' 条事件）');
  }
  console.log('\n## ⚠ 坑与护栏（open tips —— 实验前必读，照护栏做）');
  if (!openTips.length) console.log('（无 open tips）');
  for (const t of openTips) console.log('[' + t.id + ' · ' + t.kind + '] ' + t.symptom + '\n  假象: ' + t.fake + '\n  真因: ' + t.cause + '\n  护栏: ' + t.guard + (t.link ? '\n  链接: ' + t.link : ''));
  console.log('\n## 前面实验的结论（verdicts —— 别重复踩，别重跑已判 INCONCLUSIVE 的场景）');
  if (!w.verdicts.length) console.log('（无）');
  for (const v of w.verdicts) console.log('[' + v.result + '] ' + v.exp_id + '  card=' + v.card + '\n  why: ' + v.why + '\n  judge: ' + v.judge);
  console.log('\n## 排队中的实验');
  if (!pending.length) console.log('（无）');
  for (const q of pending) console.log('[ ] ' + q.label + ' [' + q.tier + '/' + q.window + ']  ' + q.goal);
  console.log('\n## 母版');
  for (const m of w.masters) console.log('- ' + m.name + '  ' + String(m.sha).slice(0, 16) + '…  ' + m.notes);
  console.log('\n## 探针（数据面）');
  console.log('builtin: ' + builtin.map(p => p.id).join(', '));
  if (!reqProbes.length) console.log('requested: （无 —— AI 想读但还没有的数据，用 bench probe add 登记）');
  for (const p of reqProbes) console.log('- ' + p.id + ' [' + (p.status || p.kind) + '] ' + p.title + '  source=' + p.source + '  fields=' + (p.fields || []).join(',') + (p.note ? '\n  note: ' + p.note : ''));
  console.log('\n## 最近跑过的实验（runs/ 最新 5 个 —— 读时序用 bench timeline <runDir>）');
  if (!recentRuns.length) console.log('（无）');
  for (const r of recentRuns) console.log('- ' + r.run + (r.label ? ' (' + r.label + ')' : '') + '  停因=' + r.stopReason + '  ' + (r.at || '').slice(0, 19) + (r.goal ? '\n  目标: ' + r.goal : ''));
  console.log('\n共建入口: bench tip add / bench probe add / bench verdict add（要卡+judge）/ bench queue add');
  logUsage(argv, 'bench brief', { run: runDirArg ? path.basename(path.resolve(runDirArg)) : null, status: 'ok' });
}

/** 健康哨：跑完/中断后先判「这轮材料能不能用」，坏实验早熔断。 */
function computeHealth(runDir) {
  const envPath = path.join(runDir, 'envelope.json');
  if (!fs.existsSync(envPath)) die(3, 'no envelope.json: ' + runDir);
  const env = JSON.parse(fs.readFileSync(envPath, 'utf8'));
  const problems = [];
  const before = ((env.world || {}).before) || {};
  const after = ((env.world || {}).after) || {};
  if (before.complete !== true) problems.push('world.before incomplete');
  if (after.complete !== true) problems.push('world.after incomplete');
  const stop = env.stop || {};
  if (stop.javaExited === false) problems.push('java did not exit');
  if ((env.watch || {}).stopReason && /java died/i.test(env.watch.stopReason)) problems.push('watch stopped by java died');
  if (after.control_key && before.control_key && after.control_key !== before.control_key && env.world.drift !== true) problems.push('control keys differ but drift flag not set');
  const ev = path.join(runDir, 'evidence');
  for (const f of ['tools.jsonl', 'context.jsonl', 'world-before.json', 'world-after.json']) if (!fs.existsSync(path.join(ev, f))) problems.push('missing evidence/' + f);
  // ★ A0（90 号 §8）：证据不可判 ≠ 健康。这里只报事实，不改任何行为。
  const a0 = {
    present: !!env.a0,
    version: env.a0 ? (env.a0.version || null) : null,
    session: (env.session || {}).status || 'UNKNOWN',
    interventions: (env.interventions || {}).status || 'UNKNOWN',
    interventionCount: (env.interventions || {}).count == null ? null : env.interventions.count,
    delivery: (env.context_delivery || {}).status || 'UNKNOWN',
    // A1（93 号）：死亡事实。老 run 没有这个键 = 未采集，不是「没死」。
    deaths: env.deaths ? env.deaths.status : null,
    deathCount: env.deaths && env.deaths.count != null ? env.deaths.count : null,
    // A3（95 号）：capability/tool 两层（归档后处理，realtime=false）。
    situations: env.situations ? env.situations.status : null,
    situationCount: env.situations && Array.isArray(env.situations.entries) ? env.situations.entries.length : null,
    reasons: [],
  };
  if (!env.a0) a0.reasons.push('a0:missing（老 run 或采集失败，不是「干净」）');
  else {
    const s = env.session || {};
    if (s.status === 'UNKNOWN') a0.reasons.push('session:UNKNOWN(' + ((s.reasons || []).join(',') || 'no-reason') + ')');
    if (s.status === 'DIRTY') a0.reasons.push('session:DIRTY');
    const i = env.interventions || {};
    if (i.status === 'UNKNOWN') a0.reasons.push('interventions:UNKNOWN');
    if (i.status === 'PRESENT') a0.reasons.push('interventions:PRESENT(' + i.count + ') → 结果只能算「人工介入后结果」');
    const d = env.context_delivery || {};
    if (d.status === 'UNKNOWN') a0.reasons.push('delivery:UNKNOWN');
    if (d.truncatedCountedAsDelivered) a0.reasons.push('delivery:截断条目被当成送达');
    // delivered 可以多于 rendered：执行视图直接注入正文，不经过逐条 expanded（2026-10-29 实测）。
    // 这不是矛盾，单列给审计看，不进 problems。
    if (d.deliveredWithoutRender && d.deliveredWithoutRender.count > 0) {
      a0.reasons.push('delivery:deliveredWithoutRender=' + d.deliveredWithoutRender.count + '（直接注入，非异常）');
    }
    // A1：有 deaths 键却 UNKNOWN = 拿不到 instrumentation，必须显式报，不得当成没死。
    if (env.deaths && env.deaths.status === 'UNKNOWN') {
      a0.reasons.push('deaths:UNKNOWN(' + ((env.deaths.reasons || []).join(',') || 'no-reason') + ')');
    }
  }
  // A1：deaths:UNKNOWN 和 DIRTY 同级——拿不到死亡证据时不能把这一轮当健康样本。
  const blockingA0 = a0.reasons.filter((r) => /DIRTY|截断|矛盾|deaths:UNKNOWN/.test(r));
  if (blockingA0.length) problems.push(...blockingA0);
  const out = { run: path.basename(runDir), healthy: problems.length === 0, problems, stopReason: (env.watch || {}).stopReason || null, drift: env.world ? env.world.drift : null, complete: { before: before.complete, after: after.complete }, postStopRequests: (env.stop || {}).postStopRequests, a0 };
  return out;
}
function health(runDir) {
  const out = computeHealth(runDir);
  console.log(JSON.stringify(out, null, 2));
  logUsage(null, 'bench health', { run: path.basename(runDir), status: out.problems.length ? 'unhealthy' : 'ok' });
  process.exit(out.problems.length ? 1 : 0);
}

/** 坑账本：19 时间锁 + 18 tips 的统一索引（只读两处真源，不改它们）。 */
function pit(argv) {
  const PL = require('./lib/pit-ledger.js');
  const sub = argv[1] === 'build' ? 'build' : 'list';
  if (sub === 'build') {
    const L = PL.build();
    if (has(argv, '--json')) console.log(JSON.stringify({ counts: L.counts, updated_at: L.updated_at }, null, 2));
    else {
      const c = L.counts;
      console.log('# 坑账本已重建 ' + PL.LEDGER);
      console.log('共 ' + c.total + ' 条（timeLock ' + c.timeLock + ' / tip ' + c.tip + '）｜watching ' + c.watching + ' · guarded ' + c.guarded + ' · fixed ' + c.fixed + ' · museum ' + c.museum + '｜可进机器判据 ' + c.gateEligible);
    }
    logUsage(argv, 'bench pit build', { status: 'ok' });
    return 0;
  }
  const res = PL.list({
    status: arg(argv, '--status'),
    source: arg(argv, '--source'),
    eligible: has(argv, '--eligible'),
  });
  if (has(argv, '--json')) console.log(JSON.stringify(res, null, 2));
  else console.log(PL.renderText(res));
  logUsage(argv, 'bench pit', { status: 'ok' });
  return 0;
}

/** 工具分层视图（生成，不手写第二份真源）。默认只列 core，其余层显式展开。 */
function layers(argv) {
  const TL = require('./lib/tool-layers.js');
  const view = TL.load();
  const opts = {
    specialist: has(argv, '--specialist'),
    operator: has(argv, '--operator'),
    legacy: has(argv, '--legacy'),
    archived: has(argv, '--archived'),
    all: has(argv, '--all'),
  };
  if (has(argv, '--json')) console.log(JSON.stringify(TL.renderJson(view, opts), null, 2));
  else console.log(TL.renderText(view, opts));
  if (view.problems.length) console.error('\n[warn] ' + view.problems.join('\n[warn] '));
  logUsage(argv, 'bench layers', { status: 'ok' });
}

// ── 常驻视图（bench live） ────────────────────────────────────────────────
/**
 * ★ 2026-10-28 用户下单：「常驻在那里实时拿快照，方便 AI 直接读，并且可以自己开关」。
 * 引擎是 bin/bench-watch.js（独立进程，只读 monitor、只写 experiments/live/）；
 * 这里只做开关与查看，不自己跑循环 —— 开关写进 live/watch.json，引擎每拍重读。
 */
const LIVE_DIR = path.join(HARNESS, 'experiments', 'live');
function liveStatusOf() {
  try { return JSON.parse(fs.readFileSync(path.join(LIVE_DIR, 'status.json'), 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
function liveMain(argv) {
  const sub = argv[1] || 'status';
  const LB = require(path.join(__dirname, 'lib', 'bench-live.js'));
  const { spawn, spawnSync } = require('child_process');
  const engine = path.join(__dirname, 'bench-watch.js');
  const ctl = LB.loadControl(LIVE_DIR);
  const block = (ms) => spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},' + ms + ')'], { stdio: 'ignore' });

  if (sub === 'status') {
    const st = liveStatusOf();
    const alive = !!(st && pidAlive(st.pid));
    console.log('# 实验台常驻视图 · status');
    console.log('开关文件: ' + path.join(LIVE_DIR, 'watch.json'));
    console.log('enabled=' + ctl.enabled + '  views=' + ctl.views.join(',') + '  interval=' + ctl.interval_s + 's  by=' + ctl.by + (ctl.updated_at ? ' @ ' + ctl.updated_at : ''));
    if (!st) console.log('进程: 没跑过 —— node bin/bench.js live start');
    else {
      console.log('进程: pid=' + st.pid + ' ' + (alive ? '运行中' : '已退出') + '  started=' + st.started_at + '  last_tick=' + st.last_tick_at + '  ticks=' + st.ticks + (st.paused ? '  (paused)' : ''));
      if (st.counters) {
        const pick = ['taskchain_snapshot', 'numen_context', 'supervisor_output', 'llm_request', 'tool_call', 'tool_result', 'assistant', 'death'];
        console.log('计数: ' + (pick.map((k) => k + '=' + (st.counters[k] || 0)).join(' ')));
      }
    }
    for (const v of LB.VIEWS) {
      const p = path.join(LIVE_DIR, v + '.md');
      if (!fs.existsSync(p)) { console.log('  ' + v + '.md  —— 还没有'); continue; }
      const s = fs.statSync(p);
      console.log('  ' + v + '.md  ' + (s.size / 1024).toFixed(1) + ' KB  ' + new Date(s.mtimeMs).toISOString().slice(0, 19) + '  → ' + p);
    }
    console.log('读法: node bin/bench.js live show chain');
    logUsage(argv, 'bench live status', { status: 'ok' });
    return 0;
  }

  if (sub === 'start') {
    const st = liveStatusOf();
    if (st && pidAlive(st.pid)) { console.log('已在跑 pid=' + st.pid + '（要换参数先 live stop）'); return 0; }
    if (!fs.existsSync(path.join(LIVE_DIR, 'watch.json'))) LB.saveControl(LIVE_DIR, {}, 'bench live start');
    const iv = parseInt(arg(argv, '--interval') || '0', 10);
    if (iv >= 5) LB.saveControl(LIVE_DIR, { interval_s: iv }, 'bench');
    const args = [engine, '--out', LIVE_DIR];
    if (arg(argv, '--monitor')) args.push('--monitor', arg(argv, '--monitor'));
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: HARNESS });
    child.unref();
    let s2 = null;
    for (let i = 0; i < 40; i++) { block(200); s2 = liveStatusOf(); if (s2 && s2.pid) break; }
    if (!s2 || !pidAlive(s2.pid)) die(1, '启动后 8s 内没写出 status.json —— 手动跑一遍看报错：node ' + engine + ' --once');
    if (!s2.last_tick_at || s2.starting) block(2500);
    const s3 = liveStatusOf() || s2;
    console.log('已启动 pid=' + s3.pid + '  interval=' + LB.loadControl(LIVE_DIR).interval_s + 's  首拍=' + (s3.ticks || 0) + '  视图在 ' + LIVE_DIR);
    return 0;
  }

  if (sub === 'stop') {
    const st = liveStatusOf();
    if (!st || !pidAlive(st.pid)) { console.log('没在跑'); return 0; }
    try { process.kill(st.pid, 'SIGTERM'); } catch { /* ignore */ }
    block(700);
    if (pidAlive(st.pid)) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* ignore */ } block(300); }
    // Windows 下 SIGTERM 可能不走 handler：把状态显式标成已停，避免下次 status 说谎
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, 'status.json'), 'utf8'));
      cur.running = false; cur.stopped_at = new Date().toISOString(); cur.stopped_reason = 'bench live stop';
      fs.writeFileSync(path.join(LIVE_DIR, 'status.json'), JSON.stringify(cur, null, 2) + '\n');
    } catch { /* ignore */ }
    console.log('已停 pid=' + st.pid);
    return 0;
  }

  if (sub === 'on' || sub === 'off') {
    LB.saveControl(LIVE_DIR, { enabled: sub === 'on' }, 'bench live ' + sub);
    const st = liveStatusOf();
    const alive = !!(st && pidAlive(st.pid));
    console.log('enabled=' + (sub === 'on') + (alive ? '（下一拍生效，不用重启）' : '（进程没跑，start 后生效）'));
    return 0;
  }

  if (sub === 'only') {
    const list = String(argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length) die(2, 'usage: bench live only snapshot,chain,chat,context');
    const bad = list.filter((v) => !LB.VIEWS.includes(v));
    if (bad.length) die(2, '未知视图：' + bad.join(',') + '（只认 ' + LB.VIEWS.join('|') + '）');
    LB.saveControl(LIVE_DIR, { views: list }, 'bench live only');
    console.log('views=' + list.join(',') + '（下一拍生效）');
    return 0;
  }

  if (sub === 'interval') {
    const n = parseInt(argv[2], 10);
    if (!(n >= 5)) die(2, 'usage: bench live interval <秒>（最小 5）');
    LB.saveControl(LIVE_DIR, { interval_s: n }, 'bench live interval');
    console.log('interval=' + n + 's（下一拍生效）');
    return 0;
  }

  if (sub === 'show') {
    const v = argv[2] || 'snapshot';
    if (!LB.VIEWS.includes(v)) die(2, '未知视图：' + v + '（只认 ' + LB.VIEWS.join('|') + '）');
    const p = path.join(LIVE_DIR, v + '.md');
    if (!fs.existsSync(p)) die(1, '还没有 ' + p + '（bench live status 看哪份在；或 live start）');
    console.log(fs.readFileSync(p, 'utf8'));
    logUsage(argv, 'bench live show ' + v, { status: 'ok' });
    return 0;
  }

  if (sub === 'selftest') {
    const r = spawnSync(process.execPath, [engine, '--self-test'], { stdio: 'inherit' });
    return r.status == null ? 1 : r.status;
  }

  die(2, 'usage: bench live [status|start|stop|on|off|only <views>|interval <s>|show [view]|selftest]');
}

function selfTest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const f = path.join(tmp, 'workbench.json');
  const usageF = path.join(tmp, 'usage.jsonl');
  const checkpointF = path.join(tmp, 'CHECKPOINT.md');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, updated_at: '', probes: [], tips: [], signals: [], verdicts: [], queue: [], masters: [] }));
  fs.writeFileSync(checkpointF, '# CHECKPOINT\n\n> 写入时间：2026-10-29 13:00\n\n- **主线目标**：测试目标\n- **下一步**：测试下一步\n');
  const run = (args) => {
    const r = require('child_process').spawnSync(process.execPath, [__filename].concat(args), {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { BENCH_FILE: f, BENCH_USAGE_FILE: usageF, RDD_CHECKPOINT: checkpointF, DSH_SESSION_ID: '' }),
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  // 注意：FILE 在模块顶层算死；测试子进程用 BENCH_FILE 覆盖
  const cases = [];
  const c1 = run(['tip', 'add', '--kind', 'pitfall', '--symptom', 's', '--fake', 'f', '--cause', 'c', '--guard', 'g']);
  cases.push(['tip add', c1.code === 0, c1.out.trim()]);
  const c2 = run(['tip', 'add', '--kind', 'pitfall', '--symptom', 's']);
  cases.push(['tip reject empty fake/cause/guard', c2.code !== 0, c2.out.trim().slice(0, 60)]);
  const c3 = run(['verdict', 'add', 'x', '--card', 'V-20261026-12', '--judge', 'node a b', '--result', 'INCONCLUSIVE', '--why', 'w']);
  cases.push(['verdict with card ok', c3.code === 0, c3.out.trim()]);
  const c4 = run(['verdict', 'add', 'x', '--judge', 'node a b', '--result', 'PASS', '--why', 'w']);
  cases.push(['verdict without card rejected', c4.code !== 0, c4.out.trim().slice(0, 80)]);
  const c5 = run(['signal', 'add', 'x', '--note', 'n']);
  cases.push(['signal ok', c5.code === 0, c5.out.trim()]);
  // health：造假 run
  const rd = path.join(tmp, 'run1');
  fs.mkdirSync(path.join(rd, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(rd, 'envelope.json'), JSON.stringify({ watch: { stopReason: 'wall 600s' }, world: { before: { complete: true }, after: { complete: false } }, stop: { javaExited: true } }));
  for (const f2 of ['tools.jsonl', 'context.jsonl']) fs.writeFileSync(path.join(rd, 'evidence', f2), '');
  const c6 = run(['health', rd]);
  cases.push(['health catches incomplete after', c6.code === 1 && c6.out.includes('world.after incomplete'), c6.out.trim().slice(0, 120)]);
  // v0.1：probe / timeline / brief
  fs.writeFileSync(path.join(rd, 'evidence', 'tools.jsonl'),
    JSON.stringify({ timestamp: '2026-10-26T14:02:48.932Z', type: 'tool_call', data: { tool_call_id: 'mcp-4', tool: 'rdd_get_inventory' } }) + '\n' +
    JSON.stringify({ timestamp: '2026-10-26T14:02:49.100Z', type: 'tool_result', data: { tool_call_id: 'mcp-4', result: '{"success":true,"message":"背包物品清单查询成功"}' } }) + '\n');
  const c7 = run(['probe', 'add', '--id', 'sleep_success_window', '--title', 't', '--source', 'tools.jsonl', '--fields', 'tool,result', '--note', 'n']);
  cases.push(['probe add', c7.code === 0, c7.out.trim()]);
  const c8 = run(['probe', 'add', '--id', 'sleep_success_window', '--title', 't', '--source', 's', '--fields', 'f', '--note', 'n']);
  cases.push(['probe add duplicate rejected', c8.code !== 0, c8.out.trim().slice(0, 60)]);
  const c9 = run(['probe', 'add', '--id', 'x2', '--title', 't']);
  cases.push(['probe add missing fields rejected', c9.code !== 0, c9.out.trim().slice(0, 60)]);
  const c10 = run(['probe', 'list']);
  cases.push(['probe list shows new probe', c10.code === 0 && c10.out.includes('sleep_success_window'), c10.out.trim().slice(0, 60)]);
  const c11 = run(['timeline', rd]);
  cases.push(['timeline on run dir', c11.code === 0 && c11.out.includes('rdd_get_inventory'), c11.out.trim().slice(0, 120)]);
  const c12 = run(['brief', rd]);
  cases.push(['brief with run dir', c12.code === 0 && c12.out.includes('开工包'), c12.out.trim().slice(0, 80)]);
  const c13 = run(['brief']);
  cases.push(['brief ledger only', c13.code === 0 && c13.out.includes('实验台 brief'), c13.out.trim().slice(0, 60)]);
  // v0.2（2026-10-28）：折叠的链/上下文能 --tag 打开；对话进时序；live 开关可查
  fs.writeFileSync(path.join(rd, 'evidence', 'rdd.jsonl'),
    JSON.stringify({ timestamp: '2026-10-26T14:02:50.000Z', type: 'taskchain_snapshot', data: { reason: 'periodic_observation', taskChain: { goalId: 'goal-x', primaryStatus: 'STALLED', stateVersion: 9, currentSubtaskId: 'p1-r2', description: '测试链', primaries: [{ id: 'p0' }, { id: 'p1' }] } } }) + '\n' +
    JSON.stringify({ timestamp: '2026-10-26T14:02:51.000Z', type: 'numen_context', data: { context: '<rdd><current_task>挖黑曜石</current_task></rdd>' } }) + '\n');
  fs.writeFileSync(path.join(rd, 'evidence', 'ai.jsonl'),
    JSON.stringify({ timestamp: '2026-10-26T14:02:52.000Z', type: 'assistant', data: { text: '我去砍树' } }) + '\n');
  const c14 = run(['timeline', rd]);
  cases.push(['timeline 默认折叠链帧但给出链摘要',
    c14.code === 0 && c14.out.includes('任务链: goal=goal-x') && !c14.out.includes('[chain] taskchain_snapshot v=9'), c14.out.trim().slice(0, 160)]);
  const c15 = run(['timeline', rd, '--tag', 'chain']);
  cases.push(['timeline --tag chain 打开链帧',
    c15.code === 0 && c15.out.includes('[chain] taskchain_snapshot v=9 status=STALLED'), c15.out.trim().slice(0, 160)]);
  const c16 = run(['timeline', rd, '--tag', 'chat,ctx']);
  cases.push(['timeline --tag chat,ctx 打开对话与上下文',
    c16.code === 0 && c16.out.includes('我去砍树') && c16.out.includes('挖黑曜石'), c16.out.trim().slice(0, 160)]);
  const c17 = run(['live', 'status']);
  cases.push(['live status 可跑（没进程也不崩）', c17.code === 0 && c17.out.includes('watch.json'), c17.out.trim().slice(0, 160)]);
  // 2026-10-29：分层视图 + 开工包首屏 + 使用证据（施工单第 2/3/4 阶段）
  const c18 = run(['layers', '--json', '--all']);
  let layersJson = null;
  try { layersJson = JSON.parse(c18.out.slice(c18.out.indexOf('{'))); } catch {}
  cases.push(['layers 默认只列 core，--all 才展开四层',
    c18.code === 0 && layersJson && layersJson.core.length <= 5 && layersJson.counts.registry >= 90 && Array.isArray(layersJson.operator) && layersJson.operator.length > 0,
    c18.out.trim().slice(0, 160)]);
  const c18b = run(['layers', '--json']);
  let layersDefault = null;
  try { layersDefault = JSON.parse(c18b.out.slice(c18b.out.indexOf('{'))); } catch {}
  cases.push(['layers 默认视图不含 operator/legacy 明细',
    c18b.code === 0 && layersDefault && layersDefault.operator === undefined && layersDefault.legacy_or_unverified === undefined && layersDefault.core.length <= 5,
    c18b.out.trim().slice(0, 200)]);
  const c19 = run(['brief', '--session', 'selftest-session']);
  cases.push(['brief 首屏有目标/边界/live/core/限制',
    c19.code === 0 && c19.out.includes('本轮目标与边界') && c19.out.includes('测试目标') && c19.out.includes('core 入口') && c19.out.includes('已知限制') && c19.out.includes('不是每轮模型收到的工具定义数'),
    c19.out.trim().slice(0, 200)]);
  let usageLines = [];
  try { usageLines = fs.readFileSync(usageF, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const briefUsage = usageLines.filter((r) => r.cmd === 'bench brief').pop();
  cases.push(['brief 写使用证据（session 可识别）',
    !!briefUsage && briefUsage.session === 'selftest-session' && briefUsage.source === 'unknown' && briefUsage.run === null,
    JSON.stringify(usageLines.slice(-2))]);
  const c20 = run(['usage', '--json']);
  let usageJson = null;
  try { usageJson = JSON.parse(c20.out.slice(c20.out.indexOf('{'))); } catch {}
  cases.push(['usage 能读回账本', c20.code === 0 && usageJson && usageJson.total >= 1, c20.out.trim().slice(0, 160)]);
  const c21 = run(['layers', '--json', '--operator']);
  let opRisk = null;
  try { opRisk = JSON.parse(c21.out.slice(c21.out.indexOf('{'))).operator.find((x) => x.id === 'compile.entry'); } catch {}
  cases.push(['operator 带显式风险文案', !!opRisk && !!opRisk.risk && /run-mutation|部署/.test(opRisk.risk), JSON.stringify(opRisk)]);
  const c22 = run(['brief', '--json', '--session', 'selftest-session']);
  let briefJson = null;
  try { briefJson = JSON.parse(c22.out.slice(c22.out.indexOf('{'))); } catch {}
  cases.push(['brief --json 带 entry（目标/live/限制）',
    c22.code === 0 && briefJson && briefJson.entry && briefJson.entry.limits.length >= 2 && typeof briefJson.entry.live.known === 'boolean',
    c22.out.trim().slice(0, 120)]);
  // 2026-10-30：坑账本（19 时间锁 + 18 tips 合成索引）
  let pitRes = null;
  try { pitRes = require('./lib/pit-ledger.js').list(); } catch (e) { pitRes = { error: e.message }; }
  cases.push(['pit 账本能读且计数自洽',
    !pitRes.error && pitRes.counts && pitRes.counts.total === (pitRes.counts.timeLock + pitRes.counts.tip) && pitRes.counts.total >= 19 && pitRes.rows.length === pitRes.counts.total,
    pitRes.error ? pitRes.error : JSON.stringify(pitRes.counts)]);
  let ok = true;
  for (const [name, pass, msg] of cases) { console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (pass ? '' : '  -> ' + msg)); if (!pass) ok = false; }
  console.log(JSON.stringify({ selfTest: ok ? 'PASS' : 'FAIL', cases: cases.length }));
  process.exit(ok ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'selftest') selfTest();
  if (cmd === 'catalog') return catalog();
  if (cmd === 'tip') return argv[1] === 'add' ? tipAdd(argv) : tipList(argv);
  if (cmd === 'signal') return argv[1] === 'add' ? signalAdd(argv) : signalList();
  if (cmd === 'verdict') return argv[1] === 'add' ? verdictAdd(argv) : verdictList();
  if (cmd === 'queue') { if (argv[1] === 'add') return queueAdd(argv); if (argv[1] === 'next') return queueNext(argv); return queueList(argv); }
  if (cmd === 'master') return argv[1] === 'add' ? masterAdd(argv) : masterList();
  if (cmd === 'probe') return argv[1] === 'add' ? probeAdd(argv) : probeList(argv);
  if (cmd === 'brief') return brief(argv);
  if (cmd === 'layers') return layers(argv);
  if (cmd === 'pit') return pit(argv);
  if (cmd === 'usage') return usage(argv);
  if (cmd === 'timeline') return timeline(argv);
  if (cmd === 'live' || cmd === 'watch') process.exit(liveMain(argv));
  if (cmd === 'health') { const rd = argv[1]; if (!rd) die(2, 'usage: bench.js health <runDir>'); return health(path.resolve(rd)); }
  // A7（99 号）：两臂对比与周指标（只读 envelope，不改行为）
  if (cmd === 'compare') return compareCmd(argv);
  if (cmd === 'compare-many') return compareManyCmd(argv);
  if (cmd === 'report') return reportCmd(argv);
  if (cmd === 'verify') { const code = verifyCmd(argv); process.exit(code); }
  if (cmd === 'noshot') {
    const rd = argv[1];
    if (!rd) die(2, 'usage: bench.js noshot <runDir> [--log <latest.log>]');
    const li = argv.indexOf('--log');
    if (li >= 0) process.exit(noshotCmd(path.resolve(rd), path.resolve(argv[li + 1])));
    process.exit(noshotCmd(path.resolve(rd), null));
  }
  die(2, 'usage: bench.js catalog|tip|signal|verdict|queue|master|probe|brief|layers|usage|timeline|health|compare|compare-many|report|verify|live|selftest');
}

/** A7：`bench compare <runA> <runB>` —— 同目标同母版才给 DIRECTIONAL，否则 INCONCLUSIVE。 */
function compareCmd(argv) {
  const [a, b] = argv.slice(1);
  if (!a || !b) die(2, 'usage: bench.js compare <runA> <runB>');
  const E = require('./lib/experiment');
  const load = (d) => JSON.parse(fs.readFileSync(path.join(path.resolve(d), 'envelope.json'), 'utf8'));
  const r = E.compare(load(a), load(b));
  console.log('verdict: ' + r.verdict + (r.reasons.length ? '  reasons=' + r.reasons.join(',') : '')
    + (r.notes && r.notes.length ? '  notes=' + r.notes.join(',') : ''));
  for (const row of r.rows) {
    console.log('  ' + String(row.metric).padEnd(14) + ' A=' + String(row.a).padEnd(6) + ' B=' + String(row.b).padEnd(6) + ' delta=' + row.delta);
  }
  console.log('note: 单轮最高 DIRECTIONAL，从不等于「变好」；没有任何可比较指标 => INSUFFICIENT（不是 DIRECTIONAL）。'
      + '目标/母版/场景/构建（jarsAtLaunch 指纹）任一不同或取不到 => INCONCLUSIVE；'
      + 'SUPPORTED 需要 envelope.prereg 或 contract.prereg = {metric,arm,direction}，且主指标两臂各≥5 份、区间不重叠、方向相符。'
      + '（151 §2 / P1-20261030）');
  return 0;
}

/** A7：`bench compare-many --a d1,d2,d3 --b d4,d5,d6` —— 两臂多轮，中位数 + 极差。 */
function compareManyCmd(argv) {
  const E = require('./lib/experiment');
  const ai = argv.indexOf('--a');
  const bi = argv.indexOf('--b');
  const gi = argv.indexOf('--goal');
  const goalOverride = gi >= 0 ? argv[gi + 1] : null;
  if (ai < 0 || bi < 0) die(2, 'usage: bench.js compare-many --a <dir1,dir2,...> --b <dir1,dir2,...> [--goal "<实验目标>"]');
  const load = (d) => JSON.parse(fs.readFileSync(path.join(path.resolve(d), 'envelope.json'), 'utf8'));
  const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean).map((d) => {
    const e = load(d);
    if (!e.goal && goalOverride) e.goal = goalOverride;   // 老 run 没存 goal 时由实验者显式声明
    return e;
  });
  const r = E.compareGroups(list(argv[ai + 1]), list(argv[bi + 1]));
  console.log('verdict: ' + r.verdict + '  sample A=' + r.sample.a + ' B=' + r.sample.b
    + (r.reasons.length ? '  reasons=' + r.reasons.join(',') : '')
    + (r.notes && r.notes.length ? '  notes=' + r.notes.join(',') : ''));
  for (const row of r.rows) {
    const f = (s) => (s.median === null ? 'UNKNOWN' : s.median + ' [' + s.min + '..' + s.max + '] n=' + s.n);
    console.log('  ' + String(row.metric).padEnd(14) + ' A=' + f(row.a).padEnd(22) + ' B=' + f(row.b));
  }
  console.log('note: n<3 必 INCONCLUSIVE；无从比较 => INSUFFICIENT。'
      + 'SUPPORTED 需要预注册主指标（envelope.prereg={metric,arm,direction}）+ 两臂各>=5 份 + 主指标区间不重叠 + 方向相符；'
      + '没有预注册 => 封顶 DIRECTIONAL（「区间不重叠」不是学习收益）。'
      + '目标/母版/场景/构建任一不同或取不到 => INCONCLUSIVE。（151 §2 / P1-20261030）');
  return 0;
}

/** A7：`bench report [--since YYYY-MM-DD] [--mode campaign|diagnostic|regression] [--all]` —— 周指标，缺字段 UNKNOWN 不补 0。 */
function reportCmd(argv) {
  const E = require('./lib/experiment');
  const i = argv.indexOf('--since');
  const since = i >= 0 ? Date.parse(argv[i + 1]) : Date.now() - 7 * 86400000;
  const mi = argv.indexOf('--mode');
  const mode = mi >= 0 ? argv[mi + 1] : 'campaign';
  const includeAll = argv.includes('--all');
  const runsRoot = path.join(HARNESS, 'runs');
  const envs = [];
  if (fs.existsSync(runsRoot)) {
    for (const n of fs.readdirSync(runsRoot)) {
      const f = path.join(runsRoot, n, 'envelope.json');
      try {
        if (fs.statSync(f).mtimeMs < since) continue;
        envs.push(JSON.parse(fs.readFileSync(f, 'utf8')));
      } catch { /* 没有 envelope 的目录不算样本 */ }
    }
  }
  const w = E.weekly(envs, { mode, includeAll });
  console.log(JSON.stringify(w, null, 2));
  if (!includeAll && w.runs !== w.totalRuns) {
    console.log('note: 只统计 mode=' + w.mode + ' 的局；' + (w.totalRuns - w.runs) + ' 局被排除（'
      + Object.entries(w.excluded.byMode).filter(([, n]) => n).map(([k, n]) => k + '=' + n).join(' ')
      + '）。诊断/回归局不混进通关曲线；要看全量加 --all。（151 §3）');
  }
  return 0;
}
/**
 * 151 §4：`bench verify [--json] [--manifest <file>]` —— 一个入口、一张表。
 *
 * 只读：跑离线检查、读已有证据文件；**不启动游戏、不编译、不部署**。
 * 退出码：0 = 所有必验项 PASS；1 = 有必验项未过（这就是「整体没完成」）；2 = 用法/清单错。
 */
function verifyCmd(argv) {
  const A = require('./lib/acceptance');
  const i = argv.indexOf('--manifest');
  const file = i >= 0 ? path.resolve(argv[i + 1]) : path.join(HARNESS, 'experiments', 'acceptance.json');
  let res;
  try {
    res = A.evaluate(A.loadManifest(file), {
      root: HARNESS,
      modsDir: path.join(HARNESS, '..', '..', 'mc', 'The Best of Twilight Forest', 'mods'),
    });
  } catch (e) {
    console.error('验收清单读不了：' + e.message);
    return 2;
  }
  if (argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else console.log(A.render(res));
  return res.summary.overall === 'COMPLETE' ? 0 : 1;
}

/**
 * 151 §5 H21：`bench noshot <runDir> [--log <latest.log>]` —— 读一次 run 的判别性观测账。
 * 只读；缺摘要就报 UNOBSERVED，不替人把「没看见」写成「没发生」。
 */
function noshotCmd(runDir, logPath) {
  const N = require('./lib/noshot');
  const toolsPath = path.join(runDir, 'evidence', 'tools.jsonl');
  const tools = fs.existsSync(toolsPath) ? fs.readFileSync(toolsPath, 'utf8') : '';
  let log = '';
  if (logPath && fs.existsSync(logPath)) log = fs.readFileSync(logPath, 'utf8');
  const r = N.analyze(tools, log);
  console.log(N.render(r));
  return r.verdict === 'OBSERVED' ? 0 : 1;
}

main();
