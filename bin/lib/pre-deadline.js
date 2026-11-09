'use strict';
/**
 * pre-deadline.js —— "事前截止"检查（2026-11-09，离线模块）
 *
 * 为什么：如果一条请求声称"依据某条经验/证据"，但那条证据的落盘时间**晚于**请求，
 * 那它就不是事前依据，而是事后拼的。这类错误在汇总里完全看不出来，只有对时间才能发现。
 *
 * 语义（有限）：
 *   - 只比较**时间戳先后**，不证明内容因果、不证明内容真伪；
 *   - 任一指针解析不到、或缺时间 → UNKNOWN（不给通过）；
 *   - 允许 equal（同一毫秒写入无法区分）但会单独计数，提示"同刻不可判"。
 */
function checkPreDeadline(items, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const resolve = typeof o.resolve === 'function' ? o.resolve : null;
  const list = Array.isArray(items) ? items : [];
  const out = { total: list.length, ok: 0, late: [], unknown: [], sameInstant: 0 };
  for (const it of list) {
    if (!it || typeof it.at !== 'string' || !Number.isFinite(Date.parse(it.at))) { out.unknown.push({ id: it && it.id, why: 'bad-ref-time' }); continue; }
    const refs = Array.isArray(it.refs) ? it.refs : [];
    if (!refs.length) { out.unknown.push({ id: it.id, why: 'no-refs' }); continue; }
    let allOk = true;
    for (const r of refs) {
      const rec = resolve ? (() => { try { return resolve(r); } catch { return null; } })() : null;
      if (!rec || typeof rec.at !== 'string' || !Number.isFinite(Date.parse(rec.at))) { out.unknown.push({ id: it.id, ref: r, why: 'ref-unresolved' }); allOk = false; continue; }
      const tRef = Date.parse(rec.at);
      const tUse = Date.parse(it.at);
      if (tRef > tUse) { out.late.push({ id: it.id, ref: r, usedAt: it.at, refAt: rec.at }); allOk = false; }
      else if (tRef === tUse) { out.sameInstant++; }
    }
    if (allOk) out.ok++;
  }
  const status = out.late.length ? 'VIOLATION' : (out.unknown.length ? 'UNKNOWN' : (out.total ? 'PRESENT' : 'UNKNOWN'));
  return { status, ...out, reasons: [
    ...(out.late.length ? ['evidence-after-use'] : []),
    ...(out.unknown.length ? ['unresolvable-refs'] : []),
    ...(out.sameInstant ? ['same-instant-undecidable'] : []),
  ] };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const src = { 'ev-1': { at: '2026-11-09T05:00:00Z' }, 'ev-2': { at: '2026-11-09T07:00:00Z' } };
  const resolve = (k) => src[k] || null;
  ok(checkPreDeadline([], {}).status === 'UNKNOWN', '①空 → UNKNOWN');
  ok(checkPreDeadline([{ id: 'a', at: '2026-11-09T06:00:00Z', refs: ['ev-1'] }], { resolve }).status === 'PRESENT', '②证据早于使用 → PRESENT');
  const late = checkPreDeadline([{ id: 'a', at: '2026-11-09T06:00:00Z', refs: ['ev-2'] }], { resolve });
  ok(late.status === 'VIOLATION' && late.reasons.includes('evidence-after-use'), '③证据晚于使用 → VIOLATION');
  ok(checkPreDeadline([{ id: 'a', at: '2026-11-09T06:00:00Z', refs: ['nope'] }], { resolve }).status === 'UNKNOWN', '④指针解析不到 → UNKNOWN');
  ok(checkPreDeadline([{ id: 'a', at: '2026-11-09T06:00:00Z', refs: [] }], { resolve }).status === 'UNKNOWN', '⑤没有依据 → UNKNOWN');
  const same = checkPreDeadline([{ id: 'a', at: '2026-11-09T05:00:00Z', refs: ['ev-1'] }], { resolve });
  ok(same.reasons.includes('same-instant-undecidable'), '⑥同刻单独提示');
  return fails;
}

module.exports = { checkPreDeadline, selftest };

if (require.main === module) {
  const fails = selftest();
  if (fails.length) { console.error('pre-deadline selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
  console.log('pre-deadline selftest PASS（6 组）');
}
