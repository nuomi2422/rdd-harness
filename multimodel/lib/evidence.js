'use strict';
/**
 * evidence.js —— 证据信封、哈希、对齐（设计草案 §6.4 / §6.5）
 *
 * 三条不能忘的话：
 *   1. JSONL 是传输/审计格式，不因为格式就天然真实。
 *   2. 哈希证明的是「保存后没被改」，不证明「采集时来源可信」。
 *   3. 时间戳和 tick 是两回事；外部截图拿不到 serverTick 时附 clock mapping，
 *      **不许伪造精确 tick**。
 *
 * 对齐的判据顺序（先身份、后内容）：身份 / worldSession / 维度 / ownerEpoch
 *   → 因果顺序 → 新鲜度。任何一步 fatal，都不该再去看「内容像不像」。
 */

const crypto = require('crypto');

const REQUIRED_FIELDS = [
  'schemaVersion', 'eventId', 'runId', 'attemptId', 'worldSessionId', 'instanceId',
  'worldId', 'dimension', 'ownerEpoch', 'source', 'capturedAt', 'kind',
];
const SOURCES = ['worldstate', 'runtime_events', 'camera', 'build_artifacts', 'mcp_receipts', 'model', 'harness'];
const TICK_SOURCES = new Set(['worldstate', 'camera']);

function sha256(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function makeEnvelope(fields) {
  const env = Object.assign({ schemaVersion: 1 }, fields);
  if (!env.sha256 && env.payloadRef && env.payloadText !== undefined) env.sha256 = sha256(env.payloadText);
  delete env.payloadText;
  return env;
}

function validateEnvelope(env) {
  const errors = [];
  for (const f of REQUIRED_FIELDS) {
    if (env[f] === undefined || env[f] === null || env[f] === '') errors.push(`缺少字段 ${f}`);
  }
  if (env.schemaVersion !== 1) errors.push(`schemaVersion 必须是 1（实际 ${env.schemaVersion}）`);
  if (env.source && !SOURCES.includes(env.source)) errors.push(`未知 source：${env.source}`);
  if (env.ownerEpoch !== undefined && !Number.isInteger(env.ownerEpoch)) errors.push('ownerEpoch 必须是整数');
  if (env.capturedAt && Number.isNaN(Date.parse(env.capturedAt))) errors.push('capturedAt 不是可解析时间');
  if (env.sha256 && !/^[0-9a-f]{64}$/.test(env.sha256)) errors.push('sha256 格式不合法');
  if (env.sha256 === '<actual-content-hash>') errors.push('sha256 还是设计文档里的占位符，不是真实哈希');
  if (TICK_SOURCES.has(env.source) && env.serverTick === undefined) {
    errors.push(`source=${env.source} 必须带 serverTick（拿不到就换 source 并附 clock mapping，不许伪造）`);
  }
  return { ok: errors.length === 0, errors };
}

class EvidenceLog {
  constructor(context) {
    this.context = Object.assign({}, context);
    this.entries = [];
    this.payloads = {};
  }

  /** 只允许 harness/受保护采集器写入；模型侧只能引用 payloadRef */
  add(kind, source, payload, opts) {
    const o = opts || {};
    const seq = this.entries.length + 1;
    const env = makeEnvelope(Object.assign({
      eventId: o.eventId || `ev-${this.context.runId || 'run'}-${String(seq).padStart(4, '0')}`,
      runId: o.runId || this.context.runId,
      attemptId: o.attemptId || this.context.attemptId,
      actionId: o.actionId,
      worldSessionId: o.worldSessionId || this.context.worldSessionId,
      instanceId: o.instanceId || this.context.instanceId,
      worldId: o.worldId || this.context.worldId,
      dimension: o.dimension || this.context.dimension,
      companionId: o.companionId !== undefined ? o.companionId : this.context.companionId,
      ownerEpoch: o.ownerEpoch !== undefined ? o.ownerEpoch : this.context.ownerEpoch,
      source,
      sourceSeq: o.sourceSeq,
      serverTick: o.serverTick,
      capturedAt: o.capturedAt || new Date().toISOString(),
      receivedAt: o.receivedAt || new Date().toISOString(),
      kind,
      payloadRef: o.payloadRef || `evidence/${kind}-${seq}.json`,
      payloadText: typeof payload === 'string' ? payload : JSON.stringify(payload),
      sha256: o.sha256,
    }));
    this.entries.push(env);
    this.payloads[env.eventId] = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return env;
  }

  latest(kind) {
    const hit = this.entries.filter((e) => e.kind === kind);
    return hit.length ? hit[hit.length - 1] : null;
  }

  bySource(source) { return this.entries.filter((e) => e.source === source); }
}

const SEVERITY = { FATAL: 'fatal', BLOCKING: 'blocking', INFO: 'info' };

function alignEvidence(entries, options) {
  const o = options || {};
  const issues = [];
  const now = o.now ? Date.parse(o.now) : Date.now();
  const expected = {
    attemptId: o.attemptId,
    worldSessionId: o.worldSessionId,
    dimension: o.dimension,
    companionId: o.companionId,
    ownerEpoch: o.ownerEpoch,
  };
  const push = (severity, code, detail, entry) => issues.push({ severity, code, detail, eventId: entry && entry.eventId });

  const seen = new Set();
  for (const e of entries) {
    const v = validateEnvelope(e);
    for (const err of v.errors) push(SEVERITY.FATAL, 'ENVELOPE_INVALID', `${e.eventId || '?'}: ${err}`, e);
    if (seen.has(e.eventId)) push(SEVERITY.FATAL, 'DUPLICATE_EVENT', `eventId 重复：${e.eventId}`, e);
    seen.add(e.eventId);

    if (expected.attemptId && e.attemptId !== expected.attemptId) push(SEVERITY.FATAL, 'ATTEMPT_MISMATCH', `证据来自 attempt=${e.attemptId}，本轮是 ${expected.attemptId}`, e);
    if (expected.worldSessionId && e.worldSessionId !== expected.worldSessionId) push(SEVERITY.FATAL, 'SESSION_MISMATCH', `证据来自 worldSession=${e.worldSessionId}（跨进程/重启的旧会话不能复用）`, e);
    if (expected.dimension && e.dimension !== expected.dimension) push(SEVERITY.FATAL, 'DIMENSION_MISMATCH', `证据维度 ${e.dimension} ≠ 目标维度 ${expected.dimension}`, e);
    if (expected.companionId && e.companionId && e.companionId !== expected.companionId) push(SEVERITY.FATAL, 'SUBJECT_MISMATCH', `证据主体 ${e.companionId} ≠ 目标同伴 ${expected.companionId}`, e);
    if (expected.ownerEpoch !== undefined && e.ownerEpoch !== undefined && e.ownerEpoch < expected.ownerEpoch) {
      push(SEVERITY.FATAL, 'EPOCH_STALE', `证据 ownerEpoch=${e.ownerEpoch} < 当前 ${expected.ownerEpoch}（控制权已切换，旧回答不能提交）`, e);
    }
    if (o.maxEvidenceAgeMs !== undefined && e.capturedAt) {
      const age = now - Date.parse(e.capturedAt);
      if (age > o.maxEvidenceAgeMs) push(SEVERITY.BLOCKING, 'EVIDENCE_STALE', `${e.kind} 采集于 ${e.capturedAt}，年龄 ${age}ms > ${o.maxEvidenceAgeMs}ms`, e);
    }
  }

  // 因果顺序：同一个动作的 before/after 不能反序
  if (Array.isArray(o.pairs)) {
    const byId = new Map(entries.map((e) => [e.eventId, e]));
    for (const p of o.pairs) {
      const a = byId.get(p.beforeEventId), b = byId.get(p.afterEventId);
      if (!a || !b) { push(SEVERITY.BLOCKING, 'CAUSAL_PAIR_MISSING', `动作 ${p.actionId || '?'} 的 before/after 有一侧缺失`); continue; }
      if (a.serverTick !== undefined && b.serverTick !== undefined && a.serverTick > b.serverTick) {
        push(SEVERITY.BLOCKING, 'CAUSAL_ORDER', `动作 ${p.actionId || '?'} 的 after(serverTick=${b.serverTick}) 早于 before(${a.serverTick})`, b);
      }
    }
  }

  // tick 偏差：允许 20 tick，但必须按实际采集延迟校准
  if (o.maxAlignmentSkewTicks !== undefined) {
    const ticks = entries.map((e) => e.serverTick).filter((t) => typeof t === 'number');
    if (ticks.length >= 2) {
      const skew = Math.max(...ticks) - Math.min(...ticks);
      if (skew > o.maxAlignmentSkewTicks) {
        push(SEVERITY.BLOCKING, 'SKEW_EXCEEDED', `证据 tick 跨度 ${skew} > 允许 ${o.maxAlignmentSkewTicks}`);
      }
    }
  }

  // 丢失区间必须显式记录，不能补造
  const seqs = entries.map((e) => e.sourceSeq).filter((s) => typeof s === 'number').sort((a, b) => a - b);
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1] + 1) push(SEVERITY.INFO, 'SEQ_GAP', `sourceSeq 在 ${seqs[i - 1]} → ${seqs[i]} 之间有缺口（记录在案，不得补造）`);
  }

  const fatal = issues.filter((i) => i.severity === SEVERITY.FATAL);
  const blocking = issues.filter((i) => i.severity === SEVERITY.BLOCKING);
  return { ok: fatal.length === 0 && blocking.length === 0, issues, fatal, blocking, entries: entries.slice() };
}

module.exports = { EvidenceLog, makeEnvelope, validateEnvelope, alignEvidence, sha256, SOURCES, SEVERITY, REQUIRED_FIELDS };
