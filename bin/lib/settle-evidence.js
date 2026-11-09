'use strict';
/**
 * settle-evidence.js —— "结算是否真按最终目标核验"的读端判据（2026-11-09）
 *
 * 背景：主干活在 RddSettleStageTool 上加了 verify_final_goal（要求最后一个一级目标的
 * 全部 subtask 都由服务端世界事实匹配），成功落 `rdd.jsonl/primary_settled_by_fact`，
 * 拒绝落 `rdd.jsonl/primary_settle_rejected`。本模块把这些变成可数的证据。
 *
 * 口径（重要，别含糊）：
 *   - **没有 settle 事件 ≠ 没核验**，而是 UNKNOWN（no-settle-events）；
 *   - 字段上线**前**的历史事件缺少 verified/verify_final_goal → 记为 legacy，**既不算通过也不算失败**，
 *     单独计数并从"核验覆盖率"分母里剔除（否则会把旧日志冤枉成失败）；
 *   - verify_final_goal=true 但 unmet 非空 → **自相矛盾**，按 malformed 处理，不得算通过；
 *   - 拒绝事件里的 `final:<id>` 单列，便于看"卡在哪个最终目标"。
 */
const SETTLED = 'primary_settled_by_fact';
const REJECTED = 'primary_settle_rejected';

function isType(v, t) {
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'array') return Array.isArray(v);
  return typeof v === t;
}

function parse(text, type) {
  const events = [];
  let bad = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.type === type) events.push(o);
    } catch { bad++; }
  }
  return { events, bad };
}

function finalsFromUnmet(unmet) {
  return (Array.isArray(unmet) ? unmet : [])
    .map((x) => (typeof x === 'string' ? x : (x && (x.id || x.subtaskId || x.name)) || null))
    .filter(Boolean)
    .map(String);
}

function build(rddText) {
  const s = parse(rddText, SETTLED);
  const r = parse(rddText, REJECTED);
  const reasons = [];
  if (s.bad || r.bad) reasons.push('malformed-lines');

  const settled = { total: s.events.length, verified: 0, verifyFinalGoal: 0, legacy: 0, inconsistent: 0 };
  // 2026-11-09：按 companion 分开记，避免"一个同伴核验过、另一个没过"被合计成好看的数字。
  const byCompanion = {};
  for (const ev of s.events) {
    const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
    const ck = typeof d.companionId === 'string' ? d.companionId : 'unknown';
    const g = byCompanion[ck] || (byCompanion[ck] = { total: 0, judged: 0, verifyFinalGoal: 0 });
    // 字段上线前的历史事件：没有 verified 字段 → legacy，不计入分母
    g.total++;
    if (d.verified === undefined && d.verify_final_goal === undefined) { settled.legacy++; continue; }
    if (!isType(d.verified, 'boolean') || !isType(d.verify_final_goal, 'boolean')) { settled.inconsistent++; reasons.push('settled:bad-flag-types'); continue; }
    if (d.verify_final_goal === true && isType(d.unmet, 'array') && d.unmet.length > 0) {
      // 说核验通过却又有未满足项：矛盾，不认
      settled.inconsistent++; reasons.push('settled:verify-final-goal-with-unmet'); continue;
    }
    if (d.verified === true) settled.verified++;
    g.judged++;
    if (d.verify_final_goal === true) { settled.verifyFinalGoal++; g.verifyFinalGoal++; }
  }

  const rejected = { total: r.events.length, finals: [] };
  for (const ev of r.events) {
    const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
    for (const f of finalsFromUnmet(d.unmet)) if (!rejected.finals.includes(f)) rejected.finals.push(f);
    // 兼容：拒绝理由里内嵌 final:<id> 的形态
    const msg = typeof d.reason === 'string' ? d.reason : (typeof d.message === 'string' ? d.message : '');
    const m = /final:([A-Za-z0-9_.:-]+)/g;
    let hit;
    while ((hit = m.exec(msg)) !== null) if (!rejected.finals.includes(hit[1])) rejected.finals.push(hit[1]);
  }

  if (!s.events.length && !r.events.length) {
    return { status: 'UNKNOWN', reasons: reasons.concat(['no-settle-events']), settled, rejected, coverage: null };
  }

  const judged = settled.total - settled.legacy;
  const coverage = {
    judged: judged > 0 ? settled.verifyFinalGoal + '/' + judged : null,
    legacyExcluded: settled.legacy,
    inconsistent: settled.inconsistent,
  };
  // 只有"有结算、且每条被判定的事件都带了 verify_final_goal"才算 PRESENT
  let status = 'PARTIAL';
  if (judged > 0 && settled.verifyFinalGoal === judged && settled.inconsistent === 0) status = 'PRESENT';
  if (judged === 0) status = 'UNKNOWN';
  if (status === 'UNKNOWN') reasons.push('no-judgeable-settlements');
  if (settled.inconsistent) status = 'UNKNOWN';
  return { status, reasons, settled, rejected, coverage, byCompanion };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const L = (type, data) => JSON.stringify({ type, data });
  const settled = (over) => L(SETTLED, Object.assign({ companionId: 'c', primary: 'p', verified: true, verify_final_goal: true, unmet: [] }, over || {}));
  const rejectedEv = (over) => L(REJECTED, Object.assign({ companionId: 'c', primary: 'p', verified: false, verify_final_goal: true, unmet: ['final:goal-a'] }, over || {}));

  ok(build('').status === 'UNKNOWN', '①空流 UNKNOWN');
  ok(build('').reasons.includes('no-settle-events'), '①理由');
  ok(build(settled()).status === 'PRESENT', '②带最终目标核验 → PRESENT');
  ok(build(settled({ verify_final_goal: false })).status === 'PARTIAL', '③未按最终目标核验 → PARTIAL');
  ok(build(L(SETTLED, { companionId: 'c', primary: 'p', reason: 'old' })).settled.legacy === 1, '④历史事件记 legacy');
  ok(build(settled({ verify_final_goal: true, unmet: ['final:x'] })).status !== 'PRESENT', '⑤自相矛盾不得 PRESENT');
  const rej = build(rejectedEv());
  ok(rej.rejected.finals.includes('final:goal-a'), '⑥拒绝项单列最终目标');
  return fails;
}

module.exports = { build, SETTLED, REJECTED, selftest };

if (require.main === module) {
  const fails = selftest();
  if (fails.length) { console.error('settle-evidence selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
  console.log('settle-evidence selftest PASS（6 组）');
}