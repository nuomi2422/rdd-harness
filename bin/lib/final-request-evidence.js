'use strict';
/**
 * final-request-evidence.js —— 最终请求"是否真的带 why"的读端判据（2026-11-09）
 *
 * 背景：044 §0.7 要求"规划/执行的最终请求实际含 why 与经验来源"。此前监控流里
 * 根本没有最终请求记录，这条只能靠人看。生产侧已在 EntityAgentLoop 发布
 * `context/final_request` 事件（字段见 REQUIRED），本模块据此给机器可判的证据。
 *
 * 口径（不许含糊）：
 *   - **没有任何 final_request 事件 ≠ 没有 why**，而是 UNKNOWN（no-final-request-events）；
 *   - 事件缺字段/类型不对 → 该条 malformed，不许当作"有 why"；
 *   - whyPresent=true 只说明"请求里出现了 why 字段"，**不证明理由质量**（那要靠人/样本）。
 */
const REQUIRED = {
  companion_id: 'string',
  requestKind: 'string',
  turn: 'number',
  rationalePresent: 'boolean',
  whyPresent: 'boolean',
  whyStatus: 'string',
  risksPresent: 'boolean',
  sourcePresent: 'boolean',
  conditionsPresent: 'boolean',
  rationaleSource: 'string',
};

function isType(v, t) {
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === t;
}

function parseLines(text) {
  const out = [];
  let bad = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.type === 'final_request') out.push(o);
    } catch { bad++; }
  }
  return { events: out, bad };
}

function checkEvent(ev) {
  const d = ev && ev.data && typeof ev.data === 'object' ? ev.data : null;
  if (!d) return { ok: false, why: 'missing-data' };
  const missing = [];
  const wrong = [];
  for (const [k, t] of Object.entries(REQUIRED)) {
    if (d[k] === undefined) { missing.push(k); continue; }
    if (!isType(d[k], t)) wrong.push(k + ':' + t);
  }
  // 2026-11-09：信封身份与发布时刻 stamp 冲突的事件，即使字段齐全也不得计入"why 已交付"。
  // （生产侧若采纳该标记，这里是消费端的防线；没有该字段时按 false 处理，向后兼容。）
  if (d.stamp_conflict === true) return { ok: false, why: 'stamp-conflict' };
  if (missing.length) return { ok: false, why: 'missing-fields', missing };
  if (wrong.length) return { ok: false, why: 'wrong-types', wrong };
  return { ok: true };
}

/**
 * @param {string} contextText  context.jsonl 原文
 * @returns {{status:string, reasons:string[], total:number, delivered:string|null, byKind:object, events:object[]}}
 */
function build(contextText) {
  const { events, bad } = parseLines(contextText);
  const reasons = [];
  if (bad > 0) reasons.push('malformed-lines');
  if (!events.length) {
    return { status: 'UNKNOWN', reasons: reasons.concat(['no-final-request-events']), total: 0, delivered: null, byKind: {}, events: [] };
  }
  let delivered = 0;
  const byKind = {};
  const reported = events.map((ev, i) => {
    const chk = checkEvent(ev);
    const d = (ev.data && typeof ev.data === 'object') ? ev.data : {};
    const kind = typeof d.requestKind === 'string' ? d.requestKind : 'unknown';
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (!chk.ok) reasons.push('event#' + i + ':' + chk.why);
    else if (d.whyPresent === true) delivered++;
    return {
      index: i, ok: chk.ok, problem: chk.ok ? null : chk.why,
      companion: d.companion_id ?? null, requestKind: kind, turn: d.turn ?? null,
      whyPresent: d.whyPresent === true, whyStatus: d.whyStatus ?? null,
      rationaleSource: d.rationaleSource ?? null,
      // 2026-11-09：生产侧已加 stamp 冲突标记（9790c7335），这里原样带出便于追溯，
      // 但不因此把该事件算成"身份已证"——冲突一律不进 delivered。
      stampConflict: d.stamp_conflict === true,
      stampWorldId: d.stamp_world_id ?? null,
      stampServerSession: d.stamp_server_session ?? null,
      // 2026-11-09：可选。生产侧若把 rationale 代次带上，读端就能发现
      // "最终请求用的是旧代次理由"（异步回调写晚了）这类错误，而不是只看有没有 why。
      rationaleGeneration: Number.isFinite(d.rationaleGeneration) ? d.rationaleGeneration : null,
    };
  });
  const wellFormed = reported.filter((r) => r.ok).length;
  // 任何一条坏事件都不许把整体判成"已交付"
  const status = wellFormed === events.length ? (delivered === events.length ? 'PRESENT' : 'PARTIAL') : 'UNKNOWN';
  if (status === 'PARTIAL') reasons.push('why-missing-in-some-requests');
  return { status, reasons, total: events.length, delivered: delivered + '/' + events.length, byKind, events: reported };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const ev = (over, drop) => {
    const data = Object.assign({
      companion_id: 'c', requestKind: 'execute', turn: 1, rationalePresent: true, whyPresent: true,
      whyStatus: 'PRESENT', risksPresent: true, sourcePresent: true, conditionsPresent: false,
      rationaleSource: 'planner_tool:rdd_patch:x',
    }, over || {});
    if (drop) delete data[drop];
    return JSON.stringify({ category: 'context', type: 'final_request', data });
  };

  ok(build('').status === 'UNKNOWN', '①空流必须 UNKNOWN');
  ok(build('').reasons.includes('no-final-request-events'), '①要有 no-final-request-events 理由');
  const one = build(ev());
  ok(one.status === 'PRESENT', '②完整一条 + whyPresent → PRESENT');
  ok(one.delivered === '1/1', '②覆盖率 1/1');
  const noWhy = build(ev({ whyPresent: false, whyStatus: 'ABSENT' }));
  ok(noWhy.status === 'PARTIAL', '③whyPresent=false → PARTIAL 而非 PRESENT');
  const missField = build(ev({}, 'rationaleSource'));
  ok(missField.status !== 'PRESENT', '④缺字段不得 PRESENT');
  const conflicted = build(ev({ stamp_conflict: true }));
  ok(conflicted.status !== 'PRESENT', '④b stamp 冲突不得 PRESENT');
  ok(conflicted.reasons.some((r) => r.includes('stamp-conflict')), '④b 要给出 stamp-conflict 理由');
  const cf = build(ev({ stamp_conflict: true, stamp_world_id: 'world-B', stamp_server_session: 'sess-B' }));
  ok(cf.events[0].stampConflict === true && cf.events[0].stampWorldId === 'world-B', '④c 冲突信息要原样带出');
  const wrongType = build(ev({ turn: '1' }));
  ok(wrongType.status !== 'PRESENT', '⑤类型不对不得 PRESENT');
  const garbage = build('{not json}\n' + ev());
  ok(garbage.reasons.includes('malformed-lines'), '⑥坏行要显式记');
  return fails;
}

module.exports = { build, checkEvent, REQUIRED, selftest };

if (require.main === module) {
  const fails = selftest();
  if (fails.length) { console.error('final-request-evidence selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
  console.log('final-request-evidence selftest PASS（7 组）');
}