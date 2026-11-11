'use strict';
// 044 A1: reconstructable, read-only projection over monitor-reader/action-ledger.
// No production identity resolver is installed: raw claims never prove attribution.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AL = require('./action-ledger');
const { createPull } = require('./monitor-reader');
const FILES = ['tools.jsonl', 'events.jsonl', 'context.jsonl', 'rdd.jsonl'];
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const str = v => typeof v === 'string' && v.trim() === v && v.length ? v : null;
const time = v => typeof v === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : NaN;
const data = e => e && e.data && typeof e.data === 'object' ? e.data : {};
function claims(e) {
  const d = data(e);
  return { worldId: str(d.world_id || e.world_id), serverSession: str(d.server_session || e.server_session || d.session_id),
    companion: str(d.companion_id || e.companion_id || d.companionId), run: str(e.session),
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
  if (!raw.run || data(row.event).stamp_conflict === true) return null;
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
    tool: d.tool || d.task || null, intervention: r.event.intervention ?? d.intervention ?? 'UNKNOWN',
    payload: { status: content ? 'INCLUDED_REDACTED' : 'NOT_EXPANDED', ref: r.ref },
  };
  if (content) out.payload.value = redact(d);
  return out;
}
function project(linesByFile, opts = {}) {
  const rows = [], gaps = [...(opts.gaps || [])], sources = {};
  const cutoff = opts.asOf ? time(opts.asOf) : Infinity;
  if ((opts.view === 'decision' && !opts.asOf) || (opts.asOf && !Number.isFinite(cutoff)))
    return { error: 'invalid-or-missing-cutoff', rows: [], gaps, sources };
  for (const file of FILES) {
    if (linesByFile[file] === undefined || linesByFile[file] === null) {
      gaps.push({ file, reason: 'missing-stream' }); continue;
    }
    const text = String(linesByFile[file]), lines = text.split('\n');
    sources[file] = { file: opts.dir ? path.resolve(opts.dir, file) : file, sha256: hash(text), bytes: Buffer.byteLength(text) };
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], byteOffset = offset;
      offset += Buffer.byteLength(raw) + (i < lines.length - 1 ? 1 : 0);
      if (!raw.trim()) continue;
      const ref = file + ':' + (i + 1);
      let event;
      try { event = JSON.parse(raw); } catch { gaps.push({ ref, reason: 'malformed-line' }); continue; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { gaps.push({ ref, reason: 'invalid-event' }); continue; }
      const stamps = [event.timestamp, event.at, data(event).timestamp, data(event).at].filter(v => v !== undefined);
      const ts = stamps.map(time);
      const ingestedRaw = event.ingestedAt ?? event.ingested_at;
      const ingested = ingestedRaw === undefined ? null : time(ingestedRaw);
      // Exclude ambiguous times from bounded views; never retain them "for completeness".
      if (opts.asOf && (!ts.length || ts.some(t => !Number.isFinite(t)) || new Set(ts).size > 1 ||
          (ingestedRaw !== undefined && !Number.isFinite(ingested)))) {
        gaps.push({ ref, reason: 'cutoff-time-unknown' }); continue;
      }
      if (opts.asOf && (ts[0] > cutoff || (ingested !== null && ingested > cutoff))) continue;
      const row = { event, file, ref, line: i + 1, byteOffset, sha256: hash(raw),
        sourceFile: sources[file].file, claimed: claims(event),
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
  const p = project(linesByFile, opts);
  const base = { schemaVersion: 1, view: opts.view || 'retrospective', asOf: opts.asOf || null,
    visibility: 'journal-time-only; not proof of model-visible delivery', sources: p.sources, gaps: p.gaps };
  if (p.error) return { ...base, status: 'UNKNOWN', reason: p.error, rows: [] };
  let selected = p.rows.filter(r => matches(r, opts));
  const mode = opts.mode || 'episode';
  const anchor = opts.eventRef ? selected.find(r => r.ref === opts.eventRef &&
    (!opts.eventHash || r.sha256 === opts.eventHash)) : null;
  let stages, action, unknowns = [];
  if (mode !== 'list') {
    if (!anchor) return { ...base, status: 'UNKNOWN', reason: 'event-not-visible-or-source-changed', rows: [] };
    if (mode === 'expand') {
      const before = Number.isSafeInteger(opts.before) ? Math.max(0, Math.min(opts.before, 100)) : 3;
      const after = Number.isSafeInteger(opts.after) ? Math.max(0, Math.min(opts.after, 100)) : 3;
      selected = selected.filter(r => r.file === anchor.file && r.line >= anchor.line - before && r.line <= anchor.line + after);
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
  const queryKey = hash(JSON.stringify({ sources: p.sources, mode, eventRef: opts.eventRef, eventHash: opts.eventHash,
    asOf: opts.asOf, view: base.view, filters: [opts.companion,opts.run,opts.worldId,opts.serverSession,opts.callId,opts.types],
    before: opts.before, after: opts.after, content: !!opts.content,
    // Bind adapter result too: a cursor cannot switch identity/authorization adapters.
    records: selected.map(r => [r.ref, r.sha256, r.scope]) }));
  const result = page(selected, queryKey, opts);
  return { ...base, ...result, status: result.status === 'PRESENT' && mode === 'episode' ? 'PARTIAL' : result.status,
    ...(stages ? { stages, unknowns, completeness: 'PARTIAL; tool completion is not world-effect proof' } : {}) };
}
function fromDir(dir, opts = {}) {
  const reader = createPull({ dir }), texts = {};
  for (const file of FILES) {
    texts[file] = reader.pull(file);
    if (!fs.existsSync(path.join(dir, file))) texts[file] = null;
  }
  const gaps = Object.entries(reader.gaps).map(([file,g]) => ({ file, ...g }));
  for (const [file, pending] of Object.entries(reader.pending)) if (pending)
    gaps.push({ file, reason: 'partial-tail-not-consumed', from: reader.offsets[file] || 0 });
  const verification = reader.verifySegments();
  if (!verification.ok && Object.values(verification.files).some(f => f.broken))
    gaps.push({ reason: 'source-changed-during-read' });
  return build(texts, { ...opts, dir, gaps });
}
function cli(argv) {
  const get = flag => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const dir = get('--dir') || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
  return fromDir(dir, { mode: argv.includes('--list') ? 'list' : argv.includes('--expand') ? 'expand' : 'episode',
    eventRef: get('--event'), eventHash: get('--event-hash'), asOf: get('--as-of'), view: get('--view'),
    companion: get('--companion'), run: get('--run'), worldId: get('--world'), serverSession: get('--server-session'),
    callId: get('--call'), cursor: get('--cursor'), limit: Number(get('--limit')),
    maxBytes: Number(get('--max-bytes')), before: Number(get('--before')), after: Number(get('--after')),
    content: argv.includes('--content') });
}
function render(r) {
  const out = ['[单调用证据包] ' + r.status + (r.reason ? ' ' + r.reason : '')];
  if (r.action) out.push('动作=' + r.action.state + ' 身份=' + r.action.identityStatus);
  if (r.asOf) out.push('截止=' + r.asOf + '（日志时刻，不等于模型已见）');
  for (const row of r.rows || []) out.push(row.ref + ' ' + row.type + ' ' + (row.tool || '') + ' ' + row.identityStatus);
  if (r.unknowns) out.push('缺环节=' + r.unknowns.join(', '));
  out.push('读取缺口=' + JSON.stringify(r.gaps || []));
  if (r.nextCursor) out.push('下一页 --cursor ' + r.nextCursor);
  if (r.relation) out.push(r.relation);
  return out.join('\n');
}
module.exports = { build, fromDir, cli, render };
