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
 * 事件归一（monitor 五条流 → 七类标签）：
 *   chain  taskchain_snapshot / requirement_manifest / goal_kickoff / subtask_* / chain_recovering …
 *   ctx    numen_context / supervisor_input|context|output / runtime_state / planning_input_verbatim
 *   chat   ai.jsonl assistant、turn；context.jsonl user_prompt、supervisor 的 llm_response
 *   act    执行 AI 的 llm_response.tool_calls（**参数只有这里有**；tools.jsonl 的 tool_call 只记 args_chars）
 *   proto  tools.jsonl tool_call / tool_result
 *   death  instrumentation.jsonl death / starvation_death
 *   event  events.jsonl 其余
 *
 * 视图（VIEWS）：snapshot / chain / chat / context / strand。
 *   strand 把「说（ai.jsonl assistant）、做（act 的 tool_calls）、果（tool_result）、链（状态迁移）、死」
 *   按时间串成一条 —— 这是用户 2026-11-01 要的「自动组装成一串」。
 *   ★ 拼不出来的只有「思考」：llm_response.excluded 含 hidden_reasoning，监控里根本没有。
 *
 * 用法见 bin/bench-watch.js（引擎）与 bin/bench.js live（开关）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIEWS = ['snapshot', 'chain', 'chat', 'context', 'strand'];
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
/** 偏移只推进到换行；调用方可传内存状态检测可观测的替换。不持久化。 */
function readTail(file, offset, windowBytes, cursor, options = {}) {
  const limit = windowBytes || 1024 * 1024;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return { lines: [], offset: offset || 0, size: 0, reset: false, missing: true, error: String(e.code || e.message || e), continuity: 'UNKNOWN' }; }
  try {
    const st = fs.fstatSync(fd), size = st.size;
    const identity = st.ino ? String(st.dev) + ':' + String(st.ino) : null;
    let start = offset || 0, reset = false, reason = null;
    const read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); };
    if (cursor && cursor.seen) {
      if (size < cursor.size || size < start) reason = 'truncated';
      else if (identity && cursor.identity && identity !== cursor.identity) reason = 'replaced';
      else if (cursor.anchor && !read(cursor.anchorStart, cursor.anchor.length).equals(cursor.anchor)) reason = 'changed';
      if (reason) { reset = true; start = 0; }
    } else if (size < start) { reset = true; reason = 'truncated'; start = 0; }
    let skipped = 0, discard = !!(cursor && cursor.dropping && !reset);
    if (size - start > limit) {
      const next = size - limit;
      skipped = next - start;
      start = next;
      discard = discard || (start > 0 && read(start - 1, 1)[0] !== 10);
    }
    const buf = read(start, Math.max(0, size - start));
    let begin = 0;
    if (discard) {
      const end = buf.indexOf(10);
      if (end < 0) begin = buf.length;
      else begin = end + 1;
    }
    const last = buf.lastIndexOf(10);
    const records = [];
    let lines = [], decodeError = null;
    if (last >= begin) {
      try {
        const decoder = options.encoding ? new TextDecoder(options.encoding, { fatal: true }) : null;
        if (options.records) {
          for (let pos = begin; pos <= last;) {
            const end = buf.indexOf(10, pos), raw = buf.subarray(pos, end);
            const text = decoder ? decoder.decode(raw) : raw.toString('utf8');
            records.push({ text, byteOffset: start + pos, sha256: crypto.createHash('sha256').update(raw).digest('hex') });
            pos = end + 1;
          }
          lines = records.map(r => r.text);
        } else lines = buf.subarray(begin, last + 1).toString('utf8').split('\n').slice(0, -1);
      } catch { decodeError = 'invalid-log-encoding'; lines = []; records.length = 0; }
    }
    // 窗口内没有完整行时，丢弃残段，下一拍仍须找首个换行。
    const nextOffset = discard && last < begin ? start + begin : (last >= begin ? start + last + 1 : start);
    const dropping = discard && last < 0;
    const actualSize = start + buf.length;
    const anchorStart = Math.max(0, actualSize - 256);
    if (cursor) Object.assign(cursor, { seen: true, size: actualSize, identity, anchorStart, anchor: read(anchorStart, actualSize - anchorStart), dropping });
    return { lines, records, decodeError, partial: nextOffset < actualSize, offset: nextOffset, size: actualSize, reset, reason, skipped, continuity: 'UNKNOWN', dropping };
  } finally { fs.closeSync(fd); }
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
    ring: { chain: [], ctx: [], chat: [], act: [], proto: [], death: [], event: [] },
    calls: Object.create(null),      // tool_call_id -> {name,args,t}，strand 用来把「果」配回工具名/参数
    callsN: 0,
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
      if (d.taskChain != null && (!chain || Array.isArray(chain) || typeof chain !== 'object')) throw new Error('invalid taskChain');
      if (chain && chain.primaries != null && (!Array.isArray(chain.primaries) || chain.primaries.some(p => !p || typeof p !== 'object' || Array.isArray(p)))) throw new Error('invalid taskChain primaries');
      if (chain && chain.satisfiedStages != null && !Array.isArray(chain.satisfiedStages)) throw new Error('invalid taskChain satisfiedStages');
      return { kind: 'chain', rec: { t, type, chain, reason: d.reason, companion: d.companionId } };
    }
    if (type === 'numen_context') return { kind: 'ctx', rec: { t, type, who: 'numen', text: d.context || d.text || '', companion: d.companionId } };
    if (type === 'supervisor_output') return { kind: 'ctx', rec: { t, type, who: 'supervisor', text: d.message || d.text || '', companion: d.companionId } };
    if (type === 'supervisor_input' || type === 'supervisor_context') return { kind: 'ctx', rec: { t, type, who: 'supervisor', text: d.text || d.context || '', companion: d.companionId } };
    if (type === 'planning_input_verbatim') return { kind: 'ctx', rec: { t, type, who: 'planner', text: d.text || d.prompt || '', companion: d.companionId } };
    if (type === 'runtime_state') return { kind: 'ctx', rec: { t, type, who: 'runtime', text: d.context || d.text || '', companion: d.companionId } };
    if (type === 'requirement_manifest') {
      if (d.rows != null && (!Array.isArray(d.rows) || d.rows.some(r => !r || typeof r !== 'object' || Array.isArray(r)))) throw new Error('invalid requirement_manifest rows');
      return { kind: 'chain', rec: { t, type, manifest: d, companion: d.companionId } };
    }
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
    if (type === 'goal_kickoff') return { kind: 'chain', rec: { t, type, brief: 'goal=' + (d.taskId || '?') + ' primary=' + (d.primaryId || '?') + ' subtask=' + (d.subtaskId || '?'), companion: d.companionId } };
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
      const res = d.response || {};
      if (d.actor === 'supervisor') {
        // 规划 AI 的回应进 chat（执行 AI 的正文与 ai.jsonl assistant 重复，留在 chat 会一条当两条证据）。
        const names = (res.tool_calls || []).map((c) => c.name).filter(Boolean);
        return { kind: 'chat', rec: { t, type, who: '规划 AI', text: (res.content || '') + (names.length ? '  ⟨' + names.join(',') + '⟩' : ''), phase: d.phase, model: d.model } };
      }
      // ★ 执行 AI 的 tool_calls：只有这里有**参数正文**（tools.jsonl 的 tool_call 只记 args_chars），
      //   单独归一成 act，供 strand 串「她想做什么」。没有调用的纯说话响应不进 act（说由 ai.jsonl 负责）。
      const calls = (res.tool_calls || []).map((c) => {
        const fn = (c && c.function) || {};
        return {
          id: (c && c.id) || null,
          name: (c && c.name) || fn.name || '?',
          args: c && c.args != null ? c.args : (c && c.arguments != null ? c.arguments : (fn.arguments != null ? fn.arguments : '')),
        };
      }).filter((c) => c.name && c.name !== '?');
      if (!calls.length) return null;
      return { kind: 'act', rec: { t, type, requestId: d.requestId || null, model: d.model, phase: d.phase, actor: d.actor, calls } };
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
    if (type === 'tool_call') {
      // 参数正文不在这条事件里（只有 args_chars）——「做」的可读参数在 context.jsonl 的 llm_response.tool_calls。
      return { kind: 'proto', rec: { t, type, callId: d.tool_call_id || null, tool: d.tool || '?',
        text: '→ ' + (d.tool || '?') + (d.args_chars ? '（参数 ' + d.args_chars + ' 字）' : '') } };
    }
    if (type === 'tool_result') {
      let ok = null, msg = '';
      try { const r = JSON.parse(d.result || '{}'); ok = r.success; msg = r.message || ''; } catch { msg = String(d.result || ''); }
      return { kind: 'proto', rec: { t, type, callId: d.tool_call_id || null, tool: d.tool || null, ok,
        text: (ok === false ? '✘ ' : ok === true ? '✔ ' : '? ') + clip(msg, 140) } };
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
    if (type === 'observer_tick') {
      if (!d || typeof d !== 'object' || Array.isArray(d) || (d.nearby != null && !Array.isArray(d.nearby))) throw new Error('invalid observer_tick nearby');
      return { kind: 'event', rec: { t, type, tick: d } };
    }
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
    if (it.kind === 'act') {
      for (const c of (it.rec.calls || [])) if (c && c.id) state.calls[c.id] = { name: c.name, args: c.args, t: it.rec.t };
      state.callsN = (state.callsN || 0) + 1;
      if (state.callsN > 8000) {   // 有界：只留最近 4000 个 callId
        const ks = Object.keys(state.calls);
        for (let i = 0; i < ks.length - 4000; i++) delete state.calls[ks[i]];
        state.callsN = 4000;
      }
    }
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
    L.push('goal_id=' + cv.goalId + '  status=' + cv.status + '  stateVersion=' + cv.version + '  链数据年龄=' + ago(state.last.chain.t, now));
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
    // ★ 2026-10-28 用户提醒：多玩家同服时睡觉跳夜要所有人睡，bot/Observer 不睡会卡夜 —— 摆在「身体」这一节。
    //   规则常显（它是常识，不依赖数据）；只有样本新鲜时才敢报「当前有几个人」。
    const fresh = (now - state.last.observer.t) < 10 * 60 * 1000;
    const others = (obs.nearby || []).filter((e) => e && e.category === 'player').length;
    L.push('睡觉注意：多人同服跳夜要所有人睡（playersSleepingPercentage 默认 100）—— bot / Observer 不睡会卡夜；' +
      '睡眠 A/B 前只留一个玩家。' + (fresh && others > 0 ? '（本样本视野内另有 ' + others + ' 个玩家）' : ''));
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
  // 换存档/没建链时，链快照会停在上一局；不标年龄就会被当成当前局读。
  if (state.last.chain && (now - state.last.chain.t) > 10 * 60 * 1000) {
    alerts.push('任务链数据 ' + ago(state.last.chain.t, now) + ' 没更新 —— 可能换了存档/本局还没建链，别当当前局');
  }
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

// ── strand：把「说 / 做 / 果 / 链 / 死」按时间串成一条 ──────────────────────
/** 链里值得进活线的类型（周期快照走「状态迁移折叠」，资产/事实快照是噪声，不进） */
const STRAND_CHAIN_TYPES = new Set([
  'requirement_manifest', 'requirement_gaps_changed', 'subtask_stalled', 'subtask_resumed',
  'subtask_stall_escalated', 'carrier_alarm', 'chain_recovering', 'goal_kickoff',
]);

function renderStrand(state, meta) {
  const now = (meta && meta.now) || Date.now();
  const items = [];
  // key：去重键。monitor 有「同一逻辑事件被两个生产者各写一遍」（如 tool_result 的 client / server-async，
  // event_id 不同、callId 与正文相同），所以「果」按 callId+正文去重，而不是按 event_id。
  const push = (t, kind, text, id, key) => { if (t == null) return; items.push({ t, kind, text, id: id || null, key: key || null }); };
  // 说 / 用户 / 规划：对话流（她说的那句来自 ai.jsonl assistant；执行 AI 的正文不重复进）
  for (const r of state.ring.chat) {
    if (r.type === 'assistant') push(r.t, '说', clip(r.text, 300), r.id, 'say:' + r.t + '|' + clip(r.text, 300));
    else if (r.type === 'user_prompt') push(r.t, '用户', clip(r.text, 200), r.id, 'user:' + r.t + '|' + clip(r.text, 200));
    else if (r.type === 'llm_response') push(r.t, '规划', clip(r.text, 200), r.id, 'plan:' + r.t + '|' + clip(r.text, 200));
  }
  // 做：执行 AI 每次响应里的 tool_calls（带参数；参数只有 context.jsonl 有）
  for (const r of state.ring.act) {
    for (const c of (r.calls || [])) {
      const t2 = clip(c.name + (c.args ? ' ' + String(c.args) : ''), 260);
      push(r.t, '做', t2, r.id, 'act:' + (c.id || r.t + '#' + t2));
    }
  }
  // 果：tool_result（按 tool_call_id 把工具名配回来）
  for (const r of state.ring.proto) {
    if (r.type !== 'tool_result') continue;
    const known = r.callId && state.calls[r.callId];
    const txt2 = clip((known ? known.name + ' ' : '') + r.text, 280);
    push(r.t, '果', txt2, r.id, 'res:' + (r.callId || 't' + r.t) + '|' + txt2);
  }
  // 链：状态迁移 + 明确事件（同一状态连续快照折叠）
  let prevKey = null;
  for (const r of state.ring.chain) {
    if (r.chain) {
      const c = r.chain;
      const key = (c.primaryStatus || '?') + '|' + (c.currentSubtaskId || '?') + '|' + (c.stateVersion == null ? '?' : c.stateVersion);
      if (key === prevKey) continue;
      prevKey = key;
      push(r.t, '链', clip('status=' + (c.primaryStatus || '?') + ' v=' + (c.stateVersion == null ? '?' : c.stateVersion) + ' stage=' + (c.currentSubtaskId || '?'), 200), r.id, r.id ? null : 'chain:' + r.t + '|' + key);
    } else if (STRAND_CHAIN_TYPES.has(r.type)) {
      const extra = r.gaps ? String(r.gaps) : (r.brief || '');
      const txt3 = clip(r.type + (extra ? ' ' + extra : ''), 200);
      push(r.t, '链', txt3, r.id, 'chain:' + r.t + '|' + txt3);
    }
  }
  // 死
  for (const r of state.ring.death) push(r.t, '死', clip(r.text, 200), r.id, 'death:' + r.t + '|' + clip(r.text, 200));

  items.sort((a, b) => (a.t || 0) - (b.t || 0));
  // monitor 里确实存在同 event_id 的重复行（实测 tools.jsonl 1200 行里 64 条重复），按 id 去重。
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const k = it.key || (it.id ? 'id:' + it.id + '|' + it.kind : 'txt:' + it.kind + '|' + it.t + '|' + it.text);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }
  items.length = 0;
  items.push(...uniq);
  const MAX = 80;
  const shown = items.slice(-MAX);

  const L = [];
  L.push('# 实验台 live · strand（说 / 做 / 果 / 链 / 死，按时间串成一条）');
  L.push('captured_at=' + ts(now) + '  条目=' + items.length + '（各流 ring 上限 ' + RING + '；只留最近 ' + MAX + ' 条）');
  L.push('规则：说=ai.jsonl assistant（内脑自述）｜做=执行 AI 响应里的 tool_calls（参数只存在 context.jsonl）｜果=tools.jsonl tool_result｜链=任务链状态迁移｜死=死亡');
  L.push('⚠ 思考（hidden reasoning）不在监控数据里：llm_response 写着 excluded=[credentials,hidden_reasoning]，这一串只有「她说 / 她做 / 结果」，没有「她想」。');
  L.push('');
  if (!items.length) {
    L.push('未观测到可串的事件（ring 里还没有 assistant / llm_response.tool_calls / tool_result / 链迁移）。');
    L.push('这**不是**「她没说没做」——是本进程还没吃到这些流，或 watch.json 关掉了 strand。');
    return L.join('\n') + '\n';
  }
  if (items.length > shown.length) L.push('（更早的 ' + (items.length - shown.length) + ' 条已滚动丢弃）');
  L.push('## 最近 ' + shown.length + ' 条（旧 → 新）');
  L.push('');
  for (const it of shown) L.push('[' + ts(it.t) + '] ' + it.kind + '  ' + it.text);
  L.push('');
  L.push('> 只读拼接：来自 monitor/*.jsonl；不补缺项，「没观测到」不写成「没做」。');
  return L.join('\n') + '\n';
}

const RENDERERS = { snapshot: renderSnapshot, chain: renderChain, chat: renderChat, context: renderContext, strand: renderStrand };

function render(view, state, meta) {
  const fn = RENDERERS[view];
  if (!fn) throw new Error('unknown view: ' + view);
  const warnings = Object.entries(state.files).filter(([, f]) => f.gaps || f.malformed || f.late).map(([name, f]) => name + ': gaps=' + (f.gaps || 0) + ' skipped_bytes=' + (f.skippedBytes || 0) + ' malformed=' + (f.malformed || 0) + ' late=' + (f.late || 0) + ' last=' + (f.gapReason || '-'));
  return fn(state, meta || {}) + '\n> 采集连续性 UNKNOWN（无法证明完整）；' + (warnings.length ? warnings.join('；') : '未检测到缺口') + '\n';
}

/** 一次渲染所有选中视图，返回 {view: text}。 */
function renderAll(state, meta, views) {
  const out = {};
  for (const v of (views && views.length ? views : VIEWS)) out[v] = render(v, state, meta);
  return out;
}

module.exports = {
  VIEWS, DEFAULT_MONITOR, MAX_TEXT, RING,
  newState, readTail, normalize, apply, render, renderAll, renderStrand, chainView,
  loadControl, saveControl, writeAtomic, ts, ago, clip, bindWindow, observeNormalEnd,
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
      ...(o.bridgeWindow !== undefined ? { bridgeWindow: o.bridgeWindow } : {}),
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


// 047 (2026-11-12): external host binds raw scope once; no world/identity authority.
const windowFields = ['windowKey','worldId','serverSession','companion','run','targetSession','since','logFile','encoding','timezone'];
const hashBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const zonedTime = s => typeof s === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(s) ? Date.parse(s) : NaN;
function validateWindow(b) {
  if (!b || !windowFields.slice(0,6).every(k => typeof b[k] === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(b[k]))) throw new Error('window-scope-incomplete');
  if (!Number.isFinite(zonedTime(b.since)) || !path.isAbsolute(b.logFile || '') || b.logFile.length > 512 || /[\x00-\x1f]/.test(b.logFile)
      || !['utf-8','gb18030'].includes(b.encoding) || !/^[+-](?:0\d|1[0-3]):[0-5]\d$|^[+-]14:00$/.test(b.timezone || '')) throw new Error('window-source-or-time-unknown');
}
function windowHash(b) { return hashBytes(JSON.stringify([...windowFields.map(k => b[k]),b.source])); }
function bindWindow(out, input, now = Date.now()) {
  validateWindow(input);
  if (zonedTime(input.since) > now) throw new Error('window-start-in-future');
  const prior = loadControl(out).bridgeWindow;
  if (prior?.windowKey === input.windowKey) {
    if (windowFields.some(k => prior[k] !== input[k])) throw new Error('window-binding-conflict');
    return prior; // Same explicit command never moves the bound EOF forward.
  }
  const st = fs.lstatSync(input.logFile);
  if (!st.isFile()) throw new Error('log-not-regular-file');
  const cursor = {}, tail = readTail(input.logFile, st.size, 2*1024*1024, cursor);
  if (tail.missing || tail.reset || tail.skipped || tail.partial || !cursor.identity || (tail.size && cursor.anchor[cursor.anchor.length-1] !== 10)) throw new Error('log-start-boundary-unknown');
  const b = Object.fromEntries(windowFields.map(k => [k,input[k]]));
  b.source = {offset:tail.offset,size:cursor.size,identity:cursor.identity,anchorStart:cursor.anchorStart,anchor:cursor.anchor.toString('base64'),boundAt:new Date(now).toISOString()};
  saveControl(out,{bridgeWindow:b},'bench live bind-window');
  return b;
}
function logMarker(record, timezone) {
  const text = record.text.replace(/\r$/, '');
  const m = /^\[(\d{1,2})(\d{2})月(\d{4}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\] \[(Render|Server) thread\/INFO\] \[(net\.minecraft\.(?:client\.Minecraft|server\.MinecraftServer)\/|minecraft\/(?:Minecraft|MinecraftServer))\]: (Stopping!|All dimensions are saved)$/.exec(text);
  if (!m) return null;
  const [,day,month,year,hour,min,sec,ms,thread,logger,message] = m;
  if ((message === 'Stopping!' && (thread !== 'Render' || !['net.minecraft.client.Minecraft/','minecraft/Minecraft'].includes(logger)))
      || (message !== 'Stopping!' && (thread !== 'Server' || !['net.minecraft.server.MinecraftServer/','minecraft/MinecraftServer'].includes(logger)))) return null;
  const local = year+'-'+month+'-'+day.padStart(2,'0')+'T'+hour+':'+min+':'+sec+'.'+ms;
  const date = new Date(local+'Z');
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0,23) !== local) throw new Error('log-time-invalid');
  const time = Date.parse(local+timezone);
  return {...record,kind:message === 'Stopping!' ? 'stopping' : 'saved',at:new Date(time).toISOString()};
}
function observeNormalEnd(state, opt) {
  const b = opt.bridgeWindow;
  if (b === undefined) return undefined; // No bridge files, log reads or state when unconfigured.
  let progress;
  try {
    validateWindow(b);
    const src = b.source;
    if (!src || !Number.isFinite(zonedTime(src.boundAt)) || zonedTime(src.boundAt) < zonedTime(b.since) || !Number.isSafeInteger(src.offset) || src.offset < 0 || src.size !== src.offset || typeof src.identity !== 'string' || !src.identity
        || !Number.isSafeInteger(src.anchorStart) || src.anchorStart !== Math.max(0,src.size-256) || typeof src.anchor !== 'string'
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(src.anchor)
        || Buffer.from(src.anchor,'base64').length !== src.size-src.anchorStart) throw new Error('log-source-binding-incomplete');
    const key = windowHash(b);
    if (state.bridge && state.bridge.key !== key && state.bridge.windowKey === b.windowKey) throw new Error('window-binding-conflict');
    progress = state.bridge;
    if (!progress || progress.key !== key) progress = state.bridge = {key,windowKey:b.windowKey,offset:src.offset,cursor:{seen:true,size:src.size,identity:src.identity,anchorStart:src.anchorStart,anchor:Buffer.from(src.anchor,'base64')},status:'WAITING'};
    if (progress.failed || progress.status === 'NOTIFIED') return progress;
    const noticeFile = path.join(opt.out,'bench-bridge-binding.json');
    if (fs.existsSync(noticeFile)) {
      const st = fs.lstatSync(noticeFile);
      if (!st.isFile() || st.size > 16384) throw new Error('notice-unreadable');
      const old = JSON.parse(fs.readFileSync(noticeFile,'utf8'));
      if (old.windowKey === b.windowKey) {
        if (old.hostBindingHash !== key) throw new Error('window-binding-conflict');
        progress.status = 'NOTIFIED'; return progress;
      }
    }
    const cursor = {...progress.cursor};
    const r = readTail(b.logFile,progress.offset,2*1024*1024,cursor,{encoding:b.encoding,records:true});
    if (r.missing || r.reset || r.skipped || r.decodeError || r.dropping) throw new Error(r.decodeError || r.reason || 'log-read-gap');
    if (r.partial) { progress.status='UNKNOWN'; progress.reason='partial-log-line'; return progress; }
    const now = opt.now || Date.now();
    for (const record of r.records) {
      const marker = logMarker(record,b.timezone);
      if (!marker) continue;
      const time = zonedTime(marker.at);
      if (time < Math.max(zonedTime(b.since),zonedTime(src.boundAt) || 0) || time > now) throw new Error('log-time-outside-window');
      if (marker.kind === 'stopping') {
        if (progress.stopping) throw new Error('multiple-stop-markers');
        progress.stopping=marker;
      } else if (progress.stopping) {
        if (time < zonedTime(progress.stopping.at)) throw new Error('log-time-reversed');
        if (progress.saved) throw new Error('multiple-save-markers');
        progress.saved=marker;
      }
    }
    progress.offset=r.offset; progress.cursor=cursor;
    if (!progress.saved) { progress.status='WAITING'; delete progress.reason; return progress; }
    const cutoff=progress.saved.at;
    const pack=require('./evidence-pack').fromDir(opt.monitor,{mode:'list',asOf:cutoff,worldId:b.worldId,serverSession:b.serverSession,companion:b.companion,run:b.run,
      maxSourceFiles:12,maxSourceBytes:4*1024*1024,limit:24,maxBytes:64000});
    if (pack.schemaVersion !== 1 || !Array.isArray(pack.rows) || !pack.asOf) throw new Error('evidence-package-unavailable');
    pack.notification={kind:'normal-end-log-only',identityStatus:'UNKNOWN',worldEffects:'UNKNOWN',windowKey:b.windowKey,since:b.since,cutoff};
    const bytes=JSON.stringify(pack), packageFile=path.join(path.resolve(opt.out),'bench-bridge-'+hashBytes(b.windowKey).slice(0,24)+'.json');
    if (Buffer.byteLength(bytes) > 1024*1024) throw new Error('evidence-package-budget');
    writeAtomic(packageFile,bytes);
    const notice={...Object.fromEntries(windowFields.slice(0,7).map(k=>[k,b[k]])),cutoff,packageFile,packageSha256:hashBytes(bytes),hostBindingHash:key,
      logProof:{file:b.logFile,encoding:b.encoding,timezone:b.timezone,stopping:progress.stopping,saved:progress.saved,identityStatus:'UNKNOWN'},
      end:{kind:'normal-end',at:cutoff,windowKey:b.windowKey,worldId:b.worldId,serverSession:b.serverSession,companion:b.companion,run:b.run,cutoff}};
    writeAtomic(noticeFile,JSON.stringify(notice));
    progress.status='NOTIFIED'; delete progress.reason;
  } catch(e) {
    progress = progress || state.bridge || {};
    Object.assign(progress,{status:'UNKNOWN',failed:true,reason:String(e.message).slice(0,200)});
    state.bridge=progress;
  }
  return progress;
}
