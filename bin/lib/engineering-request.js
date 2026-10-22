'use strict';
/**
 * engineering-request.js —— G7a 工程桥的**契约与状态机**（纯函数，无 IO / 无网络）
 *
 * 依据：75 号 §15.7 `EngineeringRequest(requestId, contractRevision, batchId, scope,
 * expectedBaseRevision, evidenceRefs, budgetAuthorizationRef)` + §15.8 B7。
 *
 * 三条纪律（判据 R1–R7 的由来）：
 *  1. **缺证据不放行**：进 IMPLEMENTED 必须有 evidenceRefs；进 VERIFIED 必须有独立核验者（≠提交者）且证据 ≥2。
 *  2. **未填不等于无限**：没有 budgetAuthorizationRef 就是「没有预算」，不是「随便花」。
 *  3. **断点要认基线**：expectedBaseRevision 与实际不符 → BLOCKED，不许拿错基线的活继续。
 *
 * 用法：
 *   const er = require('./engineering-request');
 *   let r = er.create({requestId:'G7a-1', contractRevision:'v1', batchId:'G7a', scope:'harness',
 *                      expectedBaseRevision:'abc123', budgetAuthorizationRef:'bud-1'});
 *   r = er.accept(r, {by:'ai'});
 *   r = er.implement(r, {by:'ai', evidenceRefs:['card.md:12']});
 *   r = er.verify(r, {by:'ai', reviewer:'auditor', evidenceRefs:['a:1','b:2']});
 *   er.selftest();   // → {ok:true, failures:[]}
 */

const STATES = Object.freeze(['RECEIVED', 'ACCEPTED', 'IMPLEMENTED', 'VERIFIED', 'BLOCKED', 'REJECTED']);
const TERMINAL = Object.freeze(['VERIFIED', 'REJECTED']);
const NEXT = Object.freeze({
  RECEIVED: ['ACCEPTED', 'BLOCKED', 'REJECTED'],
  ACCEPTED: ['IMPLEMENTED', 'BLOCKED', 'REJECTED'],
  IMPLEMENTED: ['VERIFIED', 'BLOCKED', 'REJECTED'],
  VERIFIED: [],
  BLOCKED: ['ACCEPTED', 'REJECTED'],
  REJECTED: [],
});

function fail(code, message) {
  const e = new Error(`${code}: ${message}`);
  e.code = code;
  throw e;
}

function nowMillis() {
  return Date.now();
}

function nonEmpty(s) {
  return typeof s === 'string' && s.trim().length > 0;
}

function clone(req) {
  return {
    ...req,
    evidenceRefs: [...req.evidenceRefs],
    transitions: [...req.transitions],
  };
}

function transition(req, to, { by, reason } = {}) {
  if (!STATES.includes(to)) fail('UNKNOWN_STATE', `没有这个状态：${to}`);
  if (TERMINAL.includes(req.state)) fail('TERMINAL_STATE', `${req.state} 是终态，不能再迁到 ${to}`);
  if (!NEXT[req.state].includes(to)) fail('ILLEGAL_TRANSITION', `${req.state} 不能直接到 ${to}`);
  if ((to === 'BLOCKED' || to === 'REJECTED') && !nonEmpty(reason)) {
    fail('REASON_REQUIRED', `${to} 必须写理由`);
  }
  const next = clone(req);
  next.state = to;
  next.transitions.push({ from: req.state, to, at: nowMillis(), by: by || '', reason: reason || '' });
  return next;
}

function create(input = {}) {
  const required = ['requestId', 'contractRevision', 'batchId', 'scope'];
  for (const k of required) {
    if (!nonEmpty(input[k])) fail('MISSING_FIELD', `缺必填字段：${k}`);
  }
  const evidenceRefs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs.filter(nonEmpty) : [];
  return {
    requestId: input.requestId,
    contractRevision: input.contractRevision,
    batchId: input.batchId,
    scope: input.scope,
    expectedBaseRevision: input.expectedBaseRevision || '',
    budgetAuthorizationRef: input.budgetAuthorizationRef || '',
    submitter: input.submitter || '',
    evidenceRefs,
    state: 'RECEIVED',
    spent: 0,
    blockedReason: '',
    transitions: [{ from: null, to: 'RECEIVED', at: nowMillis(), by: input.submitter || '', reason: 'created' }],
  };
}

function accept(req, opts = {}) {
  const next = transition(req, 'ACCEPTED', opts);
  return next;
}

function implement(req, opts = {}) {
  const refs = Array.isArray(opts.evidenceRefs) ? opts.evidenceRefs.filter(nonEmpty) : [];
  if (req.evidenceRefs.length + refs.length === 0) {
    fail('EVIDENCE_REQUIRED', '进 IMPLEMENTED 必须带证据（缺证据不放行）');
  }
  const next = transition(req, 'IMPLEMENTED', opts);
  next.evidenceRefs = [...req.evidenceRefs, ...refs];
  return next;
}

function verify(req, opts = {}) {
  const reviewer = opts.reviewer || '';
  const refs = Array.isArray(opts.evidenceRefs) ? opts.evidenceRefs.filter(nonEmpty) : [];
  if (!nonEmpty(reviewer)) fail('INDEPENDENT_REVIEW_REQUIRED', '进 VERIFIED 必须有独立核验者');
  if (!nonEmpty(req.submitter)) fail('SUBMITTER_REQUIRED', '请求必须记提交者，否则「独立核验」无从判定');
  if (reviewer === req.submitter) {
    fail('INDEPENDENT_REVIEW_REQUIRED', '核验者不能是提交者本人');
  }
  const all = [...req.evidenceRefs, ...refs];
  if (all.length < 2) fail('EVIDENCE_REQUIRED', '进 VERIFIED 至少 2 条证据');
  const next = transition(req, 'VERIFIED', opts);
  next.evidenceRefs = all;
  next.verifiedBy = reviewer;
  return next;
}

function block(req, opts = {}) {
  const next = transition(req, 'BLOCKED', opts);
  next.blockedReason = opts.reason || '';
  return next;
}

function reject(req, opts = {}) {
  const next = transition(req, 'REJECTED', opts);
  next.blockedReason = opts.reason || '';
  return next;
}

/** 断点：基线版本必须对得上，否则 BLOCKED(BASE_REVISION_MISMATCH)。 */
function checkBase(req, actualRevision, opts = {}) {
  if (!nonEmpty(req.expectedBaseRevision)) {
    return block(req, { by: opts.by, reason: 'BASE_REVISION_MISMATCH: 请求没写期望基线' });
  }
  if (req.expectedBaseRevision !== actualRevision) {
    return block(req, {
      by: opts.by,
      reason: `BASE_REVISION_MISMATCH: 期望 ${req.expectedBaseRevision}，实际 ${actualRevision}`,
    });
  }
  return req;
}

/** 断点续跑：只接受「同一个 requestId + 同一基线」，其余一律拒绝。 */
function resume(req, { requestId, atRevision, by } = {}) {
  if (!nonEmpty(requestId) || requestId !== req.requestId) {
    fail('RESUME_UNKNOWN', `没有这个请求：${requestId}`);
  }
  if (!nonEmpty(atRevision) || atRevision !== req.expectedBaseRevision) {
    fail('RESUME_UNKNOWN', `断点基线对不上：${atRevision}`);
  }
  if (req.state === 'BLOCKED') {
    return accept(req, { by, reason: 'resume' });
  }
  return req;
}

/**
 * 预算：`budgets` 是授权表 `{id: {currency|quota, amount, calls, tokens, expiresAt, scope}}`。
 * **没有授权就是没有预算**（未填 ≠ 无限）。
 */
function assertBudget(req, budgets = {}, cost = {}, { at = nowMillis(), scope } = {}) {
  const ref = req.budgetAuthorizationRef;
  if (!nonEmpty(ref)) fail('NO_AUTHORIZATION', '请求没有预算授权（未填不等于无限）');
  const b = budgets[ref];
  if (!b) fail('NO_AUTHORIZATION', `授权表里没有 ${ref}`);
  if (b.expiresAt && at > b.expiresAt) fail('BUDGET_EXPIRED', `${ref} 已过期`);
  if (scope && b.scope && b.scope !== scope) fail('BUDGET_SCOPE_MISMATCH', `${ref} 只覆盖 ${b.scope}`);
  const amount = Number(cost.amount || 0);
  const calls = Number(cost.calls || 0);
  const tokens = Number(cost.tokens || 0);
  if (b.amount != null && amount > 0 && amount > b.amount) fail('BUDGET_EXCEEDED', `金额上限 ${b.amount}`);
  if (b.calls != null && calls > 0 && calls > b.calls) fail('BUDGET_EXCEEDED', `调用上限 ${b.calls}`);
  if (b.tokens != null && tokens > 0 && tokens > b.tokens) fail('BUDGET_EXCEEDED', `token 上限 ${b.tokens}`);
  return { ok: true, ref, amount, calls, tokens };
}

// ─────────────────────────── selftest（R1–R7） ───────────────────────────

function selftest() {
  const failures = [];
  const check = (name, fn) => {
    try {
      fn();
    } catch (e) {
      failures.push(`${name}: ${e.message}`);
    }
  };
  const expectCode = (fn, code) => {
    try {
      fn();
    } catch (e) {
      if (e.code !== code) throw new Error(`期望 ${code}，得到 ${e.code}: ${e.message}`);
      return;
    }
    throw new Error(`期望抛 ${code}，但没抛`);
  };

  const base = () => create({
    requestId: 'r1', contractRevision: 'v1', batchId: 'G7a', scope: 'harness',
    expectedBaseRevision: 'abc', submitter: 'ai',
  });

  check('R1 合法链', () => {
    let r = base();
    r = accept(r, { by: 'ai' });
    r = implement(r, { by: 'ai', evidenceRefs: ['card.md:12'] });
    r = verify(r, { by: 'ai', reviewer: 'auditor', evidenceRefs: ['a:1'] });
    if (r.state !== 'VERIFIED') throw new Error(r.state);
    if (r.transitions.length !== 4) throw new Error('transitions=' + r.transitions.length);
    expectCode(() => transition(base(), 'VERIFIED', {}), 'ILLEGAL_TRANSITION');
  });

  check('R2 缺证据不放行', () => {
    const r = accept(base(), { by: 'ai' });
    expectCode(() => implement(r, { by: 'ai' }), 'EVIDENCE_REQUIRED');
    expectCode(() => implement(r, { by: 'ai', evidenceRefs: ['  '] }), 'EVIDENCE_REQUIRED');
  });

  check('R3 独立核验', () => {
    let r = implement(accept(base(), { by: 'ai' }), { by: 'ai', evidenceRefs: ['a:1'] });
    expectCode(() => verify(r, { by: 'ai', reviewer: 'ai', evidenceRefs: ['b:2'] }), 'INDEPENDENT_REVIEW_REQUIRED');
    expectCode(() => verify(r, { by: 'ai', reviewer: 'x', evidenceRefs: [] }), 'EVIDENCE_REQUIRED');
  });

  check('R4 理由与终态', () => {
    expectCode(() => block(base(), { by: 'ai' }), 'REASON_REQUIRED');
    expectCode(() => reject(base(), { by: 'ai', reason: '' }), 'REASON_REQUIRED');
    const v = verify(implement(accept(base(), { by: 'ai' }), { by: 'ai', evidenceRefs: ['a:1'] }),
      { by: 'ai', reviewer: 'x', evidenceRefs: ['b:2'] });
    expectCode(() => transition(v, 'ACCEPTED', {}), 'TERMINAL_STATE');
  });

  check('R5 预算', () => {
    const r = create({ requestId: 'r5', contractRevision: 'v1', batchId: 'G7a', scope: 'harness' });
    expectCode(() => assertBudget(r, {}, { amount: 1 }), 'NO_AUTHORIZATION');
    const budgets = {
      b1: { amount: 10, expiresAt: nowMillis() + 10000, scope: 'harness' },
      b2: { amount: 10, expiresAt: nowMillis() - 1000 },
      b3: { amount: 10, scope: 'game' },
    };
    expectCode(() => assertBudget({ ...r, budgetAuthorizationRef: 'b1' }, budgets, { amount: 11 }), 'BUDGET_EXCEEDED');
    expectCode(() => assertBudget({ ...r, budgetAuthorizationRef: 'b2' }, budgets, { amount: 1 }), 'BUDGET_EXPIRED');
    expectCode(() => assertBudget({ ...r, budgetAuthorizationRef: 'b3' }, budgets, { amount: 1 }, { scope: 'harness' }),
      'BUDGET_SCOPE_MISMATCH');
    const ok = assertBudget({ ...r, budgetAuthorizationRef: 'b1' }, budgets, { amount: 5 }, { scope: 'harness' });
    if (!ok.ok) throw new Error('正常授权不该被拒');
  });

  check('R6 断点', () => {
    const r = base();
    const b = checkBase(r, 'different', { by: 'ai' });
    if (b.state !== 'BLOCKED' || !b.blockedReason.startsWith('BASE_REVISION_MISMATCH')) throw new Error(b.state);
    if (checkBase(r, 'abc', { by: 'ai' }).state !== 'RECEIVED') throw new Error('基线一致不该被拦');
    expectCode(() => resume(r, { requestId: 'nope', atRevision: 'abc' }), 'RESUME_UNKNOWN');
    const resumed = resume(b, { requestId: 'r1', atRevision: 'abc', by: 'ai' });
    if (resumed.state !== 'ACCEPTED') throw new Error('恢复后应回到 ACCEPTED，实际 ' + resumed.state);
  });

  check('R7 可重放', () => {
    let r = base();
    r = accept(r, { by: 'ai' });
    r = implement(r, { by: 'ai', evidenceRefs: ['a:1'] });
    r = verify(r, { by: 'ai', reviewer: 'x', evidenceRefs: ['b:2'] });
    const replay = r.transitions.reduce((acc, t) => {
      if (t.to === 'RECEIVED') return acc;
      if (t.to === 'ACCEPTED') return accept(acc, { by: t.by });
      if (t.to === 'IMPLEMENTED') return implement(acc, { by: t.by, evidenceRefs: ['replay:1'] });
      if (t.to === 'VERIFIED') return verify(acc, { by: t.by, reviewer: 'x', evidenceRefs: ['replay:2'] });
      return acc;
    }, base());
    if (replay.state !== r.state) throw new Error('重放终态不一致');
  });

  return { ok: failures.length === 0, failures, checks: 7 };
}

module.exports = {
  STATES, TERMINAL, NEXT,
  create, accept, implement, verify, block, reject,
  checkBase, resume, assertBudget, selftest,
};

if (require.main === module) {
  const r = selftest();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
