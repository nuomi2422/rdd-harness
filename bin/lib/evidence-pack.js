'use strict';
// 044 A1: reconstructable, read-only projection over monitor-reader/action-ledger.
// No production identity resolver is installed: raw claims never prove attribution.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AL = require('./action-ledger');
const { createPull, boundedWindowStream } = require('./monitor-reader');
const FILES = ['tools.jsonl', 'events.jsonl', 'context.jsonl', 'rdd.jsonl'];
// Keep the required/default four-stream contract; learner is explicitly selectable.
const SUPPORTED = [...FILES, 'learner.jsonl'];
// MonitoringJournal rotates to <stream>-<epoch millis>.jsonl in the same directory.
const physicalStream = (file, sourceLayout) => {
  if (sourceLayout === 'bounded-window') return boundedWindowStream(file);
  const m = /^(tools|events|context|rdd|learner)(?:-[1-9]\d{12})?\.jsonl$/.exec(file);
  return m ? m[1] + '.jsonl' : null;
};
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const str = v => typeof v === 'string' && v.trim() === v && v.length ? v : null;
const time = v => typeof v === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : NaN;
const data = e => e && e.data && typeof e.data === 'object' ? e.data : {};
function claims(e, file, sourceLayout) {
  const d = data(e);
  // Learner lifecycle's companion is a raw claim, not a new identity adapter.
  const review = physicalStream(file, sourceLayout) === 'learner.jsonl' && e.category === 'learner' &&
    ['review_started', 'reviewed', 'review_interrupted', 'review_failed'].includes(e.type);
  const companions = review ? [d.companion_id, e.companion_id, d.companionId, d.companion].map(str).filter(Boolean) : [];
  const companionConflict = new Set(companions).size > 1;
  return { worldId: str(d.world_id || e.world_id), serverSession: str(d.server_session || e.server_session || d.session_id),
    companion: companionConflict ? null : str(d.companion_id || e.companion_id || d.companionId || (review && d.companion)),
    ...(companionConflict ? { companionConflict: true } : {}), run: str(e.session),
    requestId: str(d.request_id || d.requestId || e.request_id),
    chainId: str(d.chain_id || d.chainId), generation: d.chain_epoch ?? d.chainEpoch ?? d.rationaleGeneration ?? null };
}
const scopeKey = c => c.worldId && c.serverSession && c.companion && c.run
  ? JSON.stringify([c.worldId, c.serverSession, c.companion, c.run, c.chainId, c.generation]) : null;
function identity(row, resolveIdentity) {
  if (typeof resolveIdentity !== 'function') return null;
  let c;
  try { c = resolveIdentity(row.event, row.file.replace('.jsonl', '')); } catch { return null; }
  if (!c || !str(c.worldId) || !str(c.serverSession) || !str(c.companion) || !str(c.evidence)) return null;
  const raw = row.claimed;
  if (!raw.run || raw.companionConflict || data(row.event).stamp_conflict === true) return null;
  for (const k of ['worldId', 'serverSession', 'companion']) if (raw[k] && raw[k] !== c[k]) return null;
  // Reuse ledger's explicit-field checks for tools and terminals as well.
  return { ...raw, worldId: c.worldId, serverSession: c.serverSession, companion: c.companion };
}
function redact(v) {
  // Content is opt-in; redact credentials both as keys and embedded in text.
  if (typeof v === 'string') return v
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) =>
    [k, /^(?:api[_-]?key|access[_-]?token|password|secret|authorization|cookie)$/i.test(k) ? '[REDACTED]' : redact(x)]));
  return v;
}
function publicRow(r, content) {
  const d = data(r.event);
  const out = { ref: r.ref, sourceFile: r.sourceFile, line: r.line, byteOffset: r.byteOffset,
    sha256: r.sha256, eventId: r.eventId, sourceSequence: r.sourceSequence, occurredAt: r.event.timestamp || r.event.at || null,
    ingestedAt: r.event.ingestedAt || r.event.ingested_at || null, type: r.event.type || null,
    claimedIdentity: r.claimed, identityStatus: r.scope ? 'VERIFIED_BY_ADAPTER' : 'UNKNOWN',
    requestId: r.claimed.requestId, callId: d.tool_call_id || null, taskId: d.task_id || d.id || null,
    // 2026-11-13 A1：源里 tool_transport_binding 带 model_call_id，context 的 llm_response 也带同一个 id；
    // 只做投影，不做认证（identityStatus 仍是 UNKNOWN）。
    modelCallId: str(d.model_call_id),
    tool: d.tool || d.task || null, intervention: r.event.intervention ?? d.intervention ?? 'UNKNOWN',
    payload: { status: content ? 'INCLUDED_REDACTED' : 'NOT_EXPANDED', ref: r.ref },
  };
  if (content) out.payload.value = redact(d);
  return out;
}
function project(linesByFile, opts = {}) {
  const rows = [], gaps = [...(opts.gaps || [])], sources = { ...(opts.sourceMetadata || {}) };
  const cutoff = opts.asOf ? time(opts.asOf) : Infinity, since = opts.since ? time(opts.since) : -Infinity;
  if ((opts.view === 'decision' && !opts.asOf) || (opts.asOf && !Number.isFinite(cutoff)) ||
      (opts.since && !Number.isFinite(since)) || since > cutoff)
    return { error: 'invalid-or-missing-cutoff', rows: [], gaps, sources };
  for (const file of opts.sourceFiles || FILES) {
    if (opts.sourceMetadata && linesByFile[file] === undefined) continue;
    if (linesByFile[file] === undefined || linesByFile[file] === null) {
      gaps.push({ file, reason: 'missing-stream' }); continue;
    }
    const text = String(linesByFile[file]), lines = text.split('\n');
    sources[file] = { ...sources[file], file: opts.dir ? path.resolve(opts.dir, file) : file, sha256: hash(text), bytes: Buffer.byteLength(text) };
    const start = opts.sourceMetadata?.[file]?.observedFrom || 0;
    let offset = start;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], byteOffset = offset;
      offset += Buffer.byteLength(raw) + (i < lines.length - 1 ? 1 : 0);
      if (!raw.trim()) continue;
      const ref = start ? file + '@' + byteOffset : file + ':' + (i + 1);
      let event;
      try { event = JSON.parse(raw); } catch { gaps.push({ ref, reason: 'malformed-line' }); continue; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { gaps.push({ ref, reason: 'invalid-event' }); continue; }
      const stamps = [event.timestamp, event.at, data(event).timestamp, data(event).at].filter(v => v !== undefined);
      const ts = stamps.map(time);
      const ingestedRaw = event.ingestedAt ?? event.ingested_at;
      const ingested = ingestedRaw === undefined ? null : time(ingestedRaw);
      // Exclude ambiguous times from bounded views; never retain them "for completeness".
      if ((opts.asOf || opts.since) && (!ts.length || ts.some(t => !Number.isFinite(t)) || new Set(ts).size > 1 ||
          (ingestedRaw !== undefined && !Number.isFinite(ingested)))) {
        gaps.push({ ref, reason: 'cutoff-time-unknown' }); continue;
      }
      if ((opts.asOf || opts.since) && (ts[0] < since || ts[0] > cutoff || (ingested !== null && ingested > cutoff))) continue;
      const row = { event, file: physicalStream(file, opts.sourceLayout) || file, physicalFile: file, ref, line: start ? null : i + 1, windowLine: i + 1, byteOffset, sha256: hash(raw),
        sourceFile: sources[file].file, claimed: claims(event, file, opts.sourceLayout),
        eventId: str(event.event_id), sourceSequence: Number.isSafeInteger(event.event_seq) ? event.event_seq : null };
      row.scope = identity(row, opts.resolveIdentity);
      rows.push(row);
    }
  }
  return { rows, gaps, sources };
}
function matches(row, opts) {
  for (const [option, key] of [['companion','companion'],['run','run'],['worldId','worldId'],['serverSession','serverSession']])
    if (opts[option] && row.claimed[key] !== opts[option]) return false;
  if (opts.callId && data(row.event).tool_call_id !== opts.callId) return false;
  return !opts.types || opts.types.includes(row.event.type);
}
function page(rows, queryKey, opts) {
  const limit = Number.isSafeInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 200) : 40;
  const maxBytes = Number.isSafeInteger(opts.maxBytes) && opts.maxBytes >= 1024 ? Math.min(opts.maxBytes, 1048576) : 65536;
  let offset = 0;
  if (opts.cursor) {
    try {
      const c = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString());
      if (c.query !== queryKey || !Number.isSafeInteger(c.offset) || c.offset < 0 || c.offset > rows.length) throw Error();
      offset = c.offset;
    } catch { return { status: 'RESET', reason: 'cursor-query-or-source-changed', rows: [] }; }
  }
  const result = [];
  let bytes = 2, i = offset;
  for (; i < rows.length && result.length < limit; i++) {
    const row = publicRow(rows[i], opts.content);
    let n = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (n + bytes > maxBytes && result.length) break;
    if (n + bytes > maxBytes) {
      // Keep source references, never silently clip JSON or consume an unreturned record.
      row.payload = { status: 'TRUNCATED', reason: 'max-bytes', ref: row.ref };
      n = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (n + bytes > maxBytes) return { status: 'UNKNOWN', reason: 'max-bytes-too-small', rows: [] };
    }
    result.push(row); bytes += n;
  }
  return { status: 'PRESENT', rows: result, total: rows.length, offset, returned: result.length,
    byteBudgetScope: 'rows-only', nextCursor: i < rows.length ? Buffer.from(JSON.stringify({ query: queryKey, offset: i })).toString('base64url') : null };
}
function build(linesByFile, opts = {}) {
  if (opts.sourceLayout !== undefined && opts.sourceLayout !== 'bounded-window') return { schemaVersion: 1, status: 'UNKNOWN', reason: 'invalid-source-layout', rows: [], sources: {}, gaps: [{ reason: 'invalid-source-layout' }] };
  const p = project(linesByFile, opts);
  const base = { schemaVersion: 1, ...(opts.sourceLayout ? { sourceLayout: opts.sourceLayout } : {}), view: opts.view || 'retrospective', asOf: opts.asOf || null,
    since: opts.since || null, visibility: 'journal-time-only; not proof of model-visible delivery', sources: p.sources, gaps: p.gaps,
    ...(opts.sourceCoverage ? { sourceCoverage: { ...opts.sourceCoverage,
      status: p.gaps.length ? 'PARTIAL' : 'OBSERVED_FILES_ONLY',
      scope: 'named physical files and observed byte ranges only; not session completeness or verified identity' } } : {}) };
  if (p.error) return { ...base, status: 'UNKNOWN', reason: p.error, rows: [] };
  let selected = p.rows.filter(r => matches(r, opts));
  // --model-call：必须按 [scopeKey, wire_call_id] **成对**匹配。旧实现用一个 wires Set 加一个 scopes Set，
  // 会笛卡尔误配：同一 modelId 在 scopeA→wireA、scopeB→wireB 时，scopeA 的 wireB 行也会被拉进来。
  // 绑定只从「当前 filters/as-of 候选」里取；同 id 跨 scope 视为冲突 → UNKNOWN，不强行认成同一调用。
  let modelCallConflict = false;
  if (opts.modelCallId) {
    const hit = r => str(data(r.event).model_call_id) === opts.modelCallId;
    const srcs = selected.filter(hit);
    const scopeSet = new Set(srcs.map(r => scopeKey(r.claimed)).filter(Boolean));
    modelCallConflict = scopeSet.size > 1;
    const pairs = new Set(srcs.map(b => {
      const k = scopeKey(b.claimed), w = str(data(b.event).wire_call_id);
      return k && w ? k + '|' + w : null;
    }).filter(Boolean));
    selected = modelCallConflict ? [] : selected.filter(r => {
      if (hit(r)) return true;
      const k = scopeKey(r.claimed), w = str(data(r.event).tool_call_id);
      return !!k && !!w && pairs.has(k + '|' + w);
    });
  }
  const mode = opts.mode || 'episode';
  const anchor = opts.eventRef ? selected.find(r => r.ref === opts.eventRef &&
    (!opts.eventHash || r.sha256 === opts.eventHash)) : null;
  let stages, action, unknowns = [];
  if (mode !== 'list') {
    if (!anchor) return { ...base, status: 'UNKNOWN', reason: 'event-not-visible-or-source-changed', rows: [] };
    if (mode === 'expand') {
      const before = Number.isSafeInteger(opts.before) ? Math.max(0, Math.min(opts.before, 100)) : 3;
      const after = Number.isSafeInteger(opts.after) ? Math.max(0, Math.min(opts.after, 100)) : 3;
      selected = selected.filter(r => r.physicalFile === anchor.physicalFile && r.windowLine >= anchor.windowLine - before && r.windowLine <= anchor.windowLine + after);
      base.relation = 'source-neighbours-only; no causal association';
    } else {
      const key = anchor.scope && scopeKey(anchor.scope);
      const scoped = key ? p.rows.filter(r => r.scope && scopeKey(r.scope) === key) : [];
      const callId = data(anchor.event).tool_call_id;
      const toolRows = scoped.filter(r => r.file === 'tools.jsonl' && data(r.event).tool_call_id === callId);
      const terminalRows = scoped.filter(r => r.file === 'events.jsonl');
      const ledger = AL.build(scoped.filter(r => r.file === 'tools.jsonl').map(r => JSON.stringify(r.event)).join('\n'),
        terminalRows.map(r => JSON.stringify(r.event)).join('\n'), { resolveIdentity: opts.resolveIdentity });
      action = ledger.calls.find(c => c.callId === callId) || { state: 'identity-unknown', identityStatus: 'UNKNOWN' };
      if (action.identityStatus !== 'KNOWN') {
        selected = [anchor];
        unknowns.push('identity-unverified; no records joined');
      } else {
        const uniqueTask = action.taskId && ledger.calls.filter(c => c.taskId === action.taskId).length === 1;
        selected = toolRows.concat(terminalRows.filter(r => uniqueTask && data(r.event).id === action.taskId));
        const reqIds = [...new Set(toolRows.map(r => r.claimed.requestId).filter(Boolean))];
        if (reqIds.length === 1) {
          const requestRows = scoped.filter(r => r.claimed.requestId === reqIds[0] && !['tools.jsonl','events.jsonl'].includes(r.file));
          selected.push(...requestRows);
        } else unknowns.push('request-id-missing-or-ambiguous');
      }
      // Stage membership requires an explicit edge, not timestamp proximity.
      const refs = test => selected.filter(test).map(r => r.ref);
      stages = {
        goal: refs(r => ['taskchain_snapshot','goal_snapshot'].includes(r.event.type)),
        pre: refs(r => r.event.type === 'observation' && data(r.event).phase === 'pre'),
        finalRequest: refs(r => r.event.type === 'final_request' || r.event.type === 'llm_request'),
        call: refs(r => r.event.type === 'tool_call'),
        receipt: refs(r => r.event.type === 'tool_result'),
        terminal: action.identityStatus === 'KNOWN' ? refs(r => r.event.type === 'task_finished') : [],
        post: refs(r => r.event.type === 'observation' && data(r.event).phase === 'post'),
        media: [],
      };
      for (const [stage, refs2] of Object.entries(stages)) if (!refs2.length) unknowns.push(stage + ':NOT_COLLECTED_OR_UNASSOCIATED');
      if (action.state === 'accepted-no-terminal') unknowns.push('terminal:UNKNOWN');
      if (!anchor.claimed.chainId || anchor.claimed.generation === null) unknowns.push('chain-identity:UNKNOWN');
      if (!selected.some(r => r.event.type === 'tool_call' && (data(r.event).args || data(r.event).arguments)))
        unknowns.push('call-arguments:NOT_COLLECTED_OR_UNASSOCIATED');
      if (selected.some(r => r.event.type === 'final_request' && !data(r.event).request && !data(r.event).messages && !data(r.event).body))
        unknowns.push('final-request-body:NOT_COLLECTED; metadata-only');
      base.anchor = publicRow(anchor, false);
      base.action = { state: action.state, identityStatus: action.identityStatus, taskId: action.taskId || null,
        duplicates: action.duplicates || 0, terminal: action.terminal || null };
    }
  }
  const queryKey = hash(JSON.stringify({ sources: p.sources, ...(opts.sourceLayout ? { sourceLayout: opts.sourceLayout } : {}), mode, eventRef: opts.eventRef, eventHash: opts.eventHash,
    asOf: opts.asOf, since: opts.since, order: opts.order, view: base.view, filters: [opts.companion,opts.run,opts.worldId,opts.serverSession,opts.callId,opts.types],
    modelCallId: opts.modelCallId, before: opts.before, after: opts.after, content: !!opts.content,
    // Bind adapter result too: a cursor cannot switch identity/authorization adapters.
    records: selected.map(r => [r.ref, r.sha256, r.scope]) }));
  if (opts.order === 'latest-per-stream' && mode === 'list') {
    const groups = SUPPORTED.map(file => selected.filter(r => r.file === file)
      .sort((a,b) => time(b.event.timestamp || b.event.at) - time(a.event.timestamp || a.event.at) || b.byteOffset-a.byteOffset));
    selected = [];
    for (let i=0; groups.some(g => i<g.length); i++) for (const g of groups) if (g[i]) selected.push(g[i]);
  }
  const result = page(selected, queryKey, opts);
  // 2026-11-13 A1：筛选后 0 行不是「有证据」。原来一律返回 PRESENT，读的人会把
  // 「这个 world/companion/session 没命中」当成证据存在。空集显式 EMPTY + reason，不当 PASS。
  const anyFilter = !!(opts.companion || opts.run || opts.worldId || opts.serverSession || opts.callId || opts.modelCallId || opts.since || opts.asOf || (opts.types && opts.types.length));
  let status = result.status;
  let reason = result.reason;
  if (status === 'PRESENT' && result.total === 0) {
    status = 'EMPTY';
    reason = anyFilter ? 'filter-matches-no-rows' : 'no-rows-in-named-sources';
  } else if (status === 'PRESENT' && (mode === 'episode' || (opts.sourceCoverage && p.gaps.length))) {
    status = 'PARTIAL';
  }
  if (modelCallConflict) { status = 'UNKNOWN'; reason = 'model-call-scope-conflict'; }
  return { ...base, ...result, status, ...(reason ? { reason } : {}),
    ...(stages ? { stages, unknowns, completeness: 'PARTIAL; tool completion is not world-effect proof' } : {}) };
}
/**
 * Discover only explicit production stream names in one directory; every file is
 * consumed and reverified by monitor-reader. No concatenated archive line numbers,
 * recursive history walk, or identity binding is introduced here.
 */
function fromDir(dir, opts = {}) {
  const unknown = reason => ({ schemaVersion: 1, status: 'UNKNOWN', reason, rows: [], sources: {},
    gaps: [{ reason }], sourceCoverage: { status: 'PARTIAL', scope: 'named physical files only; not session completeness' } });
  if (opts.sourceLayout !== undefined && opts.sourceLayout !== 'bounded-window') return unknown('invalid-source-layout');
  const bounded = opts.sourceLayout === 'bounded-window';
  const logicalStream = file => physicalStream(file, opts.sourceLayout);
  const required = stream => bounded ? 'new-' + stream : stream;
  if (bounded) {
    try {
      for (let p = path.resolve(dir);; p = path.dirname(p)) {
        const st = fs.lstatSync(p);
        if (!st.isDirectory() || st.isSymbolicLink()) return unknown('source-directory-unreadable');
        if (path.dirname(p) === p) break;
      }
    } catch { return unknown('source-directory-unreadable'); }
  }
  const streams = opts.streams === undefined ? FILES : Array.isArray(opts.streams)
    ? [...new Set(opts.streams.map(x => typeof x === 'string' && !x.endsWith('.jsonl') ? x + '.jsonl' : x))] : [];
  if (!streams.length || streams.some(x => !SUPPORTED.includes(x))) return unknown('invalid-stream-selection');
  const explicit = opts.sources;
  if (explicit !== undefined && (!Array.isArray(explicit) || !explicit.length ||
      explicit.some(f => typeof f !== 'string' || !logicalStream(f) || !streams.includes(logicalStream(f)))))
    return unknown('invalid-source-selection');
  const maxFiles = opts.maxSourceFiles === undefined ? 12 : Number(opts.maxSourceFiles);
  const maxBytes = opts.maxSourceBytes === undefined ? 64 * 1024 * 1024 : Number(opts.maxSourceBytes);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 64 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024)
    return unknown('invalid-source-budget');
  const snapshot = () => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const names = explicit ? [...new Set(explicit)] : [...new Set(streams.map(required).concat(entries
      .filter(e => e.isFile() && logicalStream(e.name) && streams.includes(logicalStream(e.name))).map(e => e.name)))];
    return Object.fromEntries(names.sort().map(file => {
      let meta;
      try {
        const st = fs.lstatSync(path.join(dir, file), { bigint: true });
        meta = { size: Number(st.size), ino: String(st.ino), dev: String(st.dev),
          mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs), regular: st.isFile() };
      } catch (e) { meta = { error: e.code || 'stat-failed' }; }
      return [file, meta];
    }));
  };
  let manifest;
  try { manifest = snapshot(); } catch { return unknown('source-directory-unreadable'); }
  const offsets = {}, discardHead = [], texts = {}, gaps = [], metadata = {};
  const files = Object.keys(manifest).sort((a, b) => {
    const liveA = bounded || SUPPORTED.includes(a), liveB = bounded || SUPPORTED.includes(b);
    if (liveA !== liveB) return liveA ? -1 : 1;
    return liveA ? SUPPORTED.indexOf(logicalStream(a)) - SUPPORTED.indexOf(logicalStream(b))
      : Number(b.slice(b.lastIndexOf('-') + 1, -6)) - Number(a.slice(a.lastIndexOf('-') + 1, -6)) || a.localeCompare(b);
  });
  // Opt-in writer policy: reserve one budget per logical stream, then current half + archives half.
  // Defaults retain historical prefix pagination. Never scan unread prefixes to invent line numbers.
  if (opts.sourceWindow !== undefined && opts.sourceWindow !== 'latest') return unknown('invalid-source-window');
  const latest = opts.sourceWindow === 'latest', allowances = {};
  if (latest) {
    const chosen = files.filter(f => manifest[f].regular).slice(0,maxFiles);
    const groups = streams.map(s => chosen.filter(f => logicalStream(f) === s)).filter(g => g.length);
    const quota = Math.floor(maxBytes / Math.max(1,groups.length));
    for (const group of groups) {
      const current = group.find(f => bounded || SUPPORTED.includes(f)), archives = group.filter(f => f !== current);
      const currentShare = current ? (archives.length ? Math.floor(quota/2) : quota) : 0;
      if (current) allowances[current] = Math.min(manifest[current].size,currentShare);
      const share = Math.floor((quota-currentShare)/Math.max(1,archives.length));
      for (const f of archives) allowances[f] = Math.min(manifest[f].size,share);
    }
    for (const [f,n] of Object.entries(allowances)) {
      offsets[f] = Math.max(0,manifest[f].size-n);
      if (offsets[f]) discardHead.push(f);
    }
  }
  const reader = createPull({ dir, offsets, discardHead, ...(bounded ? { sourceLayout: opts.sourceLayout } : {}) });
  let allocated = 0, attempted = 0;
  for (const file of files) {
    const m = manifest[file];
    const source = metadata[file] = { file: path.resolve(dir, file), stream: logicalStream(file),
      manifest: m, bytes: 0, sha256: null, readStatus: 'NOT_READ', observedFrom: 0, observedTo: 0 };
    if (m.error || !m.regular) {
      gaps.push({ file, reason: m.error === 'ENOENT' ? 'missing-stream' : 'source-unavailable', detail: m.error || 'not-a-file' });
      continue;
    }
    if (attempted >= maxFiles) { gaps.push({ file, reason: 'source-file-budget', unreadBytes: m.size }); continue; }
    if (allocated >= maxBytes && m.size > 0) { gaps.push({ file, reason: 'source-byte-budget', unreadBytes: m.size }); continue; }
    attempted++;
    const allowance = latest ? (allowances[file] || 0) : Math.min(m.size, maxBytes - allocated);
    allocated += allowance;
    texts[file] = reader.pull(file, allowance);
    source.observedFrom = reader.windowStartOffset[file] ?? offsets[file] ?? 0;
    source.observedTo = reader.offsets[file] || 0;
    source.readStatus = !source.observedFrom && source.observedTo === m.size ? (m.size ? 'OBSERVED' : 'EMPTY') : 'PARTIAL';
    if (latest && source.observedFrom) gaps.push({ file, reason: 'source-prefix-excluded', from:0, to:source.observedFrom });
    if (!latest && allowance < m.size) gaps.push({ file, reason: 'source-byte-budget',
      from: source.observedTo, unreadBytes: m.size - source.observedTo });
  }
  for (const [file, g] of Object.entries(reader.gaps)) gaps.push({ file, ...g });
  if (bounded && !reader.replayDomain.complete) gaps.push({ reason: 'source-envelope-domain-incomplete' });
  for (const [file, pending] of Object.entries(reader.pending)) if (pending)
    gaps.push({ file, reason: 'partial-tail-not-consumed', from: reader.offsets[file] || 0 });
  const verification = reader.verifySegments();
  let after;
  try { after = snapshot(); } catch { after = {}; gaps.push({ reason: 'source-directory-unreadable-after-read' }); }
  if (JSON.stringify(manifest) !== JSON.stringify(after)) gaps.push({ reason: 'source-manifest-changed' });
  for (const file of files) {
    const source = metadata[file], verified = verification.files[file];
    source.segmentVerification = verified || null;
    if (JSON.stringify(manifest[file]) !== JSON.stringify(after[file]) || (verified && verified.broken)) {
      gaps.push({ file, reason: 'source-changed-during-read' });
      delete texts[file]; source.readStatus = 'CHANGED';
    }
  }
  return build(texts, { ...opts, dir, gaps, sourceFiles: files, sourceMetadata: metadata,
    sourceCoverage: { streams, namedSources: files.length,
      physicalSources: Object.values(manifest).filter(m => m.regular).length, attemptedSources: attempted,
      sourceWindow: latest ? 'latest' : 'prefix', maxSourceFiles: maxFiles, maxSourceBytes: maxBytes, allocatedReadBytes: allocated,
      byteBudgetScope: 'primary reads; segment verification re-reads consumed bytes, anchors at most 64 bytes/file',
      manifestAfter: after } });
}
function cli(argv) {
  const get = flag => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const many = flag => argv.flatMap((x, i) => x === flag && argv[i + 1] !== undefined ? argv[i + 1].split(',') : []);
  const streams = many('--streams').concat(many('--stream')), sources = many('--source');
  const layoutCount = argv.filter(x => x === '--source-layout').length;
  const sourceLayout = !layoutCount ? undefined : layoutCount === 1 ? (get('--source-layout') || '') : '';
  const dir = get('--dir') || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
  return fromDir(dir, { ...(sourceLayout !== undefined ? { sourceLayout } : {}), mode: argv.includes('--list') ? 'list' : argv.includes('--expand') ? 'expand' : 'episode',
    ...(streams.length ? { streams } : {}), ...(sources.length ? { sources } : {}),
    ...(get('--max-source-files') !== undefined ? { maxSourceFiles: Number(get('--max-source-files')) } : {}),
    ...(get('--max-source-bytes') !== undefined ? { maxSourceBytes: Number(get('--max-source-bytes')) } : {}),
    eventRef: get('--event'), eventHash: get('--event-hash'), asOf: get('--as-of'), since: get('--since'), view: get('--view'),
    sourceWindow: get('--source-window'), order: get('--order'),
    companion: get('--companion'), run: get('--run'), worldId: get('--world'), serverSession: get('--server-session'),
    callId: get('--call'), modelCallId: get('--model-call'), cursor: get('--cursor'), limit: Number(get('--limit')),
    maxBytes: Number(get('--max-bytes')), before: Number(get('--before')), after: Number(get('--after')),
    content: argv.includes('--content') });
}
function render(r) {
  const out = ['[单调用证据包] ' + r.status + (r.reason ? ' ' + r.reason : '')];
  if (r.action) out.push('动作=' + r.action.state + ' 身份=' + r.action.identityStatus);
  if (r.asOf) out.push('截止=' + r.asOf + '（日志时刻，不等于模型已见）');
  for (const row of r.rows || []) out.push(row.ref + ' ' + row.type + ' ' + (row.tool || '') + ' ' + row.identityStatus);
  if (r.unknowns) out.push('缺环节=' + r.unknowns.join(', '));
  if (r.sourceCoverage) out.push('物理源覆盖=' + r.sourceCoverage.status
    + ' sources=' + r.sourceCoverage.physicalSources + ' read=' + r.sourceCoverage.attemptedSources
    + ' — ' + r.sourceCoverage.scope);
  out.push('读取缺口=' + JSON.stringify(r.gaps || []));
  if (r.nextCursor) out.push('下一页 --cursor ' + r.nextCursor);
  if (r.relation) out.push(r.relation);
  return out.join('\n');
}
module.exports = { build, fromDir, cli, render };
