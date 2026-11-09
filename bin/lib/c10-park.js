'use strict';
/**
 * c10-park.js —— "已确认停放"判定（离线实现，**未接入线上门禁**，2026-11-09）
 *
 * 目的：把"没人管"与"在等外部条件"分开，但**不许用配置把自己变绿**。
 * 本模块只做纯判定，不读写任何文件；接入与否由门禁维护者决定（见 050 提案）。
 *
 * 判定优先级（与 050 提案一致）：
 *   1. 人工 pause → 永不自动转绿；
 *   2. 停放记录无效（缺字段/goalId 不符/已过期/条件类型不在枚举）→ 按现状 BLOCK；
 *   3. 条件可核验且已满足 → WARN（不是 PASS），超时未恢复 → BLOCK；
 *   4. 条件不可核验 → UNKNOWN/WARN；
 *   5. 无停放记录 → 交给原有 20 分钟规则。
 */
const TYPES = ['javaw-running', 'new-event', 'manual'];

function validPark(rec, goalId, now) {
  if (!rec || typeof rec !== 'object') return { ok: false, why: 'no-park-record' };
  if (rec.kind !== 'park-ack') return { ok: false, why: 'bad-kind' };
  if (!goalId || rec.goalId !== goalId) return { ok: false, why: 'goal-mismatch' };
  if (!TYPES.includes(rec.condition && rec.condition.type)) return { ok: false, why: 'unsupported-condition' };
  if (!rec.evidence) return { ok: false, why: 'no-evidence' };
  if (!rec.expiresAt || !(Date.parse(rec.expiresAt) > 0)) return { ok: false, why: 'no-expiry' };
  if (Date.parse(rec.expiresAt) <= now) return { ok: false, why: 'expired' };
  return { ok: true };
}

/**
 * @param {object} input
 *   { now, goalId, lastEvent:{kind:'block'|'pause'|...}, park, conditionMet:boolean|null, metAt, partialWork:boolean }
 */
function decide(input) {
  const now = Number(input && input.now) || Date.now();
  const goalId = input && input.goalId;
  const last = (input && input.lastEvent) || {};
  // 1) 人为暂停：永不自动转绿
  if (last.kind === 'pause') return { state: 'BLOCK', why: 'human-pause' };
  const rec = input && input.park;
  const v = validPark(rec, goalId, now);
  if (!v.ok) {
    // 5) 没有记录 → 原有规则；其它无效情形 → BLOCK
    if (v.why === 'no-park-record') return { state: 'RULE_DEFAULT', why: 'no-park-record' };
    return { state: 'BLOCK', why: v.why };
  }
  // 4) 不可核验
  if (input.conditionMet === null || input.conditionMet === undefined) {
    return { state: 'WARN', why: 'condition-unverifiable' };
  }
  // 3) 条件已满足
  if (input.conditionMet === true) {
    const recheck = Number(rec.recheckEveryMin) > 0 ? Number(rec.recheckEveryMin) : 15;
    const windowMs = recheck * 2 * 60_000;
    const metAt = Number(input.metAt) || now;
    if (now - metAt > windowMs) return { state: 'BLOCK', why: 'condition-met-but-not-resumed' };
    if (input.partialWork) return { state: 'WARN', why: 'partial-park-offline-work' };
    return { state: 'WARN', why: 'condition-met-awaiting-resume' };
  }
  // 条件未满足：部分停放（仍有可离线工作）只能是 WARN
  if (input.partialWork) return { state: 'WARN', why: 'partial-park-offline-work' };
  return { state: 'WARN', why: 'parked-awaiting-condition' };
}

/** javaw 条件：PID 相同但启动时间更早 ⇒ 复用，不算满足。 */
function javawCondition(prev, curr) {
  if (!curr || !curr.pid) return false;
  if (!prev || !prev.pid) return true;
  if (prev.pid !== curr.pid) return true;
  const a = Number(prev.startTime) || 0;
  const b = Number(curr.startTime) || 0;
  if (!a || !b) return null; // 缺启动时间 → 不可核验
  return b >= a && b !== a;   // 同 PID 且启动时间更新才算新进程
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const now = Date.parse('2026-11-09T12:00:00Z');
  const base = { kind: 'park-ack', goalId: 'g1', condition: { type: 'javaw-running' }, evidence: 'probe#1',
    parkedAt: '2026-11-09T11:00:00Z', expiresAt: '2026-11-09T15:00:00Z', recheckEveryMin: 15 };
  ok(decide({ now, goalId: 'g1', lastEvent: { kind: 'pause' }, park: base, conditionMet: true }).why === 'human-pause', '①人为暂停优先');
  ok(decide({ now, goalId: 'g1', lastEvent: { kind: 'block' }, park: null }).state === 'RULE_DEFAULT', '②无记录走原规则');
  ok(decide({ now, goalId: 'g1', lastEvent: { kind: 'block' }, park: { ...base, goalId: 'other' } }).why === 'goal-mismatch', '③目标不符');
  ok(decide({ now, goalId: 'g1', lastEvent: { kind: 'block' }, park: { ...base, expiresAt: '2026-11-09T11:30:00Z' } }).why === 'expired', '④过期');
  ok(decide({ now, goalId: 'g1', lastEvent: { kind: 'block' }, park: base, conditionMet: null }).state === 'WARN', '⑤不可核验只 WARN');
  ok(decide({ now, goalId: 'g1', lastEvent: { kind: 'block' }, park: base, conditionMet: true, metAt: now - 60_000 }).state === 'WARN', '⑥满足但未恢复 → WARN');
  ok(decide({ now, goalId: 'g1', lastEvent: { kind: 'block' }, park: base, conditionMet: true, metAt: now - 60 * 60_000 }).why === 'condition-met-but-not-resumed', '⑦满足超时 → BLOCK');
  ok(decide({ now, goalId: 'g1', lastEvent: { kind: 'block' }, park: base, conditionMet: false, partialWork: true }).why === 'partial-park-offline-work', '⑧部分停放 → WARN');
  ok(javawCondition({ pid: 5, startTime: 100 }, { pid: 5, startTime: 100 }) === false, '⑨PID 复用不算满足');
  ok(javawCondition({ pid: 5, startTime: 100 }, { pid: 6, startTime: 200 }) === true, '⑩新进程算满足');
  ok(javawCondition({ pid: 5 }, { pid: 5 }) === null, '⑪缺启动时间 → 不可核验');
  return fails;
}

module.exports = { decide, validPark, javawCondition, TYPES, selftest };

if (require.main === module) {
  const fails = selftest();
  if (fails.length) { console.error('c10-park selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
  console.log('c10-park selftest PASS（11 组，离线未接线）');
}
