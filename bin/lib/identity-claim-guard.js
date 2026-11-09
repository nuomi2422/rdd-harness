'use strict';
/**
 * identity-claim-guard.js —— 身份 claim 的"是否独立"守门（2026-11-09）
 *
 * 为什么需要：账本 action-ledger 只校验"claim 与信封字段一致"，它无法判断
 * claim 是不是**从同一个 stamp 抄来的**。若生产 resolver 直接返回事件自己的
 * world_id/session，那就是同源自证 —— 看起来有身份，实际什么都没证明。
 *
 * 本模块不做判定替代，只做三件事：
 *   1. 拒绝没有 evidence 指针的 claim（无法回查就不算证据）；
 *   2. 拒绝 evidence 明显指向自身（self / envelope / event，或等于 worldId/serverSession 拼串）；
 *   3. 拒绝缺少 worldId/serverSession/companion 任一项的 claim。
 *
 * 边界（写清，别当成完整防护）：它只能挡住"明显自证"，**挡不住**精心伪造的指针。
 * 真正的独立性要靠证据来源本身（不同组件、不同存储），这一点必须由生产侧证明。
 */
function judgeClaim(ev, claim) {
  if (!claim || typeof claim !== 'object') return { ok: false, why: 'no-claim' };
  const worldId = typeof claim.worldId === 'string' ? claim.worldId.trim() : '';
  const serverSession = typeof claim.serverSession === 'string' ? claim.serverSession.trim() : '';
  const companion = typeof claim.companion === 'string' ? claim.companion.trim() : '';
  if (!worldId || !serverSession || !companion) return { ok: false, why: 'incomplete-claim' };
  const evidence = typeof claim.evidence === 'string' ? claim.evidence.trim() : '';
  if (!evidence) return { ok: false, why: 'no-evidence-pointer' };
  if (/^(self|envelope|event|same)$/i.test(evidence)) return { ok: false, why: 'self-referential-evidence' };
  if (evidence === worldId + '/' + serverSession) return { ok: false, why: 'self-referential-evidence' };
  // 事件自带字段被原样当成"证据"：同样是自证
  const e = ev && typeof ev === 'object' ? ev : {};
  const d = e.data && typeof e.data === 'object' ? e.data : {};
  const envWorld = e.world_id || d.world_id;
  const envSess = e.server_session || d.server_session || d.session_id;
  if (envWorld === worldId && envSess === serverSession && /envelope|self|event/i.test(evidence)) {
    return { ok: false, why: 'self-referential-evidence' };
  }
  return { ok: true };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const ev = { world_id: 'w', server_session: 's', data: {} };
  ok(judgeClaim(ev, null).why === 'no-claim', '①无 claim');
  ok(judgeClaim(ev, { worldId: 'w', serverSession: 's' }).why === 'incomplete-claim', '②缺 companion');
  ok(judgeClaim(ev, { worldId: 'w', serverSession: 's', companion: 'c' }).why === 'no-evidence-pointer', '③缺证据指针');
  ok(judgeClaim(ev, { worldId: 'w', serverSession: 's', companion: 'c', evidence: 'self' }).why === 'self-referential-evidence', '④自证 self');
  ok(judgeClaim(ev, { worldId: 'w', serverSession: 's', companion: 'c', evidence: 'w/s' }).why === 'self-referential-evidence', '⑤自证拼串');
  ok(judgeClaim(ev, { worldId: 'w', serverSession: 's', companion: 'c', evidence: 'rdd.jsonl#taskchain_snapshot:42' }).ok === true, '⑥独立指针通过');
  return fails;
}

module.exports = { judgeClaim, selftest };

if (require.main === module) {
  const fails = selftest();
  if (fails.length) { console.error('identity-claim-guard selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
  console.log('identity-claim-guard selftest PASS（6 组）');
}
