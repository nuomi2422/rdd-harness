'use strict';
/**
 * A0（90 号批次）证据块：把一次 run 的
 *   会话边界 / 人工介入 / 检索投送四阶段 / 世界视图关联
 * 汇成可回放的三段结构，挂到 envelope 上（旧字段一律不动）。
 *
 * 纪律（90 号 §11 + 85 号）：
 *   1. 缺失即 UNKNOWN/PARTIAL，绝不补 0/false/成功；
 *   2. 只读既有事实源（monitor 落盘事件 / chat.jsonl / world-view），不新建采集中心；
 *   3. 不改任何规划、战斗、告警语义；
 *   4. `ExposureLedger` 是会话内存（不落盘），**不能**当这里的账本。
 *
 * CLI: node a0-evidence.js selftest        离线判据（无游戏、无网络）
 *      node a0-evidence.js backfill <runDir> 给已有 run 补 A0 块（只补，不覆盖已有 A0）
 */

const fs = require('fs');
const path = require('path');

const A0_VERSION = 'a0-v1';
const KINDS = ['GIVE', 'TP', 'REVIVE', 'PILLAR', 'CRYSTAL', 'DRAGON', 'SHOOT', 'HEAL', 'OTHER'];
const ACTORS = ['HUMAN', 'AGENT_ADMIN', 'HARNESS', 'GAME_RULE', 'UNKNOWN'];
const SOURCES = ['MONITOR_EVENT', 'GAME_LOG', 'MANUAL_DECLARATION'];

/** admin_command_used.data.mode → 介入类别（未知 mode 归 OTHER，不丢事件）。 */
const MODE_TO_KIND = {
  'direct-give': 'GIVE',
  'direct-teleport': 'TP',
  revive: 'REVIVE',
  'revive-heal': 'REVIVE',
  'pillar-up': 'PILLAR',
  'crystal-clear': 'CRYSTAL',
  'dragon-fight': 'DRAGON',
  'shoot-at': 'SHOOT',
  heal: 'HEAL',
};

/** 这条介入改了实验前提的哪一面（结论侧据此拒绝「自主成功」）。 */
const IMPACT = {
  GIVE: ['resource'],
  TP: ['position'],
  REVIVE: ['life', 'position', 'resource'],
  PILLAR: ['position'],
  CRYSTAL: ['combat_precondition'],
  DRAGON: ['combat_precondition'],
  SHOOT: ['combat'],
  HEAL: ['life'],
  OTHER: [],
};

// ---------------------------------------------------------------- 解析 ----

/** 逐行 JSON；坏行留在 bad 里（不抛、不吞）。 */
function parseJsonl(text) {
  const rows = [];
  const bad = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e) {
      bad.push({ line: i + 1, reason: e.message.slice(0, 120) });
    }
  }
  return { rows, bad };
}

const toMs = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

// -------------------------------------------------------- 会话边界 ----

/**
 * 会话洁净三态。判据（按优先级）：
 *   ① 首请求缺失 → UNKNOWN（没有证据，不猜）
 *   ② chat 归档缺失/空 → UNKNOWN
 *   ③ chat 里**最早一条记录就晚于本次启动** → CLEAN（新进程结构上就没有旧历史，证据=文件本身）
 *   ④ 有 clear 边界、且边界早于首请求、且首请求消息数 ≤ 2 → CLEAN
 *   ⑤ 首请求消息数 > 2 → DIRTY（请求里已经带着历史）
 *   ⑥ 其余 → UNKNOWN
 * 绝不把 ⑥ 写成 CLEAN。
 */
function classifySession({ chatRows, firstRequest, runStartAt }) {
  const out = {
    status: 'UNKNOWN',
    clear_boundary_at: null,
    first_request_message_count: null,
    first_request_at: null,
    legacy_messages_present: null,
    chat_records_after_clear: null,
    evidence: [],
    reasons: [],
  };
  if (!firstRequest || firstRequest.messageCount == null) {
    out.reasons.push('no-first-llm-request');
    return out;
  }
  out.first_request_message_count = firstRequest.messageCount;
  out.first_request_at = firstRequest.at || null;
  if (firstRequest.eventId) out.evidence.push('evidence/context.jsonl#' + firstRequest.eventId);

  if (!Array.isArray(chatRows) || chatRows.length === 0) {
    out.reasons.push('no-chat-archive');
    return out;
  }

  const withTs = chatRows.map((r) => ({ r, ts: toMs(r.ts != null ? r.ts : r.created) })).filter((x) => x.ts != null);
  const clears = withTs.filter((x) => x.r.type === 'clear').map((x) => x.ts).sort((a, b) => a - b);
  const roles = withTs.filter((x) => typeof x.r.role === 'string' && x.r.role);
  const startMs = toMs(runStartAt);
  const firstReqMs = toMs(out.first_request_at);

  out.legacy_messages_present = (startMs != null && roles.length)
    ? roles.some((x) => x.ts < startMs)
    : null;

  if (!withTs.length) {
    out.reasons.push('chat-archive-has-no-timestamps');
    return out;
  }

  const earliest = Math.min.apply(null, withTs.map((x) => x.ts));
  if (startMs != null && earliest >= startMs) {
    out.status = 'CLEAN';
    out.reasons.push('fresh-process(first-chat-record-after-launch)');
    return out;
  }

  if (clears.length) {
    const boundary = clears[clears.length - 1];
    out.clear_boundary_at = new Date(boundary).toISOString();
    out.chat_records_after_clear = roles.filter((x) => x.ts > boundary).length;
    const beforeFirst = firstReqMs != null && boundary <= firstReqMs;
    if (beforeFirst && out.first_request_message_count <= 2) {
      out.status = 'CLEAN';
      out.reasons.push('clear-boundary-before-first-request');
      return out;
    }
    if (!beforeFirst) out.reasons.push('clear-boundary-after-first-request');
  } else {
    out.reasons.push('no-clear-record');
  }

  if (out.first_request_message_count > 2) {
    out.status = 'DIRTY';
    out.reasons.push('first-request-carries-history');
    return out;
  }
  return out;
}

// -------------------------------------------------------- 人工介入 ----

/** 从一条 monitor 事件推介入类别。 */
function kindOf(data) {
  data = data || {};
  const mode = typeof data.mode === 'string' ? data.mode : '';
  if (MODE_TO_KIND[mode]) return MODE_TO_KIND[mode];
  const cmd = String(data.command || '').trim().toLowerCase();
  const verb = cmd.split(/\s+/)[0];
  if (verb === 'give') return 'GIVE';
  if (verb === 'tp' || verb === 'teleport') return 'TP';
  // 通用命令路径（setblock / fill / summon / gamemode / time / weather …）没有 mode，
  // 但**它仍然是一次介入**（改动世界或前置）。归 OTHER，不丢事件 —— 丢证据比分类粗糙更糟。
  return cmd ? 'OTHER' : null;
}

/**
 * 规范化一条介入事件。缺关键字段一律拒收（返回 ok:false），
 * 不接受「靠补默认值凑出一条记录」。
 */
function normalizeIntervention(ev) {
  const at = toMs(ev && ev.timestamp);
  const eventId = ev && ev.event_id;
  const data = (ev && ev.data) || {};
  const kind = kindOf(data);
  const actor = ACTORS.includes(data.actor) ? data.actor : 'UNKNOWN';
  if (!at) return { ok: false, reason: 'missing-timestamp', eventId: eventId || null };
  if (!eventId) return { ok: false, reason: 'missing-event-id', eventId: null };
  if (!kind) return { ok: false, reason: 'unknown-kind', eventId };
  const entry = {
    interventionId: 'iv-' + eventId,
    eventId,
    runId: data.runId || null,
    kind,
    at: new Date(at).toISOString(),
    atMs: at,
    actor,
    // 事件里没有 actor 字段时如实标：这次介入**经工具通道**发生，谁按的键无法从证据判定。
    actor_evidence: data.actor ? 'event-field' : 'not-recorded',
    source: 'MONITOR_EVENT',
    via: 'admin-tool',
    mode: data.mode || null,
    command: data.command || null,
    stuck: data.stuck || null,
    impact: IMPACT[kind] ? IMPACT[kind].slice() : [],
    autonomous_attributable: false,
  };
  return { ok: true, entry };
}

/** 汇总介入：按 eventId 去重；同时记录被拒收的条目（审计用）。 */
function collectInterventions(events, opts) {
  const options = opts || {};
  const entries = [];
  const rejected = [];
  const seen = new Set();
  let dup = 0;
  for (const ev of events || []) {
    if (!ev || ev.type !== 'admin_command_used') continue;
    const n = normalizeIntervention(ev);
    if (!n.ok) {
      rejected.push({ eventId: n.eventId, reason: n.reason });
      continue;
    }
    if (seen.has(n.entry.eventId)) {
      dup++;
      continue;
    }
    seen.add(n.entry.eventId);
    entries.push(n.entry);
  }
  entries.sort((a, b) => a.atMs - b.atMs);
  const status = entries.length ? 'PRESENT' : (options.eventsAvailable === false ? 'UNKNOWN' : 'NONE');
  return {
    count: entries.length,
    ids: entries.map((e) => e.interventionId),
    status,
    byKind: entries.reduce((m, e) => { m[e.kind] = (m[e.kind] || 0) + 1; return m; }, {}),
    entries,
    rejected,
    duplicatesDropped: dup,
  };
}

// ---------------------------------------------------- 检索投送四阶段 ----

/**
 * 从落盘事件还原四阶段。事实边界（90 号 §6.1）：
 *   RECALLED        = retrieval_snapshot（只有聚合 entries，**没有 per-ref**，如实标 AGGREGATE_ONLY）
 *   RENDERED        = expanded / auto_expanded（正文渲染；auto_expanded 只报 hits，没有 ref）
 *   KEPT            = 最终请求装配后保留 = request_delivered 的 refs（先裁后记）
 *   REQUEST_DELIVERED = request_delivered.refs
 *   TRUNCATED       = expanded{truncated:true} + retrieval_snapshot.truncationReasons
 * 绝不把 runtime_state 里出现 ref 当成 delivered（本函数不读 runtime_state）。
 */
function collectDelivery({ contextRows, expmemRows }) {
  const ctx = contextRows || [];
  const mem = expmemRows || [];

  const snapshots = ctx.filter((e) => e && e.type === 'retrieval_snapshot');
  const expanded = mem.filter((e) => e && e.type === 'expanded');
  const autoExpanded = mem.filter((e) => e && e.type === 'auto_expanded');
  const deliveredEvents = mem.filter((e) => e && e.type === 'request_delivered');

  const truncationReasons = [];
  let recalledEntries = 0;
  for (const s of snapshots) {
    const d = s.data || {};
    recalledEntries += Number(d.entries || 0);
    for (const r of (Array.isArray(d.truncationReasons) ? d.truncationReasons : [])) {
      const t = String(r);
      if (!truncationReasons.includes(t)) truncationReasons.push(t);
    }
  }

  const renderedRefs = [];
  const truncatedRefs = [];
  for (const e of expanded) {
    const d = e.data || {};
    if (!d.ref) continue;
    if (!renderedRefs.includes(d.ref)) renderedRefs.push(d.ref);
    if (d.truncated === true) truncatedRefs.push(d.ref);
  }

  const deliveredRefs = [];
  let deliveredEventsCount = 0;
  for (const e of deliveredEvents) {
    const d = e.data || {};
    deliveredEventsCount++;
    for (const r of (Array.isArray(d.refs) ? d.refs : [])) if (!deliveredRefs.includes(r)) deliveredRefs.push(r);
  }

  // 渲染过但最终请求里没有 = 被预算裁掉（可审计的"没送到"）
  const droppedRefs = renderedRefs.filter((r) => !deliveredRefs.includes(r));
  // 反向：最终请求里有、但没见过 expanded —— 这是**正常**的（执行视图直接注入正文，
  // 不一定经过逐条 expanded）。不能当成矛盾，但要单列出来供审计。
  const deliveredWithoutRender = deliveredRefs.filter((r) => !renderedRefs.includes(r));
  // 截断的条目即便出现在 delivered 里也只能算"半截"，单独列出
  const truncatedDelivered = truncatedRefs.filter((r) => deliveredRefs.includes(r));

  const anyEvidence = snapshots.length || expanded.length || autoExpanded.length || deliveredEvents.length;
  return {
    status: anyEvidence ? 'PRESENT' : (contextRows && expmemRows ? 'NONE' : 'UNKNOWN'),
    recalled: {
      snapshots: snapshots.length,
      entriesAggregate: recalledEntries,
      refs: null,
      refs_status: 'AGGREGATE_ONLY',
    },
    rendered: {
      events: expanded.length,
      autoEvents: autoExpanded.length,
      autoHitsAggregate: autoExpanded.reduce((n, e) => n + Number((e.data || {}).hits || 0), 0),
      refs: renderedRefs,
      note: 'auto_expanded 只报 hits，不含 ref',
    },
    kept: {
      refs: deliveredRefs.slice(),
      note: '最终请求装配后保留（先裁后记）；与 delivered 同源',
    },
    delivered: {
      events: deliveredEventsCount,
      refs: deliveredRefs,
    },
    truncated: {
      refs: truncatedRefs,
      reasons: truncationReasons,
      deliveredAnyway: truncatedDelivered,
    },
    dropped: { refs: droppedRefs, count: droppedRefs.length },
    // 最终请求里有、但没有逐条 expanded 的 ref（执行视图直接注入）——不是矛盾
    deliveredWithoutRender: { refs: deliveredWithoutRender, count: deliveredWithoutRender.length },
    // 判据：任何"截断却算送达"都要在结论侧拦住
    truncatedCountedAsDelivered: truncatedDelivered.length > 0,
  };
}

// ------------------------------------------------------ 世界视图 ----

/** 从 envelope.world + evidence/world-view-<phase>.json 汇总四相位视图关联。 */
function worldViewsFromEnvelope(env, readJson) {
  const out = { before: null, after: null, death: null, review: null, drift: null, evidence: [] };
  const w = (env && env.world) || {};
  for (const phase of ['before', 'after', 'death', 'review']) {
    let v = w[phase];
    if (!v && readJson) {
      const j = readJson('evidence/world-view-' + phase + '.json');
      if (j) v = j;
    }
    if (!v) continue;
    out[phase] = {
      view_id: v.view_id || null,
      control_key: v.control_key || null,
      captured_at: v.captured_at || null,
      coverage: v.coverage || null,
      complete: typeof v.complete === 'boolean' ? v.complete : null,
    };
    if (v.view_id) out.evidence.push('world-view:' + phase + '#' + v.view_id);
  }
  out.drift = (w.drift === undefined) ? null : w.drift;
  return out;
}

// ------------------------------------------------- envelope 接线 ----

/** 把三段并进 envelope：只加键，不改/不删旧键（离线判据要断言这点）。 */
function applyToEnvelope(env, { session, interventions, delivery, worldViews }) {
  const out = Object.assign({}, env); // 浅拷贝：旧键原样
  out.session = session || { status: 'UNKNOWN', reasons: ['not-collected'] };
  out.interventions = interventions || { count: 0, ids: [], status: 'UNKNOWN', entries: [], rejected: [] };
  out.context_delivery = delivery || { status: 'UNKNOWN' };
  if (worldViews) out.world_views = worldViews;
  out.a0 = {
    version: A0_VERSION,
    collected_at: new Date().toISOString(),
    session_status: out.session.status,
    interventions_status: out.interventions.status,
    delivery_status: out.context_delivery.status,
  };
  return out;
}

/**
 * 结论侧闸门：A0 证据不足以支持"自主成功"时，把 PASS 降级。
 * 返回 {overall, downgraded, reasons[]}；不改动其它任何字段。
 */
function gateVerdict(overall, env) {
  const reasons = [];
  const s = env && env.session;
  const i = env && env.interventions;
  const d = env && env.context_delivery;
  if (!env || !env.a0) {
    return { overall: overall === 'PASS' ? 'INCONCLUSIVE' : overall, downgraded: overall === 'PASS', reasons: ['a0:missing'] };
  }
  if (s && s.status === 'DIRTY') reasons.push('session:DIRTY');
  if (s && s.status === 'UNKNOWN') reasons.push('session:UNKNOWN');
  if (i && i.status === 'UNKNOWN') reasons.push('interventions:UNKNOWN');
  if (i && i.status === 'PRESENT') reasons.push('interventions:PRESENT(' + i.count + ')');
  if (d && d.truncatedCountedAsDelivered) reasons.push('delivery:truncated-counted-as-delivered');
  if (!reasons.length) return { overall, downgraded: false, reasons: [] };
  const downgraded = overall === 'PASS' || overall === 'PASS_WITH_GAPS';
  return { overall: downgraded ? 'INCONCLUSIVE' : overall, downgraded, reasons };
}

/** timeline 用的行（不含时间侧判定；没有来源就返回空数组，不造事件）。 */
function timelineEntries(env) {
  const out = [];
  if (!env) return out;
  const s = env.session;
  if (s && (s.first_request_at || s.status)) {
    out.push({
      // ★ 用**首请求时刻**做这条线的时间戳：clear_boundary 可能是几天前（陈旧 clear），
      //   拿它当 at 会把「会话边界」画到 run 之前几十万秒处（实测 T-229841s）。
      at: s.first_request_at || (env.timings && env.timings.stimulusSentAt) || null,
      tag: 'a0',
      text: '会话边界 ' + s.status + '  首请求msgs=' + (s.first_request_message_count == null ? '?' : s.first_request_message_count)
        + '  clear=' + (s.clear_boundary_at || 'none') + (s.reasons && s.reasons.length ? '  ' + s.reasons.join(',') : ''),
    });
  }
  const wv = env.world_views || {};
  for (const phase of ['before', 'death', 'review', 'after']) {
    const v = wv[phase];
    if (!v) continue;
    out.push({
      at: v.captured_at,
      tag: 'view',
      text: 'world-view[' + phase + '] view_id=' + (v.view_id || '?') + ' coverage=' + (v.coverage || '?')
        + ' control_key=' + String(v.control_key || '?').slice(0, 60),
    });
  }
  const iv = env.interventions;
  if (iv && Array.isArray(iv.entries)) {
    for (const e of iv.entries) {
      out.push({
        at: e.at,
        tag: 'interv',
        text: '介入 ' + e.kind + '  actor=' + e.actor + '  ' + String(e.command || e.mode || '').slice(0, 70)
          + '  impact=' + (e.impact || []).join('+'),
      });
    }
  }
  const d = env.context_delivery;
  if (d && d.status && d.status !== 'UNKNOWN') {
    const at = (env.timings && env.timings.watchEnd) || (env.timings && env.timings.stimulusSentAt) || null;
    out.push({
      at,
      tag: 'deliv',
      text: '投送 recalled=' + (d.recalled ? d.recalled.snapshots : '?') + '份/' + (d.recalled ? d.recalled.entriesAggregate : '?') + '条'
        + '  rendered=' + (d.rendered ? d.rendered.refs.length : '?') + '条'
        + '  delivered=' + (d.delivered ? d.delivered.refs.length : '?') + '条'
        + '  dropped=' + (d.dropped ? d.dropped.count : '?') + '条'
        + '  truncated=' + (d.truncated ? d.truncated.refs.length : '?'),
    });
  }
  return out;
}

// -------------------------------------------------------- 落盘采集 ----

function firstLlmRequestFromJsonl(text) {
  const { rows } = parseJsonl(text);
  for (const e of rows) {
    if (!e || e.type !== 'llm_request') continue;
    const d = e.data || {};
    const msgs = (d.request && Array.isArray(d.request.messages)) ? d.request.messages.length : null;
    return { at: e.timestamp || null, messageCount: msgs, eventId: e.event_id || null };
  }
  return null;
}

function readIfExists(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch (e) { return null; }
}

/**
 * 一次 run 的 A0 采集。**必须在受控复位（restore）之前调用**——restore 会把
 * companions/ 整目录还原，run 期间的 chat.jsonl 会被冲掉。
 */
function collect({ runDir, monitorDir, companionsDir, launchStart, now }) {
  const ev = (f) => path.join(runDir, 'evidence', f);
  const nowIso = now || new Date().toISOString();
  const sources = {};

  // 1) 会话：挑窗口内最活跃的那个同伴 chat.jsonl，先归档再判定
  const ctxText = readIfExists(ev('context.jsonl'));
  sources.context = ctxText != null;
  const firstRequest = ctxText != null ? firstLlmRequestFromJsonl(ctxText) : null;

  let chatUuid = null;
  let chatRows = null;
  let chatArchive = null;
  try {
    const dirs = (companionsDir && fs.existsSync(companionsDir))
      ? fs.readdirSync(companionsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
      : [];
    let best = { score: -1, uuid: null, rows: null, text: null, file: null };
    for (const d of dirs) {
      const p = path.join(companionsDir, d.name, 'chat.jsonl');
      const text = readIfExists(p);
      if (text == null) continue;
      const parsed = parseJsonl(text);
      const startMs = toMs(launchStart);
      const score = parsed.rows.filter((r) => {
        const ts = toMs(r.ts != null ? r.ts : r.created);
        return ts != null && (startMs == null || ts >= startMs);
      }).length;
      if (score > best.score) best = { score, uuid: d.name, rows: parsed.rows, text, file: p };
    }
    if (best.uuid) {
      chatUuid = best.uuid;
      chatRows = best.rows;
      const outDir = ev('chat');
      fs.mkdirSync(outDir, { recursive: true });
      chatArchive = path.join(outDir, best.uuid + '.jsonl');
      fs.writeFileSync(chatArchive, best.text);
      sources.chat = true;
    } else {
      sources.chat = false;
    }
  } catch (e) {
    sources.chat = false;
  }

  const session = classifySession({ chatRows, firstRequest, runStartAt: launchStart });
  session.chat_uuid = chatUuid;
  if (chatUuid) session.evidence.push('evidence/chat/' + chatUuid + '.jsonl');

  // 2) 人工介入：只从 run 窗口内的 rdd.jsonl 取
  const rddText = readIfExists(ev('rdd.jsonl'));
  sources.rdd = rddText != null;
  const rddRows = rddText != null ? parseJsonl(rddText).rows : [];
  const interventions = collectInterventions(rddRows, { eventsAvailable: sources.rdd });
  // 事件本身不带 runId；这些行来自**本轮窗口切片**（evidence/rdd.jsonl 只装了本 run 的增量），
  // 所以按 run 补 runId 是事实，不是猜。补不上的（没有 envelope）保持 null。
  const envEarlyText = readIfExists(path.join(runDir, 'envelope.json'));
  const envEarly = envEarlyText ? JSON.parse(envEarlyText) : null;
  if (envEarly && envEarly.runId) {
    for (const e2 of interventions.entries) if (!e2.runId) e2.runId = envEarly.runId;
  }

  // 3) 投送：context.jsonl（recalled/budget）+ expmem.jsonl（rendered/delivered）
  const expmemText = readIfExists(ev('expmem.jsonl'));
  sources.expmem = expmemText != null;
  const contextRows = ctxText != null ? parseJsonl(ctxText).rows : null;
  const expmemRows = expmemText != null ? parseJsonl(expmemText).rows : null;
  const delivery = collectDelivery({ contextRows, expmemRows });

  // 4) 世界视图字段（envelope.world 已有；没用 world-view 文件也不猜）
  const envText = readIfExists(path.join(runDir, 'envelope.json'));
  const env = envText ? JSON.parse(envText) : {};
  const worldViews = worldViewsFromEnvelope(env, (rel) => {
    const t = readIfExists(path.join(runDir, rel));
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  });

  return { session, interventions, delivery, worldViews, sources: Object.assign(sources, { collected_at: nowIso }) };
}

// --------------------------------------------------------- selftest ----

function assert(cond, msg, fails) {
  if (!cond) fails.push(msg);
}

function selftest() {
  const fails = [];
  const iso = (ms) => new Date(ms).toISOString();
  const T0 = Date.parse('2026-10-29T05:00:00Z');
  const ev = (o) => Object.assign({ schema_version: 1, timestamp: iso(T0), source: 'numen', category: 'rdd', type: 'x', data: {} }, o);

  // ① 旧 envelope 字段兼容
  {
    const old = { runId: 'r1', label: 'x', contract: { sha256: 'a' }, phase: 'done', timings: { stimulusSentAt: iso(T0) }, world: { before: { complete: true } } };
    const merged = applyToEnvelope(old, {});
    assert(merged.runId === 'r1' && merged.contract.sha256 === 'a' && merged.phase === 'done', '① 旧字段被改动/丢失', fails);
    assert(merged.world.before.complete === true, '① world 子结构被改动', fails);
    assert(merged.session.status === 'UNKNOWN', '① 缺省 session 必须 UNKNOWN，不能 CLEAN', fails);
    assert(JSON.parse(JSON.stringify(merged)).a0.version === A0_VERSION, '① 三态不可序列化', fails);
  }

  // ② 介入缺字段拒收 + 通用命令归 OTHER（不丢事件）
  {
    const noTs = ev({ event_id: 'e1', type: 'admin_command_used', timestamp: undefined, data: { mode: 'direct-give' } });
    const noId = ev({ event_id: undefined, type: 'admin_command_used', data: { mode: 'direct-give' } });
    const ok = ev({ event_id: 'e2', type: 'admin_command_used', data: { mode: 'direct-teleport' } });
    const other = ev({ event_id: 'e3', type: 'admin_command_used', data: { command: 'setblock 1 2 3 minecraft:stone' } });
    const r = collectInterventions([noTs, noId, ok, other]);
    assert(r.count === 2, '② 应有 2 条合法介入（1 映射 + 1 OTHER），实得 ' + r.count, fails);
    assert(r.rejected.length === 2, '② 缺字段必须被拒收并留痕，rejected=' + r.rejected.length, fails);
    assert(r.entries[0].kind === 'TP', '② mode→kind 映射错', fails);
    assert(r.byKind.OTHER === 1, '② 通用命令（setblock）必须记成 OTHER 而不是被丢掉，实得 ' + JSON.stringify(r.byKind), fails);
    assert(r.entries[0].actor === 'UNKNOWN' && r.entries[0].actor_evidence === 'not-recorded', '② 无 actor 字段时不得猜成 HUMAN', fails);
    assert(r.entries[0].autonomous_attributable === false, '② 介入不得标为可自主归因', fails);
  }

  // ③ 重复 eventId 不重复计数
  {
    const e1 = ev({ event_id: 'dup', type: 'admin_command_used', data: { mode: 'direct-give' } });
    const e1b = ev({ event_id: 'dup', type: 'admin_command_used', data: { mode: 'direct-give' } });
    const r = collectInterventions([e1, e1b]);
    assert(r.count === 1 && r.duplicatesDropped === 1, '③ 重复 eventId 被重复计数', fails);
  }

  // ④ 会话三态
  {
    const firstReq = { at: iso(T0 + 5000), messageCount: 2, eventId: 'c1' };
    const cleanFresh = classifySession({
      chatRows: [{ role: 'user', ts: T0 + 1000 }, { role: 'assistant', ts: T0 + 2000 }],
      firstRequest: firstReq, runStartAt: iso(T0),
    });
    assert(cleanFresh.status === 'CLEAN', '④ 新进程应判 CLEAN，实得 ' + cleanFresh.status, fails);

    const dirty = classifySession({
      chatRows: [{ role: 'user', ts: T0 - 60000 }, { role: 'assistant', ts: T0 + 2000 }],
      firstRequest: { at: iso(T0 + 5000), messageCount: 7, eventId: 'c2' }, runStartAt: iso(T0),
    });
    assert(dirty.status === 'DIRTY', '④ 带历史应判 DIRTY，实得 ' + dirty.status, fails);
    assert(dirty.legacy_messages_present === true, '④ legacy_messages_present 应为 true', fails);

    const unknown = classifySession({ chatRows: [], firstRequest: null, runStartAt: iso(T0) });
    assert(unknown.status === 'UNKNOWN', '④ 无证据必须 UNKNOWN，实得 ' + unknown.status, fails);

    const noClear = classifySession({
      chatRows: [{ role: 'user', ts: T0 - 60000 }, { role: 'assistant', ts: T0 + 2000 }],
      firstRequest: { at: iso(T0 + 5000), messageCount: 2, eventId: 'c3' }, runStartAt: iso(T0),
    });
    assert(noClear.status === 'UNKNOWN', '④ 无 clear 且无法确认时必须 UNKNOWN，实得 ' + noClear.status, fails);
  }

  // ⑤ rendered / kept / delivered 不混淆 + 截断不算送达 + delivered 可多于 rendered（直接注入）
  {
    const ctxRows = [
      ev({ type: 'retrieval_snapshot', data: { entries: 5, truncationReasons: ['budget'] } }),
    ];
    const memRows = [
      ev({ type: 'expanded', data: { ref: 'exp:a', version: 'v1', truncated: false } }),
      ev({ type: 'expanded', data: { ref: 'exp:b', version: 'v1', truncated: true } }),
      ev({ type: 'request_delivered', data: { count: 2, refs: ['exp:a', 'exp:c'] } }),
    ];
    const d = collectDelivery({ contextRows: ctxRows, expmemRows: memRows });
    assert(d.rendered.refs.length === 2, '⑤ rendered 应 2 条，实得 ' + d.rendered.refs.length, fails);
    assert(d.delivered.refs.length === 2 && d.delivered.refs[0] === 'exp:a', '⑤ delivered 应 exp:a + exp:c', fails);
    assert(d.dropped.refs.length === 1 && d.dropped.refs[0] === 'exp:b', '⑤ 被裁条目必须进 dropped，实得 ' + JSON.stringify(d.dropped.refs), fails);
    assert(d.deliveredWithoutRender.count === 1 && d.deliveredWithoutRender.refs[0] === 'exp:c',
      '⑤ 直接注入的 ref 要单列成 deliveredWithoutRender（不是矛盾）', fails);
    assert(d.truncated.refs.length === 1, '⑤ 截断必须单独记账', fails);
    assert(d.recalled.refs === null && d.recalled.refs_status === 'AGGREGATE_ONLY', '⑤ recalled 无 per-ref 时必须如实标聚合口径', fails);
    assert(d.truncatedCountedAsDelivered === false, '⑤ 本例截断条目未送达，不应报错', fails);
  }

  // ⑥ runtime_state 里有 ref 不等于 delivered
  {
    const ctxRows = [ev({ type: 'runtime_state', data: { context: '<retrieved_knowledge ref="exp:z"/>' } })];
    const d = collectDelivery({ contextRows: ctxRows, expmemRows: [] });
    assert(d.delivered.refs.length === 0, '⑥ runtime_state 里的 ref 被当成 delivered', fails);
    assert(d.status === 'NONE', '⑥ 无投送事件时 status 应为 NONE，实得 ' + d.status, fails);
  }

  // ⑦ timeline 缺流不伪造
  {
    const empty = timelineEntries({});
    assert(empty.length === 0, '⑦ 空 envelope 不应产生 timeline 行，实得 ' + empty.length, fails);
    const withUnknown = timelineEntries(applyToEnvelope({ timings: { stimulusSentAt: iso(T0) } }, {}));
    assert(withUnknown.length === 1 && withUnknown[0].text.indexOf('UNKNOWN') >= 0, '⑦ UNKNOWN 会话要显式出现在 timeline', fails);
    const noDelivery = withUnknown.filter((x) => x.tag === 'deliv');
    assert(noDelivery.length === 0, '⑦ 没有投送证据时不得造 deliv 行', fails);
  }

  // ⑧ 结论闸门：DIRTY/UNKNOWN/介入 一律不能 PASS
  {
    const base = applyToEnvelope({}, { session: { status: 'CLEAN' }, interventions: { count: 0, status: 'NONE', entries: [] }, delivery: { status: 'NONE' } });
    assert(gateVerdict('PASS', base).overall === 'PASS', '⑧ 全干净时应允许 PASS', fails);
    const withIv = applyToEnvelope({}, { session: { status: 'CLEAN' }, interventions: { count: 2, status: 'PRESENT', entries: [] }, delivery: { status: 'NONE' } });
    assert(gateVerdict('PASS', withIv).overall === 'INCONCLUSIVE', '⑧ 有人工介入时不得 PASS', fails);
    const dirty = applyToEnvelope({}, { session: { status: 'DIRTY' }, interventions: { count: 0, status: 'NONE', entries: [] }, delivery: { status: 'NONE' } });
    assert(gateVerdict('PASS', dirty).overall === 'INCONCLUSIVE', '⑧ 上下文脏时不得 PASS', fails);
    assert(gateVerdict('FAIL', dirty).overall === 'FAIL', '⑧ 闸门不得把 FAIL 改成别的', fails);
  }

  // ⑨ 世界视图关联（不新建采集，只读 envelope）
  {
    const wv = worldViewsFromEnvelope({ world: { before: { view_id: 'v1', control_key: 'k', captured_at: iso(T0), coverage: 'COMPLETE' }, drift: false } });
    assert(wv.before && wv.before.view_id === 'v1' && wv.before.coverage === 'COMPLETE', '⑨ world-view 关联丢字段', fails);
    assert(wv.after === null, '⑨ 缺失相位不得补默认值', fails);
    assert(wv.drift === false, '⑨ drift 透传错', fails);
  }

  const lines = [];
  lines.push('A0 selftest · 9 组判据');
  lines.push(fails.length ? ('FAIL ' + fails.length + ' 项:') : 'PASS 全过');
  for (const f of fails) lines.push('  ✗ ' + f);
  console.log(lines.join('\n'));
  return fails.length ? 1 : 0;
}

// ------------------------------------------------------------ CLI ----

function cmdBackfill(runDir) {
  const rd = path.resolve(runDir);
  const envP = path.join(rd, 'envelope.json');
  if (!fs.existsSync(envP)) { console.error('no envelope.json: ' + rd); return 2; }
  const env = JSON.parse(fs.readFileSync(envP, 'utf8'));
  if (env.a0) { console.log('已有 A0 块，不覆盖: ' + env.a0.version); return 0; }
  // 老 run 的 chat 已被 restore 冲掉；不猜路径，默认不读。
  // 要强行用当前实例的 companions 目录，显式给 RDD_NUMEN_DIR（并自己确认归属）。
  const numenDir = process.env.RDD_NUMEN_DIR || null;
  const p = collect({
    runDir: rd,
    monitorDir: null,
    companionsDir: numenDir ? path.join(numenDir, 'companions') : null,
    launchStart: (env.timings && env.timings.launchStart) || env.createdAt,
  });
  const merged = applyToEnvelope(env, p);
  merged.a0.backfilled = true;
  merged.a0.sources = p.sources;
  fs.writeFileSync(envP, JSON.stringify(merged, null, 2));
  console.log('backfill ok: session=' + merged.session.status + ' interventions=' + merged.interventions.status
    + '(' + merged.interventions.count + ') delivery=' + merged.context_delivery.status);
  return 0;
}

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'selftest') process.exit(selftest());
  if (cmd === 'backfill' && arg) process.exit(cmdBackfill(arg));
  console.error('usage: a0-evidence.js selftest | backfill <runDir>');
  process.exit(2);
}

module.exports = {
  A0_VERSION, KINDS, ACTORS, SOURCES,
  parseJsonl, classifySession, normalizeIntervention, collectInterventions,
  collectDelivery, worldViewsFromEnvelope, applyToEnvelope, gateVerdict, timelineEntries,
  firstLlmRequestFromJsonl, collect, selftest,
};
