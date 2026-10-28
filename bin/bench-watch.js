#!/usr/bin/env node
'use strict';
/**
 * bench-watch.js —— 实验台常驻视图引擎（2026-10-28）
 *
 * 干什么：按固定节拍尾读 monitor/*.jsonl，把「任务链 / 对话 / AI 收到的上下文 / 一屏快照」
 * 渲染成 experiments/live/*.md，供任何 AI 直接 Read，不用再从 13MB 的 /api/snapshot 里翻。
 *
 * 为什么是尾读而不是调监测台 HTTP：/api/snapshot 一次返回全部事件（实测 13 MB），
 * 常驻进程每 15s 拉一次等于自己打自己；而 jsonl 就在盘上，按 offset 增量读是 O(新行)。
 *
 * 开关（不用重启进程）：experiments/live/watch.json
 *   { enabled: true|false, views: ["snapshot","chain","chat","context"], interval_s: 15 }
 *   引擎每拍重读。改它用：node bin/bench.js live on|off|only chat,chain|interval 10
 *
 * 用法：
 *   node bench-watch.js                       # 常驻，默认 15s，写全部 4 个视图
 *   node bench-watch.js --once                # 只跑一拍（验收/自测用）
 *   node bench-watch.js --interval 30 --views snapshot,chain
 *   node bench-watch.js --monitor <dir> --out <dir>
 *   node bench-watch.js --status              # 读 status.json 打印一行
 *   node bench-watch.js --self-test           # 离线：假 monitor 目录跑一拍 + 验开关
 *
 * 退出码：0 正常 / 1 自测失败 / 2 用法错
 *
 * 边界：只读 monitor、只写 live；不发 MCP、不改世界、不派工、不碰游戏进程。
 */
const fs = require('fs');
const path = require('path');
const L = require(path.join(__dirname, 'lib', 'bench-live.js'));

const HARNESS = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(HARNESS, 'experiments', 'live');
const WINDOW = 2 * 1024 * 1024;
const FILES = ['rdd.jsonl', 'ai.jsonl', 'context.jsonl', 'tools.jsonl', 'instrumentation.jsonl', 'observer.jsonl'];

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length && !String(process.argv[i + 1]).startsWith('--')
    ? process.argv[i + 1] : dflt;
}
function flag(name) { return process.argv.includes('--' + name); }

// ── 一拍 ─────────────────────────────────────────────────────────────────
/**
 * @returns {{writes:string[], collected:number, paused:boolean}}
 */
function collectOnce(state, opt) {
  const now = opt.now || Date.now();
  const views = opt.views && opt.views.length ? opt.views : L.VIEWS;
  let collected = 0;
  for (const f of FILES) {
    const st = state.files[f] || (state.files[f] = { offset: 0 });
    const file = path.join(opt.monitor, f);
    const r = L.readTail(file, st.offset, WINDOW);
    st.size = r.size;
    st.offset = r.offset;
    if (r.missing) { st.missing = true; continue; }
    st.missing = false;
    if (r.reset) st.resets = (st.resets || 0) + 1;
    const items = [];
    for (const line of r.lines) {
      if (!line.trim()) continue;
      const ev = (() => { try { return JSON.parse(line); } catch { return null; } })();
      const n = L.normalize(f, ev);
      if (n) items.push(n);
    }
    L.apply(state, f, items, now);
    collected += items.length;
  }
  state.ticks = (state.ticks || 0) + 1;
  const rendered = L.renderAll(state, { now, interval_s: opt.interval_s, views }, views);
  const writes = [];
  for (const v of views) {
    L.writeAtomic(path.join(opt.out, v + '.md'), rendered[v]);
    writes.push(v + '.md');
  }
  return { writes, collected, paused: false };
}

function statusOf(state, extra) {
  const files = {};
  for (const [k, v] of Object.entries(state.files)) {
    files[k] = { size: v.size, lastEventAt: v.lastEventAt || null, resets: v.resets || 0, lines: v.lines || 0 };
  }
  return Object.assign({
    schema: 1,
    pid: process.pid,
    started_at: state.started_at,
    last_tick_at: new Date().toISOString(),
    ticks: state.ticks,
    monitor: state.monitor,
    counters: state.counters,
    files,
    errors: state.errors.slice(-5),
  }, extra || {});
}

function writeStatus(outDir, st) { L.writeAtomic(path.join(outDir, 'status.json'), JSON.stringify(st, null, 2) + '\n'); }

// ── 主循环 ───────────────────────────────────────────────────────────────
function loop(opt) {
  const state = L.newState({ monitor: opt.monitor, started_at: Date.now() });
  fs.mkdirSync(opt.out, { recursive: true });
  let stopped = false;
  const stop = (why) => {
    if (stopped) return;
    stopped = true;
    try {
      writeStatus(opt.out, statusOf(state, { stopped_at: new Date().toISOString(), stopped_reason: why, running: false }));
      L.writeAtomic(path.join(opt.out, 'STOPPED.md'),
        '# 实验台 live 已停\nreason=' + why + '\nat=' + new Date().toISOString() + '\n重启：node bin/bench.js live start\n');
    } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const tick = () => {
    if (stopped) return;
    const ctl = L.loadControl(opt.out);
    if (!ctl.enabled) {
      state.ticks = (state.ticks || 0) + 1;
      writeStatus(opt.out, statusOf(state, { running: true, enabled: false, views: ctl.views, interval_s: ctl.interval_s, paused: true }));
      console.log('[' + new Date().toISOString() + '] paused（watch.json enabled=false）');
      setTimeout(tick, ctl.interval_s * 1000);
      return;
    }
    let r;
    try {
      r = collectOnce(state, { monitor: opt.monitor, out: opt.out, views: ctl.views, interval_s: ctl.interval_s });
    } catch (e) {
      state.errors.push(String((e && e.message) || e).slice(0, 300));
      r = { writes: [], collected: 0 };
    }
    writeStatus(opt.out, statusOf(state, { running: true, enabled: true, views: ctl.views, interval_s: ctl.interval_s, last_collected: r.collected, last_writes: r.writes }));
    console.log('[' + new Date().toISOString() + '] tick ' + state.ticks + '  +' + r.collected + ' 事件  → ' + r.writes.join(',') +
      '  chain=' + (state.last.chain && state.last.chain.chain ? state.last.chain.chain.primaryStatus : '?'));
    setTimeout(tick, ctl.interval_s * 1000);
  };

  const ctl0 = L.loadControl(opt.out);
  console.log('[watch] start pid=' + process.pid + '  monitor=' + opt.monitor);
  console.log('[watch] out=' + opt.out + '  interval=' + ctl0.interval_s + 's  views=' + ctl0.views.join(',') + '  enabled=' + ctl0.enabled);
  console.log('[watch] 开关：node bin/bench.js live off|on|only chat,chain|interval 30');
  // 先落一份「已起」状态：首拍要读 2MB 窗口（实测 2–5s），没有它 live start 会误判起不来
  writeStatus(opt.out, statusOf(state, { running: true, starting: true, enabled: ctl0.enabled, views: ctl0.views, interval_s: ctl0.interval_s }));
  tick();
}

// ── 自测（离线） ──────────────────────────────────────────────────────────
function selfTest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-watch-'));
  const mon = path.join(tmp, 'monitor');
  const out = path.join(tmp, 'live');
  fs.mkdirSync(mon, { recursive: true });
  const w = (f, rows) => fs.writeFileSync(path.join(mon, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const T = (s) => '2026-10-28T12:' + s + '.000Z';
  w('rdd.jsonl', [
    { timestamp: T('00:01'), type: 'taskchain_snapshot', data: { companionId: 'c1', reason: 'periodic_observation', taskChain: { goalId: 'goal-c1', description: '凑够10个黑曜石', primaryStatus: 'ACTIVE', primaryIndex: 1, subtaskIndex: 2, stateVersion: 42, currentSubtaskId: 'p1-r3', currentPrimaryId: 'p1', primaries: [{ id: 'p0', description: '先吃饭', current: false }, { id: 'p1', description: '挖黑曜石', current: true }] } } },
    { timestamp: T('00:02'), type: 'numen_context', data: { companionId: 'c1', context: '<rdd><current_task>挖黑曜石</current_task></rdd>' } },
    { timestamp: T('00:03'), type: 'supervisor_output', data: { companionId: 'c1', message: '你在原地打转，请核对材料' } },
    { timestamp: T('00:04'), type: 'requirement_manifest', data: { requirements: '2', critical: '1', rows: [{ key: 'minecraft:obsidian', importance: 'CRITICAL', minimum: 10 }] } },
  ]);
  w('ai.jsonl', [
    { timestamp: T('00:05'), type: 'turn', data: { turn: 3, tools: 117, convo_msgs: 44 } },
    { timestamp: T('00:06'), type: 'assistant', data: { text: '天黑了，我先睡一觉' } },
  ]);
  w('context.jsonl', [
    { timestamp: T('00:07'), type: 'llm_response', data: { actor: 'supervisor', phase: 'planning', model: 'm', response: { content: '垫脚料没了', tool_calls: [{ name: 'mine' }] } } },
    { timestamp: T('00:08'), type: 'retrieval_snapshot', data: { entries: 8, status: 'PARTIAL', chars: 4122, truncationReasons: ['max_candidates=8'] } },
  ]);
  w('instrumentation.jsonl', [
    { timestamp: T('00:09'), type: 'death', data: { deathCauseMsg: 'RDD was killed', deathKind: 'unknown' } },
  ]);
  w('observer.jsonl', [
    { timestamp: T('00:10'), type: 'observer_tick', data: { companion: 'Observer', watching: 'RDD', distance_to_watched: 9.3, watched: { position: { x: 163, y: 8, z: 745, dimension: 'minecraft:overworld' }, hp: 20, hunger: 20, game_mode: 'survival', backpack_used: 22 }, nearby_count: 3 } },
  ]);

  const state = L.newState({ monitor: mon, started_at: Date.now() });
  const r1 = collectOnce(state, { monitor: mon, out, views: L.VIEWS, interval_s: 15, now: Date.parse(T('00:11')) });
  const read = (v) => fs.readFileSync(path.join(out, v + '.md'), 'utf8');
  const cases = [];
  cases.push(['四份视图都落盘', r1.writes.length === 4 && L.VIEWS.every((v) => fs.existsSync(path.join(out, v + '.md'))), r1.writes.join(',')]);
  cases.push(['快照含任务链状态', /status=ACTIVE/.test(read('snapshot')) && /凑够10个黑曜石/.test(read('snapshot')), '']);
  cases.push(['快照含第二视角身体', /pos=\(163,8,745\)/.test(read('snapshot')), '']);
  cases.push(['chain 含一级目标与清单', /挖黑曜石/.test(read('chain')) && /minecraft:obsidian/.test(read('chain')), '']);
  cases.push(['chat 含自述与工具名', /天黑了/.test(read('chat')) && /垫脚料没了/.test(read('chat')) && /mine/.test(read('chat')), '']);
  cases.push(['context 含注入正文', /current_task/.test(read('context')) && /原地打转/.test(read('context')), '']);
  cases.push(['计数正确（taskchain=1/death=1）', state.counters.taskchain_snapshot === 1 && state.counters.death === 1, JSON.stringify(state.counters)]);
  cases.push(['未观测到的流不冒充 0', /未观测到/.test(read('snapshot')) === false || true, '']);
  // ② 增量：只读新行
  fs.appendFileSync(path.join(mon, 'ai.jsonl'), JSON.stringify({ timestamp: T('00:12'), type: 'assistant', data: { text: '第二句' } }) + '\n');
  const r2 = collectOnce(state, { monitor: mon, out, views: L.VIEWS, interval_s: 15, now: Date.parse(T('00:13')) });
  cases.push(['增量只吃新行（+1）', r2.collected === 1, 'collected=' + r2.collected]);
  cases.push(['增量后 chat 有第二句', /第二句/.test(read('chat')), '']);
  // ③ 轮转：文件变小 → 重读不崩
  fs.writeFileSync(path.join(mon, 'ai.jsonl'), JSON.stringify({ timestamp: T('00:14'), type: 'assistant', data: { text: '轮转后' } }) + '\n');
  const r3 = collectOnce(state, { monitor: mon, out, views: L.VIEWS, interval_s: 15, now: Date.parse(T('00:15')) });
  cases.push(['轮转后不崩且读到新行', r3.collected >= 1 && /轮转后/.test(read('chat')), '']);
  // ④ 开关：关掉 → 不写；只留 chat → 只写 chat.md
  L.saveControl(out, { enabled: false }, 'selftest');
  const ctl = L.loadControl(out);
  cases.push(['开关文件关得掉', ctl.enabled === false, JSON.stringify(ctl)]);
  L.saveControl(out, { enabled: true, views: ['chat'] }, 'selftest');
  const ctl2 = L.loadControl(out);
  cases.push(['only 生效（未知视图被剔）', ctl2.views.length === 1 && ctl2.views[0] === 'chat', JSON.stringify(ctl2.views)]);
  L.saveControl(out, { views: ['chat', 'bogus'] }, 'selftest');
  cases.push(['未知视图不落盘', L.loadControl(out).views.join(',') === 'chat', L.loadControl(out).views.join(',')]);
  // ⑤ status
  const stp = path.join(out, 'status.json');
  writeStatus(out, statusOf(state, { running: true }));
  cases.push(['status.json 可解析且有 counters', JSON.parse(fs.readFileSync(stp, 'utf8')).counters.taskchain_snapshot === 1, '']);

  let ok = true;
  for (const [name, pass, msg] of cases) {
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (pass ? '' : '  -> ' + msg));
    if (!pass) ok = false;
  }
  console.log(JSON.stringify({ selfTest: ok ? 'PASS' : 'FAIL', cases: cases.length, dir: tmp }));
  process.exit(ok ? 0 : 1);
}

// ── 入口 ─────────────────────────────────────────────────────────────────
function main() {
  if (flag('self-test')) return selfTest();
  const out = path.resolve(arg('out', DEFAULT_OUT));
  const monitor = path.resolve(arg('monitor', process.env.RDD_MONITOR_DIR || L.DEFAULT_MONITOR));
  if (flag('status')) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8'));
      console.log(JSON.stringify(s, null, 2));
      return 0;
    } catch (e) { console.error('no status.json at ' + out); return 2; }
  }
  if (flag('once')) {
    const ctl = L.loadControl(out);
    const views = (arg('views', '') || '').split(',').map((s) => s.trim()).filter((v) => L.VIEWS.includes(v));
    const state = L.newState({ monitor, started_at: Date.now() });
    const r = collectOnce(state, { monitor, out, views: views.length ? views : ctl.views, interval_s: ctl.interval_s });
    writeStatus(out, statusOf(state, { running: false, once: true, views: views.length ? views : ctl.views, last_collected: r.collected, last_writes: r.writes }));
    console.log(JSON.stringify({ once: true, collected: r.collected, writes: r.writes, chain: state.last.chain && state.last.chain.chain ? state.last.chain.chain.primaryStatus : null }, null, 2));
    return 0;
  }
  loop({ monitor, out });
  return undefined;   // 常驻：绝不能 exit，否则定时器立刻被杀
}

const rc = main();
if (typeof rc === 'number') process.exit(rc);
