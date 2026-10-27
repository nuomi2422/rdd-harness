#!/usr/bin/env node
/**
 * run-long-horizon.js —— 一条命令跑「超长线任务」（2026-10-27 goal 第 10 轮）
 *
 * 主人要的那件事：「发送通关mc指令看超长时任务效果」。
 * 这一步依赖游戏实例，而实例常被并行会话占着；所以把**那一整串动作**先写成一条命令，
 * 窗口一开就能跑，不用临场拼参数（临场拼＝每次都少一步、每次都采不到同一批判据）。
 *
 * 它做什么（顺序固定，任一步失败就停并如实报）：
 *   1. 预检：跑 harness-gate preflight，`VERDICT=BLOCKED` 直接拒绝（不绕门禁）
 *   2. 实例：java 进程不在 → 调 start-rdd.ps1 起（已在则跳过）
 *   3. 等 MCP 8765 通（最多 --wait 秒）
 *   4. list_companions → 选定同伴（名字可用 --companion 指定）
 *   5. rdd_supervisor_submit 发目标（代码层直发，不冒充主人打字）
 *   6. 轮询链形状：每 --poll 秒采一次 rdd_status，记录 stages/current/subtask 推进
 *   7. 到点出报告：链形状变化、死亡数、工具调用数、关键事件（recovery/side_task/replanned）
 *   8. 除非 --keep-running，否则停实例（stop-rdd.ps1）
 *
 * 判据（与 V-20261027-01 对齐）：
 *   J1 回执含 "objective accepted"；J2 supervisor_input.source=rdd_supervisor_submit；
 *   J3 阶段数 ≥5 且覆盖到尾盘（下界/末地）；J4 期间无整段 replanned。
 *
 * 用法：
 *   node run-long-horizon.js --objective "通关MC（干掉末影龙）" --minutes 40
 *   node run-long-horizon.js --dry-run            # 只打计划，不动实例
 *   node run-long-horizon.js --companion RDD --keep-running
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = 'D:\\rdd';
const MCP = path.join(ROOT, 'workspace', 'rdd-selfcompile', 'scripts', 'mcp-call.js');
const GATE = path.join(ROOT, 'harness', 'rdd-harness', 'bin', 'harness-gate.js');
const START = path.join(ROOT, 'start-rdd.ps1');
const STOP = path.join(ROOT, 'stop-rdd.ps1');
const MONITOR = path.join(ROOT, 'mc', 'The Best of Twilight Forest', 'config', 'numen', 'monitor');
const JOURNAL = path.join(ROOT, 'harness', 'rdd-harness', 'experiments', 'journal');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (n) => process.argv.includes('--' + n);

function run(cmd, args, timeout) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: timeout || 120000, windowsHide: true });
}

function mcpCall(tool, companion, argsObj) {
  // mcp-call.js 的契约：companion 必须作为独立参数（踩过 4 次的坑）
  const payload = JSON.stringify(argsObj || {});
  const r = run(process.execPath, [MCP, tool, companion, payload], 60000);
  const out = (r.stdout || '') + (r.stderr || '');
  return { ok: r.status === 0, out, code: r.status };
}

function javaCount() {
  const r = run('powershell.exe',
    ['-NoProfile', '-Command', '@(Get-Process java,javaw -ErrorAction SilentlyContinue).Count'], 20000);
  return Number(String(r.stdout || '0').trim()) || 0;
}

function portOpen(port) {
  const r = run('powershell.exe',
    ['-NoProfile', '-Command',
      `$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',${port}); 'open'}catch{'closed'}finally{$c.Dispose()}`],
    15000);
  return String(r.stdout || '').includes('open');
}

function preflightVerdict() {
  const today = new Date().toISOString().slice(0, 10);
  const r = run(process.execPath, [GATE, 'preflight', '--since', today, '--keyword', 'rdd'], 300000);
  const txt = (r.stdout || '') + (r.stderr || '');
  const m = txt.match(/VERDICT=(\w+)/);
  const counts = txt.match(/PASS=(\d+)\s+WARN=(\d+)\s+BLOCK=(\d+)/);
  return {
    verdict: m ? m[1] : 'UNKNOWN',
    pass: counts ? Number(counts[1]) : null,
    warn: counts ? Number(counts[2]) : null,
    block: counts ? Number(counts[3]) : null,
    text: txt,
  };
}

/** 从 monitor 目录读最近事件计数（只读尾部，别把 16MB 文件全读进来）。 */
function tailCount(file, pattern, maxBytes) {
  try {
    const st = fs.statSync(file);
    const take = Math.min(st.size, maxBytes || 8 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, st.size - take);
    fs.closeSync(fd);
    const txt = buf.toString('utf8');
    const m = txt.match(pattern);
    return txt.split(pattern).length - 1;
  } catch {
    return -1;
  }
}

async function main() {
  const objective = arg('objective', '通关MC（干掉末影龙）');
  const minutes = Number(arg('minutes', '40'));
  const pollSec = Number(arg('poll', '30'));
  const waitSec = Number(arg('wait', '300'));
  const companion = arg('companion', '');
  const dry = has('dry-run');
  const keep = has('keep-running');

  console.log('=== 超长线任务 runbook ===');
  console.log(`  目标：${objective}`);
  console.log(`  轮询：${minutes} 分钟内每 ${pollSec}s 采一次；等 MCP 最多 ${waitSec}s`);
  console.log(`  同伴：${companion || '（自动从 list_companions 选）'}`);
  console.log(`  结束时：${keep ? '保持实例运行' : '停实例'}`);

  if (dry) {
    console.log('\n[dry-run] 计划已打印，未动实例、未调 MCP。');
    console.log('  真跑：node run-long-horizon.js --objective "' + objective + '" --minutes ' + minutes);
    process.exit(0);
  }

  // 1) 预检
  console.log('\n[1/8] 预检 harness-gate preflight …');
  const pf = preflightVerdict();
  console.log(`      VERDICT=${pf.verdict}（PASS=${pf.pass} WARN=${pf.warn} BLOCK=${pf.block}）`);
  if (pf.verdict !== 'PASS') {
    console.error('✘ 预检没过，拒绝起实例（门禁是硬的，不绕）。先处理 BLOCK 项。');
    const blocks = (pf.text.match(/✘ [^\n]+/g) || []).slice(0, 5);
    blocks.forEach((b) => console.error('   ' + b.trim()));
    process.exit(3);
  }

  // 2) 实例
  let started = false;
  if (javaCount() === 0) {
    console.log('[2/8] 起实例（start-rdd.ps1，约 150s）…');
    const r = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', START], 600000);
    started = true;
    if (r.status !== 0) {
      console.error('✘ 起实例失败：' + (r.stderr || '').slice(0, 400));
      process.exit(4);
    }
  } else {
    console.log('[2/8] 实例已在运行，跳过启动');
  }

  // 3) 等 MCP
  console.log('[3/8] 等 MCP 8765 …');
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    if (portOpen(8765)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!portOpen(8765)) {
    console.error(`✘ ${waitSec}s 内 MCP 8765 没通`);
    process.exit(5);
  }

  // 4) 选同伴
  console.log('[4/8] list_companions …');
  const list = mcpCall('list_companions', companion || 'RDD', {});
  console.log('      ' + (list.out || '').trim().split('\n').slice(0, 6).join('\n      '));
  const nameMatch = (list.out || '').match(/"?name"?\s*[:=]\s*"?([A-Za-z0-9_]+)"?/);
  const who = companion || (nameMatch ? nameMatch[1] : 'RDD');

  // 5) 发目标（代码层直发）
  console.log(`[5/8] rdd_supervisor_submit → ${who} …`);
  const submit = mcpCall('rdd_supervisor_submit', who, { objective });
  console.log('      ' + (submit.out || '').trim().slice(0, 400));
  const accepted = /objective accepted/i.test(submit.out || '');
  if (!accepted) {
    console.error('✘ 提交未被受理（回执见上）。');
    if (!keep) run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STOP], 180000);
    process.exit(6);
  }

  // 6) 轮询链形状
  console.log(`[6/8] 轮询 ${minutes} 分钟 …`);
  const samples = [];
  const endAt = Date.now() + minutes * 60000;
  const startedAt = Date.now();
  while (Date.now() < endAt) {
    const st = mcpCall('rdd_status', who, {});
    const line = (st.out || '').replace(/\s+/g, ' ').slice(0, 260);
    samples.push({ at: new Date().toISOString(), ok: st.ok, line });
    const elapsed = Math.round((Date.now() - startedAt) / 60000);
    console.log(`      +${elapsed}m  ${line.slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, Math.max(15, pollSec) * 1000));
  }

  // 7) 汇总
  console.log('[7/8] 汇总事件 …');
  const rddFile = path.join(MONITOR, 'rdd.jsonl');
  const instrFile = path.join(MONITOR, 'instrumentation.jsonl');
  const toolsFile = path.join(MONITOR, 'tools.jsonl');
  const summary = {
    objective,
    companion: who,
    startedAt: new Date(startedAt).toISOString(),
    minutes,
    startedInstance: started,
    submitAccepted: accepted,
    samples: samples.slice(-40),
    events: {
      supervisor_input: tailCount(rddFile, /"type":"supervisor_input"/g),
      goal_staged: tailCount(rddFile, /"type":"goal_staged"/g),
      replanned: tailCount(rddFile, /"type":"replanned"/g),
      side_task_created: tailCount(rddFile, /"type":"side_task_created"/g),
      recovery_named_from_needs: tailCount(rddFile, /"type":"recovery_named_from_needs"/g),
      deaths: tailCount(instrFile, /"type":"death"/g),
    },
    stagePatternsInjected: tailCount(rddFile, /stage_patterns/g),
    toolCalls: tailCount(toolsFile, /"type":"tool_call"/g),
  };
  fs.mkdirSync(JOURNAL, { recursive: true });
  const outFile = path.join(JOURNAL, `long-horizon-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log('      报告：' + outFile);
  console.log('      事件：' + JSON.stringify(summary.events));

  // 8) 收尾
  if (!keep) {
    console.log('[8/8] 停实例 …');
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STOP], 180000);
  } else {
    console.log('[8/8] 按 --keep-running 保留实例');
  }
  console.log('✅ 完成');
}

main().catch((e) => {
  console.error('✘ run-long-horizon 崩了：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
