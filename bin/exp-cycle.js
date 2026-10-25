#!/usr/bin/env node
'use strict';
/**
 * exp-cycle.js —— 无人值守学习轮回驱动（2026-10-25 夜）
 *
 * 做什么：连跑 N 轮「同一长线任务」，轮末自动出卡点简报，下一轮开局带上这份简报；
 * 轮内事件（死亡/里程碑/卡点）由 runner 从 monitor+背包自动落盘（不靠 AI 自述）。
 *
 * 用法：
 *   node exp-cycle.js run --prefix learn --rounds 4 --minutes 25 --goal "从零开始……"
 *   node exp-cycle.js analyze <runId>        # 只分析已有 run（不跑游戏）
 *
 * 输出：runs/<runId>/evidence/records.jsonl（钩子记录）、experiments/journal/<runId>.brief.md、
 *       experiments/journal/<prefix>-summary.md（四轮对比 + improved 判定）
 *
 * 安全围栏：轮数上限（默认 4）、每轮墙钟（默认 25 分钟）、失败也继续但记录、全流程只读判定。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HARNESS = path.resolve(__dirname, '..');
const RUNS = path.join(HARNESS, 'runs');
const JOURNAL = path.join(HARNESS, 'experiments', 'journal');
const RUNNER = path.join(__dirname, 'exp-runner.js');

const STAGE_RANK = { S1_wood: 1, S2_stone: 2, S3_iron: 3, S4_diamond: 4, S5_armor: 5 };
const STAGE_NAME = { 1: 'S1 木器', 2: 'S2 石器', 3: 'S3 铁器', 4: 'S4 钻石', 5: 'S5 钻石套' };

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\\uFEFF/, '')); } catch { return null; } }
function readLines(p) { try { return fs.readFileSync(p, 'utf8').split(/\\r?\\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }

function analyzeRun(runDir) {
  const env = readJson(path.join(runDir, 'envelope.json')) || {};
  const recs = readLines(path.join(runDir, 'evidence', 'records.jsonl'));
  const milestones = recs.filter((r) => r.kind === 'milestone');
  const deaths = recs.filter((r) => r.kind === 'death');
  const blockers = recs.filter((r) => r.kind === 'blocker');
  const snaps = recs.filter((r) => r.kind === 'snapshot');
  let maxStage = 0; const stageTimes = {};
  for (const m of milestones) {
    const rank = STAGE_RANK[m.data.stage] || 0;
    if (rank > maxStage) maxStage = rank;
    if (rank && !stageTimes[rank]) stageTimes[rank] = m.at;
  }
  const firstTs = snaps.length ? Date.parse(snaps[0].at) : null;
  const stageSeconds = {};
  for (const [rank, at] of Object.entries(stageTimes)) stageSeconds[rank] = firstTs ? Math.round((Date.parse(at) - firstTs) / 1000) : null;
  const items = snaps.length ? (snaps[snaps.length - 1].data.items || {}) : {};
  return {
    runId: path.basename(runDir), label: env.label, createdAt: env.createdAt,
    watchSeconds: (env.timings && env.timings.watchSeconds) || null,
    stopReason: env.watch && env.watch.stopReason, toolCalls: env.watch && env.watch.toolCalls,
    maxStage, stageName: STAGE_NAME[maxStage] || 'S0 空手', stageSeconds,
    deaths: deaths.length, blockers: blockers.map((b) => b.data), milestoneCount: milestones.length,
    experience: env.experience || null, finalItems: items,
  };
}

function briefOf(a) {
  const lines = [];
  lines.push('# 轮末简报 · ' + a.runId);
  lines.push('');
  lines.push('- 最远阶段：**' + a.stageName + '**（阶段耗时 ' + JSON.stringify(a.stageSeconds) + ' 秒）');
  lines.push('- 墙钟：' + a.watchSeconds + 's；决策/工具调用：' + a.toolCalls + '；停止原因：' + a.stopReason);
  lines.push('- 死亡：' + a.deaths + ' 次；卡点：' + (a.blockers.length ? a.blockers.map((b) => b.tool + ' 连续失败3次').join('；') : '无'));
  lines.push('- 经验：before=' + (a.experience ? String(a.experience.before).slice(0, 12) : '?') + ' after=' + (a.experience ? String(a.experience.after).slice(0, 12) : '?') + (a.experience && a.experience.before !== a.experience.after ? '（有新增）' : '（无变化）'));
  lines.push('- 里程碑：' + a.milestoneCount + ' 条（S1 木器→S5 钻石套）');
  return lines.join('\n') + '\n';
}

function cmdRun(args) {
  const opt = { prefix: 'learn', rounds: 4, minutes: 25, goal: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prefix') opt.prefix = args[++i];
    else if (args[i] === '--rounds') opt.rounds = parseInt(args[++i], 10);
    else if (args[i] === '--minutes') opt.minutes = parseInt(args[++i], 10);
    else if (args[i] === '--goal') opt.goal = args[++i];
    else if (args[i] === '--goal-file') opt.goal = fs.readFileSync(args[++i], 'utf8');
    else if (args[i] === '--zero-start') opt.zeroStart = true;
  }
  fs.mkdirSync(JOURNAL, { recursive: true });
  const rounds = [];
  let prevBrief = '';
  for (let i = 1; i <= opt.rounds; i++) {
    const label = opt.prefix + '-r' + i;
    const goalText = opt.goal + (prevBrief ? '\n\n【上一轮简报，先读再开工】\n' + prevBrief : '');
    const goalFile = path.join(JOURNAL, label + '.goal.txt');
    fs.writeFileSync(goalFile, goalText, 'utf8');
    console.log('=== round ' + i + '/' + opt.rounds + ' label=' + label + ' ===');
    const runDirGuess = () => {
      const ds = fs.readdirSync(RUNS).filter((d) => d.startsWith('exp-' + label.replace(/[^a-z0-9-]/gi, '') + '-') || d.startsWith('exp-' + label + '-')).sort();
      return ds.length ? path.join(RUNS, ds[ds.length - 1]) : null;
    };
    const before = new Set(fs.existsSync(RUNS) ? fs.readdirSync(RUNS) : []);
    const r = spawnSync(process.execPath, [RUNNER, 'run', '--label', label, '--minutes', String(opt.minutes), '--keep-experience', '--no-delta-stop', '--goal-file', goalFile, ...(opt.zeroStart ? ['--zero-start'] : [])], { encoding: 'utf8', timeout: (opt.minutes + 10) * 60000 });
    const after = fs.readdirSync(RUNS);
    const created = after.filter((d) => !before.has(d) && d.startsWith('exp-'));
    const runDir = created.length ? path.join(RUNS, created[created.length - 1]) : runDirGuess();
    if (!runDir) { console.error('round ' + i + ' 没有产生 run 目录，停止（stdout 尾部：' + String(r.stdout || '').slice(-300) + '）'); break; }
    const a = analyzeRun(runDir);
    const brief = briefOf(a);
    fs.writeFileSync(path.join(JOURNAL, a.runId + '.brief.md'), brief, 'utf8');
    fs.writeFileSync(path.join(JOURNAL, a.runId + '.json'), JSON.stringify(a, null, 2) + '\n', 'utf8');
    rounds.push(a);
    prevBrief = brief.replace(/^# 轮末简报 · [^\n]+\n\n/, '');
    console.log(brief);
  }
  // summary + improved 判定
  const base = rounds[0];
  const marks = rounds.map((r, idx) => {
    if (!base) return false;
    if (idx === 0) return false;
    const better = r.maxStage > base.maxStage;
    const faster = r.maxStage === base.maxStage && base.stageSeconds[r.maxStage] && r.stageSeconds[r.maxStage] && r.stageSeconds[r.maxStage] <= base.stageSeconds[r.maxStage] * 0.8;
    return { runId: r.runId, better, faster, advanced: better || faster };
  }).filter(Boolean);
  const improved = marks.filter((m) => m.advanced).length;
  const md = [];
  md.push('# 学习轮回汇总 · ' + opt.prefix);
  md.push('');
  md.push('| 轮 | 最远阶段 | 阶段耗时(s) | 死亡 | 卡点 | 墙钟(s) | 经验变化 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const r of rounds) md.push('| ' + r.runId + ' | ' + r.stageName + ' | ' + JSON.stringify(r.stageSeconds) + ' | ' + r.deaths + ' | ' + (r.blockers.length ? r.blockers.map((b) => b.tool).join(',') : '无') + ' | ' + r.watchSeconds + ' | ' + (r.experience && r.experience.before !== r.experience.after ? '有新增' : '无') + ' |');
  md.push('');
  md.push('**improved 判定**（第 1 轮为基线）：' + (improved ? '有 ' + improved + ' 轮更强（' + marks.filter((m) => m.advanced).map((m) => m.runId).join(',') + '）' : '没有轮次强于第 1 轮') + '。');
  md.push('');
  md.push('> 小样本 pilot：只能看方向，不能下「越玩越聪明」结论；判定基于最远阶段与同阶段耗时，不看聊天措辞。');
  fs.writeFileSync(path.join(JOURNAL, opt.prefix + '-summary.md'), md.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(JOURNAL, opt.prefix + '-summary.json'), JSON.stringify({ prefix: opt.prefix, rounds, marks, improved }, null, 2) + '\n', 'utf8');
  console.log('\n' + md.join('\n'));
}

const argv = process.argv.slice(2);
if (argv[0] === 'run') cmdRun(argv.slice(1));
else if (argv[0] === 'analyze' && argv[1]) {
  const d = path.isAbsolute(argv[1]) ? argv[1] : path.join(RUNS, argv[1]);
  const a = analyzeRun(d);
  console.log(JSON.stringify(a, null, 2));
  console.log('\n' + briefOf(a));
}
else { console.error('usage: exp-cycle.js run --prefix X --rounds 4 --minutes 25 --goal "..." [--zero-start] | analyze <runId>'); process.exit(2); }
