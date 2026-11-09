'use strict';
/**
 * identity-claim-guard.js —— 身份 claim 的**结构检查**（2026-11-09，口径已纠正）
 *
 * ⚠️ 它不是"独立性守门"，也**不是安全认证**。
 * 之前的版本用黑名单（self/envelope/…）挡自证，指挥官指出：**任意虚构 pointer 都能过，
 * 换条路径也可能同根** —— 那只是"看起来严"，不是证明。
 *
 * 现在的口径：
 *   - `checkClaimShape(claim)`：只查结构性废话（缺字段/无指针），返回 `independent: false`；
 *   - `verifyIndependent(claim, resolve)`：**必须**由调用方提供 `resolve(pointer)`，
 *     把那串指针真的解析成一条记录，并逐项比对 world/serverSession/companion；
 *     解析不出来、记录不存在、字段不符、来源与事件同根 → 一律 false；
 *   - **没有 resolve 就永远 false**（UNKNOWN），不允许"没验证也算通过"。
 */
function checkClaimShape(claim) {
  if (!claim || typeof claim !== 'object') return { ok: false, why: 'no-claim', independent: false };
  const worldId = typeof claim.worldId === 'string' ? claim.worldId.trim() : '';
  const serverSession = typeof claim.serverSession === 'string' ? claim.serverSession.trim() : '';
  const companion = typeof claim.companion === 'string' ? claim.companion.trim() : '';
  const evidence = typeof claim.evidence === 'string' ? claim.evidence.trim() : '';
  if (!worldId || !serverSession || !companion) return { ok: false, why: 'incomplete-claim', independent: false };
  if (!evidence) return { ok: false, why: 'no-evidence-pointer', independent: false };
  // 结构上可以带着走，但**独立性从未被证明**
  return { ok: true, why: 'shape-ok-but-unverified', independent: false };
}

/**
 * ⚠️ 这是**有限检查**，建立在明确的**接口假设**上，不是安全认证：
 *   假设 1：`resolve` 由可信调用方提供（它自己就是信任边界）；
 *   假设 2：解析出的记录带**来源标记** `provenance`，且调用方声明哪些来源可信；
 *   假设 3：记录**绑定到具体事件**（`eventKey`），不是"字段恰好相同"的另一条。
 * 任何一条不满足 → UNKNOWN。**字段一致、没有自称 stamp，都不构成独立性证明**
 * （`derivedFrom` 这类自述字段本身就可伪造，只能当线索，不当证据）。
 *
 * @param {object} claim
 * @param {(pointer: string) => object|null} resolve
 * @param {{eventKey?: string, trustedSources?: string[]}} opts
 */
function verifyIndependent(claim, resolve, opts) {
  const shape = checkClaimShape(claim);
  if (!shape.ok) return { ok: false, independent: false, why: shape.why };
  if (typeof resolve !== 'function') return { ok: false, independent: false, why: 'no-pointer-resolver' };
  const o = opts && typeof opts === 'object' ? opts : {};
  const eventKey = typeof o.eventKey === 'string' ? o.eventKey : '';
  const trusted = Array.isArray(o.trustedSources) ? o.trustedSources : [];
  if (!eventKey) return { ok: false, independent: false, why: 'no-event-binding' };
  if (!trusted.length) return { ok: false, independent: false, why: 'no-trusted-sources' };
  let rec;
  try { rec = resolve(claim.evidence); } catch (e) { return { ok: false, independent: false, why: 'resolver-threw' }; }
  if (!rec || typeof rec !== 'object') return { ok: false, independent: false, why: 'pointer-unresolved' };
  // 绑定关系：必须指向**这个**事件，而不是字段恰好一样的另一条
  if (rec.eventKey !== eventKey) return { ok: false, independent: false, why: 'pointer-to-other-or-unbound' };
  // 来源标记：必须显式存在且属于调用方声明的可信来源
  const prov = typeof rec.provenance === 'string' ? rec.provenance.trim() : '';
  if (!prov) return { ok: false, independent: false, why: 'missing-provenance' };
  if (!trusted.includes(prov)) return { ok: false, independent: false, why: 'untrusted-provenance' };
  if (rec.worldId !== claim.worldId) return { ok: false, independent: false, why: 'world-mismatch' };
  if (rec.serverSession !== claim.serverSession) return { ok: false, independent: false, why: 'session-mismatch' };
  if (rec.companion !== claim.companion) return { ok: false, independent: false, why: 'companion-mismatch' };
  return { ok: true, independent: true, why: 'independent-verified-within-assumptions' };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const claim = { worldId: 'w', serverSession: 's', companion: 'c', evidence: 'some/path#1' };
  ok(checkClaimShape(claim).independent === false, '①结构 OK 也不得自称独立');
  const OPTS = { eventKey: 'ev-1', trustedSources: ['rdd.jsonl'] };
  ok(verifyIndependent(claim, null, OPTS).why === 'no-pointer-resolver', '②没有解析器必须 false');
  ok(verifyIndependent(claim, () => null, OPTS).why === 'pointer-unresolved', '③解析不出来 false');
  ok(verifyIndependent(claim, () => ({ worldId: 'w', serverSession: 's', companion: 'c' }), OPTS).why === 'pointer-to-other-or-unbound', '④无事件绑定 false');
  ok(verifyIndependent(claim, () => ({ eventKey: 'ev-1', worldId: 'w', serverSession: 's', companion: 'c' }), OPTS).why === 'missing-provenance', '⑤缺来源 false');
  ok(verifyIndependent(claim, () => ({ eventKey: 'ev-1', provenance: 'stamp', worldId: 'w', serverSession: 's', companion: 'c' }), OPTS).why === 'untrusted-provenance', '⑥伪造/不可信来源 false');
  ok(verifyIndependent(claim, () => ({ eventKey: 'ev-2', provenance: 'rdd.jsonl', worldId: 'w', serverSession: 's', companion: 'c' }), OPTS).why === 'pointer-to-other-or-unbound', '⑦指到别的事件 false');
  ok(verifyIndependent(claim, () => ({ eventKey: 'ev-1', provenance: 'rdd.jsonl', worldId: 'w', serverSession: 's', companion: 'c' }), OPTS).independent === true, '⑧条件齐了才算通过');
  ok(verifyIndependent(claim, () => null, {}).why === 'no-event-binding', '⑨缺 eventKey false');
  ok(verifyIndependent(claim, () => null, { eventKey: 'ev-1' }).why === 'no-trusted-sources', '⑩缺可信来源清单 false');
  return fails;
}

module.exports = { checkClaimShape, verifyIndependent, selftest };

if (require.main === module) {
  const fails = selftest();
  if (fails.length) { console.error('identity-claim selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
  console.log('identity-claim selftest PASS（10 组，有限检查/接口假设）');
}