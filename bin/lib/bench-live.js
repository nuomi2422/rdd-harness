#!/usr/bin/env node
'use strict';
/**
 * lib/bench-live.js —— 实验台「常驻视图」的数据层 + 渲染层（2026-10-28）
 *
 * 为什么存在（用户原话，2026-10-28）：
 *   「实验台有没有常驻化一些环境？把 mc 事件直接解析成快照放在实验台，还可以从监测台
 *    拿取 numen 和 supervisor 的上下文以及任务链，他们的对话记录整条链路也可以弄出来，
 *    可以开关显示，常驻在那里实时拿快照，方便 AI 直接读。」
 *
 * 边界（写死在代码里，改之前先看 §10 代码绑定）：
 *   - **只读**：只读 monitor/*.jsonl，只写 experiments/live/*；不发 MCP、不改世界、不派工。
 *   - **不伪造**：没采到就写「未观测到」，不把缺项写成 0；每份视图都带 captured_at 与数据年龄。
 *   - **有界**：每个流只保留尾部 ring（内存有界），文件按 offset 增量读，不整文件重读。
 *   - **纯渲染**：renderX(state) 是纯函数，给同一份 state 必得同一份 md —— 离线可测。
 *
 * 事件归一（monitor 五条流 → 六类标签）：
 *   chain  taskchain_snapshot / requirement_manifest / goal_kickoff / subtask_* / chain_recovering …
 *   ctx    numen_context / supervisor_input|context|output / runtime_state / planning_input_verbatim
 *   chat   ai.jsonl assistant、turn；context.jsonl user_prompt、llm_response.response.content
 *   proto  tools.jsonl tool_call / tool_result
 *   death  instrumentation.jsonl death / starvation_death
 *   event  events.jsonl 其余
 *
 * 用法见 bin/bench-watch.js（引擎）与 bin/bench.js live（开关）。
 */
const fs = require('fs');
const path = require('path');

const VIEWS = ['snapshot', 'chain', 'chat', 'context'];
const DEFAULT_MONITOR = 'D:\\rdd\\mc\\The Best of Twilight Forest\\config\\numen\\monitor';
const MAX_TEXT = 4000;      // 单个 ctx 文本最长落盘字符数
const MAX_LINE = 20000;     // 单行最长保留（防超长请求体撑爆内存）
const RING = 400;           // 每类事件 ring 容量

// ── 小工具 ────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function ts(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function ago(ms, now) {
  if (ms == null) return '未观测到';
  const s = Math.max(0, Math.round(((now || Date.now()) - ms) / 1000));
  if (s < 60) return s + 's 前';
  if (s < 3600) return Math.round(s / 60) + 'm 前';
  return (s / 3600).toFixed(1) + 'h 前';
}
function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function num(v, dflt) { return typeof v === 'number' && isFinite(v) ? v : (dflt === undefined ? null : dflt); }

/** 原子写：先写 .tmp 再 rename，读的人永远看不到半份。 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ── 增量读尾 ──────────────────────────────────────────────────────────────
/**
 * 从 offset 读到文件尾；若文件变小（轮转）则从头一个窗口重读。
 * @returns {{lines:string[], offset:number, size:number, reset:boolean}}
 */
function readTail(file, offset, windowBytes) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { lines: [], offset: offset || 0, size: 0, reset: false, missing: true }; }
  try {
    const st = fs.fstatSync(fd);
    const size = st.size;
    let start = offset || 0;
    let reset = false;
    if (size < start) { start = Math.max(0, size - (windowBytes || 1024 * 1024)); reset = true; }
    if (size - start > (windowBytes || 1024 * 1024)) start = size - (windowBytes || 1024 * 1024);
    const len = size - start;
    if (len <= 0) return { lines: [], offset: size, size, reset };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const parts = text.split('\n');
    // 最后一段可能是写了一半的行走，留到下一拍（用 size 减去它的字节数太麻烦，直接丢）
    parts.pop();
    return { lines: parts, offset: size, size, reset };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// ── 状态 ──────────────────────────────────────────────────────────────────
function newState(meta) {
  return {
    schema: 1,
    started_at: meta && meta.started_at ? meta.started_at : Date.now(),
    monitor: (meta && meta.monitor) || DEFAULT_MONITOR,
    pid: process.pid,
    ticks: 0,
    files: {},                    // name -> {offset,size,mtime,lastEventAt,lines,missing}
    ring: { chain: [], ctx: [], chat: [], proto: [], death: [], event: [] },
    counters: Object.create(null),
    last: { chain: null, numen: null, supervisorOut: null, supervisorIn: null, runtime: null, manifest: null, gaps: null, retrieval: null, observer: null, planIn: null },
    errors: [],
  };
}

function pushRing(state, kind, rec) {
  const arr = state.ring[kind];
  if (!arr) return;
  arr.push(rec);
  if (arr.length > RING) arr.splice(0, arr.length - RING);
}

/** 把 taskChain 统一成对象（有的路径给 JSON 字符串，见监测台 HANDOFF 233 行）。 */
function asChain(v) {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return typeof v === 'object' ? v : null;
}

function parseJson(line) {
  if (!line || line.length > MAX_LINE) {
    if (line && line.length > MAX_LINE) { try { return JSON.parse(line.slice(0, MAX_LINE)); } catch { return null; } }
    return null;
  }
  try { return JSON.parse(line); } catch { return null; }
}

/** 归一一条事件；返回 {kind, rec} 或 null。 */
function normalize(file, ev) {
  if (!ev || !ev.type) return null;
  const d = ev.data || {};
  const t = Date.parse(ev.timestamp) || Date.now();
  const type = String(ev.type);

  if (file === 'rdd.jsonl') {
    if (type === 'taskchain_snapshot') {
      const chain = asChain(d.taskChain);
      return { kind: 'chain', rec: { t, type, chain, reason: d.reason, companion: d.companionId } };
    }
    if (type === 'numen_context') return { kind: 'ctx', rec: { t, type, who: 'numen', text: d.context || d.text || '', companion: d.companionId } };
    if (type === 'supervisor_output') return { kind: 'ctx', rec: { t, type, who: 'supervisor', text: d.message || d.text || '', companion: d.companionId } };
    if (type === 'supervisor_input' || type === 'supervisor_context') return { kind: 'ctx', rec: { t, type, who: 'supervisor', text: d.text || d.context || '', companion: d.companionId } };
    if (type === 'planning_input_verbatim') return { kind: 'ctx', rec: { t, type, who: 'planner', text: d.text || d.prompt || '', companion: d.companionId } };
    if (type === 'runtime_state') return { kind: 'ctx', rec: { t, type, who: 'runtime', text: d.context || d.text || '', companion: d.companionId } };
    if (type === 'requirement_manifest') return { kind: 'chain', rec: { t, type, manifest: d, companion: d.companionId } };
    if (type === 'requirement_gaps_changed') return { kind: 'chain', rec: { t, type, gaps: d.gaps, companion: d.companionId } };
    // ★ 方块面：journal 里真正落盘的「方块级」事实是 asset_snapshot 的 facilities（如 minecraft:chest@117,62,703）。
    //   逐格网格（blockUpdate → grid）服务端日志里没有，别在这里假装有；真网格走 world_probe/scan_blocks。
    if (type === 'asset_snapshot') {
      const fac = [], missing = [];
      let dim = null;
      for (const a of (d.assets || [])) {
        const v = a && a.observation && a.observation.value;
        if (!v) continue;
        if (v.dimension) dim = v.dimension;
        for (const f of (v.facilities || [])) {
          const s = String(f);
          if (/@-?\d+,-?\d+,-?\d+$/.test(s)) fac.push(s);
          else missing.push(s);
        }
      }
      return { kind: 'chain', rec: { t, type, assets: { dim, facilities: fac, missing }, brief: 'facilities=' + fac.length + (dim ? ' dim=' + dim : ''), companion: d.companionId } };
    }
    if (type === 'subtask_stalled' || type === 'subtask_resumed' || type === 'subtask_stall_escalated') {
      return { kind: 'chain', rec: { t, type, brief: 'source=' + (d.source || '?') + ' reason=' + clip(d.reason || '', 60) + ' subtask=' + (d.subtask || '?'), companion: d.companionId } };
    }
    if (type === 'carrier_alarm') return { kind: 'chain', rec: { t, type, brief: 'added=' + (d.added || '-') + ' active=' + (d.active || '-') + ' escalated=' + (d.escalated || '-'), companion: d.companionId } };
    return { kind: 'chain', rec: { t, type, brief: clip(JSON.stringify(d), 140), companion: d.companionId } };
  }

  if (file === 'ai.jsonl') {
    if (type === 'assistant') return { kind: 'chat', rec: { t, type, who: '她说', text: d.text || '' } };
    if (type === 'turn') return { kind: 'chat', rec: { t, type, who: '回合', text: 'turn=' + (d.turn == null ? '?' : d.turn) + ' tools=' + (d.tools == null ? '?' : d.tools) + ' convo_msgs=' + (d.convo_msgs == null ? '?' : d.convo_msgs) } };
    return null;
  }

  if (file === 'context.jsonl') {
    if (type === 'user_prompt') return { kind: 'chat', rec: { t, type, who: '用户', text: d.text || '' } };
    if (type === 'llm_response') {
      // 只留规划 AI 的回应：执行 AI 的回应与 ai.jsonl assistant 重复，留在 chat 里会一条当两条证据。
      if (d.actor !== 'supervisor') return null;
      const r = d.response || {};
      const calls = (r.tool_calls || []).map((c) => c.name).filter(Boolean);
      return { kind: 'chat', rec: { t, type, who: '规划 AI', text: (r.content || '') + (calls.length ? '  ⟨' + calls.join(',') + '⟩' : ''), phase: d.phase, model: d.model } };
    }
    if (type === 'llm_request') {
      const msgs = ((d.request || {}).messages || []);
      return { kind: 'ctx', rec: { t, type, who: 'request', actor: d.actor, phase: d.phase, model: d.model, text: 'actor=' + (d.actor || '?') + ' phase=' + (d.phase || '?') + ' msgs=' + msgs.length + ' tokens≈' + (d.promptTokens || '?') } };
    }
    if (type === 'runtime_state') return { kind: 'ctx', rec: { t, type, who: 'runtime', text: d.context || '', phase: d.origin } };
    if (type === 'retrieval_snapshot') return { kind: 'ctx', rec: { t, type, who: 'retrieval', text: 'entries=' + (d.entries == null ? '?' : d.entries) + ' status=' + (d.status || '?') + ' chars=' + (d.chars == null ? '?' : d.chars) + ' reasons=' + JSON.stringify(d.truncationReasons || []) } };
    if (type === 'llm_usage') return { kind: 'proto', rec: { t, type, text: 'tokens=' + (d.totalTokens == null ? '?' : d.totalTokens) + ' model=' + (d.model || '?') + ' dur=' + (d.durationMs == null ? '?' : d.durationMs) + 'ms' } };
    return null;
  }

  if (file === 'tools.jsonl') {
    if (type === 'tool_call') return { kind: 'proto', rec: { t, type, text: '→ ' + (d.tool || '?') + ' ' + clip(d.args || d.arguments || '', 120) } };
    if (type === 'tool_result') {
      let ok = null, msg = '';
      try { const r = JSON.parse(d.result || '{}'); ok = r.success; msg = r.message || ''; } catch { msg = String(d.result || ''); }
      return { kind: 'proto', rec: { t, type, ok, text: (ok === false ? '✘ ' : ok === true ? '✔ ' : '? ') + clip(msg, 140) } };
    }
    return null;
  }

  if (file === 'instrumentation.jsonl') {
    if (type === 'death' || type === 'starvation_death') {
      return { kind: 'death', rec: { t, type, text: (d.deathCauseMsg || d.deathCauseId || 'death') + ' kind=' + (d.deathKind || '?') + (d.reason ? ' reason=' + d.reason : '') } };
    }
    if (type === 'asset_mismatch') return { kind: 'death', rec: { t, type, text: '资产不符 ' + (d.context ? JSON.stringify(d.context) : clip(JSON.stringify(d), 120)) } };
    return null;
  }

  if (file === 'observer.jsonl') {
    if (type === 'observer_tick') return { kind: 'event', rec: { t, type, tick: d } };
    if (type === 'observer_loop_start') return { kind: 'event', rec: { t, type, text: 'observer 开跑 pid=' + (d.pid || '?') } };
    if (type === 'observer_loop_stop') return { kind: 'event', rec: { t, type, text: 'observer 停 ' + (d.reason || '') } };
    return null;
  }

  return null;
}

/** 把一批已归一事件吃进 state。 */
function apply(state, file, items, nowMs) {
  const now = nowMs || Date.now();
  for (const it of items) {
    pushRing(state, it.kind, it.rec);
    state.counters[it.rec.type] = (state.counters[it.rec.type] || 0) + 1;
    const f = state.files[file] || (state.files[file] = { lines: 0 });
    f.lastEventAt = it.rec.t || now;
    // last 视图
    if (it.kind === 'chain' && it.rec.chain) state.last.chain = it.rec;
    if (it.kind === 'chain' && it.rec.manifest) state.last.manifest = it.rec.manifest;
    if (it.kind === 'chain' && it.rec.gaps) state.last.gaps = it.rec.gaps;
    if (it.kind === 'chain' && it.rec.assets) state.last.assets = it.rec;
    if (it.kind === 'ctx') {
      if (it.rec.type === 'numen_context') state.last.numen = it.rec;
      else if (it.rec.type === 'supervisor_output') state.last.supervisorOut = it.rec;
      else if (it.rec.type === 'supervisor_input' || it.rec.type === 'supervisor_context') state.last.supervisorIn = it.rec;
      else if (it.rec.type === 'runtime_state') state.last.runtime = it.rec;
      else if (it.rec.type === 'retrieval_snapshot') state.last.retrieval = it.rec;
      else if (it.rec.type === 'planning_input_verbatim') state.last.planIn = it.rec;
    }
    if (it.kind === 'event' && it.rec.tick) state.last.observer = it.rec;
  }
}

// ── 渲染（纯函数） ─────────────────────────────────────────────────────────
function chainView(chain) {
  if (!chain) return null;
  const primaries = Array.isArray(chain.primaries) ? chain.primaries : [];
  const idx = num(chain.primaryIndex, 0);
  return {
    goalId: chain.goalId || null,
    status: chain.primaryStatus || '?',
    version: chain.stateVersion == null ? '?' : chain.stateVersion,
    primaryIndex: idx == null ? '?' : (idx + 1),
    primaryTotal: primaries.length || '?',
    subtaskIndex: chain.subtaskIndex == null ? '?' : (chain.subtaskIndex + 1),
    currentSubtask: chain.currentSubtaskId || null,
    currentPrimary: chain.currentPrimaryId || null,
    description: chain.description || '',
    satisfied: Array.isArray(chain.satisfiedStages) ? chain.satisfiedStages : [],
    primaries,
  };
}

function renderSnapshot(state, meta) {
  const now = (meta && meta.now) || Date.now();
  const cv = chainView(state.last.chain && state.last.chain.chain);
  const L = [];
  L.push('# 实验台 live · snapshot');
  L.push('captured_at=' + ts(now) + '  pid=' + state.pid + '  interval=' + (meta.interval_s || '?') + 's  views=' + (meta.views || []).join(','));
  L.push('monitor=' + state.monitor);
  L.push('本进程启动于 ' + ts(state.started_at) + '，已跑 ' + state.ticks + ' 拍');
  L.push('');
  L.push('## 当前任务链');
  if (cv) {
    L.push('goal_id=' + cv.goalId + '  status=' + cv.status + '  stateVersion=' + cv.version);
    L.push('主目标 ' + cv.primaryIndex + '/' + cv.primaryTotal + '  ·  当前小步 ' + cv.subtaskIndex + '  ·  subtask=' + (cv.currentSubtask || '?'));
    L.push('description: ' + clip(cv.description, 300));
  } else {
    L.push('未观测到 taskchain_snapshot —— 不是「没有任务」，是流里还没有。');
  }
  const obs = state.last.observer && state.last.observer.tick;
  L.push('');
  L.push('## 身体（第二视角 observer）');
  if (obs) {
    const w = obs.watched || {};
    const p = w.position || {};
    L.push('pos=(' + [p.x, p.y, p.z].map((v) => (v == null ? '?' : Math.round(v))).join(',') + ')  dim=' + (p.dimension || '?') +
      '  hp=' + (w.hp == null ? '?' : w.hp) + '  food=' + (w.hunger == null ? '?' : w.hunger) +
      '  mode=' + (w.game_mode || '?') + '  backpack=' + (w.backpack_used == null ? '?' : w.backpack_used) +
      '  dist=' + (obs.distance_to_watched == null ? '?' : obs.distance_to_watched));
    L.push('样本时间 ' + ts(state.last.observer.t) + '（' + ago(state.last.observer.t, now) + '）' + (obs.nearby_count == null ? '' : '  nearby=' + obs.nearby_count));
  } else {
    L.push('未观测到 observer_tick —— 第二视角没在跑（node bin/observer-loop.js --interval 30）。');
  }
  L.push('');
  L.push('## 方块 / 设施（asset_snapshot，方块级坐标）');
  const as = state.last.assets;
  if (as) {
    const fac = (as.assets && as.assets.facilities) || [];
    const miss = (as.assets && as.assets.missing) || [];
    L.push('dim=' + ((as.assets && as.assets.dim) || '?') + '  共 ' + fac.length + ' 个' +
      (miss.length ? '（另有 ' + miss.length + ' 条「没有」事实）' : '') + '  样本 ' + ts(as.t) + '（' + ago(as.t, now) + '）');
    for (const f of fac.slice(0, 12)) L.push('- ' + f);
    if (fac.length > 12) L.push('…（还有 ' + (fac.length - 12) + ' 个，读 monitor/rdd.jsonl 的 asset_snapshot）');
    for (const m of miss.slice(0, 2)) L.push('- ✘ ' + clip(m.replace(/^\(missing\)\s*/, ''), 80));
    L.push('注：这是设施级坐标，不是逐格网格；逐格要 world_probe/scan_blocks（未接常驻）。');
  } else {
    L.push('未观测到 asset_snapshot（方块级事实还没出现）。');
  }
  L.push('');
  L.push('## 流');
  const order = ['rdd.jsonl', 'ai.jsonl', 'context.jsonl', 'tools.jsonl', 'instrumentation.jsonl', 'observer.jsonl'];
  for (const f of order) {
    const s = state.files[f];
    if (!s) { L.push('- ' + f + '  —— 本轮还没读到（文件不存在或本轮无新行）'); continue; }
    L.push('- ' + f + '  ' + (s.size == null ? '' : (s.size / 1048576).toFixed(1) + ' MB') +
      '  最后事件 ' + (s.lastEventAt ? ago(s.lastEventAt, now) + '（' + ts(s.lastEventAt) + '）' : '未观测到'));
  }
  L.push('');
  L.push('## 计数（本进程启动以来）');
  const c = state.counters;
  const keys = ['taskchain_snapshot', 'numen_context', 'supervisor_output', 'supervisor_input', 'llm_request', 'llm_response', 'tool_call', 'tool_result', 'death', 'starvation_death', 'assistant', 'turn'];
  L.push(keys.map((k) => k + '=' + (c[k] || 0)).join('  '));
  L.push('');
  L.push('## 告警');
  const alerts = [];
  if (state.last.chain && state.last.chain.chain && state.last.chain.chain.primaryStatus === 'STALLED') alerts.push('主状态 STALLED');
  const cm = state.last.chain && state.last.chain.chain;
  if (cm && (cm.currentSubtaskId || '').length) {
    const st = state.ring.chain.slice(-40).reverse().find((r) => r.type === 'subtask_stalled');
    if (st) alerts.push('最近一次 subtask_stalled：' + ts(st.t) + '  ' + clip(st.brief, 120));
  }
  if (state.last.observer && (now - state.last.observer.t) > 10 * 60 * 1000) alerts.push('observer 样本超过 10 分钟 —— 第二视角可能已停');
  const oldest = state.started_at;
  if (state.ticks > 0 && !state.last.chain) alerts.push('整轮没有 taskchain_snapshot —— 链观测没开？');
  if (!alerts.length) alerts.push('（无）');
  for (const a of alerts) L.push('- ' + a);
  L.push('');
  L.push('> 只读视图：来自 monitor/*.jsonl，不改世界、不派工。「未观测到」≠ 0。');
  return L.join('\n') + '\n';
}

function renderChain(state, meta) {
  const now = (meta && meta.now) || Date.now();
  const cv = chainView(state.last.chain && state.last.chain.chain);
  const L = [];
  L.push('# 实验台 live · chain（任务链）');
  L.push('captured_at=' + ts(now) + '  数据年龄=' + (state.last.chain ? ago(state.last.chain.t, now) : '未观测到'));
  L.push('');
  if (!cv) {
    L.push('未观测到 taskchain_snapshot。');
    return L.join('\n') + '\n';
  }
  L.push('goal_id=' + cv.goalId + '  status=' + cv.status + '  stateVersion=' + cv.version);
  L.push('阶段 ' + cv.primaryIndex + '/' + cv.primaryTotal + '  小步 ' + cv.subtaskIndex);
  L.push('description:');
  L.push('  ' + clip(cv.description, 600));
  L.push('');
  L.push('## 一级目标（primaries）');
  cv.primaries.forEach((p, i) => {
    const mark = p.current ? '▶' : (i < (num(state.last.chain.chain.primaryIndex, 0) || 0) ? '✔' : '·');
    L.push(mark + ' [' + (i + 1) + '] ' + (p.id || '?') + (p.unexpanded ? '  (未展开)' : ''));
    L.push('    ' + clip(p.description || '', 400));
  });
  if (cv.satisfied.length) {
    L.push('');
    L.push('已满足阶段：' + cv.satisfied.join(', '));
  }
  const man = state.last.manifest;
  if (man && Array.isArray(man.rows)) {
    L.push('');
    L.push('## 需求清单（requirement_manifest）');
    for (const r of man.rows) L.push('- ' + (r.key || '?') + '  ' + (r.importance || '?') + '  至少 ' + (r.minimum == null ? '?' : r.minimum));
  }
  if (state.last.gaps) {
    L.push('');
    L.push('## 缺口（requirement_gaps_changed）');
    L.push('  ' + state.last.gaps);
  }
  L.push('');
  L.push('## 最近 12 次链事件（连续同状态的快照已折叠）');
  const rows = state.ring.chain.slice(-60);
  const collapsed = [];
  for (const r of rows) {
    if (r.chain) {
      const key = 'snap|' + (r.chain.primaryStatus || '') + '|' + (r.chain.currentSubtaskId || '') + '|' + (r.chain.stateVersion == null ? '' : r.chain.stateVersion);
      const last = collapsed[collapsed.length - 1];
      if (last && last.key === key) { last.n++; last.t = r.t; continue; }
      collapsed.push({ key, t: r.t, n: 1, r });
    } else collapsed.push({ key: null, t: r.t, n: 1, r });
  }
  if (!collapsed.length) L.push('（无）');
  for (const c of collapsed.slice(-12)) {
    const r = c.r;
    let line = ts(c.t) + '  ' + r.type;
    if (r.chain) line += '  status=' + (r.chain.primaryStatus || '?') + ' v=' + (r.chain.stateVersion == null ? '?' : r.chain.stateVersion) + ' stage=' + (r.chain.currentSubtaskId || '?');
    else if (r.manifest) line += '  req=' + (r.manifest.requirements == null ? '?' : r.manifest.requirements) + ' critical=' + (r.manifest.critical == null ? '?' : r.manifest.critical);
    else if (r.gaps) line += '  ' + clip(r.gaps, 140);
    else if (r.brief) line += '  ' + clip(r.brief, 140);
    if (c.n > 1) line += '  ×' + c.n + '（状态没变）';
    L.push(line);
  }
  L.push('');
  L.push('> 数据源 rdd.jsonl（taskchain_snapshot 每 5s / 每次状态迁移一条）。帧数见 snapshot 页计数。');
  return L.join('\n') + '\n';
}

function renderChat(state, meta) {
  const now = (meta && meta.now) || Date.now();
  const L = [];
  const turns = state.ring.chat.filter((r) => r.type === 'turn');
  const lines = state.ring.chat.filter((r) => r.type !== 'turn');
  L.push('# 实验台 live · chat（对话记录，整条链路）');
  L.push('captured_at=' + ts(now) + '  对话条目=' + lines.length + '（ring 上限 ' + RING + '；回合边界 ' + turns.length + ' 次' +
    (turns.length ? '，最近 ' + ts(turns[turns.length - 1].t) : '') + '）');
  L.push('更早的对话直接读 monitor/ai.jsonl（assistant 正文 + turn 边界）。');
  L.push('');
  if (!lines.length) {
    L.push('未观测到对话事件（ai.jsonl / context.jsonl 还没有新行）。');
    return L.join('\n') + '\n';
  }
  L.push('## 最近 ' + Math.min(30, lines.length) + ' 条（旧 → 新）');
  for (const r of lines.slice(-30)) {
    L.push('');
    L.push('[' + ts(r.t) + '] ' + r.who + (r.model ? ' · ' + r.model : '') + (r.phase ? ' · ' + r.phase : '') + ' · ' + ago(r.t, now));
    L.push('  ' + clip(r.text, 700));
  }
  L.push('');
  L.push('> 「她说」= ai.jsonl assistant（内脑自述）；「用户」= 派单原文；「规划 AI」= context.jsonl actor=supervisor 的回应。');
  return L.join('\n') + '\n';
}

function renderContext(state, meta) {
  const now = (meta && meta.now) || Date.now();
  const L = [];
  L.push('# 实验台 live · context（AI 实际收到什么）');
  L.push('captured_at=' + ts(now));
  L.push('');
  const block = (title, rec, max) => {
    L.push('## ' + title);
    if (!rec) { L.push('未观测到。'); L.push(''); return; }
    L.push('时间 ' + ts(rec.t) + '（' + ago(rec.t, now) + '）  长度 ' + String(rec.text || '').length + ' 字');
    L.push('```');
    L.push(clip(rec.text, max || MAX_TEXT));
    L.push('```');
    L.push('');
  };
  block('注入给执行 AI 的上下文（numen_context 的 <rdd> 块）', state.last.numen, 3000);
  block('规划 AI 的输入（supervisor_input / planning_input_verbatim）', state.last.supervisorIn || state.last.planIn, 3000);
  block('规划 AI 的输出（supervisor_output）', state.last.supervisorOut, 2000);
  block('执行 AI 的 runtime_state（背包/自身，注入正文）', state.last.runtime, 2500);
  L.push('## 检索面（retrieval_snapshot）');
  L.push(state.last.retrieval ? ts(state.last.retrieval.t) + '  ' + state.last.retrieval.text : '未观测到。');
  L.push('');
  L.push('> 只抽「最近一次」；要看历史序列，用 node bin/bench.js timeline <runDir> --tag ctx 或直接读 monitor/rdd.jsonl。');
  return L.join('\n') + '\n';
}

const RENDERERS = { snapshot: renderSnapshot, chain: renderChain, chat: renderChat, context: renderContext };

function render(view, state, meta) {
  const fn = RENDERERS[view];
  if (!fn) throw new Error('unknown view: ' + view);
  return fn(state, meta || {});
}

/** 一次渲染所有选中视图，返回 {view: text}。 */
function renderAll(state, meta, views) {
  const out = {};
  for (const v of (views && views.length ? views : VIEWS)) out[v] = render(v, state, meta);
  return out;
}

module.exports = {
  VIEWS, DEFAULT_MONITOR, MAX_TEXT, RING,
  newState, readTail, normalize, apply, render, renderAll, chainView,
  loadControl, saveControl, writeAtomic, ts, ago, clip,
};

// ── 控制面（开关文件） ────────────────────────────────────────────────────
/**
 * experiments/live/watch.json —— 常驻进程每拍重读它，所以「开关」不用重启进程。
 *   {schema:1, enabled:true, views:["snapshot","chain","chat","context"], interval_s:15, updated_at, by, note}
 */
function controlPath(outDir) { return path.join(outDir, 'watch.json'); }

function loadControl(outDir) {
  const p = controlPath(outDir);
  const dflt = { schema: 1, enabled: true, views: VIEWS.slice(), interval_s: 15, updated_at: null, by: 'default' };
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    const views = Array.isArray(o.views) ? o.views.filter((v) => VIEWS.includes(v)) : VIEWS.slice();
    return {
      schema: 1,
      enabled: o.enabled !== false,
      views: views.length ? views : VIEWS.slice(),
      interval_s: Math.max(5, parseInt(o.interval_s, 10) || 15),
      updated_at: o.updated_at || null,
      by: o.by || 'unknown',
      note: o.note || '',
    };
  } catch { return dflt; }
}

function saveControl(outDir, patch, by) {
  const cur = loadControl(outDir);
  const next = Object.assign({}, cur, patch || {}, { schema: 1, updated_at: new Date().toISOString(), by: by || 'bench' });
  // 归一
  next.views = (Array.isArray(next.views) ? next.views : VIEWS).filter((v) => VIEWS.includes(v));
  if (!next.views.length) next.views = VIEWS.slice();
  next.interval_s = Math.max(5, parseInt(next.interval_s, 10) || 15);
  next.enabled = next.enabled !== false;
  writeAtomic(controlPath(outDir), JSON.stringify(next, null, 2) + '\n');
  return next;
}
