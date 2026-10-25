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

const RDD = 'D:/rdd';
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
const NUMEN_STATE_DIRS = [
  'rdd-tasks', 'rdd-ledger', 'rdd-facts', 'rdd-assets', 'rdd-history',
  'rdd-semantics', 'rdd-side', 'companions', 'worldstate', 'acx',
];
const NUMEN_STATE_GLOBS = [/^experience-.*\.jsonl$/, /^learner-memos-.*\.json$/];

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
  if (companion) argv.push(companion);
  if (args) argv.push(args);
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: timeoutMs || 25000 });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function oakLogCount(raw) {
  if (!raw) return null;
  const patterns = [
    /"minecraft:oak_log"\s*:\s*(\d+)/,
    /"oak_log"\s*:\s*(\d+)/,
    /oak_log[^0-9]{0,80}?(\d+)/,
  ];
  for (const p of patterns) { const m = raw.match(p); if (m) return parseInt(m[1], 10); }
  return null;
}
function log(runDir, phase, msg) {
  const line = nowIso() + ' [' + phase + '] ' + msg + '\n';
  fs.appendFileSync(path.join(runDir, 'events.log'), line);
  console.log(line.trim());
}
function fail(runDir, phase, msg, code) {
  if (runDir) log(runDir, phase, 'FATAL ' + msg);
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
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const contractHash = sha256File(CONTRACT_PATH);
  const runId = 'exp-' + label + '-' + stamp();
  const runDir = path.join(RUNS, runId);
  fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
  const env = {
    runId, label, createdAt: nowIso(), contract: { path: CONTRACT_PATH, sha256: contractHash, revision: contract.contractRevision, scenarioId: contract.scenarioId },
    gameDir: GAME, phase: 'preflight', timings: {},
  };
  const saveEnv = () => fs.writeFileSync(path.join(runDir, 'envelope.json'), JSON.stringify(env, null, 2));
  saveEnv();
  log(runDir, 'init', 'runId=' + runId + ' label=' + label);

  // ---------- preflight ----------
  const java0 = javaProcs();
  if (java0.length) fail(runDir, 'preflight', 'java already running: ' + java0.join(',') + ' — 实例被占用，拒绝抢跑', 10);
  if (await portOpen(8765)) fail(runDir, 'preflight', 'MCP 8765 already listening — 有实例在跑？', 10);
  if (!fs.existsSync(contract.masterWorld.path)) fail(runDir, 'preflight', '母版存档不存在: ' + contract.masterWorld.path, 10);
  if (!fs.existsSync(MC_LAUNCH)) fail(runDir, 'preflight', '启动器不存在: ' + MC_LAUNCH, 3);
  if (!(await portOpen(8080))) {
    log(runDir, 'preflight', 'OpenClaw 8080 未监听 → 拉起 server.js');
    const ocLog = fs.openSync(path.join(runDir, 'evidence', 'oc-server.log'), 'a');
    spawn(process.execPath, ['server.js'], { cwd: OC_DIR, detached: true, stdio: ['ignore', ocLog, ocLog] }).unref();
    for (let i = 0; i < 40 && !(await portOpen(8080)); i++) await sleep(250);
    if (!(await portOpen(8080))) fail(runDir, 'preflight', 'OpenClaw 8080 起不来（见 evidence/oc-server.log）', 3);
  }
  log(runDir, 'preflight', '实例空闲，母版存在，OpenClaw 就绪');

  // ---------- prepare ----------
  env.phase = 'prepare';
  const world = 'exp-' + label + '-' + stamp().slice(9);
  const worldPath = path.join(SAVES, world);
  if (fs.existsSync(worldPath)) fail(runDir, 'prepare', '世界副本已存在，拒绝覆盖: ' + worldPath, 10);
  const masterManifest = manifestOf(contract.masterWorld.path);
  log(runDir, 'prepare', '母版清单 files=' + masterManifest.count + ' sha256=' + masterManifest.sha256.slice(0, 16) + '… → 复制到 ' + world);
  copyTree(contract.masterWorld.path, worldPath);
  const copyManifest = manifestOf(worldPath);
  if (copyManifest.sha256 !== masterManifest.sha256) fail(runDir, 'prepare', '世界副本与母版不一致（复制损坏）', 3);
  log(runDir, 'prepare', '世界副本校验通过 files=' + copyManifest.count);

  // 存档外状态快照（受控复位基线）
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
  env.master = { source: contract.masterWorld.path, world, worldPath, manifest: masterManifest, baselineManifest };
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

  let ready = false;
  let companions = null;
  for (let i = 0; i < 120; i++) { // ≤ 300s
    if (javaProcs().length === 0 && i > 8) fail(runDir, 'launch', 'java 进程没起来（启动器日志见 evidence/launcher.log）', 3);
    if (await portOpen(8765)) {
      const r = mcp('list_companions', null, null, 20000);
      if (r.ok) { companions = r.out; break; }
    }
    await sleep(2500);
  }
  if (!companions) fail(runDir, 'launch', '300s 内 MCP 未就绪', 3);
  env.timings.mcpReady = nowIso();
  log(runDir, 'launch', 'MCP 就绪');

  // 启动日志段（S1 证据）：从启动前 offset 到当前
  const logBuf = fs.readFileSync(logPath).slice(logStart);
  fs.writeFileSync(path.join(runDir, 'evidence', 'boot.log'), logBuf);
  const bootText = logBuf.toString('latin1');
  const foundMods = (bootText.match(/Found mod file "[^"]+"/g) || []);
  env.boot = { bytes: logBuf.length, foundMods: foundMods.slice(0, 40) };
  env.jarsAtLaunch = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar')).map((f) => ({ file: f, sha256: sha256File(path.join(modsDir, f)) }));
  fs.writeFileSync(path.join(runDir, 'evidence', 'companions-raw.txt'), companions);
  saveEnv();

  // ---------- stimulus ----------
  env.phase = 'stimulus';
  const companionName = (companions.match(/"name"\s*:\s*"([^"]+)"/) || [])[1];
  if (!companionName) fail(runDir, 'stimulus', 'list_companions 无同伴名', 10);
  env.companion = companionName;
  const goalText = opts.goal || contract.stimulus.text;
  const stim = path.join(runDir, 'stimulus.json');
  fs.writeFileSync(stim, JSON.stringify({ text: goalText }, null, 2));

  const invBefore = mcp('rdd_get_inventory', companionName, null, 25000);
  fs.writeFileSync(path.join(runDir, 'evidence', 'inventory-before.json'), invBefore.out || invBefore.err);
  const before = oakLogCount(invBefore.out);
  env.inventory = { beforeRaw: invBefore.out.slice(0, 4000), oakLogBefore: before };
  log(runDir, 'stimulus', 'companion=' + companionName + ' oak_log(before)=' + before);

  const offsets = {};
  for (const f of ['tools.jsonl', 'context.jsonl', 'events.jsonl', 'ai.jsonl', 'rdd.jsonl']) {
    const p = path.join(MONITOR, f);
    offsets[f] = fs.existsSync(p) ? fs.statSync(p).size : 0;
    fs.writeFileSync(path.join(runDir, 'evidence', f), '');
  }
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
    const chunkTools = pull('tools.jsonl');
    for (const line of chunkTools.split('\n')) {
      if (line.includes('"type":"tool_call"')) {
        toolCalls++;
        lastToolCallAt = Date.now();
      }
    }
    const chunkCtx = pull('context.jsonl');
    for (const line of chunkCtx.split('\n')) if (line.includes('"type":"llm_request"')) llmRequests++;
    pull('events.jsonl');
    pull('ai.jsonl');
    const chunkRdd = pull('rdd.jsonl');
    for (const line of chunkRdd.split('\n')) {
      if (line.includes('"type":"taskchain_snapshot"')) {
        try { chain = JSON.parse(line); } catch { /* ignore */ }
      }
    }
    if ((Date.now() - lastToolCallAt) > contract.budget.stallSeconds * 1000) {
      stopReason.value = 'stalled ' + contract.budget.stallSeconds + 's without tool_call';
      break;
    }
    if (elapsed > contract.budget.stimulusWatchSeconds * 1000) { stopReason.value = 'wall ' + contract.budget.stimulusWatchSeconds + 's'; break; }
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
        if (before !== null && after !== null && after - before >= 4) { stopReason.value = 'delta>=4'; break; }
      }
    }
    await sleep(5000);
  }
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
  const ts = mcp('task_stop', companionName, null, 20000);
  fs.writeFileSync(path.join(runDir, 'evidence', 'taskstop.json'), JSON.stringify(ts, null, 2));
  log(runDir, 'stop', 'task_stop → ' + (ts.ok ? 'ok' : 'failed(记录)'));
  // 60s 宽限：数一数还有没有新的 llm_request
  let postStopRequests = 0;
  const graceEnd = Date.now() + 60000;
  while (Date.now() < graceEnd) {
    const p = path.join(MONITOR, 'context.jsonl');
    const size = fs.statSync(p).size;
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

  // ---------- restore (受控复位) ----------
  env.phase = 'restore';
  if (!exited) fail(runDir, 'restore', '游戏没停下来，拒绝在运行中还原状态（会写坏现场）', 3);
  for (const d of NUMEN_STATE_DIRS) {
    const target = path.join(NUMEN, d);
    const backup = path.join(baseDir, d);
    fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(backup)) copyTree(backup, target);
  }
  for (const f of baseFiles) fs.copyFileSync(path.join(baseDir, f), path.join(NUMEN, f));
  // 清掉运行中新建的同族文件（例如新的 experience-<uuid>.jsonl）
  for (const e of fs.readdirSync(NUMEN)) {
    if (!NUMEN_STATE_GLOBS.some((re) => re.test(e))) continue;
    if (!baseFiles.includes(e)) fs.rmSync(path.join(NUMEN, e), { force: true });
  }
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
}
(async () => {
  if (cmd === 'plan') return cmdPlan(opts);
  if (cmd === 'run') return cmdRun(opts);
  if (cmd === 'cleanup') return cmdCleanup(argv[1]);
  if (cmd === 'status') return cmdStatus();
  console.log('usage: node exp-runner.js plan|run|cleanup|status [--label x] [--goal "…"]');
  process.exit(2);
})();