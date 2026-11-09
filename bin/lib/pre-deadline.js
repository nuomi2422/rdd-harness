'use strict';
/**
 * pre-deadline.js —— "事前截止"检查（2026-11-09，离线模块）
 *
 * 为什么：如果一条请求声称"依据某条经验/证据"，但那条证据的落盘时间**晚于**请求，
 * 那它就不是事前依据，而是事后拼的。这类错误在汇总里完全看不出来，只有对时间才能发现。
 *
 * 语义（有限，且**时间来源不可信时不给结论**）：
 *   - 只比较**时间戳先后**，不证明内容因果、不证明内容真伪；
 *   - **时间来源必须声明且属于可信集**（如受管落盘的 immutable ingestion 时间）：
 *     FS mtime、事后读到的字段、自报时间一律不算；不可信 → UNKNOWN，**不得判 VIOLATION**；
 *   - 允许 equal（同刻不可判）单独计数；
 *   - 时钟偏差容差由调用方给出（clockSkewMs），容差内不判违规。
 */
function checkPreDeadline(items, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const resolve = typeof o.resolve === 'function' ? o.resolve : null;
  // 2026-11-09（指挥官指出）：trustedSources 只是**授权标签**，不是事实证明。
  // 调用方必须为每个标签提供**验证器**：能核签发/不可变捕获/时钟域与误差界。
  // 只给字符串名单 → 一律 UNKNOWN（不允许"声明即可信"）。
  const sources = o.sources && typeof o.sources === 'object' ? o.sources : {};
  const trusted = Array.isArray(o.trustedSources) ? o.trustedSources : [];
  const labelOk = (label) => trusted.includes(String(label || '')) && sources[String(label)] && typeof sources[String(label)].verify === 'function';
  const skewFor = (label) => {
    const src = sources[String(label)] || {};
    return Number.isFinite(src.skewMs) ? Math.max(0, Number(src.skewMs)) : 0;
  };
  const list = Array.isArray(items) ? items : [];
  const out = { total: list.length, ok: 0, late: [], unknown: [], sameInstant: 0 };
  for (const it of list) {
    if (!it || typeof it.at !== 'string' || !Number.isFinite(Date.parse(it.at))) { out.unknown.push({ id: it && it.id, why: 'bad-ref-time' }); continue; }
    // 请求侧时间来源也要可信，否则整条不可判
    if (!labelOk(it.atSource)) { out.unknown.push({ id: it.id, why: 'untrusted-use-time' }); continue; }
    if (!sources[String(it.atSource)].verify(it)) { out.unknown.push({ id: it.id, why: 'use-time-unverified' }); continue; }
    const refs = Array.isArray(it.refs) ? it.refs : [];
    if (!refs.length) { out.unknown.push({ id: it.id, why: 'no-refs' }); continue; }
    let allOk = true;
    for (const r of refs) {
      const rec = resolve ? (() => { try { return resolve(r); } catch { return null; } })() : null;
      if (!rec || typeof rec.at !== 'string' || !Number.isFinite(Date.parse(rec.at))) { out.unknown.push({ id: it.id, ref: r, why: 'ref-unresolved' }); allOk = false; continue; }
      if (!labelOk(rec.atSource)) { out.unknown.push({ id: it.id, ref: r, why: 'untrusted-ref-time' }); allOk = false; continue; }
      if (!sources[String(rec.atSource)].verify(rec)) { out.unknown.push({ id: it.id, ref: r, why: 'ref-time-unverified' }); allOk = false; continue; }
      // 不同时钟域不可直接比较（跨域只能 UNKNOWN）
      const domA = sources[String(it.atSource)].clockDomain || it.atSource;
      const domB = sources[String(rec.atSource)].clockDomain || rec.atSource;
      if (domA !== domB) { out.unknown.push({ id: it.id, ref: r, why: 'cross-clock-domain' }); allOk = false; continue; }
      const skew = Math.min(skewFor(it.atSource), skewFor(rec.atSource));
      const tRef = Date.parse(rec.at);
      const tUse = Date.parse(it.at);
      if (tRef > tUse + skew) { out.late.push({ id: it.id, ref: r, usedAt: it.at, refAt: rec.at, skewMs: skew }); allOk = false; }
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
  const TR = ['ingestion'];
  const sources = { ingestion: { clockDomain: 'host', skewMs: 1000, verify: (r) => r && r.immutable === true } };
  const rec = (at, extra) => ({ at, atSource: 'ingestion', immutable: true, ...(extra || {}) });
  const src = {
    'ev-1': rec('2026-11-09T05:00:00Z'),
    'ev-2': rec('2026-11-09T07:00:00Z'),
    'ev-forged': rec('2026-11-09T05:00:00Z', { immutable: false }),
    'ev-otherclock': rec('2026-11-09T05:00:00Z', { atSource: 'remote' }),
  };
  const resolve = (k) => src[k] || null;
  const ALL = { resolve, trustedSources: ['ingestion', 'remote'], sources: { ...sources, remote: { clockDomain: 'gpu', skewMs: 1000, verify: (r) => r && r.immutable === true } } };
  const use = (at, extra) => ({ id: 'a', at, atSource: 'ingestion', immutable: true, ...(extra || {}) });

  ok(checkPreDeadline([], {}).status === 'UNKNOWN', '①空 → UNKNOWN');
  ok(checkPreDeadline([use('2026-11-09T06:00:00Z', { refs: ['ev-1'] })], ALL).status === 'PRESENT', '②证据早于使用 → PRESENT');
  const late = checkPreDeadline([use('2026-11-09T06:00:00Z', { refs: ['ev-2'] })], ALL);
  ok(late.status === 'VIOLATION', '③证据晚于使用 → VIOLATION');
  ok(checkPreDeadline([use('2026-11-09T06:00:00Z', { refs: ['nope'] })], ALL).status === 'UNKNOWN', '④指针解析不到 → UNKNOWN');
  ok(checkPreDeadline([use('2026-11-09T06:00:00Z', { refs: [] })], ALL).status === 'UNKNOWN', '⑤没有依据 → UNKNOWN');
  const same = checkPreDeadline([use('2026-11-09T05:00:00Z', { refs: ['ev-1'] })], ALL);
  ok(same.reasons.includes('same-instant-undecidable'), '⑥同刻单独提示');
  // ⑤ 伪造 ingestion 标签：验证器说不可变证据不成立 → UNKNOWN，绝不判违规
  ok(checkPreDeadline([use('2026-11-09T06:00:00Z', { refs: ['ev-forged'] })], ALL).status === 'UNKNOWN', '⑦伪造来源标签 → UNKNOWN');
  // ⑥ 只有标签、没有验证器 → 一律 UNKNOWN
  ok(checkPreDeadline([use('2026-11-09T06:00:00Z', { refs: ['ev-1'] })], { resolve, trustedSources: ['ingestion'] }).status === 'UNKNOWN', '⑧只给标签不给验证器 → UNKNOWN');
  // ⑦ 跨时钟域不可比
  ok(checkPreDeadline([use('2026-11-09T06:00:00Z', { refs: ['ev-otherclock'] })], ALL).status === 'UNKNOWN', '⑨跨时钟域 → UNKNOWN');
  // ⑧ 容差内不判违规
  const skewOk = checkPreDeadline([use('2026-11-09T06:00:00Z', { refs: ['ev-2'] })], { ...ALL, sources: { ...ALL.sources, ingestion: { ...ALL.sources.ingestion, skewMs: 2 * 3600 * 1000 } } });
  ok(skewOk.status === 'PRESENT', '⑩容差内不判违规');
  return fails;
}

module.exports = { checkPreDeadline, selftest };

if (require.main === module) {
  const fails = selftest();
  if (fails.length) { console.error('pre-deadline selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
  console.log('pre-deadline selftest PASS（10 组）');
}