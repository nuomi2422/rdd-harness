'use strict';
/**
 * verdict.js —— 确定性裁决引擎（不向任何模型询问「该不该放行」）
 *
 * 判定优先级（设计草案 §7.3）：
 *   ERROR        → 环境/采集器/Harness 基础设施故障，实验不成立
 *   BLOCKED      → 开跑前就缺能力/权限/预算/前提
 *   FAIL         → 有可信反例，或健康跑完但到截止仍未达标
 *   INCONCLUSIVE → 跑了，但必需证据缺失/过期/冲突/视觉未知，无法裁决
 *   PASS         → 必需断言成立 + 证据门通过 + 工程门通过 + 归档通过
 *
 * ★ 硬不变量违规一旦有可信证据成立，不因后来断流而抹掉 FAIL。
 * ★ 模型的「完成了」只能是 claim；它永远不参与 verdict 的计算，只被用来
 *   标记 UNSUPPORTED_SUCCESS_CLAIM。
 */

const VERDICTS = ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED', 'ERROR', 'CANCELED'];
const FLAGS = {
  UNSUPPORTED_SUCCESS_CLAIM: 'UNSUPPORTED_SUCCESS_CLAIM',
  EVIDENCE_CONFLICT: 'EVIDENCE_CONFLICT',
  HARD_INVARIANT_VIOLATION: 'HARD_INVARIANT_VIOLATION',
  VISION_UNKNOWN: 'VISION_UNKNOWN',
  EVIDENCE_STALE: 'EVIDENCE_STALE',
  EVIDENCE_INVALID: 'EVIDENCE_INVALID',
  CAUSAL_ORDER: 'CAUSAL_ORDER',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  ENGINEERING_GATE: 'ENGINEERING_GATE',
  ARCHIVE_GATE: 'ARCHIVE_GATE',
  STRICT_PROFILE_UNSUPPORTED: 'STRICT_PROFILE_UNSUPPORTED',
};

function decide(input) {
  const ctx = input || {};
  const flags = new Set();
  const reasons = [];
  const adds = (code, detail) => reasons.push({ code, detail });

  const truthy = (v) => v === true;
  const assertions = ctx.assertions || [];
  const invariants = ctx.invariants || [];
  const claims = ctx.claims || [];
  const evidence = ctx.evidence || null;
  const observation = ctx.observation || {};
  const eng = ctx.engineering || {};
  const archive = ctx.archive || { ok: true };

  // ── 0. 运行前阻断（能力/预算/严格档位）─────────────────────────────
  if (ctx.blocked && ctx.blocked.reasons && ctx.blocked.reasons.length) {
    for (const r of ctx.blocked.reasons) {
      adds(r.code || 'BLOCKED', r.detail || String(r));
      if (r.flag) flags.add(r.flag);
    }
    if (ctx.blocked.reasons.some((r) => (r.code || '').includes('BUDGET'))) flags.add(FLAGS.BUDGET_EXHAUSTED);
    if (ctx.blocked.reasons.some((r) => (r.code || '').includes('CAPABILITY') || (r.flag === FLAGS.CAPABILITY_MISSING))) flags.add(FLAGS.CAPABILITY_MISSING);
    if (ctx.blocked.reasons.some((r) => r.flag === FLAGS.STRICT_PROFILE_UNSUPPORTED)) flags.add(FLAGS.STRICT_PROFILE_UNSUPPORTED);
    return finish('BLOCKED', ctx, flags, reasons, { nextAction: ctx.blocked.nextAction || 'SAFE_PAUSE' });
  }

  // ── 1. 环境故障 ────────────────────────────────────────────────────
  if (ctx.environment && ctx.environment.healthy === false) {
    adds('ENVIRONMENT_UNHEALTHY', ctx.environment.detail || '环境/采集器/Harness 基础设施故障，实验无法完成');
    return finish('ERROR', ctx, flags, reasons, {});
  }
  if (ctx.canceled) {
    adds('CANCELED', ctx.canceledReason || '用户取消或外部安全停机');
    return finish('CANCELED', ctx, flags, reasons, {});
  }

  // ── 2. 硬不变量 ────────────────────────────────────────────────────
  let hardFail = false;
  for (const inv of invariants) {
    if (truthy(inv.violated) && inv.trusted !== false) {
      hardFail = true;
      flags.add(FLAGS.HARD_INVARIANT_VIOLATION);
      adds('HARD_INVARIANT_VIOLATION', `${inv.id || inv.predicate}：有可信证据证明不变量被违反` + (inv.reason ? `（${inv.reason}）` : ''));
    }
  }

  // ── 3. 必需断言被可信反例推翻 ──────────────────────────────────────
  let hardFailAssertion = false;
  for (const a of assertions) {
    if (a.result === false && a.trusted !== false && (a.required !== false)) {
      hardFailAssertion = true;
      adds('ASSERTION_FALSE', `${a.id || a.predicate}：断言不成立` + (a.reason ? `（${a.reason}）` : ''));
    }
  }

  // ── 4. 模型口头成功声明 ────────────────────────────────────────────
  let unsupported = false;
  for (const c of claims) {
    if (c.kind === 'success' && !truthy(c.supported)) {
      unsupported = true;
      flags.add(FLAGS.UNSUPPORTED_SUCCESS_CLAIM);
      adds('UNSUPPORTED_SUCCESS_CLAIM', `${c.actor || c.role || '模型'} 声明「完成/成功」，但没有对应证据支撑`);
    }
  }

  // ── 5. 证据门 ──────────────────────────────────────────────────────
  let evidenceBlocking = false;
  if (evidence) {
    for (const issue of evidence.fatal || []) {
      evidenceBlocking = true;
      if (issue.code === 'EVIDENCE_STALE') flags.add(FLAGS.EVIDENCE_STALE);
      else if (issue.code === 'CAUSAL_ORDER') flags.add(FLAGS.CAUSAL_ORDER);
      else flags.add(FLAGS.EVIDENCE_INVALID);
      adds(`EVIDENCE_${issue.code}`, issue.detail);
    }
    for (const issue of evidence.blocking || []) {
      evidenceBlocking = true;
      if (issue.code === 'EVIDENCE_STALE') flags.add(FLAGS.EVIDENCE_STALE);
      else if (issue.code === 'CAUSAL_ORDER' || issue.code === 'CAUSAL_PAIR_MISSING') flags.add(FLAGS.CAUSAL_ORDER);
      else flags.add(FLAGS.EVIDENCE_INVALID);
      adds(`EVIDENCE_${issue.code}`, issue.detail);
    }
  }

  // ── 6. 双源冲突：禁止 PASS，但不许直接判幻觉 ───────────────────────
  let conflict = false;
  if (ctx.conflict && ctx.conflict.detected) {
    conflict = true;
    flags.add(FLAGS.EVIDENCE_CONFLICT);
    adds('EVIDENCE_CONFLICT', ctx.conflict.detail || '同步且可信的状态源与视觉源互相矛盾 —— 禁止 PASS，先补采');
  }

  // ── 7. 视觉未知 ────────────────────────────────────────────────────
  let visionUnknown = false;
  if (observation.visualRequired) {
    if (!observation.visionAvailable) {
      visionUnknown = true;
      flags.add(FLAGS.VISION_UNKNOWN);
      adds('VISION_UNAVAILABLE', '本卡要求视觉证据，但没有可用的视觉模型/画面');
    }
    for (const f of observation.frames || []) {
      if (f.required !== false && f.ok !== true) {
        visionUnknown = true;
        flags.add(FLAGS.VISION_UNKNOWN);
        adds('FRAME_UNUSABLE', `关键帧 ${f.role || '?'} 不可用：${f.reason || '未知'}`);
      }
    }
    for (const role of observation.missingKeyframes || []) {
      visionUnknown = true;
      flags.add(FLAGS.VISION_UNKNOWN);
      adds('KEYFRAME_MISSING', `必需关键帧缺失：${role}`);
    }
  }

  // ── 8. 未决断言 ────────────────────────────────────────────────────
  const unknownRequired = assertions.filter((a) => a.required !== false && a.result !== true && a.result !== false);
  for (const a of unknownRequired) adds('ASSERTION_UNKNOWN', `${a.id || a.predicate}：证据不足以判定（${a.result || 'unknown'}）`);

  // ── 9. 截止 ────────────────────────────────────────────────────────
  if (ctx.deadlineExceeded) adds('DEADLINE_EXCEEDED', '到达截止时间仍未达标');
  if (ctx.deadlineExceeded && !hardFail && !hardFailAssertion) flags.add(FLAGS.DEADLINE_EXCEEDED);

  // ── 裁决 ───────────────────────────────────────────────────────────
  let verdict;
  if (hardFail || hardFailAssertion) {
    verdict = 'FAIL';                     // 可信反例优先，断流也抹不掉
  } else if (evidenceBlocking || conflict || visionUnknown || unknownRequired.length || unsupported) {
    verdict = 'INCONCLUSIVE';
  } else if (ctx.deadlineExceeded) {
    verdict = 'FAIL';                     // 环境与观测健康但没达标 = 任务失败
  } else if (truthy(eng.gatesPassed) === false) {
    verdict = 'BLOCKED';
    flags.add(FLAGS.ENGINEERING_GATE);
    adds('ENGINEERING_GATE', '工程门禁未通过：' + ((eng.reasons || []).join(' ; ') || '未说明'));
  } else if (truthy(archive.ok) === false) {
    verdict = 'BLOCKED';
    flags.add(FLAGS.ARCHIVE_GATE);
    adds('ARCHIVE_GATE', '产物归档门未通过：' + ((archive.reasons || []).join(' ; ') || '未说明'));
  } else {
    verdict = 'PASS';
  }

  // 最终 PASS 的定义：四面都对上。任何一面没对上，PASS 必须降级。
  if (verdict === 'PASS' && (truthy(eng.gatesPassed) === false || truthy(archive.ok) === false)) verdict = 'BLOCKED';

  return finish(verdict, ctx, flags, reasons, {
    taskVerdict: hardFail || hardFailAssertion || ctx.deadlineExceeded ? 'FAIL'
      : (unknownRequired.length || evidenceBlocking || conflict || visionUnknown || unsupported) ? 'INCONCLUSIVE' : 'PASS',
  });
}

function finish(verdict, ctx, flags, reasons, extra) {
  if (!VERDICTS.includes(verdict)) throw new Error(`未知 verdict：${verdict}`);
  const base = {
    verdict,
    flags: [...flags].sort(),
    reasons,
    ranAt: new Date().toISOString(),
    // 数据可用性口径：ERROR/INCONCLUSIVE 不进任务失败率，但进可用性/覆盖率
    countsTowardTaskFailureRate: verdict === 'FAIL',
    countsTowardAvailability: verdict === 'ERROR' || verdict === 'INCONCLUSIVE',
  };
  return Object.assign(base, extra || {});
}

module.exports = { decide, VERDICTS, FLAGS };
