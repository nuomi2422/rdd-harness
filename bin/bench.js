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

/** 健康哨：跑完/中断后先判「这轮材料能不能用」，坏实验早熔断。 */
function health(runDir) {
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
  console.log(JSON.stringify(out, null, 2));
  process.exit(problems.length ? 1 : 0);
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
  if (cmd === 'health') { const rd = argv[1]; if (!rd) die(2, 'usage: bench.js health <runDir>'); return health(path.resolve(rd)); }
  die(2, 'usage: bench.js catalog|tip|signal|verdict|queue|master|health|selftest');
}
main();
