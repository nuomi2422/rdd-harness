#!/usr/bin/env node
'use strict';
/**
 * exp-runner.js —— 游戏内实验运行器（79号 W1 冒烟，2026-10-25 首版）
 *
 * 为什么存在：
 *   79号设计把「AI设计实验→冻结标准→真实游戏运行→机械裁决」定为可扩展协议。
 *   本脚本只做运行器该做的事：复制母版环境、起游戏、派一个正常目标、观测、停机、
 *   受控复位、归档证据。裁决由 exp-judge.js 机械完成（不调模型、不认口头结论）。
 *
 * 用法：
 *   node exp-runner.js plan   [--label a]            # 干跑：校验契约/实例状态，打印将做什么（不改盘）
 *   node exp-runner.js run    --label a [--goal "…"] # 真跑一轮（复制世界→起游戏→派活→观测→停→复位→归档）
 *   node exp-runner.js cleanup <runId>               # 按 verdict.json 清理世界副本（PASS删/FAIL留）
 *   node exp-runner.js status                        # 列出现有 run
 *
 * 硬约束（fail-fast，宁可拒）：
 *   - 起游戏前 java 必须为 0；MCP 8765 必须空闲；8080 由本脚本负责拉起
 *   - 先复制世界再起游戏；世界名 = exp-<label>-<HHmmss>，绝不写 live
 *   - 运行前后各录一次 config/numen 受控状态快照；停机后整树还原（受控复位）
 *   - 预算：观测墙钟 600s、停滞 180s、总时长 15min；超限即停并如实落 aborted 原因
 *   - 证据先行：每个阶段都写 events.log；停不下来就红警，不伪报完成
 *
 * 退出码：0 运行完成（裁决另判）/ 10 环境不成立或预算中止 / 2 用法错 / 3 基础设施错
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { readLevelInfo, patchLevel } = require('./lib/nbt');
const A0 = require('./lib/a0-evidence');
const AL = require('./lib/action-ledger');

const RDD = 'D:/rdd';
const RDD_ROOT = () => RDD;
const GAME = path.join(RDD, 'mc', 'The Best of Twilight Forest');
const SAVES = path.join(GAME, 'saves');
const NUMEN = path.join(GAME, 'config', 'numen');
const MONITOR = path.join(NUMEN, 'monitor');
const HARNESS = path.join(RDD, 'harness', 'rdd-harness');
const RUNS = path.join(HARNESS, 'runs');
const CONTRACT_PATH = path.join(HARNESS, 'experiments', 'smoke-r1.contract.json');
const MC_LAUNCH = path.join(RDD, 'tools', 'mc-launch.mjs');
const MCP_CALL = path.join(RDD, 'workspace', 'rdd-selfcompile', 'scripts', 'mcp-call.js');
const OC_DIR = path.join(RDD, 'workspace', 'mc-openclaw-controller', 'scripts');

const GIT = 'C:/Users/admin/AppData/Local/Programs/MinGit/cmd/git.exe';

// 受控复位的"存档外"状态（glob 展开后拷贝）
// 2026-10-27：把 'acx' 从复位清单里摘了 —— ACX 版本库是**学习产物**（学习者写、人批准），
// 复位它等于每轮把产物扔掉。实测：今晚批准的两个脚本（night_clear_then_sleep /
// night_collect_then_sleep）在下一轮跑完后从 library.json 消失，而投递箱里那两条已标 ADOPTED、
// 不会再被采纳 ⇒ 产物静默丢失。要清库请手动删 config/numen/acx，别靠复位。
const NUMEN_STATE_DIRS = [
  'rdd-tasks', 'rdd-ledger', 'rdd-facts', 'rdd-assets', 'rdd-history',
  'rdd-semantics', 'rdd-side', 'companions', 'worldstate',
];
// 2026-10-27：加了 learner-enqueued.jsonl —— 它是「这些事件已经入过队」的落盘去重日志。
// 原来只还原 experience/learner-memos，不还原它 ⇒ 本轮入队的 memo 被还原冲掉，
// 而去重日志仍记着「入过队」⇒ 同一批事件以后永远不再入队（样本静默丢失）。
// 实测：夜间两轮 4 次死亡，跑完 memo 队列 0 条，就是这个原因。
const NUMEN_STATE_GLOBS = [/^experience-.*\.jsonl$/, /^learner-memos-.*\.json$/, /^learner-enqueued\.jsonl$/];

function nowIso() { return new Date().toISOString(); }
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(f) { return sha256(fs.readFileSync(f)); }
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d); else fs.copyFileSync(s, d);
  }
}
function expHash() {
  try {
    const files = learnFiles().sort();
    return sha256(files.map((f) => f + ':' + sha256File(path.join(NUMEN, f))).join('\n'));
  } catch { return null; }
}
/** 学习产物文件清单（experience-*.jsonl / learner-memos-*.json）；归档与哈希共用同一份口径。 */
function learnFiles() {
  try {
    return fs.readdirSync(NUMEN).filter((f) => /^experience-.*\.jsonl$|^learner-memos-.*\.json$/.test(f));
  } catch { return []; }
}
function manifestOf(dir) {
  const items = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else items.push(path.relative(dir, abs).replace(/\\/g, '/') + ':' + sha256File(abs));
    }
  };
  walk(dir);
  items.sort();
  return { count: items.length, sha256: sha256(items.join('\n')) };
}
function ps(cmd, timeoutMs) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: timeoutMs || 30000 });
  return (r.stdout || '').trim();
}
function javaProcs() {
  const out = ps("Get-CimInstance Win32_Process -Filter \"Name='java.exe' OR Name='javaw.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -like '*" + GAME.replace(/'/g, "''") + "*' } | ForEach-Object { $_.ProcessId }");
  return out.split(/\s+/).filter(Boolean);
}
function portOpen(port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.setTimeout(timeoutMs || 800);
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function mcp(tool, companion, args, timeoutMs) {
  const argv = [MCP_CALL, tool];
  // 空串要保留：create_companion 这类"没有 companion 参数"的工具，必须占住第 2 个位置，
  // 否则 args 会被当成 companion 读走（mcp-call.js 是按位置取参的）。
  if (companion !== undefined && companion !== null) argv.push(companion);
  if (args) argv.push(args);
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: timeoutMs || 25000 });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/**
 * 世界侧控制变量快照（world_probe action=snapshot）。
 * 原始回执落 evidence/world-<tag>.json，摘要进 envelope；失败不伪造默认值。
 */
function worldSnapshot(runDir, companion, tag) {
  const r = mcp('world_probe', companion, '{"action":"snapshot"}', 45000);
  const raw = r.out || r.err || '';
  fs.writeFileSync(path.join(runDir, 'evidence', 'world-' + tag + '.json'), raw);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* raw 已落盘，下面按失败记 */ }
  const data = parsed && parsed.data ? parsed.data : null;
  return {
    ok: !!(r.ok && parsed && parsed.success !== false && data),
    data,
    raw,
    sha256: sha256(raw),
    // A0：view_id 需要「哪一轮 / 哪个相位 / 何时」
    runId: path.basename(runDir),
    phase: tag,
    finishedAt: new Date().toISOString(),
  };
}

function worldSummary(s) {
  const d = (s && s.data) || {};
  // A0（90 号 §2 第 3 条）：把 world-view 的三元字段（view_id / control_key / captured_at）
  // 挂到 envelope 上，供 bench timeline 与后续复盘按 id 关联。
  // view_id 的构造与 bin/world-view.js:74 同形（runId + phase + 采集时刻），不另造编号体系；
  // captured_at 优先用探针自己的 at，没有就用落盘时刻并标 inferred。
  const at = d.at || d.captured_at || null;
  const capturedAt = at || (s && s.finishedAt) || null;
  const viewId = (s && s.runId && s.phase && capturedAt)
    ? s.runId + '-' + s.phase + '-' + String(capturedAt).replace(/[:.]/g, '-')
    : null;
  return {
    ok: !!(s && s.ok),
    complete: d.complete === true,
    control_key: d.control_key || null,
    stable_key: d.stable_key || null,
    sha256: (s && s.sha256) || null,
    errors: Array.isArray(d.errors) ? d.errors : [],
    view_id: viewId,
    captured_at: capturedAt,
    captured_at_inferred: !at,
    coverage: d.complete === true ? 'COMPLETE' : 'PARTIAL',
  };
}
function parseCompanions(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = line.match(/^-\s+(.+?)\s+\(id:\s*([0-9a-fA-F-]+)\)/);
    if (m) out.push({ name: m[1].trim(), id: m[2] });
  }
  return out;
}

/**
 * 同伴的模型绑定在 config/numen/companions/<uuid>/binding.json。
 * 2026-10-30 实测：MCP `create_companion` 现召的同伴**没有**这个文件 ⇒ 内脑拿不到 provider
 * ⇒ 一次 LLM 请求都不发（exp-zero-r1 的 llmRequests=0）。CompanionHome.binding() 每次现读文件，
 * 所以运行中补写立即生效，不需要重启。
 */
function ensureProviderBinding(companion, providerId) {
  if (!companion || !companion.id) return { ok: false, reason: 'no companion id' };
  if (!providerId) return { ok: false, reason: 'no provider id' };
  const dir = path.join(NUMEN, 'companions', companion.id);
  const file = path.join(dir, 'binding.json');
  if (fs.existsSync(file)) {
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cur && cur.provider) return { ok: true, provider: cur.provider, existed: true, file };
    } catch { /* 坏文件按没有处理，下面重写 */ }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ provider: providerId }));
  return { ok: true, provider: providerId, existed: false, file };
}

/** 从已有同伴里取 provider（多数票）；全空就返回 ''（不许瞎编一个 id）。 */
function defaultProvider() {
  const base = path.join(NUMEN, 'companions');
  if (!fs.existsSync(base)) return '';
  const counts = {};
  for (const d of fs.readdirSync(base)) {
    const f = path.join(base, d, 'binding.json');
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && j.provider) counts[j.provider] = (counts[j.provider] || 0) + 1;
    } catch { /* 单个坏文件不影响多数票 */ }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : '';
}
function oakLogCount(raw) {
  if (!raw) return null;
  try {
    const j = JSON.parse(String(raw));
    const items = j && j.data && j.data.items;
    if (items && typeof items === 'object') {
      return Number(items['minecraft:oak_log'] || 0);
    }
  } catch { /* fall through to text scan */ }
  for (const p of [/"minecraft:oak_log"\s*:\s*(\d+)/, /"oak_log"\s*:\s*(\d+)/, /oak_log[^0-9]{0,80}?(\d+)/]) {
    const m = String(raw).match(p); if (m) return parseInt(m[1], 10);
  }
  return null;
}
function log(runDir, phase, msg) {
  const line = nowIso() + ' [' + phase + '] ' + msg + '\n';
  fs.appendFileSync(path.join(runDir, 'events.log'), line);
  console.log(line.trim());
}
let CTX = null; // {runDir, env, worldPath, baseDir} —— 供失败时紧急清场
function emergencyCleanup(reason) {
  if (!CTX) return;
  const { runDir, worldPath, baseDir } = CTX;
  try {
    const pids = javaProcs();
    if (pids.length) ps('Get-CimInstance Win32_Process -Filter "Name=\'java.exe\' OR Name=\'javaw.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine -like \'*' + GAME.replace(/'/g, "''") + '*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }', 30000);
    for (let i = 0; i < 30 && javaProcs().length; i++) { spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500']); }
    // 受控复位
    if (baseDir && fs.existsSync(baseDir)) {
      for (const d of NUMEN_STATE_DIRS) {
        const target = path.join(NUMEN, d), backup = path.join(baseDir, d);
        fs.rmSync(target, { recursive: true, force: true });
        if (fs.existsSync(backup)) copyTree(backup, target);
      }
      const baseFiles = fs.readdirSync(baseDir).filter((f) => NUMEN_STATE_GLOBS.some((re) => re.test(f)));
      for (const f of baseFiles) fs.copyFileSync(path.join(baseDir, f), path.join(NUMEN, f));
      for (const e of fs.readdirSync(NUMEN)) if (NUMEN_STATE_GLOBS.some((re) => re.test(e)) && !baseFiles.includes(e)) fs.rmSync(path.join(NUMEN, e), { force: true });
    }
    if (worldPath && fs.existsSync(worldPath) && path.resolve(worldPath).startsWith(path.resolve(SAVES) + path.sep) && path.basename(worldPath).startsWith('exp-')) {
      fs.rmSync(worldPath, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(runDir, 'cleanup.json'), JSON.stringify({ at: nowIso(), kept: false, reason: 'aborted: ' + reason }, null, 2));
    log(runDir, 'cleanup', '紧急清场完成（开机状态已复原、世界副本已删）');
  } catch (e) {
    try { log(runDir, 'cleanup', '紧急清场失败: ' + e.message); } catch {}
  }
}
function fail(runDir, phase, msg, code) {
  if (runDir) log(runDir, phase, 'FATAL ' + msg);
  emergencyCleanup(phase + ': ' + msg);
  console.error('FATAL[' + phase + '] ' + msg);
  process.exit(code || 10);
}

async function cmdPlan(opts) {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const contractHash = sha256File(CONTRACT_PATH);
  const java = javaProcs();
  console.log('=== exp-runner plan (干跑，不改盘) ===');
  console.log('contract      : ' + CONTRACT_PATH);
  console.log('contractHash  : ' + contractHash);
  console.log('scenario      : ' + contract.scenarioId + ' / ' + contract.contractRevision);
  console.log('master        : ' + contract.masterWorld.path + ' (exists=' + fs.existsSync(contract.masterWorld.path) + ')');
  console.log('java procs    : ' + (java.length ? java.join(',') : '0 (可起)'));
  console.log('8080 open     : ' + (await portOpen(8080)));
  console.log('8765 open     : ' + (await portOpen(8765)));
  console.log('8766 open     : ' + (await portOpen(8776)) + ' (monitor station, 可选)');
  console.log('steps         : prepare(复制世界+存档外快照) → launch → stimulus(enqueue: “' + contract.stimulus.text + '”) → watch(≤' + contract.budget.stimulusWatchSeconds + 's) → stop → restore → archive');
  console.log('预算           : 观测≤' + contract.budget.stimulusWatchSeconds + 's, 停滞≤' + contract.budget.stallSeconds + 's');
  process.exit(java.length === 0 ? 0 : 10);
}

async function cmdRun(opts) {
  const label = opts.label || 'smoke';
  if (opts.mode && !RUN_MODES.includes(opts.mode)) {
    console.error('--mode 只能是 ' + RUN_MODES.join(' | ') + '（收到 ' + opts.mode + '）');
    process.exit(2);
  }
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const contractHash = sha256File(CONTRACT_PATH);
  // --master 允许换母版（干净模板 saves/exp-clean：无基地无箱子）。默认仍用契约里的 saves/live。
  const masterPath = opts.master ? path.resolve(opts.master) : contract.masterWorld.path;
  const runId = 'exp-' + label + '-' + stamp();
  const runDir = path.join(RUNS, runId);
  fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
  const env = {
    runId, label, createdAt: nowIso(), contract: { path: CONTRACT_PATH, sha256: contractHash, revision: contract.contractRevision, scenarioId: contract.scenarioId },
    gameDir: GAME, phase: 'preflight', timings: {}, world: {},
    // 151 §3：这次 run 是主线/诊断/回归，必须显式声明；没声明就记 unspecified（曲线默认不收它）。
    mode: { kind: opts.mode || 'unspecified', source: opts.mode ? 'flag' : 'default' },
    // 151 §3：持续学习 vs 冷启动也要声明；恢复策略决定「本轮学到的能不能带到下一轮」。
    learning: { mode: opts.keepExperience ? 'continuous' : 'cold-start', declaredAt: nowIso() },
    // A7（99 号）：实验条件必须可读——compare 用 goal+master 判「同条件」；goal 在 stimulus 段填。
    goal: null,
  };
  const saveEnv = () => fs.writeFileSync(path.join(runDir, 'envelope.json'), JSON.stringify(env, null, 2));
  saveEnv();
  log(runDir, 'init', 'runId=' + runId + ' label=' + label);

  // ---------- preflight ----------
  const java0 = javaProcs();
  if (java0.length) fail(runDir, 'preflight', 'java already running: ' + java0.join(',') + ' — 实例被占用，拒绝抢跑', 10);
  if (await portOpen(8765)) fail(runDir, 'preflight', 'MCP 8765 already listening — 有实例在跑？', 10);
  if (!fs.existsSync(masterPath)) fail(runDir, 'preflight', '母版存档不存在: ' + masterPath, 10);
  if (!fs.existsSync(MC_LAUNCH)) fail(runDir, 'preflight', '启动器不存在: ' + MC_LAUNCH, 3);
  if (!(await portOpen(8080))) {
    log(runDir, 'preflight', 'OpenClaw 8080 未监听 → 拉起 server.js');
    const ocLog = fs.openSync(path.join(runDir, 'evidence', 'oc-server.log'), 'a');
    spawn(process.execPath, ['server.js'], { cwd: OC_DIR, detached: true, stdio: ['ignore', ocLog, ocLog] }).unref();
    for (let i = 0; i < 40 && !(await portOpen(8080)); i++) await sleep(250);
    if (!(await portOpen(8080))) fail(runDir, 'preflight', 'OpenClaw 8080 起不来（见 evidence/oc-server.log）', 3);
  }
  log(runDir, 'preflight', '实例空闲，母版存在，OpenClaw 就绪');

  // 磁盘余量：每个 run 约 130MB（env-baseline 77MB + evidence 55MB）。
  // 2026-10-29 实测 ENOSPC 会让「世界加载超慢 / 同伴不进场」看起来像别的问题，必须提前挡。
  try {
    const st = fs.statfsSync ? fs.statfsSync(GAME) : null;
    if (st) {
      const freeGB = (st.bavail * st.bsize) / 1024 / 1024 / 1024;
      if (freeGB < 2) {
        fail(runDir, 'preflight', '磁盘余量不足 ' + freeGB.toFixed(2) + 'GB（<2GB）——先清旧 run 的 env-baseline', 4);
      }
      log(runDir, 'preflight', '磁盘余量 ' + freeGB.toFixed(1) + 'GB');
    }
  } catch (e) {
    log(runDir, 'preflight', '磁盘余量检查跳过：' + String(e.message).slice(0, 60));
  }

  // ---------- prepare ----------
  env.phase = 'prepare';
  const world = 'exp-' + label + '-' + stamp().slice(9);
  const worldPath = path.join(SAVES, world);
  if (fs.existsSync(worldPath)) fail(runDir, 'prepare', '世界副本已存在，拒绝覆盖: ' + worldPath, 10);
  const masterManifest = manifestOf(masterPath);
  log(runDir, 'prepare', '母版清单 files=' + masterManifest.count + ' sha256=' + masterManifest.sha256.slice(0, 16) + '… → 复制到 ' + world);
  copyTree(masterPath, worldPath);
  const copyManifest = manifestOf(worldPath);
  if (copyManifest.sha256 !== masterManifest.sha256) fail(runDir, 'prepare', '世界副本与母版不一致（复制损坏）', 3);
  log(runDir, 'prepare', '世界副本校验通过 files=' + copyManifest.count);

  // zero-start 的难度/keepInventory 直接写进副本 level.dat，不走聊天命令。
  // 理由（2026-10-25 两次短测）：/save-all 的 RETURN 会丢（latest.log 留下 "save-all flush<--[此处]" 这种
  // 没提交的输入），于是「命令没生效」和「没落盘」长得一模一样。NBT 是顺序结构、无绝对偏移，改副本文件是确定性的。
  if (opts.zeroStart) {
    const p = patchLevel(path.join(worldPath, 'level.dat'), { difficulty: 1, keepInventory: 'true' });
    fs.writeFileSync(path.join(runDir, 'evidence', 'level-after-zero.json'), JSON.stringify(p, null, 2));
    if (p.error) fail(runDir, 'prepare', 'zero-start 改 level.dat 失败: ' + p.error, 3);
    log(runDir, 'prepare', 'zero-start：副本 level.dat → ' + JSON.stringify(p.changed.length ? p.changed : p.note));

    // A0：会话历史也是实验材料（88 §1.2）。清会话必须发生在 launch 之前，
    // 否则 ConvoLog 已经把旧历史加载进首个请求。--keep-session 只用于复现 DIRTY 反例。
    if (!opts.keepSession) {
      const boundary = A0.appendClearBoundary(path.join(NUMEN, 'companions'), { reason: 'zero-start' });
      fs.writeFileSync(path.join(runDir, 'evidence', 'session-clear.json'), JSON.stringify(boundary, null, 2));
      env.sessionClear = boundary;
      log(runDir, 'prepare', 'A0 会话边界：' + (boundary.injected
        ? '追加 clear ×' + boundary.injected + '（' + boundary.files.map((f) => f.uuid).join(',') + '）'
        : '未注入（' + (boundary.skipped.join(',') || boundary.reason) + '）'));
    } else {
      env.sessionClear = { skipped: true, reason: '--keep-session（复现 DIRTY 反例用）' };
      log(runDir, 'prepare', 'A0 会话边界：--keep-session → 保留历史（本轮预期判 DIRTY）');
    }
  }

  // 存档外状态快照（受控复位基线）
  env.experience = { before: expHash() };
  const baseDir = path.join(runDir, 'env-baseline');
  fs.mkdirSync(baseDir, { recursive: true });
  const baselineManifests = {};
  for (const d of NUMEN_STATE_DIRS) {
    const src = path.join(NUMEN, d);
    if (fs.existsSync(src)) {
      copyTree(src, path.join(baseDir, d));
      baselineManifests[d] = manifestOf(src);
    }
  }
  const baseFiles = [];
  for (const e of fs.readdirSync(NUMEN)) {
    if (NUMEN_STATE_GLOBS.some((re) => re.test(e))) baseFiles.push(e);
  }
  for (const f of baseFiles) fs.copyFileSync(path.join(NUMEN, f), path.join(baseDir, f));
  const baselineManifest = manifestOf(baseDir);
  log(runDir, 'prepare', '存档外状态快照 files=' + baselineManifest.sha256.slice(0, 16) + '…（' + (baseFiles.length + NUMEN_STATE_DIRS.length) + ' 项）');

  // mods jar 身份
  const modsDir = path.join(GAME, 'mods');
  const jars = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar')).map((f) => ({ file: f, sha256: sha256File(path.join(modsDir, f)) }));
  env.master = { source: masterPath, world, worldPath, manifest: masterManifest, baselineManifest };
  CTX = { runDir, env, worldPath, baseDir };
  env.jarsAtPrepare = jars;
  env.saveEnvAt = nowIso();
  saveEnv();
  fs.writeFileSync(path.join(runDir, 'evidence', 'jars.json'), JSON.stringify(jars, null, 2));

  // ---------- launch ----------
  env.phase = 'launch';
  env.timings.launchStart = nowIso();
  const logPath = path.join(GAME, 'logs', 'latest.log');
  const logStart = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const launchLog = fs.openSync(path.join(runDir, 'evidence', 'launcher.log'), 'a');
  spawn(process.execPath, [MC_LAUNCH, '--instance', GAME, '--level', world, '--mem', '4G'],
    { cwd: RDD, detached: true, stdio: ['ignore', launchLog, launchLog] }).unref();
  log(runDir, 'launch', '游戏已脱离启动（world=' + world + '），等待 MCP 8765…');
  // 实验台常驻视图：实验期间 bench 也要看得到现场（幂等；起不来不影响实验）
  try {
    const bl = spawnSync(process.execPath, [path.join(HARNESS, 'bin', 'bench.js'), 'live', 'start'], { cwd: HARNESS, stdio: 'ignore', timeout: 30000 });
    log(runDir, 'launch', 'bench live start → ' + (bl.status === 0 ? 'ok' : 'exit ' + bl.status));
  } catch (e) { log(runDir, 'launch', 'bench live start 失败（忽略）：' + (e && e.message)); }

  let companionsRaw = null;
  for (let i = 0; i < 120; i++) { // ≤ 300s
    if (javaProcs().length === 0 && i > 8) fail(runDir, 'launch', 'java 进程没起来（启动器日志见 evidence/launcher.log）', 3);
    if (await portOpen(8765)) {
      const r = mcp('list_companions', null, null, 20000);
      if (r.ok) { companionsRaw = r.out; break; }
    }
    await sleep(2500);
  }
  if (!companionsRaw) fail(runDir, 'launch', '300s 内 MCP 未就绪', 3);
  log(runDir, 'launch', 'MCP 就绪，等待世界加载/同伴进场…');
  let companions = parseCompanions(companionsRaw);
  for (let i = 0; i < 72 && companions.length === 0; i++) { // 世界加载 ~2-3 分钟
    // 全新存档里**永远**不会有同伴：等满 6 分钟纯属浪费。60s 还没有就直接去召。
    if (opts.createCompanion && i >= 12) break;
    await sleep(5000);
    const r = mcp('list_companions', null, null, 20000);
    if (r.ok) { companionsRaw = r.out; companions = parseCompanions(r.out); }
  }
  // 全新存档里没有任何同伴 —— 允许当场召一个（用户 2026-10-30：从零开始，新存档当母版）
  if (companions.length === 0 && opts.createCompanion) {
    log(runDir, 'launch', '无同伴 → create_companion name=' + opts.createCompanion);
    const cr = mcp('create_companion', '', JSON.stringify({ name: opts.createCompanion }), 60000);
    log(runDir, 'launch', 'create_companion → ' + (cr.ok ? String(cr.out).slice(0, 160) : 'FAILED ' + String(cr.err || cr.out).slice(0, 160)));
    for (let i = 0; i < 24 && companions.length === 0; i++) {
      await sleep(5000);
      const rr = mcp('list_companions', null, null, 20000);
      if (rr.ok) { companionsRaw = rr.out; companions = parseCompanions(rr.out); }
    }
    env.companionCreated = {
      name: opts.createCompanion,
      ok: companions.length > 0,
      at: nowIso(),
      reply: String(cr.out || cr.err || '').slice(0, 200),
    };
    log(runDir, 'launch', '新同伴就位: ' + (companions.map((c) => c.name).join(',') || '（仍无）'));
  }
  if (companions.length === 0) fail(runDir, 'launch', '世界加载后仍无同伴（list_companions: ' + String(companionsRaw).slice(0, 120) + '）', 10);
  env.timings.mcpReady = nowIso();
  log(runDir, 'launch', 'MCP 就绪');

  // 启动日志段（S1 证据）：从启动前 offset 到当前
  const logNow = fs.statSync(logPath).size;
  const from = logNow < logStart ? 0 : logStart; // 新会话会截断 latest.log：变小=从 0 读
  const logBuf = fs.readFileSync(logPath).slice(from);
  fs.writeFileSync(path.join(runDir, 'evidence', 'boot.log'), logBuf);
  const bootText = logBuf.toString('latin1');
  const foundMods = (bootText.match(/Found mod file "[^"]+"/g) || []);
  env.boot = { bytes: logBuf.length, foundMods: foundMods.slice(0, 40) };
  env.jarsAtLaunch = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar')).map((f) => ({ file: f, sha256: sha256File(path.join(modsDir, f)) }));
  fs.writeFileSync(path.join(runDir, 'evidence', 'companions-raw.txt'), String(companionsRaw));
  saveEnv();

  // ---------- stimulus ----------
  env.phase = 'stimulus';
  // ★ 2026-10-29（A0）：原来无条件取 companions[0] —— 自从 P16 造了观察者同伴 OBS，
  //   她的名字排在 RDD 前面，于是每一轮实验都在驱 OBS 而不是主体（实测 run-a0-clean 命中 OBS）。
  //   现在允许 --companion 指定；指定的名字不在场就**直接失败**，不许静默换成别人。
  let companionName;
  if (opts.companion) {
    const hit = companions.find((c) => c.name === opts.companion);
    if (!hit) fail(runDir, 'stimulus', '指定的同伴不在场: ' + opts.companion + '（在场: ' + companions.map((c) => c.name).join(',') + '）', 10);
    companionName = hit.name;
    log(runDir, 'stimulus', '同伴已显式指定 = ' + companionName);
  } else {
    companionName = companions[0].name;
    log(runDir, 'stimulus', '未指定 --companion，按 list_companions 顺序取第一个 = ' + companionName
      + '（在场: ' + companions.map((c) => c.name).join(',') + '）');
  }
  fs.writeFileSync(path.join(runDir, 'evidence', 'companions-raw.txt'), String(companionsRaw));
  env.companion = companionName;
  // 模型绑定：新召的同伴没有 binding.json 就没有 provider，内脑会一声不响地不动
  {
    const providerId = opts.companionProvider || defaultProvider();
    const sel = companions.find((c) => c.name === companionName);
    const bind = ensureProviderBinding(sel, providerId);
    env.companionBinding = Object.assign({ companionId: sel ? sel.id : null }, bind);
    if (bind.ok) {
      log(runDir, 'stimulus', '模型绑定：' + companionName + ' → ' + bind.provider + (bind.existed ? '（原有）' : '（本轮补写）'));
    } else {
      log(runDir, 'stimulus', '⚠ 没有可用的 provider 绑定（' + bind.reason + '）—— 内脑不会发 LLM 请求');
    }
  }

  // H1（103 号）：起跑前虚空体检 —— 同伴若在末地虚空/虚空层，这一轮测到的是
  // 环境逼出来的 tp/setblock 自救，不是能力。命中即拒绝，除非显式 --allow-void。
  if (opts.allowVoid) {
    log(runDir, 'preflight', '虚空体检被 --allow-void 跳过');
  } else {
    const st = mcp('get_self_status', companionName, undefined, 30000);
    const g = require('./lib/guard').voidProblem(st.ok ? st.out : '');
    if (g) {
      log(runDir, 'preflight', '虚空体检命中：' + g.kind + ' ' + g.dim + ' (' + g.x + ',' + g.y + ',' + g.z + ')');
      fail(runDir, 'preflight', g.message, 5);
    }
    log(runDir, 'preflight', '虚空体检通过（未命中）');

    // H1.1（104 号）：位置正常不代表不会死进虚空——上一轮的事故是「人站在 y=64，
    // 但重生点绑在末地虚空」。再查一次重生点（床锚）维度+坐标。
    const rs = mcp('rdd_respawn_info', companionName, undefined, 30000);
    const rp = rs.ok ? require('./lib/guard').respawnProblemFromText(rs.out) : null;
    if (rp) {
      log(runDir, 'preflight', '重生点体检命中：' + rp.kind + ' ' + rp.dim + ' (' + rp.x + ',' + rp.y + ',' + rp.z + ')');
      fail(runDir, 'preflight', rp.message, 6);
    }
    log(runDir, 'preflight', '重生点体检通过（未命中）');

    // H7（118 号）：母版世界体检 —— 末地若有多只末影龙（或龙卡在原点），这一轮测到的
    // 不是 AI 能力，是素材污染（exp-loop-r8：8 只龙卡 (0,0,0)，白跑 8 分钟）。
    // 复用已有 rdd_nearby_entities，不新增观测通道。
    if (opts.allowDirtyWorld) {
      log(runDir, 'preflight', '世界体检被 --allow-dirty-world 跳过');
    } else {
      const ents = mcp('rdd_nearby_entities', companionName,
        JSON.stringify({ radius: 128, count_only: true }), 30000);
      const ws = ents.ok ? require('./lib/guard').worldSanity(ents.out) : null;
      if (ws) {
        log(runDir, 'preflight', '世界体检命中：末影龙 ' + ws.count + ' 只 atOrigin=' + ws.atOrigin);
        // 2026-10-30：先降级为**警告**。原因：8 条 ender_dragon 里可能混着末影龙的 7 个部位
        // （EnderDragonPart 也是 Entity、type 同样报 ender_dragon），那样这条会挡住所有正常的末地轮次。
        // 先用一次专门验证定性，再决定要不要恢复成 fail。
        log(runDir, 'preflight', '世界体检警告（不拦）：' + ws.message);
      }
      log(runDir, 'preflight', '世界体检通过（未命中）');
    }
  }
  const goalText = opts.goalFile ? fs.readFileSync(opts.goalFile, 'utf8').trim() : (opts.goal || contract.stimulus.text);
  env.goal = goalText;              // A7：写进信封，compare 才能判「同条件」
  env.master = env.master || null;
  saveEnv();
  const stim = path.join(runDir, 'stimulus.json');
  fs.writeFileSync(stim, JSON.stringify({ text: goalText }, null, 2));
  let triggerDeathAt = null;

  if (opts.zeroStart) {
    // 难度/keepInventory 已在 prepare 写进副本 level.dat，这里只清背包。
    // /clear 的目标是「同伴」本身：它是服务端玩家实体，名字就是 list_companions 的 name。
    // 2026-10-25 短测：清 RDDDev（客户端玩家、我们打字用的那个）时同伴背包分毫未动；
    // 改清 RDD 后 latest.log 实测「已移除玩家RDD的192个物品」，背包归零。
    const SEND = path.join(HARNESS, 'bin', 'send-mc-command.ps1');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SEND, '-Text', '/clear ' + companionName], { encoding: 'utf8', timeout: 40000 });
    log(runDir, 'zero-start', '/clear ' + companionName + ' exit=' + r.status);
    await sleep(1500);
    const da = spawnSync(process.execPath, [path.join(RDD_ROOT(), 'workspace', 'rdd-selfcompile', 'scripts', 'drop-all.js'), companionName], { encoding: 'utf8', timeout: 90000 });
    log(runDir, 'zero-start', 'drop-all exit=' + da.status + (da.stderr ? ' ' + String(da.stderr).slice(0, 120) : ''));
    await sleep(1500);
    // --night：质量触发环境。强制深夜刷怪，让「death」事件进 instrumentation（学习系统的食源）。
    // 干净母版无床无掩体，她无法睡觉跳过；easy 下 mob 可战可不战，死亡是可控风险而非必死。
    if (opts.night) {
      const nt = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SEND, '-Text', '/time set midnight'], { encoding: 'utf8', timeout: 40000 });
      log(runDir, 'zero-start', '/time set midnight exit=' + nt.status);
      await sleep(800);
    }
  }

  // --trigger-death：管线冒烟专用。刺激后延迟 N 秒 kill 同伴一次，确定性地产生一条 death 事件，
  // 用来验「death → instrumentation → auto_intake → 复盘 → 经验」整条链在真实数据上是不是通的。
  // 2026-10-29（A1 实测）：原来写死只在 `--zero-start` 分支里 —— 于是不加 zero-start 时
  // `--trigger-death` 被**静默忽略**（a1-drops 轮 deaths=NONE，白跑 8 分钟）。触发死亡是测试工具，
  // 不该依赖清档。注意：zero-start 会强制 keepInventory=true ⇒ 掉落清单为空 ⇒ 重算不会触发；
  // 要验「掉落 + 重算」就必须**不加** zero-start（用母版原值 keepInventory=false）。
  if (opts.triggerDeath) {
    const delayMs = (opts.triggerDeathDelaySeconds || 90) * 1000;
    triggerDeathAt = Date.now() + delayMs;
    log(runDir, 'trigger-death', '已排程（' + (delayMs / 1000) + 's 后 kill ' + companionName + '）');
  }

  // 世界侧控制变量：必须在 zero-start 改完难度/时间之后、派目标之前拍。
  // 这张快照是两轮实验可比性的证据；失败也落 raw，不拿假值补。
  const worldBefore = worldSnapshot(runDir, companionName, 'before');
  env.world.before = worldSummary(worldBefore);
  log(runDir, 'world', 'before complete=' + env.world.before.complete
      + ' control_key=' + String(env.world.before.control_key).slice(0, 180));
  saveEnv();

  const invBefore = mcp('rdd_get_inventory', companionName, null, 25000);
  fs.writeFileSync(path.join(runDir, 'evidence', 'inventory-before.json'), invBefore.out || invBefore.err);
  const before = oakLogCount(invBefore.out);
  env.inventory = { beforeRaw: invBefore.out.slice(0, 4000), oakLogBefore: before };
  log(runDir, 'stimulus', 'companion=' + companionName + ' oak_log(before)=' + before);

  const offsets = {};
  // A0（90 号）：expmem.jsonl 里才有 expanded/auto_expanded/request_delivered，
  // 不归档它就无法区分「渲染过」和「最终请求里真的有」。
  // A1（93 号）：instrumentation.jsonl 里才有 death / starvation_death —— 88 §7.5 说
  // 「monitor 没有 death 事件」是只看了 rdd.jsonl；不拉这个文件，死亡就永远只能靠人记。
  for (const f of ['tools.jsonl', 'context.jsonl', 'events.jsonl', 'ai.jsonl', 'rdd.jsonl', 'expmem.jsonl', 'instrumentation.jsonl']) {
    const p = path.join(MONITOR, f);
    offsets[f] = fs.existsSync(p) ? fs.statSync(p).size : 0;
    fs.writeFileSync(path.join(runDir, 'evidence', f), '');
  }
  const watchSec = opts.minutes ? opts.minutes * 60 : contract.budget.stimulusWatchSeconds;
  const stallSec = opts.minutes ? Math.max(300, Math.min(900, Math.floor(watchSec / 3))) : contract.budget.stallSeconds;
  const t0 = Date.now();
  env.timings.stimulusSentAt = nowIso();
  const enq = mcp('enqueue', companionName, '@' + stim, 25000);
  fs.writeFileSync(path.join(runDir, 'evidence', 'enqueue.json'), JSON.stringify(enq, null, 2));
  if (!enq.ok) fail(runDir, 'stimulus', 'enqueue 失败: ' + (enq.err || enq.out).slice(0, 300), 10);
  log(runDir, 'stimulus', '目标已入队（"' + goalText + '"）');
  saveEnv();

  // ---------- watch ----------
  env.phase = 'watch';
  let lastToolCallAt = Date.now();
  let toolCalls = 0, llmRequests = 0;
  let chain = null;
  let after = before;
  let invAfterRaw = '';
  const stopReason = { value: null };
  let nextInventoryAt = Date.now();
  // 阶段里程碑只认「craft 出来的东西」（2026-10-26 改）：
  // 旧版按背包出现即记里程碑，结果第 2 轮从箱子里取出 4 件钻石甲也算 S5 —— 测的是「记不记得箱子在哪」，
  // 不是「会不会变强」。craft 结果文本里有 "crafted 1x stone_pickaxe"，是机器可复核的产出证明。
  const CRAFT_STAGES = {
    crafting_table: 'S1_wood', wooden_pickaxe: 'S1_wood',
    stone_pickaxe: 'S2_stone',
    iron_pickaxe: 'S3_iron',
    diamond_pickaxe: 'S4_diamond',
    diamond_helmet: 'S5_armor', diamond_chestplate: 'S5_armor',
    diamond_leggings: 'S5_armor', diamond_boots: 'S5_armor',
  };
  const seenCrafted = new Set();
  // 151 §3：动作证据用 callId 去重后的账本算，不再按文本行累计。
  // 旧实现每见到一条 "success":false 就 +1，而同一 call 会有服务端+客户端两条 result
  // => 失败次数被重复投递翻倍，「累计」还被写成「连续」。
  const raw = { tools: '', events: '' };
  const blockersSeen = new Set();
  const rec = (kind, data) => fs.appendFileSync(path.join(runDir, 'evidence', 'records.jsonl'), JSON.stringify({ at: nowIso(), kind, data }) + '\n');
  const pull = (f) => {
    const p = path.join(MONITOR, f);
    if (!fs.existsSync(p)) return '';
    const size = fs.statSync(p).size;
    if (size <= offsets[f]) return '';
    const fd = fs.openSync(p, 'r');
    const len = size - offsets[f];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offsets[f]);
    fs.closeSync(fd);
    offsets[f] = size;
    fs.appendFileSync(path.join(runDir, 'evidence', f), buf);
    return buf.toString('utf8');
  };

  for (;;) {
    const elapsed = Date.now() - t0;
    if (triggerDeathAt && Date.now() >= triggerDeathAt) {
      triggerDeathAt = null;
      const kd = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HARNESS, 'bin', 'send-mc-command.ps1'), '-Text', '/kill ' + companionName], { encoding: 'utf8', timeout: 40000 });
      log(runDir, 'trigger-death', '/kill ' + companionName + ' exit=' + kd.status);
    }
    const chunkTools = pull('tools.jsonl');
    raw.tools += chunkTools;
    for (const line of chunkTools.split('\n')) {
      if (line.includes('"type":"tool_call"')) {
        toolCalls++;
        lastToolCallAt = Date.now();
      }
      if (line.includes('"type":"tool_result"') && line.includes('"tool":"craft"')) {
        const cm = /crafted (\d+)x ([a-z_]+)/.exec(line);
        if (cm) {
          const it = cm[2];
          const stage = CRAFT_STAGES[it];
          if (stage && !seenCrafted.has(it)) {
            seenCrafted.add(it);
            rec('milestone', { item: 'minecraft:' + it, stage, count: Number(cm[1]), source: 'craft' });
          }
        }
      }
    }
    const chunkCtx = pull('context.jsonl');
    for (const line of chunkCtx.split('\n')) if (line.includes('"type":"llm_request"')) llmRequests++;
    const chunkEv = pull('events.jsonl');
    raw.events += chunkEv;
    // 只在「按 callId 去重后的真实连续失败」达到阈值时记 blocker（累计失败另算，不混称）
    if (raw.tools) {
      const lg = AL.build(raw.tools, raw.events, { minStreak: 3 });
      for (const b of lg.blockers) {
        if (blockersSeen.has(b.tool)) continue;
        blockersSeen.add(b.tool);
        rec('blocker', {
          tool: b.tool,
          consecutive_failures: b.consecutive_failures,
          note: '同一工具连续失败 ' + b.consecutive_failures + ' 次（按 callId 去重后的真实连续；累计失败另计）',
          callId: b.callId,
        });
      }
    }
    for (const line of (chunkEv || '').split('\n')) {
      if (line.includes('"type":"task_finished"') && /(died|slain|死亡|被.*杀死|killed)/i.test(line)) {
        const m = line.match(/"message":"([^"]{0,200})"/);
        rec('death', { message: m ? m[1] : '', at: Date.now() });
      }
    }
    // 学习轮回必须跑满时钟：任务一报告「原木采完」就停会把 25 分钟的实验截成 50 秒。
    // --no-delta-stop 的语义就是「不提前停」，这里一并受它管辖。
    if (!opts.noDeltaStop && chunkEv && chunkEv.includes('"type":"task_finished"') && /oak_log|原木/.test(chunkEv)) {
      stopReason.value = 'task_finished(oak_log)';
      const fin = mcp('rdd_get_inventory', companionName, null, 25000);
      if (fin.ok) {
        invAfterRaw = fin.out;
        const n = oakLogCount(fin.out);
        if (n !== null) after = n;
        fs.writeFileSync(path.join(runDir, 'evidence', 'inventory-after.json'), fin.out);
      }
      break;
    }
    pull('ai.jsonl');
    const chunkRdd = pull('rdd.jsonl');
    for (const line of chunkRdd.split('\n')) {
      if (line.includes('"type":"taskchain_snapshot"')) {
        try { chain = JSON.parse(line); } catch { /* ignore */ }
      }
    }
    if ((Date.now() - lastToolCallAt) > stallSec * 1000) {
      stopReason.value = 'stalled ' + stallSec + 's without tool_call';
      break;
    }
    if (elapsed > watchSec * 1000) { stopReason.value = 'wall ' + watchSec + 's'; break; }
    if (javaProcs().length === 0) { stopReason.value = 'java died'; break; }

    // 每 ~30s 采样一次背包
    if (Date.now() >= nextInventoryAt) {
      nextInventoryAt = Date.now() + 30000;
      const r = mcp('rdd_get_inventory', companionName, null, 25000);
      if (r.ok) {
        invAfterRaw = r.out;
        const n = oakLogCount(r.out);
        if (n !== null) after = n;
        fs.writeFileSync(path.join(runDir, 'evidence', 'inventory-after.json'), r.out);
        try {
          const j = JSON.parse(r.out);
          const items = (j && j.data && j.data.items) || {};
          rec('snapshot', { items, t: Date.now() });
        } catch { /* ignore */ }
        if (!opts.noDeltaStop && before !== null && after !== null && after - before >= 4) { stopReason.value = 'delta>=4'; break; }
      }
    }
    await sleep(5000);
  }
  // 收尾：把最后一段日志也读进账本（watch 循环 5s 一拉，尾部可能还没读）
  raw.tools += pull('tools.jsonl');
  raw.events += pull('events.jsonl');
  env.timings.watchEnd = nowIso();
  env.timings.watchSeconds = Math.round((Date.now() - t0) / 1000);
  env.watch = { stopReason: stopReason.value, toolCalls, llmRequests, oakLogBefore: before, oakLogAfter: after, chain: chain ? {
    primaryStatus: chain.data && chain.data.taskChain ? chain.data.taskChain.primaryStatus : null,
    description: chain.data && chain.data.taskChain ? chain.data.taskChain.description : null,
  } : null };
  log(runDir, 'watch', '停止原因: ' + stopReason.value + '；tool_calls=' + toolCalls + '；oak_log ' + before + '→' + after + '；watch=' + env.timings.watchSeconds + 's');
  saveEnv();

  // ---------- stop ----------
  env.phase = 'stop';
  const stopOff = fs.statSync(path.join(MONITOR, 'context.jsonl')).size;
  // 停机前最后一次背包采样（避免 30s 节奏错过交付瞬间）
  const finInv = mcp('rdd_get_inventory', companionName, null, 25000);
  if (finInv.ok) {
    invAfterRaw = finInv.out;
    const n2 = oakLogCount(finInv.out);
    if (n2 !== null) after = n2;
    fs.writeFileSync(path.join(runDir, 'evidence', 'inventory-after.json'), finInv.out);
  }
  // 停止前再拍一次：同一轮内的漂移（时间/天气/玩家变化）从这里看。
  const worldAfter = worldSnapshot(runDir, companionName, 'after');
  env.world.after = worldSummary(worldAfter);
  const wb = env.world.before, wa = env.world.after;
  env.world.drift = (wb && wa && wb.stable_key && wa.stable_key) ? wb.stable_key !== wa.stable_key : null;
  log(runDir, 'world', 'after complete=' + wa.complete + ' control_key=' + String(wa.control_key).slice(0, 180)
      + ' drift=' + env.world.drift);
  saveEnv();

  const ts = mcp('task_stop', companionName, null, 20000);
  const sb = mcp('rdd_standby', companionName, null, 20000);
  fs.writeFileSync(path.join(runDir, 'evidence', 'taskstop.json'), JSON.stringify({ task_stop: ts, rdd_standby: sb }, null, 2));
  log(runDir, 'stop', 'task_stop → ' + (ts.ok ? 'ok' : 'failed') + '；rdd_standby → ' + (sb.ok ? 'ok' : 'failed'));
  // 60s 宽限：数一数还有没有新的 llm_request
  let postStopRequests = 0;
  const graceEnd = Date.now() + 60000;
  while (Date.now() < graceEnd) {
    const p = path.join(MONITOR, 'context.jsonl');
    // 2026-10-30（exp-loop-r16 实测）：context.jsonl 会**轮转**（改名成 context-<ts>.jsonl），
    // 轮转瞬间 statSync 抛 ENOENT。原来这一行在 a0 的 try/catch **之外**，于是整个收尾直接崩，
    // 连 restore 都没跑（环境状态没还原）——比丢一条观测严重得多。
    // 处理：读不到就当作「本轮轮询没有新数据」并跳出；不猜、不补。
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch (e) {
      log(runDir, 'stop', 'context.jsonl 轮转中（' + e.code + '），停止后静默检查提前结束');
      break;
    }
    if (size > stopOff) {
      const fd = fs.openSync(p, 'r');
      const len = size - stopOff;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, stopOff);
      fs.closeSync(fd);
      fs.appendFileSync(path.join(runDir, 'evidence', 'context.jsonl'), buf);
      for (const line of buf.toString('utf8').split('\n')) if (line.includes('"type":"llm_request"')) postStopRequests++;
    }
    if (postStopRequests === 0 && Date.now() > graceEnd - 45000) break; // 15s 静默即可判
    await sleep(5000);
  }
  env.stop = { postStopRequests, graceSeconds: 60 };
  log(runDir, 'stop', '停止后新 llm_request=' + postStopRequests);

  const pids = javaProcs();
  if (pids.length) {
    ps('Get-CimInstance Win32_Process -Filter "Name=\'java.exe\' OR Name=\'javaw.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine -like \'*' + GAME.replace(/'/g, "''") + '*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }', 30000);
  }
  let exited = false;
  for (let i = 0; i < 40; i++) { if (javaProcs().length === 0) { exited = true; break; } await sleep(1000); }
  env.timings.gameExited = nowIso();
  env.stop.javaExited = exited;
  log(runDir, 'stop', 'java 退出=' + exited);
  saveEnv();

  // ---------- A0：会话边界 / 人工介入 / 投送四阶段 ----------
  // 必须在受控复位之前：restore 会把 companions/ 整目录还原成基线，
  // run 期间的 chat.jsonl 会被冲掉（90 号 §5.1，2026-10-29 实测）。
  // 只读既有事实源、只往 envelope 加键，不改任何规划/战斗行为（90 号 §2 明确不做）。
  env.phase = 'a0';
  try {
    pull('expmem.jsonl'); // 收尾再拉一次：expanded / request_delivered 都在这里
    pull('instrumentation.jsonl'); // A1：死亡事件（death / starvation_death）只在这条流
    const a0 = A0.collect({
      runDir,
      monitorDir: MONITOR,
      companionsDir: path.join(NUMEN, 'companions'),
      launchStart: env.timings.launchStart || env.createdAt,
    });
    const merged = A0.applyToEnvelope(env, a0);
    env.session = merged.session;
    env.interventions = merged.interventions;
    // 2026-10-30（第 33 轮）：调试工具通道单独计数，不并进 interventions。
    //   debug_kill 能 kill 任意实体，但回执无法可靠区分自杀/他杀 —— 只摆事实，不做归类。
    // 注意：applyToEnvelope 只透传它自己认识的字段，新加的 debugTools 在 a0 上，不在 merged 上。
    env.debug_tools = a0.debugTools || merged.debugTools || { status: 'UNKNOWN', count: null, entries: [] };
    env.context_delivery = merged.context_delivery;
    env.deaths = merged.deaths;
    // A3（95 号）：capability/tool 两层用 run 归档的 tools.jsonl 做**后处理**（非实时，realtime:false），
    // 因为 rdd 插件没有工具回执钩子；实时事件要改 api/common 的 dispatcher（另开一批）。
    try {
      const situation = require('./lib/situation');
      const toolsPath = path.join(runDir, 'evidence', 'tools.jsonl');
      const rddPath = path.join(runDir, 'evidence', 'rdd.jsonl');
      const readJsonl = (p) => (fs.existsSync(p)
        ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        : null);
      // capability 的补充源是 rdd.jsonl 的 task_negotiation COUNTER（attack/mine 失败不一定进 tool_result）
      env.situations = situation.classify({ toolsRows: readJsonl(toolsPath), rddRows: readJsonl(rddPath) });
    } catch (e) {
      env.situations = { status: 'UNKNOWN', realtime: false, entries: [], reasons: ['classify-failed:' + String(e.message).slice(0, 80)] };
    }
    env.world_views = merged.world_views;
    env.a0 = merged.a0;
    env.a0.sources = a0.sources;
    log(runDir, 'a0', 'session=' + env.session.status + '（msgs=' + env.session.first_request_message_count + ', clear=' + (env.session.clear_boundary_at || 'none') + '）'
      + ' interventions=' + env.interventions.status + '(' + env.interventions.count + ')'
      + ' delivery=' + env.context_delivery.status
      + ' rendered=' + (env.context_delivery.rendered ? env.context_delivery.rendered.refs.length : '?')
      + ' delivered=' + (env.context_delivery.delivered ? env.context_delivery.delivered.refs.length : '?')
      + ' deaths=' + (env.deaths ? env.deaths.status + '(' + env.deaths.count + ')' : '?')
      + ' situations=' + (env.situations ? env.situations.status + '(' + env.situations.entries.length + ')' : '?'));
  } catch (e) {
    // 证据缺失照实记 UNKNOWN，不拿默认值补成功
    env.session = { status: 'UNKNOWN', reasons: ['a0-collect-failed: ' + String(e.message).slice(0, 200)] };
    env.interventions = { count: 0, ids: [], status: 'UNKNOWN', entries: [], rejected: [] };
    env.context_delivery = { status: 'UNKNOWN' };
    env.deaths = { status: 'UNKNOWN', count: null, entries: [], reasons: ['collect-failed'] };
    env.situations = { status: 'UNKNOWN', realtime: false, entries: [], reasons: ['collect-failed'] };
    env.a0 = { version: A0.A0_VERSION, collected_at: nowIso(), error: String(e.message).slice(0, 400) };
    log(runDir, 'a0', 'A0 采集失败（照实记 UNKNOWN）: ' + e.message);
  }
  saveEnv();

  // ---------- 学习产物三态快照（151 §3）----------
  // 运行前(before) / 恢复前(beforeRestore) / 恢复后(after) 三个哈希都要留。
  // 为什么：恢复后与运行前相同，只证明「磁盘上的学习产物被回滚」，**不能**证明「本轮没学习」——
  // 这一轮可能学到了东西、只是被冷启动复位冲掉了。恢复前的产物必须先归档，才谈得上复核。
  env.phase = 'snapshot';
  // 停机阶段的 task_stop / rdd_standby 回执也要进账（否则「叫停」这一步永远查不到）
  raw.tools += pull('tools.jsonl');
  raw.events += pull('events.jsonl');
  // 151 §3：动作证据账本 —— 按 callId 去重，区分受理/完成/超时/取消/终态缺失，
  // 并把「累计失败」和「连续失败」分开记。只读日志，不改变任何任务控制语义。
  try {
    const lg = AL.build(raw.tools, raw.events, { minStreak: 3 });
    env.actions = Object.assign({ status: 'PRESENT', observedFrom: 'tools.jsonl+events.jsonl' }, lg.summary, { blockers: lg.blockers });
    log(runDir, 'actions', '调用 ' + lg.summary.calls + ' 条：completed=' + (lg.summary.states.completed || 0)
      + ' failed=' + (lg.summary.states.failed || 0)
      + ' cancelled=' + (lg.summary.states.cancelled || 0)
      + ' timeout=' + (lg.summary.states.timeout || 0)
      + ' acceptedOnly=' + lg.summary.acceptedOnly
      + ' noResult=' + (lg.summary.states['no-result'] || 0)
      + ' 终态覆盖=' + lg.summary.coverage.terminal
      + ' 重复投递=' + lg.summary.duplicates.results);
  } catch (e) {
    env.actions = { status: 'UNKNOWN', reason: String(e.message).slice(0, 200) };
    log(runDir, 'actions', '动作账本构建失败（照实记 UNKNOWN）: ' + e.message);
  }
  env.experience.beforeRestore = expHash();
  const learnArchive = path.join(runDir, 'evidence', 'learn-archive');
  fs.mkdirSync(learnArchive, { recursive: true });
  const archived = [];
  for (const f of learnFiles()) {
    const src = path.join(NUMEN, f);
    fs.copyFileSync(src, path.join(learnArchive, f));
    archived.push({ file: f, sha256: sha256File(src), bytes: fs.statSync(src).size });
  }
  env.experience.archive = { dir: 'evidence/learn-archive', count: archived.length, files: archived };
  log(runDir, 'snapshot', '恢复前学习产物归档 ' + archived.length + ' 个文件（' + learnArchive + '）hash=' + String(env.experience.beforeRestore).slice(0, 16) + '…');
  saveEnv();

  // ---------- restore (受控复位) ----------
  env.phase = 'restore';
  if (!exited) fail(runDir, 'restore', '游戏没停下来，拒绝在运行中还原状态（会写坏现场）', 3);
  for (const d of NUMEN_STATE_DIRS) {
    const target = path.join(NUMEN, d);
    const backup = path.join(baseDir, d);
    fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(backup)) copyTree(backup, target);
  }
  if (!opts.keepExperience) {
    for (const f of baseFiles) fs.copyFileSync(path.join(baseDir, f), path.join(NUMEN, f));
    // 清掉运行中新建的同族文件（例如新的 experience-<uuid>.jsonl）
    for (const e of fs.readdirSync(NUMEN)) {
      if (!NUMEN_STATE_GLOBS.some((re) => re.test(e))) continue;
      if (!baseFiles.includes(e)) fs.rmSync(path.join(NUMEN, e), { force: true });
    }
  } else {
    log(runDir, 'restore', 'keep-experience：保留 experience/learner-memos（本轮记忆带入下一轮）');
  }
  env.experience.after = expHash();
  // 三态结论（只陈述可核对的事实，不替读报告的人做因果判断）
  env.experience.summary = {
    learnedThisRun: env.experience.before !== env.experience.beforeRestore,
    rolledBackToBaseline: env.experience.after === env.experience.before,
    keptForNextRun: env.experience.after === env.experience.beforeRestore
      && env.experience.beforeRestore !== env.experience.before,
    note: '恢复后=运行前 只说明学习产物被回滚，不等于本轮没学习；恢复前的产物在 evidence/learn-archive，'
      + '本轮是否真学到要看 before->beforeRestore 的差异与归档内容。',
  };
  log(runDir, 'restore', '学习三态：learnedThisRun=' + env.experience.summary.learnedThisRun
    + ' rolledBack=' + env.experience.summary.rolledBackToBaseline
    + ' keptForNextRun=' + env.experience.summary.keptForNextRun);
  CTX = null;
  const restoredManifest = manifestOf(baseDir);
  log(runDir, 'restore', '存档外状态已还原（基线 ' + restoredManifest.sha256.slice(0, 16) + '…）');

  // ---------- archive ----------
  env.phase = 'archive';
  // 运行结束时的任务链已被受控复位覆盖，以 watch 抓到的 chain 快照为准
  if (chain) fs.writeFileSync(path.join(runDir, 'evidence', 'taskchain-final.json'), JSON.stringify(chain, null, 2));
  fs.writeFileSync(path.join(runDir, 'cleanup.json'), JSON.stringify({
    at: nowIso(), world, worldPath, kept: true, reason: 'verdict pending（裁决后跑 cleanup 再决定删/留）',
  }, null, 2));
  env.phase = 'done';
  env.finishedAt = nowIso();
  saveEnv();
  log(runDir, 'done', 'RUN COMPLETE. 下一步: node exp-judge.js "' + runDir + '"');
  process.exit(0);
}

function cmdCleanup(runIdArg) {
  const runDir = path.isAbsolute(runIdArg) ? runIdArg : path.join(RUNS, runIdArg);
  const env = JSON.parse(fs.readFileSync(path.join(runDir, 'envelope.json'), 'utf8'));
  const verdictPath = path.join(runDir, 'verdict.json');
  if (!fs.existsSync(verdictPath)) { console.error('没有 verdict.json，先跑 exp-judge.js 再 cleanup'); process.exit(2); }
  const v = JSON.parse(fs.readFileSync(verdictPath, 'utf8'));
  const keep = !(v.overall === 'PASS' || v.overall === 'PASS_WITH_GAPS');
  const worldPath = env.master.worldPath;
  if (!keep) {
    if (fs.existsSync(worldPath)) fs.rmSync(worldPath, { recursive: true, force: true });
    console.log('cleanup: 已删除世界副本 ' + worldPath);
  } else {
    console.log('cleanup: 裁决=' + v.overall + '，保留复现包 ' + worldPath);
  }
  const c = { at: nowIso(), world: env.master.world, worldPath, kept: keep, verdict: v.overall };
  fs.writeFileSync(path.join(runDir, 'cleanup.json'), JSON.stringify(c, null, 2));
  process.exit(0);
}

function cmdStatus() {
  const dirs = fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((d) => d.startsWith('exp-')) : [];
  if (!dirs.length) { console.log('（没有 run）'); return; }
  for (const d of dirs) {
    const envP = path.join(RUNS, d, 'envelope.json');
    let line = d;
    if (fs.existsSync(envP)) {
      const e = JSON.parse(fs.readFileSync(envP, 'utf8'));
      line += '  phase=' + e.phase + '  world=' + (e.master && e.master.world) + '  watch=' + (e.timings && e.timings.watchSeconds) + 's';
    }
    const vP = path.join(RUNS, d, 'verdict.json');
    if (fs.existsSync(vP)) line += '  verdict=' + JSON.parse(fs.readFileSync(vP, 'utf8')).overall;
    console.log(line);
  }
}

// ---- CLI ----
const argv = process.argv.slice(2);
const cmd = argv[0];
const opts = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--label') opts.label = argv[++i];
  else if (argv[i] === '--goal') opts.goal = argv[++i];
  else if (argv[i] === '--goal-file') opts.goalFile = argv[++i];
  else if (argv[i] === '--minutes') opts.minutes = parseInt(argv[++i], 10);
  else if (argv[i] === '--keep-experience') opts.keepExperience = true;
  else if (argv[i] === '--zero-start') opts.zeroStart = true;
  else if (argv[i] === '--keep-session') opts.keepSession = true;
  else if (argv[i] === '--no-delta-stop') opts.noDeltaStop = true;
  else if (argv[i] === '--master') opts.master = argv[++i];
  else if (argv[i] === '--companion') opts.companion = argv[++i];
  else if (argv[i] === '--night') opts.night = true;
  else if (argv[i] === '--allow-dirty-world') opts.allowDirtyWorld = true;
  else if (argv[i] === '--allow-void') opts.allowVoid = true;
  else if (argv[i] === '--trigger-death') opts.triggerDeath = true;
  else if (argv[i] === '--trigger-death-delay') opts.triggerDeathDelaySeconds = parseInt(argv[++i], 10);
  else if (argv[i] === '--mode') opts.mode = argv[++i];
  else if (argv[i] === '--create-companion') opts.createCompanion = argv[++i];
  else if (argv[i] === '--companion-provider') opts.companionProvider = argv[++i];
}

/** 151 §3：run 的用途必须显式声明，否则诊断短局会被当成通关效率曲线上的点。 */
const RUN_MODES = ['campaign', 'diagnostic', 'regression'];
(async () => {
  if (cmd === 'plan') return cmdPlan(opts);
  if (cmd === 'run') return cmdRun(opts);
  if (cmd === 'cleanup') return cmdCleanup(argv[1]);
  if (cmd === 'status') return cmdStatus();
  console.log('usage: node exp-runner.js plan|run|cleanup|status [--label x] [--goal "…"] [--companion RDD] [--minutes N] [--master <worldDir>]');
  process.exit(2);
})();