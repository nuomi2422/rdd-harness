#!/usr/bin/env node
'use strict';
/**
 * batch-bridge.js —— G7b 第一刀：给 `engineering-request` 接一个**真实消费者**
 *
 * 为什么要有它：`bin/lib/engineering-request.js` 是纯契约，如果没人调用，按 S-CODE-04
 * 就是「接线前状态」的死代码。这个 CLI 把它接进**批次收尾**这条真实流程：
 * 每批开一张请求 → 实现时交证据 → 收尾时由**别人的**核验签字。
 *
 * 存储：`runs/engineering-requests.jsonl`（append-only 事件流，**只增不改**）
 *   - 每行一条事件：{v, at, requestId, kind:'created'|'transition'|'spend', ...}
 *   - 状态靠**重放**得到（与 engineering-request R7 同一口径：事实在事件里，结论随时可算）
 *
 * 用法：
 *   node bin/batch-bridge.js start   --batch G7b --scope harness --revision <sha> [--submitter ai] [--budget bud-1]
 *   node bin/batch-bridge.js accept  --id <requestId> [--by ai]
 *   node bin/batch-bridge.js implement --id <requestId> --evidence "card.md:12" [--evidence "..."] [--by ai]
 *   node bin/batch-bridge.js verify  --id <requestId> --reviewer <name> --evidence "a:1" --evidence "b:2" [--by ai]
 *   node bin/batch-bridge.js block   --id <requestId> --reason "..."
 *   node bin/batch-bridge.js list [--json]
 *   node bin/batch-bridge.js show    --id <requestId> [--events]   # --events = 原始事件（对账用）
 *   node bin/batch-bridge.js selftest
 */
const fs = require('node:fs');
const path = require('node:path');
const er = require('./lib/engineering-request');

const HARNESS = path.resolve(__dirname, '..');
function ledgerFile() {
  return process.env.RDD_BRIDGE_LEDGER || path.join(HARNESS, 'runs', 'engineering-requests.jsonl');
}

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function args(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === '--' + name && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  });
  return out;
}

function readEvents() {
  const file = ledgerFile();
  if (!fs.existsSync(file)) return [];
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try {
      out.push(JSON.parse(l));
    } catch (e) {
      // 坏行要能定位，且不许因此冻结整个账本（跳过并记住）
      out.push({ kind: '__bad_line__', line: i + 1, error: e.message });
    }
  });
  return out;
}

function appendEvent(e) {
  const file = ledgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // C6：若上次写到一半就崩了（文件不以换行结尾），先补一个换行，
  // 否则新事件会跟残行粘成一行、两条一起坏掉。
  try {
    const st = fs.statSync(file);
    if (st.size > 0) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, st.size - 1);
      fs.closeSync(fd);
      if (buf[0] !== 0x0a) fs.appendFileSync(file, '\n', 'utf8');
    }
  } catch { /* 文件不存在等，交给下面创建 */ }
  fs.appendFileSync(file, JSON.stringify({ v: 1, at: Date.now(), ...e }) + '\n', 'utf8');
}

/** 累计消耗（由 spend 事件重放算出，不存第二份计数器）。 */
function spentOf(events, requestId) {
  const spent = { amount: 0, calls: 0, tokens: 0 };
  for (const e of events) {
    if (e.kind !== 'spend' || e.requestId !== requestId) continue;
    spent.amount += Number(e.amount || 0);
    spent.calls += Number(e.calls || 0);
    spent.tokens += Number(e.tokens || 0);
  }
  return spent;
}

/** 重放：事件流 → 当前状态（与 R7 同一口径）。 */
function replay(events, requestId) {
  let req = null;
  for (const e of events) {
    if (e.requestId !== requestId) continue;
    if (e.kind === 'created') {
      req = er.create({
        requestId: e.requestId, contractRevision: e.contractRevision, batchId: e.batchId,
        scope: e.scope, expectedBaseRevision: e.expectedBaseRevision,
        budgetAuthorizationRef: e.budgetAuthorizationRef, submitter: e.submitter,
      });
    } else if (e.kind === 'transition' && req) {
      const opts = { by: e.by, reason: e.reason, reviewer: e.reviewer, evidenceRefs: e.evidenceRefs || [] };
      if (e.to === 'ACCEPTED') req = er.accept(req, opts);
      else if (e.to === 'IMPLEMENTED') req = er.implement(req, opts);
      else if (e.to === 'VERIFIED') req = er.verify(req, opts);
      else if (e.to === 'BLOCKED') req = er.block(req, opts);
      else if (e.to === 'REJECTED') req = er.reject(req, opts);
    }
  }
  return req;
}

function allRequests(events) {
  const ids = [];
  for (const e of events) if (!ids.includes(e.requestId)) ids.push(e.requestId);
  // 一条坏请求不许拖垮整本列表（历史账本可能没有 submitter 等新必填字段）
  const out = [];
  for (const id of ids) {
    try {
      const r = replay(events, id);
      if (r) out.push(r);
    } catch (e) {
      out.push({ requestId: id, state: 'UNREADABLE', error: e.code || e.message });
    }
  }
  return out;
}

function cmdSpend() {
  const id = arg('id');
  if (!id) throw new Error('缺 --id');
  const events = readEvents();
  const req = replay(events, id);
  if (!req) throw new Error(`没有这个请求：${id}`);
  const raw = arg('budget-json');
  if (!raw) {
    const err = new Error('NO_AUTHORIZATION: spend 必须给 --budget-json（未填不等于无限）');
    err.code = 'NO_AUTHORIZATION';
    throw err;
  }
  const add = {
    amount: Number(arg('amount') || 0),
    calls: Number(arg('calls') || 0),
    tokens: Number(arg('tokens') || 0),
  };
  const before = spentOf(events, id);
  // 用「累计 + 本次」校验：单次没超、累计超了也要拦
  er.assertBudget(req, JSON.parse(raw), {
    amount: before.amount + add.amount,
    calls: before.calls + add.calls,
    tokens: before.tokens + add.tokens,
  }, { scope: req.scope });
  appendEvent({ kind: 'spend', requestId: id, ...add, note: arg('note') || '' });
  console.log(JSON.stringify({ ok: true, id, spent: spentOf(readEvents(), id) }));
}

function headRevision() {
  const { spawnSync } = require('node:child_process');
  const GIT = 'C:\\\\Users\\\\admin\\\\AppData\\\\Local\\\\Programs\\\\MinGit\\\\cmd\\\\git.exe';
  const got = spawnSync(GIT, ['-C', HARNESS, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return (got.stdout || '').trim();
}

/** B4 断点恢复：BLOCKED + 基线一致 → ACCEPTED（记 resumeFrom）；否则 RESUME_BASELINE_CONFLICT。 */
function cmdResume() {
  const id = arg('id');
  if (!id) throw new Error('缺 --id');
  const events = readEvents();
  const req = replay(events, id);
  if (!req) throw new Error(`没有这个请求：${id}`);
  // 同 requestId 出现两个不同基线 = 历史冲突，先拦
  const bases = new Set(
    events.filter((e) => e.kind === 'created' && e.requestId === id).map((e) => e.expectedBaseRevision || ''));
  if (bases.size > 1) {
    const err = new Error(`RESUME_BASELINE_CONFLICT: 同 id 有多个基线 ${[...bases].join(' / ')}`);
    err.code = 'RESUME_BASELINE_CONFLICT';
    throw err;
  }
  const actual = headRevision();
  if (actual !== req.expectedBaseRevision) {
    const err = new Error(`RESUME_BASELINE_CONFLICT: 期望 ${req.expectedBaseRevision}，实际 ${actual}`);
    err.code = 'RESUME_BASELINE_CONFLICT';
    throw err;
  }
  if (req.state !== 'BLOCKED') throw new Error(`只有 BLOCKED 能 resume，当前 ${req.state}`);
  appendEvent({
    kind: 'transition', requestId: id, to: 'ACCEPTED', by: arg('by') || 'ai',
    reason: `resume from BLOCKED @ ${actual}`,
    resumeFrom: { requestId: id, atRevision: actual },
  });
  const after = replay(readEvents(), id);
  console.log(JSON.stringify({ ok: true, id, state: after.state, resumedFrom: actual }));
}

const GATE = path.join(HARNESS, 'bin', 'harness-gate.js');
const ALLOWED_BODY_TOOLS = ['goto'];
const MAX_BATCH = 5;
const ALLOWED_RUNS = ['preflight', 'postflight', 'selftest', 'acx-smoke', 'acx-task', 'body-task', 'body-batch'];

/**
 * G7b 执行器第一刀：把「跑一条可验证的检查」接进来，并按结果**自动推进状态**。
 *
 * 三条纪律：
 *  1. **只跑白名单命令**（harness-gate.js 的 preflight/postflight/selftest），别的一律拒；
 *  2. 成功（exit=0）→ 自动 implement 并写证据 `run:<cmd>:exit=0`；
 *  3. 失败 → 自动 block，理由是退出码 + 输出尾部，**不许伪造证据**。
 */

/** 只读探测：端口有没有在听（不派任务、不写盘、不启停游戏）。 */
function probePorts(ports) {
  const net = require('node:net');
  const { execFileSync } = require('node:child_process');
  const out = [];
  for (const port of ports) {
    let open = false;
    try {
      // Windows 上用 netstat 判 LISTEN 最稳（connect 在少了防火墙规则时会有延迟）
      const txt = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
      open = txt.split(/\r?\n/).some((l) => l.includes(`:${port} `) && l.includes('LISTENING'));
    } catch {
      try {
        const sock = new net.Socket();
        // 同步语义不可用，退化成"看不到就是 false"
        sock.destroy();
      } catch { /* ignore */ }
    }
    out.push({ port, open });
  }
  return out;
}

const MCP_CALL = 'D:\\\\rdd\\\\workspace\\\\rdd-selfcompile\\\\scripts\\\\mcp-call.js';

/** 调一次游戏内 MCP 工具，返回解析后的 JSON（失败返回 null）。 */
function mcpCall(tool, argsObj) {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const f = path.join(os.tmpdir(), `mcp-args-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(argsObj), 'utf8');
  try {
    const got = spawnSync(process.execPath, [MCP_CALL, tool, 'RDD', '@' + f], { encoding: 'utf8' });
    const txt = (got.stdout || '').trim();
    const line = txt.split(/\r?\n/).filter(Boolean).pop() || '';
    return JSON.parse(line);
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

/** T1–T3：派一次 AC 并轮询到终态。没有 run_id 一律算失败。 */
function runAcxTask(acJson, timeoutMs) {
  const exec = mcpCall('acx_execute', { ac_json: acJson });
  const runId = exec && exec.data && exec.data.run_id;
  if (!runId) {
    return { run_id: '', state: 'DISPATCH_FAILED', steps: 0, detail: JSON.stringify(exec || {}).slice(0, 200) };
  }
  const deadline = Date.now() + Math.max(5000, timeoutMs);
  let last = 'RUNNING';
  let steps = 0;
  while (Date.now() < deadline) {
    const st = mcpCall('acx_status', { run_id: runId });
    const d = (st && st.data) || {};
    last = d.status || d.state || last;
    steps = Number(d.completed_step_index || steps);
    if (last !== 'RUNNING' && last !== 'PENDING') break;
    const t = Date.now() + 2000;
    while (Date.now() < t) { /* 忙等 2s，避免额外依赖 */ }
  }
  return { run_id: runId, state: existingTerminal(last, deadline) ? 'TIMEOUT' : last, steps };
}

function existingTerminal(s, deadline) {
  return (s === 'RUNNING' || s === 'PENDING') && Date.now() >= deadline;
}

const MC_LOG = 'D:\\rdd\\mc\\The Best of Twilight Forest\\logs\\latest.log';

/**
 * 从 latest.log 的尾部抓最近一条 `usage=UsageStats[...]`（U1/U3：只读）。
 * 抓不到返回 null —— 不是每个任务都会触发试用归因（U2）。
 */
function logSize() {
  try { return fs.statSync(MC_LOG).size; } catch { return 0; }
}

function extractUsageSince(fromOffset) {
  try {
    const st = fs.statSync(MC_LOG);
    // 严格窗口语义：偏移非法就返回 null，**不回退到尾部扫描**（否则旧账会被当成本次的）
    if (!Number.isFinite(fromOffset) || fromOffset <= 0 || fromOffset > st.size) return null;
    const from = fromOffset;
    const fd = fs.openSync(MC_LOG, 'r');
    const buf = Buffer.alloc(st.size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const m = [...text.matchAll(/usage=UsageStats\[([^\]]+)\]/g)].pop();
    if (!m) return null;
    const out = {};
    for (const kv of m[1].split(',')) {
      const [k, v] = kv.split('=').map((s) => s.trim());
      if (k) out[k] = Number.isNaN(Number(v)) ? v : Number(v);
    }
    out.fromOffset = from;
    return out;
  } catch {
    return null;
  }
}

/** V1–V3：派一次身体任务（走 CompanionBrain），3s 后取消，再抓 usage。 */
function runBodyTask(tool, argsObj, holdMs) {
  const started = mcpCall(tool, argsObj);
  const taskId = (started && started.data && (started.data.task_id || started.data.taskId)) || '';
  const dispatched = !!(started && started.success);
  const wait = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy wait */ } };
  wait(holdMs);
  // 没派发成功就不要再叫停：否则会造出「dispatched=false 但 stopped=true」的假象
  const stopped = dispatched
    ? mcpCall('task_stop', taskId ? { task_id: taskId } : {})
    : { success: false };
  wait(2000);
  return {
    task_id: taskId,
    dispatched,
    stopped: !!(stopped && stopped.success),
    stop_message: String((stopped && stopped.message) || '').slice(0, 160),
    error: dispatched ? '' : String((started && started.message) || 'dispatch failed').slice(0, 160),
  };
}

/** 诊断用：只看「最后一条」usage（不参与成功判定，别拿它当某次运行的账）。 */
function extractLastUsage() {
  return extractUsageSince(Math.max(1, logSize() - 256 * 1024));
}

/** W1–W4：顺序派 N 个身体任务（每个都派发+取消），一条 run 事件收拢。 */
function runBodyBatch(tool, argsObj, holdMs, n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const one = runBodyTask(tool, argsObj, holdMs);
    items.push(one);
    if (!one.dispatched) break;   // 派发就失败，后面不用再试
  }
  return {
    batch: items,
    ok: items.length === n && items.every((x) => x.dispatched && x.stopped),
  };
}
function cmdRun() {
  const id = arg('id');
  const cmd = arg('cmd');
  if (!id) throw new Error('缺 --id');
  if (!ALLOWED_RUNS.includes(cmd)) {
    const e = new Error(`RUN_NOT_ALLOWED: 只允许 ${ALLOWED_RUNS.join('/')}`);
    e.code = 'RUN_NOT_ALLOWED';
    throw e;
  }
  const events = readEvents();
  const req = replay(events, id);
  if (!req) throw new Error(`没有这个请求：${id}`);

  // D1–D3：acx-smoke 是**只读探测**（只看端口），不派任务、不写 monitor、不启停游戏
  let exit;
  let out;
  let probe = null;
  const t0 = Date.now();
  const logAtStart = logSize();   // MF1：记下开跑时的日志字节数，后面只认新写入的部分
  if (cmd === 'acx-smoke') {
    probe = probePorts([8765, 8080, 8776]);
    const closed = probe.filter((p) => !p.open).map((p) => p.port);
    exit = closed.length === 0 ? 0 : 1;
    out = probe.map((p) => `${p.port}:${p.open ? 'open' : 'closed'}`).join(' ');
    if (closed.length) out += ` | 不在听: ${closed.join(',')}`;
  } else if (cmd === 'acx-task') {
    // T1–T4：真派一次 acx 任务并等到终态（只读 monitor，账本只写 run 事件）
    const acFile = arg('ac-file');
    if (!acFile) throw new Error('缺 --ac-file');
    const timeout = Number(arg('timeout') || 90000);
    probe = runAcxTask(fs.readFileSync(acFile, 'utf8'), timeout);
    exit = probe.state === 'SUCCESS' ? 0 : 1;
    // U1/U2：把这次之后最近一条 usage=UsageStats[...] 挂到 probe（抓不到就 null，不影响成败）
    probe.usage = extractUsageSince(logAtStart);
    out = `run_id=${probe.run_id} state=${probe.state} steps=${probe.steps}`;
  } else if (cmd === 'body-batch') {
    // W1–W4：顺序派 N 个身体任务，一条 run 事件收拢
    const tool = arg('tool') || 'goto';
    if (!ALLOWED_BODY_TOOLS.includes(tool)) {
      const e = new Error(`TOOL_NOT_ALLOWED: 只允许 ${ALLOWED_BODY_TOOLS.join('/')}`);
      e.code = 'TOOL_NOT_ALLOWED';
      throw e;
    }
    const n = Number(arg('n') || 2);
    if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH) {
      const e = new Error(`BATCH_TOO_LARGE: --n 必须在 1..${MAX_BATCH}`);
      e.code = 'BATCH_TOO_LARGE';
      throw e;
    }
    const rawArgs = arg('args') || '';
    const argsObj = {};
    for (const kv of rawArgs.split(/\s+/).filter(Boolean)) {
      const i = kv.indexOf('=');
      if (i > 0) argsObj[kv.slice(0, i)] = kv.slice(i + 1);
    }
    probe = runBodyBatch(tool, argsObj, Number(arg('hold') || 2500), n);
    probe.tool = tool;
    probe.args = rawArgs;
    probe.usage = extractUsageSince(logAtStart);
    exit = (probe.ok && probe.usage) ? 0 : 1;
    out = `n=${probe.batch.length}/${n} ok=${probe.ok} usage=${probe.usage ? 'yes' : 'null'}`;
  } else if (cmd === 'body-task') {
    // V1–V3：派一次身体任务（走 CompanionBrain）→ 3s 后取消 → 抓 usage
    const tool = arg('tool') || 'goto';
    if (!ALLOWED_BODY_TOOLS.includes(tool)) {
      const e = new Error(`TOOL_NOT_ALLOWED: 只允许 ${ALLOWED_BODY_TOOLS.join('/')}`);
      e.code = 'TOOL_NOT_ALLOWED';
      throw e;
    }
    const rawArgs = arg('args') || '';
    const argsObj = {};
    for (const kv of rawArgs.split(/\s+/).filter(Boolean)) {
      const i = kv.indexOf('=');
      if (i > 0) argsObj[kv.slice(0, i)] = kv.slice(i + 1);
    }
    probe = runBodyTask(tool, argsObj, Number(arg('hold') || 3000));
    probe.tool = tool;
    probe.args = rawArgs;
    // V1：usage 非 null 才算成功；V2：抓不到即 BLOCKED
    probe.usage = extractUsageSince(logAtStart);
    // MF2：派发与取消都得成——光有 usage 不够（可能是别的任务留下的）
    exit = (probe.usage && probe.dispatched && probe.stopped) ? 0 : 1;
    out = `task_id=${probe.task_id} dispatched=${probe.dispatched} stopped=${probe.stopped} usage=${probe.usage ? 'yes' : 'null'}`;
  } else {
    const args = [GATE, cmd];
    if (arg('keyword')) args.push('--keyword', arg('keyword'));
    if (arg('since')) args.push('--since', arg('since'));
    const { spawnSync } = require('node:child_process');
    const got = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: HARNESS });
    exit = got.status === null ? -1 : got.status;
    out = ((got.stdout || '') + (got.stderr || '')).trim();
  }
  const tail = out.split(/\r?\n/).slice(-3).join(' | ').slice(0, 300);
  // 先在内存里校验迁移合法（非法就不落任何盘，与 G7a 同一纪律）
  const evidence = [`run:${cmd}:exit=${exit}`];
  if (exit === 0) er.implement(req, { by: 'batch-bridge', evidenceRefs: evidence });
  else er.block(req, { by: 'batch-bridge', reason: `run ${cmd} exit=${exit}: ${tail}` });
  appendEvent({ kind: 'run', requestId: id, cmd, exit, ms: Date.now() - t0, tail, ...(probe ? { probe } : {}) });
  if (exit === 0) {
    appendEvent({
      kind: 'transition', requestId: id, to: 'IMPLEMENTED', by: 'batch-bridge',
      reason: `run ${cmd} exit=0`, evidenceRefs: evidence,
    });
  } else {
    appendEvent({
      kind: 'transition', requestId: id, to: 'BLOCKED', by: 'batch-bridge',
      reason: `run ${cmd} exit=${exit}: ${tail}`,
    });
  }
  const after = replay(readEvents(), id);
  // ★ G7b 扣账接真实消耗：给了 --budget-json 才记账（没授权就没有预算，与 G7a 同口径）。
  //   消耗口径：calls=1、tokens=ceil(输出字符/4)（粗估，宁可高估不许低估）。
  let spendInfo = null;
  const budgetRaw = arg('budget-json') || (arg('budget-file') ? fs.readFileSync(arg('budget-file'), 'utf8').replace(/^\uFEFF/, '') : null);
  if (budgetRaw) {
    const budgets = JSON.parse(budgetRaw);
    const before = spentOf(readEvents(), id);
    const add = { amount: Number(arg('amount') || 0), calls: 1, tokens: Math.ceil(out.length / 4) };
    // 先记实际消耗（钱已经花了，账不能丢），再看是否超限
    appendEvent({ kind: 'spend', requestId: id, ...add, note: `run:${cmd}` });
    spendInfo = spentOf(readEvents(), id);
    try {
      er.assertBudget(req, budgets, {
        amount: before.amount + add.amount, calls: before.calls + add.calls, tokens: before.tokens + add.tokens,
      }, { scope: req.scope });
    } catch (e) {
      // 超限：账已记，状态置 BLOCKED（理由带错误码），不许悄悄继续花
      const cur = replay(readEvents(), id);
      if (['RECEIVED', 'ACCEPTED', 'IMPLEMENTED', 'BLOCKED'].includes(cur.state)) {
        appendEvent({ kind: 'transition', requestId: id, to: 'BLOCKED', by: 'batch-bridge', reason: `${e.code}: ${e.message}` });
      }
      const blocked = replay(readEvents(), id);
      // 进程退出码要跟结果一致：外部 `$?` 不能把失败看成成功（复验提醒）
      process.exitCode = 2;
      console.log(JSON.stringify({ ok: false, id, cmd, exit, state: blocked.state, spend: spendInfo, budget: e.code }));
      return;
    }
  }
  process.exitCode = after.state === 'BLOCKED' ? 2 : 0;
  console.log(JSON.stringify({ ok: after.state !== 'BLOCKED', id, cmd, exit, state: after.state, spend: spendInfo }));
}

function cmdStart() {
  const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const e = {
    kind: 'created', requestId,
    contractRevision: arg('contract') || arg('revision') || '',
    batchId: arg('batch') || '',
    scope: arg('scope') || '',
    expectedBaseRevision: arg('base') || arg('revision') || '',
    budgetAuthorizationRef: arg('budget') || '',
    submitter: arg('submitter') || 'ai',
  };
  // ★ 断点要认基线：--revision 必须与宿主实际 HEAD 一致，否则当场拒（不落盘）
  const wantRev = arg('revision') || '';
  if (wantRev) {
    const { spawnSync } = require('node:child_process');
    const GIT = 'C:\\\\Users\\\\admin\\\\AppData\\\\Local\\\\Programs\\\\MinGit\\\\cmd\\\\git.exe';
    const got = spawnSync(GIT, ['-C', HARNESS, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    const actual = (got.stdout || '').trim();
    if (!actual) throw new Error('BASE_REVISION_MISMATCH: 读不到宿主 HEAD');
    if (actual !== wantRev && !actual.startsWith(wantRev) && !wantRev.startsWith(actual)) {
      const e = new Error(`BASE_REVISION_MISMATCH: 期望 ${wantRev}，实际 ${actual}`);
      e.code = 'BASE_REVISION_MISMATCH';
      throw e;
    }
  }
  // ★ 闸门：--require-game 时端口不全在听就拒（失败要发生在最便宜的地方）
  if (process.argv.includes('--require-game')) {
    const probe = probePorts([8765, 8080, 8776]);
    const closed = probe.filter((p) => !p.open).map((p) => p.port);
    if (closed.length) {
      const err = new Error(`GAME_NOT_READY: 端口不在听 ${closed.join(',')}`);
      err.code = 'GAME_NOT_READY';
      throw err;
    }
  }
  // ★ 预算：给了 --budget 就必须能在 --budget-json 里解析到有效授权（未填不等于无限）
  if (e.budgetAuthorizationRef) {
    const raw = arg('budget-json') || (arg('budget-file') ? fs.readFileSync(arg('budget-file'), 'utf8').replace(/^\uFEFF/, '') : null);
    if (!raw) {
      const err = new Error('NO_AUTHORIZATION: 给了 --budget 就必须同时给 --budget-json（否则无法校验）');
      err.code = 'NO_AUTHORIZATION';
      throw err;
    }
    er.assertBudget({ budgetAuthorizationRef: e.budgetAuthorizationRef }, JSON.parse(raw), {}, { scope: e.scope });
  }
  // 先用契约校验一遍（缺字段会抛），再落盘
  er.create({
    requestId, contractRevision: e.contractRevision, batchId: e.batchId, scope: e.scope,
    expectedBaseRevision: e.expectedBaseRevision, budgetAuthorizationRef: e.budgetAuthorizationRef,
    submitter: e.submitter,
  });
  appendEvent(e);
  console.log(JSON.stringify({ ok: true, requestId, ledger: ledgerFile() }));
}

function transitionCmd(to) {
  const id = arg('id');
  if (!id) throw new Error('缺 --id');
  const events = readEvents();
  const req = replay(events, id);
  if (!req) throw new Error(`没有这个请求：${id}`);
  const opts = {
    by: arg('by') || 'ai', reason: arg('reason') || '',
    reviewer: arg('reviewer') || '', evidenceRefs: args('evidence'),
  };
  // 先在内存里跑一遍（非法迁移在这里就抛），再落事件
  if (to === 'ACCEPTED') er.accept(req, opts);
  else if (to === 'IMPLEMENTED') er.implement(req, opts);
  else if (to === 'VERIFIED') er.verify(req, opts);
  else if (to === 'BLOCKED') er.block(req, opts);
  else if (to === 'REJECTED') er.reject(req, opts);
  appendEvent({ kind: 'transition', requestId: id, to, ...opts });
  const after = replay(readEvents(), id);
  console.log(JSON.stringify({ ok: true, id, state: after.state, transitions: after.transitions.length }));
}

function cmdList() {
  const reqs = allRequests(readEvents());
  if (process.argv.includes('--json')) return console.log(JSON.stringify(reqs, null, 2));
  if (!reqs.length) return console.log('（还没有请求）');
  for (const r of reqs) {
    if (r.state === 'UNREADABLE') {
      console.log(`${r.requestId}  UNREADABLE  ${r.error || ''}`);
      continue;
    }
    const s = spentOf(readEvents(), r.requestId);
    console.log(`${r.requestId}  ${r.state.padEnd(11)}  ${r.batchId}  ev=${r.evidenceRefs.length}  ${r.transitions.length} 步  spent=${s.amount}/${s.calls}/${s.tokens}`);
}

}

function cmdShow() {
  const id = arg('id');
  // --events：打原始事件（含 run/spend）。复验者提醒过：transitions[].at 是重放时刻，
  // 不是真实时刻，对账必须看 JSONL 原文。
  if (process.argv.includes('--events')) {
    const file = ledgerFile();
    if (!fs.existsSync(file)) return console.log('（账本不存在）');
    const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    let n = 0;
    lines.forEach((l, i) => {
      if (!l.trim()) return;
      let e = null;
      try { e = JSON.parse(l); } catch { return; }
      if (e.requestId !== id) return;
      n++;
      console.log(`L${i + 1}\t${JSON.stringify(e)}`);
    });
    if (!n) console.log('（这个请求没有事件）');
    return;
  }
  const req = replay(readEvents(), id);
  if (!req) return console.log('没有这个请求：' + id);
  console.log(JSON.stringify(req, null, 2));
}

/**
 * G7c 综合压力：多批并发 + 预算耗尽 + 断点恢复。
 *
 * C1 三请求事件交错写同一账本，状态/消耗互不串；
 * C2 其中一个预算耗尽 → 只有它 BLOCKED；
 * C3 两个进程同时写同一账本，行不损坏、条数对得上；
 * C4 断点只回自己，不牵连别人。
 */
function cmdStress() {
  const os = require('node:os');
  const { spawn } = require('node:child_process');
  const tmp = path.join(os.tmpdir(), `bridge-stress-${Date.now()}.jsonl`);
  const keep = process.env.RDD_BRIDGE_LEDGER;
  process.env.RDD_BRIDGE_LEDGER = tmp;
  const failures = [];
  const step = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message}`); } };
  const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
  const sha = headRevision();
  const budgets = '{"s1":{"amount":0,"calls":99,"tokens":999999,"scope":"harness"}}';
  const ids = [];

  step('C1 三请求交错', () => {
    for (let i = 0; i < 3; i++) {
      process.argv = ['node', 'b', 'start', '--batch', `S${i}`, '--scope', 'harness', '--revision', sha];
      quiet(() => cmdStart());
    }
    const reqs = allRequests(readEvents());
    if (reqs.length !== 3) throw new Error('请求数 ' + reqs.length);
    for (const r of reqs) ids.push(r.requestId);
    for (const id of ids) {
      process.argv = ['node', 'b', 'accept', '--id', id, '--by', 'ai'];
      quiet(() => transitionCmd('ACCEPTED'));
    }
    for (const id of ids) if (replay(readEvents(), id).state !== 'ACCEPTED') throw new Error('不是 ACCEPTED: ' + id);
  });

  step('C2 预算耗尽只影响自己', () => {
    const target = ids[1];
    process.argv = ['node', 'b', 'run', '--id', target, '--cmd', 'selftest', '--budget-json', budgets];
    quiet(() => cmdRun());
    const t = replay(readEvents(), target);
    if (t.state !== 'BLOCKED') throw new Error('目标应 BLOCKED，实际 ' + t.state);
    if (spentOf(readEvents(), target).calls < 1) throw new Error('没记到消耗');
    for (const id of [ids[0], ids[2]]) {
      if (replay(readEvents(), id).state !== 'ACCEPTED') throw new Error('被牵连：' + id);
      if (spentOf(readEvents(), id).calls !== 0) throw new Error('消耗串了：' + id);
    }
  });

  step('C4 断点只回自己', () => {
    process.argv = ['node', 'b', 'resume', '--id', ids[1], '--by', 'ai'];
    quiet(() => cmdResume());
    if (replay(readEvents(), ids[1]).state !== 'ACCEPTED') throw new Error('resume 后不是 ACCEPTED');
    if (replay(readEvents(), ids[0]).state !== 'ACCEPTED') throw new Error('无关请求被改了');
  });

  const finish = (extra) => {
    if (keep === undefined) delete process.env.RDD_BRIDGE_LEDGER; else process.env.RDD_BRIDGE_LEDGER = keep;
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    const r = { ok: failures.length === 0, failures, ...extra };
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  };

  const writers = [0, 1].map((n) => new Promise((resolve) => {
    const p = spawn(process.execPath, [__filename, 'stress-writer', '--n', String(n)], {
      env: { ...process.env, RDD_BRIDGE_LEDGER: tmp }, stdio: 'ignore',
    });
    p.on('exit', (code) => resolve(code));
  }));
  Promise.all(writers).then((codes) => {
    if (codes.some((c) => c !== 0)) failures.push('C3 子进程失败 ' + codes.join(','));
    const lines = fs.readFileSync(tmp, 'utf8').split(/\r?\n/).filter(Boolean);
    let bad = 0;
    let marks = 0;
    for (const l of lines) {
      try { const e = JSON.parse(l); if (e.kind === 'writer-mark') marks++; } catch { bad++; }
    }
    if (bad) failures.push(`C3 有 ${bad} 行损坏`);
    if (marks !== 200) failures.push(`C3 写入条数 ${marks}（应 200）`);
    finish({ lines: lines.length, marks });
  });
}

function cmdStressWriter() {
  const n = Number(arg('n') || 0);
  for (let i = 0; i < 100; i++) appendEvent({ kind: 'writer-mark', requestId: `w${n}-${i}`, i });
  process.exit(0);
}

/** C5/C6：子进程写 N 条完整事件 + 一条截断 JSON（无换行）后退出，模拟"写到半行就崩"。 */
function cmdCrashWriter() {
  const n = Number(arg('n') || 10);
  for (let i = 0; i < n; i++) appendEvent({ kind: 'writer-mark', requestId: `crash-${i}`, i });
  // 故意不换行、不闭合
  fs.appendFileSync(ledgerFile(), '{"v":1,"kind":"half', 'utf8');
  process.exit(0);
}

function cmdStressCrash() {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const tmp = path.join(os.tmpdir(), `bridge-crash-${Date.now()}.jsonl`);
  const keep = process.env.RDD_BRIDGE_LEDGER;
  process.env.RDD_BRIDGE_LEDGER = tmp;
  const failures = [];
  const N = 10;
  const run = spawnSync(process.execPath, [__filename, 'crash-writer', '--n', String(N)],
    { env: { ...process.env, RDD_BRIDGE_LEDGER: tmp }, stdio: 'ignore' });
  if (run.status !== 0) failures.push('crash-writer 退出码 ' + run.status);

  // C5：残行存在时，完整事件必须全部读得到、且不抛
  let complete = 0;
  let bad = 0;
  const readAll = () => {
    complete = 0; bad = 0;
    for (const l of fs.readFileSync(tmp, 'utf8').split(/\r?\n/)) {
      if (!l.trim()) continue;
      try { JSON.parse(l); complete++; } catch { bad++; }
    }
  };
  try {
    readAll();
  } catch (e) {
    failures.push('C5 读账本抛异常: ' + e.message);
  }
  if (complete !== N) failures.push(`C5 完整事件 ${complete}（应 ${N}）`);
  if (bad !== 1) failures.push(`C5 残行 ${bad}（应 1）`);
  const listed = spawnSync(process.execPath, [__filename, 'list'],
    { env: { ...process.env, RDD_BRIDGE_LEDGER: tmp }, encoding: 'utf8' });
  if (listed.status !== 0) failures.push('C5 list 退出码 ' + listed.status);

  // C6：残行之后继续 append，不许粘行
  appendEvent({ kind: 'writer-mark', requestId: 'after-crash', i: 99 });
  readAll();
  if (complete !== N + 1) failures.push(`C6 append 后完整事件 ${complete}（应 ${N + 1}）`);
  const text = fs.readFileSync(tmp, 'utf8');
  const badLines = text.split(/\r?\n/).filter((l) => l.trim() && !isJson(l));
  if (badLines.length !== 1) failures.push(`C6 坏行 ${badLines.length}（残行应与新行分开，保持 1 条）`);
  const glued = text.split(/\r?\n/).filter((l) => (l.match(/\{"v":1/g) || []).length > 1);
  if (glued.length) failures.push(`C6 有 ${glued.length} 行粘了两条事件`);

  if (keep === undefined) delete process.env.RDD_BRIDGE_LEDGER; else process.env.RDD_BRIDGE_LEDGER = keep;
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  const r = { ok: failures.length === 0, failures, complete, bad };
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

function isJson(s) {
  try { JSON.parse(s); return true; } catch { return false; }
}

/** C7/C8：持续写、等父进程 SIGKILL（不是自己优雅退出）。 */
function cmdKillWriter() {
  let i = 0;
  const tick = () => {
    appendEvent({ kind: 'writer-mark', requestId: `kill-${i}`, i });
    i++;
    setTimeout(tick, 2);
  };
  tick();
}

function cmdStressKill() {
  const os = require('node:os');
  const { spawn, spawnSync } = require('node:child_process');
  const tmp = path.join(os.tmpdir(), `bridge-kill-${Date.now()}.jsonl`);
  const keep = process.env.RDD_BRIDGE_LEDGER;
  process.env.RDD_BRIDGE_LEDGER = tmp;
  const failures = [];

  const child = spawn(process.execPath, [__filename, 'kill-writer'], {
    env: { ...process.env, RDD_BRIDGE_LEDGER: tmp }, stdio: 'ignore',
  });
  const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 250);

  child.on('exit', (code, signal) => {
    clearTimeout(killer);
    let complete = 0;
    let bad = 0;
    let text = '';
    try { text = fs.readFileSync(tmp, 'utf8'); } catch { failures.push('C7 账本不存在'); }
    for (const l of text.split(/\r?\n/)) {
      if (!l.trim()) continue;
      if (isJson(l)) complete++; else bad++;
    }
    if (complete < 5) failures.push(`C7 完整行只有 ${complete}`);
    if (bad > 1) failures.push(`C7 坏行 ${bad}（应 ≤1）`);

    appendEvent({ kind: 'writer-mark', requestId: 'after-kill', i: -1 });
    const text2 = fs.readFileSync(tmp, 'utf8');
    const glued = text2.split(/\r?\n/).filter((l) => (l.match(/\{"v":1/g) || []).length > 1);
    if (glued.length) failures.push(`C8 有 ${glued.length} 行粘连`);
    if (!isJson(text2.trim().split(/\r?\n/).pop())) failures.push('C8 最后一行不是合法事件');
    const listed = spawnSync(process.execPath, [__filename, 'list'],
      { env: { ...process.env, RDD_BRIDGE_LEDGER: tmp }, encoding: 'utf8' });
    if (listed.status !== 0) failures.push('C8 list 退出码 ' + listed.status);

    if (keep === undefined) delete process.env.RDD_BRIDGE_LEDGER; else process.env.RDD_BRIDGE_LEDGER = keep;
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    const r = { ok: failures.length === 0, failures, complete, bad, signal: String(signal), code };
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });
}

// ───────────── G8 好奇心支线（第一版：世界 → 一个问题，不派发） ─────────────

const CURIO_DAILY_MAX = 5;
const CURIO_DEDUPE_MS = 24 * 3600 * 1000;

/** 世界快照 → 0 或 1 条候选（K1/K3：没新东西就不造）。 */
function curiosityCandidate(world) {
  const seenBlocks = new Set(world.seenBlocks || []);
  const seenItems = new Set(world.seenItems || []);
  for (const b of world.blocks || []) {
    if (b && !seenBlocks.has(b)) {
      return { trigger: 'new_block', target: b, question: b + ' 挖了会掉什么？', action: 'dig' };
    }
  }
  for (const it of world.inventory || []) {
    if (it && !seenItems.has(it)) {
      return { trigger: 'new_item', target: it, question: it + ' 能用来做什么？', action: 'craft' };
    }
  }
  return null;
}

function cmdCuriosity() {
  const worldFile = arg('world-file');
  if (!worldFile) throw new Error('缺 --world-file（世界快照 JSON）');
  const world = JSON.parse(fs.readFileSync(worldFile, 'utf8').replace(/^\uFEFF/, ''));
  const events = readEvents();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todays = events.filter((e) => e.kind === 'curiosity' && e.at >= today.getTime());
  if (todays.length >= CURIO_DAILY_MAX) {
    process.exitCode = 2;
    return console.log(JSON.stringify({ ok: false, code: 'QUOTA_EXCEEDED', today: todays.length }));
  }
  const cand = curiosityCandidate(world);
  if (!cand) {
    return console.log(JSON.stringify({ ok: true, code: 'NOTHING_NEW' }));
  }
  const recent = events.filter((e) => e.kind === 'curiosity' && e.at >= Date.now() - CURIO_DEDUPE_MS);
  if (recent.some((e) => e.target === cand.target && e.trigger === cand.trigger)) {
    return console.log(JSON.stringify({ ok: true, code: 'DUPLICATE_24H', target: cand.target }));
  }
  appendEvent({
    kind: 'curiosity',
    requestId: 'curio-' + Date.now().toString(36),
    questId: 'q-' + Date.now().toString(36),
    trigger: cand.trigger, target: cand.target, question: cand.question,
    hypothesis: '', action: cand.action, state: 'ASKED',
  });
  console.log(JSON.stringify({ ok: true, code: 'ASKED', target: cand.target, question: cand.question }));
}

/**
 * G8 第二版：真世界触发（用当前工具面**真实可取**的三样东西）。
 * 取不到 → NO_WORLD（exit 2，不落盘）；没有新东西 → NOTHING_NEW。
 * K7 的诚实点：world.blocksFound=false，意思是「这次没有扫方块」，不是「没有方块」。
 */
function cmdCuriosityLive() {
  const info = mcpCall('get_world_info', {});
  if (!info || info.success === false) {
    process.exitCode = 2;
    return console.log(JSON.stringify({ ok: false, code: 'NO_WORLD', why: 'get_world_info 失败' }));
  }
  const st = mcpCall('get_self_status', {});
  if (!st || st.success === false) {
    process.exitCode = 2;
    return console.log(JSON.stringify({ ok: false, code: 'NO_WORLD', why: 'get_self_status 失败' }));
  }
  const events = readEvents();
  const seenItems = events.filter((x) => x.kind === 'curiosity' && x.trigger === 'new_item').map((x) => x.target);
  const seenStructures = events.filter((x) => x.kind === 'curiosity' && x.trigger === 'new_structure').map((x) => x.target);
  const seenWeather = events.filter((x) => x.kind === 'curiosity' && x.trigger === 'weather_change').map((x) => x.target);

  const hand = st.equipment && st.equipment.mainhand && st.equipment.mainhand.item;
  const structures = st.structures || [];
  const weather = info.weather;

  let cand = null;
  if (hand && !seenItems.includes(hand)) {
    cand = { trigger: 'new_item', target: hand, question: hand + ' 能用来做什么？', action: 'craft' };
  } else if (structures.some((s) => !seenStructures.includes(s))) {
    const s = structures.find((x) => !seenStructures.includes(x));
    cand = { trigger: 'new_structure', target: s, question: s + ' 里有什么？', action: 'explore' };
  } else if (weather && !seenWeather.includes(weather)) {
    cand = { trigger: 'weather_change', target: weather, question: '在这种天气（' + weather + '）下能做什么？', action: 'explore' };
  }
  if (!cand) return console.log(JSON.stringify({ ok: true, code: 'NOTHING_NEW', source: 'live' }));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todays = events.filter((x) => x.kind === 'curiosity' && x.at >= today.getTime());
  if (todays.length >= CURIO_DAILY_MAX) {
    process.exitCode = 2;
    return console.log(JSON.stringify({ ok: false, code: 'QUOTA_EXCEEDED', today: todays.length }));
  }
  appendEvent({
    kind: 'curiosity',
    requestId: 'curio-' + Date.now().toString(36),
    questId: 'q-' + Date.now().toString(36),
    trigger: cand.trigger, target: cand.target, question: cand.question,
    hypothesis: '', action: cand.action, state: 'ASKED', source: 'live',
    blocksFound: false,
    meta: { biome: st.biome, dimension: info.dimension, weather, isDark: info.is_dark_outside },
  });
  console.log(JSON.stringify({ ok: true, code: 'ASKED', source: 'live', trigger: cand.trigger, target: cand.target, question: cand.question }));
}

function selftest() {
  const tmp = path.join(require('node:os').tmpdir(), `bridge-${Date.now()}.jsonl`);
  const keep = process.env.RDD_BRIDGE_LEDGER;
  process.env.RDD_BRIDGE_LEDGER = tmp;
  const failures = [];
  const step = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message}`); } };

  step('start→accept→implement→verify', () => {
    const before = process.argv.slice();
    const head = require('node:child_process')
      .spawnSync('C:\\\\Users\\\\admin\\\\AppData\\\\Local\\\\Programs\\\\MinGit\\\\cmd\\\\git.exe',
        ['-C', HARNESS, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    const sha = (head.stdout || '').trim();
    process.argv = ['node', 'batch-bridge.js', 'start', '--batch', 'T', '--scope', 's', '--revision', sha];
    cmdStart();
    const id = JSON.parse(fs.readFileSync(tmp, 'utf8').trim()).requestId;
    process.argv = ['node', 'b', 'accept', '--id', id];
    transitionCmd('ACCEPTED');
    process.argv = ['node', 'b', 'implement', '--id', id, '--evidence', 'x:1'];
    transitionCmd('IMPLEMENTED');
    process.argv = ['node', 'b', 'verify', '--id', id, '--reviewer', 'auditor', '--evidence', 'y:2'];
    transitionCmd('VERIFIED');
    const req = replay(readEvents(), id);
    if (req.state !== 'VERIFIED') throw new Error('终态不是 VERIFIED');
    if (!req.verifiedBy) throw new Error('没记核验者');
    process.argv = before;
  });

  step('重放稳定', () => {
    const reqs = allRequests(readEvents());
    if (reqs.length !== 1) throw new Error('请求数 ' + reqs.length);
    const again = replay(readEvents(), reqs[0].requestId);
    if (again.state !== reqs[0].state) throw new Error('重放不一致');
  });

  step('B1/B2 扣账累计 + list 的 spent', () => {
    const sha = headRevision();
    process.argv = ['node', 'b', 'start', '--batch', 'B', '--scope', 'harness', '--revision', sha,
      '--budget', 'b1', '--budget-json', '{"b1":{"amount":10,"calls":2,"tokens":100,"scope":"harness"}}'];
    cmdStart();
    const id = allRequests(readEvents()).find((r) => r.batchId === 'B').requestId;
    // 刚好到上限：放行
    process.argv = ['node', 'b', 'spend', '--id', id, '--amount', '10', '--calls', '2', '--tokens', '100',
      '--budget-json', '{"b1":{"amount":10,"calls":2,"tokens":100,"scope":"harness"}}'];
    cmdSpend();
    const before = fs.readFileSync(tmp, 'utf8').trim().split('\n').length;
    // 再花 1：累计超限，必须拒且不落盘
    process.argv = ['node', 'b', 'spend', '--id', id, '--amount', '1',
      '--budget-json', '{"b1":{"amount":10,"calls":2,"tokens":100,"scope":"harness"}}'];
    try {
      cmdSpend();
      throw new Error('超限应当被拒');
    } catch (e) {
      if (e.message === '超限应当被拒') throw e;
    }
    const after = fs.readFileSync(tmp, 'utf8').trim().split('\n').length;
    if (after !== before) throw new Error('超限的 spend 不该落盘');
    const s = spentOf(readEvents(), id);
    if (s.amount !== 10 || s.calls !== 2 || s.tokens !== 100) throw new Error(JSON.stringify(s));
  });

  step('B4 resume 只认基线', () => {
    const sha = headRevision();
    process.argv = ['node', 'b', 'start', '--batch', 'R', '--scope', 'harness', '--revision', sha];
    cmdStart();
    const id = allRequests(readEvents()).find((r) => r.batchId === 'R').requestId;
    process.argv = ['node', 'b', 'block', '--id', id, '--reason', '测试阻塞'];
    transitionCmd('BLOCKED');
    process.argv = ['node', 'b', 'resume', '--id', id, '--by', 'ai'];
    cmdResume();
    const req = replay(readEvents(), id);
    if (req.state !== 'ACCEPTED') throw new Error('resume 后应为 ACCEPTED，实际 ' + req.state);
    if (!req.transitions.some((t) => t.reason.includes('resume'))) throw new Error('没记 resume 理由');
  });

  step('run 自动扣账 + 超限置 BLOCKED', () => {
    const sha = headRevision();
    const budgets = '{"b9":{"amount":0,"calls":9,"tokens":10,"scope":"harness"}}';
    process.argv = ['node', 'b', 'start', '--batch', 'C', '--scope', 'harness', '--revision', sha];
    cmdStart();
    const id = allRequests(readEvents()).find((r) => r.batchId === 'C').requestId;
    process.argv = ['node', 'b', 'accept', '--id', id, '--by', 'ai'];
    transitionCmd('ACCEPTED');
    // token 上限设成 10，跑一次检查必然超（输出远大于 40 字符）→ 账要记、状态要 BLOCKED
    process.argv = ['node', 'b', 'run', '--id', id, '--cmd', 'selftest', '--budget-json', budgets];
    const realLog = console.log;
    console.log = () => {};              // 静音 run 的输出
    try { cmdRun(); } finally { console.log = realLog; }
    const req = replay(readEvents(), id);
    if (!['BLOCKED', 'ACCEPTED', 'IMPLEMENTED'].includes(req.state)) throw new Error('状态异常 ' + req.state);
    const s = spentOf(readEvents(), id);
    if (s.calls < 1 || s.tokens < 1) throw new Error('没有记到实际消耗：' + JSON.stringify(s));
    if (req.state !== 'BLOCKED') throw new Error('超限后应为 BLOCKED，实际 ' + req.state);
  });

  step('usage 严格窗口（MF1 残余）', () => {
    if (extractUsageSince(0) !== null) throw new Error('偏移 0 必须返回 null（不许回退尾部扫描）');
    if (extractUsageSince(-5) !== null) throw new Error('负偏移必须返回 null');
    if (extractUsageSince(logSize() + 1) !== null) throw new Error('超出文件必须返回 null');
  });
  step('非法迁移被拒且不落盘', () => {
    const id = allRequests(readEvents())[0].requestId;
    const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n').length;
    process.argv = ['node', 'b', 'accept', '--id', id];
    try {
      transitionCmd('ACCEPTED');
      throw new Error('应当被拒');
    } catch (e) {
      if (e.message === '应当被拒') throw e;   // 契约错误是预期
    }
    const after = fs.readFileSync(tmp, 'utf8').trim().split('\n').length;
    if (after !== lines) throw new Error('被拒的迁移不该落盘');
  });

  if (keep === undefined) delete process.env.RDD_BRIDGE_LEDGER;
  else process.env.RDD_BRIDGE_LEDGER = keep;
  try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  const r = { ok: failures.length === 0, failures };
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

try {
  const cmd = process.argv[2];
  if (cmd === 'start') cmdStart();
  else if (cmd === 'accept') transitionCmd('ACCEPTED');
  else if (cmd === 'implement') transitionCmd('IMPLEMENTED');
  else if (cmd === 'verify') transitionCmd('VERIFIED');
  else if (cmd === 'block') transitionCmd('BLOCKED');
  else if (cmd === 'reject') transitionCmd('REJECTED');
  else if (cmd === 'list') cmdList();
  else if (cmd === 'spend') cmdSpend();
  else if (cmd === 'resume') cmdResume();
  else if (cmd === 'usage') console.log(JSON.stringify(extractLastUsage(), null, 2));
  else if (cmd === 'curiosity-promote') {
    const r = require('./lib/curiosity').promote({ readEvents, appendEvent });
    process.exitCode = r.exit || 0;
    console.log(JSON.stringify(r));
  }
  else if (cmd === 'curiosity-close') {
    const r = require('./lib/curiosity').closeQuest({ readEvents, appendEvent }, arg('finding'));
    process.exitCode = r.exit || 0;
    console.log(JSON.stringify(r));
  }
  else if (cmd === 'curiosity-list') {
    const r = require('./lib/curiosity').list({ readEvents }, Number(arg('n') || 10));
    console.log(JSON.stringify(r));
  }
  else if (cmd === 'curiosity-move') {
    const r = require('./lib/curiosity').move({ readEvents, appendEvent });
    process.exitCode = r.exit || 0;
    console.log(JSON.stringify(r));
  }
  else if (cmd === 'curiosity-act') {
    const r = require('./lib/curiosity').act({ readEvents, appendEvent });
    process.exitCode = r.exit || 0;
    console.log(JSON.stringify(r));
  }
  else if (cmd === 'curiosity') {
    if (process.argv.includes('--live')) cmdCuriosityLive(); else cmdCuriosity();
  }
  else if (cmd === 'run') cmdRun();
  else if (cmd === 'stress') cmdStress();
  else if (cmd === 'stress-writer') cmdStressWriter();
  else if (cmd === 'stress-crash') cmdStressCrash();
  else if (cmd === 'crash-writer') cmdCrashWriter();
  else if (cmd === 'stress-kill') cmdStressKill();
  else if (cmd === 'kill-writer') cmdKillWriter();
  else if (cmd === 'show') cmdShow();
  else if (cmd === 'selftest') selftest();
  else {
    console.log('用法：start|accept|implement|verify|block|reject|list|show [--events]|selftest（见文件头）');
    process.exit(1);
  }
} catch (e) {
  console.error(JSON.stringify({ ok: false, code: e.code || 'ERROR', message: e.message }));
  process.exit(2);
}
