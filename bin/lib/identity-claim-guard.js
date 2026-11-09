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
 * 真正尝试证明独立性：把 evidence 指针解析成记录，逐项比对。
 * @param {object} claim
 * @param {(pointer: string) => object|null} resolve 由调用方提供，必须真的去读源（不同组件/存储）
 */
function verifyIndependent(claim, resolve) {
  const shape = checkClaimShape(claim);
  if (!shape.ok) return { ok: false, independent: false, why: shape.why };
  if (typeof resolve !== 'function') return { ok: false, independent: false, why: 'no-pointer-resolver' };
  let rec;
  try { rec = resolve(claim.evidence); } catch (e) { return { ok: false, independent: false, why: 'resolver-threw' }; }
  if (!rec || typeof rec !== 'object') return { ok: false, independent: false, why: 'pointer-unresolved' };
  if (rec.worldId !== claim.worldId) return { ok: false, independent: false, why: 'world-mismatch' };
  if (rec.serverSession !== claim.serverSession) return { ok: false, independent: false, why: 'session-mismatch' };
  if (rec.companion !== claim.companion) return { ok: false, independent: false, why: 'companion-mismatch' };
  // 同根：记录若标明自己也是从同一个 stamp 抄来的，不能当独立证据
  if (rec.derivedFrom === 'stamp' || rec.sameRoot === true) return { ok: false, independent: false, why: 'same-root' };
  return { ok: true, independent: true, why: 'independent-verified' };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const claim = { worldId: 'w', serverSession: 's', companion: 'c', evidence: 'some/path#1' };
  ok(checkClaimShape(claim).independent === false, '①结构 OK 也不得自称独立');
  ok(verifyIndependent(claim, null).why === 'no-pointer-resolver', '②没有解析器必须 false');
  ok(verifyIndependent(claim, () => null).why === 'pointer-unresolved', '③解析不出来 false');
  ok(verifyIndependent(claim, () => ({ worldId: 'w', serverSession: 'other', companion: 'c' })).why === 'session-mismatch', '④目标不对应 false');
  ok(verifyIndependent(claim, () => ({ worldId: 'w', serverSession: 's', companion: 'c', sameRoot: true })).why === 'same-root', '⑤同根 false');
  ok(verifyIndependent(claim, () => ({ worldId: 'w', serverSession: 's', companion: 'c' })).independent === true, '⑥真解析成功才算独立');
  ok(verifyIndependent({ ...claim, evidence: 'fake/whatever' }, () => null).independent === false, '⑦任意虚构路径不得通过');
  return fails;
}

module.exports = { checkClaimShape, verifyIndependent, selftest };

if (require.main === module) {
  const fails = selftest();
  if (fails.length) { console.error('identity-claim selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
  console.log('identity-claim selftest PASS（7 组）');
}
