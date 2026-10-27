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
 *   node bench.js timeline <runDir> [--limit N]  ← 完整时序一条命令读全（阶段/目标/回合/调用/结果/任务链/死亡）
 *   node bench.js health <runDir>
 *   node bench.js selftest
 *
 * 退出码：0 成功 / 1 校验失败或 health 不健康 / 2 用法错 / 3 读盘错
 */
const fs = require('fs');
const path = require('path');

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
  const push = (ts, tag, text) => { const s = rel(ts); if (s != null) evs.push({ s, tag, text: String(text).replace(/\s+/g, ' ').slice(0, 140) }); };
  for (const k of ['launchStart', 'mcpReady', 'stimulusSentAt', 'watchEnd', 'gameExited']) {
    if (!T[k]) continue;
    const label = k === 'mcpReady' ? ' —— MCP 就绪' : k === 'stimulusSentAt' ? ' —— 派目标' : k === 'watchEnd' ? ' —— 观察结束' : k === 'gameExited' ? ' —— 游戏退出' : ' —— 启动';
    push(T[k], 'phase', k + label);
  }
  const ctx = readJsonl(path.join(ev, 'context.jsonl')).find(e => e.type === 'user_prompt');
  if (ctx && ctx.data) push(ctx.timestamp, 'goal', '目标: ' + (ctx.data.text || '') + ' (' + (ctx.data.chars || 0) + ' 字)');
  for (const e of readJsonl(path.join(ev, 'ai.jsonl'))) if (e.type === 'turn') push(e.timestamp, 'turn', '回合 ' + ((e.data || {}).turn) + '  tools=' + ((e.data || {}).tools) + '  msgs=' + ((e.data || {}).convo_msgs));
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
  const SKIP = new Set(['taskchain_snapshot', 'numen_context', 'fact_snapshot', 'asset_snapshot', 'asset_retention']);
  for (const e of readJsonl(path.join(ev, 'rdd.jsonl'))) {
    if (SKIP.has(e.type)) continue;
    const d = e.data || {};
    push(e.timestamp, 'chain', e.type + '  ' + (d.message || d.description || d.status || JSON.stringify(d).slice(0, 80)));
  }
  let deaths = 0, deathsScanned = false;
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
          push(e.timestamp, 'death', ((e.data && (e.data.message || e.data.cause)) || e.type || 'death'));
        }
      }
    }
  }
  evs.sort((a, b) => a.s - b.s);
  const watch = env.watch || {};
  const winEnd = rel(T.gameExited || T.watchEnd), winStart = rel(T.launchStart);
  const summary = {
    run: env.runId || path.basename(runDir), label: env.label || '',
    master: ((env.master || {}).manifest || {}).sha256 ? String(env.master.manifest.sha256).slice(0, 8) : null,
    window_s: (winEnd != null && winStart != null) ? +(winEnd - winStart).toFixed(1) : null,
    stopReason: watch.stopReason || null,
    toolCalls: watch.toolCalls != null ? watch.toolCalls : calls, llmRequests: watch.llmRequests != null ? watch.llmRequests : null,
    evidence_calls: calls, evidence_ok: oks, evidence_fail: fails,
    deaths, deathsScanned, drift: env.world ? env.world.drift : null,
    goal: (ctx && ctx.data && ctx.data.text) || watch.description || null,
  };
  return { env, summary, evs, fmt };
}
function timeline(argv) {
  const rd = argv.filter(a => !a.startsWith('--'))[1];
  if (!rd) die(2, 'usage: bench.js timeline <runDir> [--limit N]');
  const limit = parseInt(arg(argv, '--limit') || '400', 10);
  const { summary, evs, fmt } = buildTimeline(path.resolve(rd));
  console.log('# 时序 · ' + summary.run + (summary.label ? ' (' + summary.label + ')' : ''));
  console.log('母版=' + (summary.master || '?') + '  窗口=' + (summary.window_s != null ? summary.window_s + 's' : '?') + '  停因=' + summary.stopReason + '  调用=' + summary.evidence_calls + '（OK ' + summary.evidence_ok + ' / FAIL ' + summary.evidence_fail + '）  回合=' + summary.llmRequests + '  死亡=' + summary.deaths + (summary.deathsScanned ? '' : '（未扫描：设 RDD_NUMEN_DIR=<numen 配置目录> 可并入死亡时点）') + '  drift=' + summary.drift);
  if (summary.goal) console.log('目标: ' + summary.goal);
  const shown = evs.slice(0, Math.max(0, limit));
  for (const e of shown) console.log(fmt(e.s).padStart(12) + '  [' + e.tag + '] ' + e.text);
  if (evs.length > shown.length) console.log('…（共 ' + evs.length + ' 条，已显示 ' + shown.length + '；--limit 调整）');
  console.log('共 ' + evs.length + ' 条事件');
}

/** 开工包：下一个 AI 一条命令拿到「要注意什么 + 前面结论 + 排队 + 母版 + 探针 +（可选）本轮 health 与时序摘要」（v0.1）。 */
function brief(argv) {
  const pos = argv.filter(a => !a.startsWith('--'));
  const runDirArg = pos[1] || null;
  const asJson = has(argv, '--json');
  const w = load();
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
  if (asJson) { console.log(JSON.stringify({ updated_at: w.updated_at, openTips, verdicts: w.verdicts, pending, masters: w.masters, requestedProbes: reqProbes, builtinProbeIds: builtin.map(p => p.id), recentRuns, run: runBlock }, null, 2)); return; }
  console.log('# 实验台 brief —— 下一个 AI 开工包（先读这份，再动手）');
  console.log('账本: ' + FILE + '  更新于 ' + w.updated_at);
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
  const out = { run: path.basename(runDir), healthy: problems.length === 0, problems, stopReason: (env.watch || {}).stopReason || null, drift: env.world ? env.world.drift : null, complete: { before: before.complete, after: after.complete }, postStopRequests: (env.stop || {}).postStopRequests };
  return out;
}
function health(runDir) {
  const out = computeHealth(runDir);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.problems.length ? 1 : 0);
}

function selfTest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const f = path.join(tmp, 'workbench.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, updated_at: '', probes: [], tips: [], signals: [], verdicts: [], queue: [], masters: [] }));
  const run = (args) => { const r = require('child_process').spawnSync(process.execPath, [__filename].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, { BENCH_FILE: f }) }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
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
  if (cmd === 'timeline') return timeline(argv);
  if (cmd === 'health') { const rd = argv[1]; if (!rd) die(2, 'usage: bench.js health <runDir>'); return health(path.resolve(rd)); }
  die(2, 'usage: bench.js catalog|tip|signal|verdict|queue|master|probe|brief|timeline|health|selftest');
}
main();
