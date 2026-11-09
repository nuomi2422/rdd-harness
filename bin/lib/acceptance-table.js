'use strict';
/**
 * acceptance-table.js —— 部署后验收表（2026-11-09，只读）
 *
 * 把"部署后应该看到什么"钉成机器可判的表，避免拿眼睛看日志：
 *   MATCH     = 数字/状态符合预期
 *   MISMATCH  = 有数据但不符合预期（说明链路/字段没接对）
 *   UNKNOWN   = 还没有对应数据（不能当成通过）
 *
 * 行（与 043 的表一致）：
 *   R1 why 交付          final_request 里 whyPresent 的比例
 *   R2 结算核验           primary_settled_by_fact 里 verify_final_goal 的比例
 *   R3 knowledge_gap     body-missing / read-failed 缺口事件是否出现且形状完整
 *   R4 SIDE_CONTEXT 身份 出现身份不符时只允许 UNKNOWN，不得出现"已验证"
 */
function parse(text) {
  const out = { rows: [], bad: 0 };
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.rows.push(JSON.parse(s)); } catch { out.bad++; }
  }
  return out;
}

const isGap = (o) => {
  const t = String(o.type || '');
  const r = String((o.data && (o.data.reason || o.data.gapReason || o.data.kind)) || '');
  return /knowledge_gap|knowledge_gap_body|knowledge_gap_read/.test(t + ' ' + r) || /body-missing|read-failed/.test(r);
};


/**
 * R5：skills 检索是否真的进了运行期上下文（口径对齐 scripts/verify-skills-retrieval.js）。
 * 期望 = skills.jsonl 里 status∈{TRIAL,PUBLISHED} 的条数与正文可取性；
 * 实际 = runtime_state 的 data.context 里出现 skill entry 的次数；缺口 = knowledge_gap 按 reason 计数。
 * 无数据 → UNKNOWN；有数据但 0 命中 → NOT_COVERED（0 不当通过）；只输出计数与指针，不含正文。
 */
function skillsRow(opts, streams) {
  const fs = require('fs');
  const path = require('path');
  const configDir = opts && opts.configDir;
  const out = { retrievable: 0, deliverableWithBody: 0, missingBody: 0, schemes: {}, actualEntries: 0,
    bodyMissing: 0, readFailed: 0, gaps: {}, pointers: [] };
  if (!configDir) return { verdict: 'UNKNOWN', detail: '未提供 configDir', data: out };
  let registryReadable = true;
  try {
    const lines = fs.readFileSync(path.join(configDir, 'skills.jsonl'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!['TRIAL', 'PUBLISHED'].includes(e.status)) continue;
      out.retrievable += 1;
      const ref = String(e.bodyRef || '');
      const scheme = ref.includes(':') ? ref.slice(0, ref.indexOf(':')) : 'none';
      out.schemes[scheme] = (out.schemes[scheme] || 0) + 1;
      if (!ref.startsWith('skill-body:')) { out.missingBody += 1; continue; }
      const body = path.join(configDir, 'skill-bodies', ref.substring('skill-body:'.length));
      if (fs.existsSync(body)) out.deliverableWithBody += 1; else out.missingBody += 1;
    }
    out.pointers.push('skills.jsonl');
  } catch { registryReadable = false; }
  const all = [];
  for (const [file, text] of [['events.jsonl', (streams && streams.events) || ''], ['rdd.jsonl', (streams && streams.rdd) || '']]) {
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (!t) continue;
      try { all.push({ o: JSON.parse(t), file, line: i + 1 }); } catch { /* 坏行跳过 */ }
    }
  }
  for (const r of all) {
    const d = r.o.data || {};
    if (String(r.o.type || '').includes('knowledge_gap')) {
      const reason = d.reason || 'unknown';
      out.gaps[reason] = (out.gaps[reason] || 0) + 1;
      // 与探针同口径：body-missing / read-failed 单列，便于直接看这两类缺口
      if (String(reason).includes('body-missing')) out.bodyMissing += 1;
      else if (String(reason).includes('read-failed')) out.readFailed += 1;
      continue;
    }
    const ctx = typeof d.context === 'string' ? d.context : '';
    if (ctx.includes('<entry ref="skill:')) {
      out.actualEntries += 1;
      out.pointers.push(r.file + ':' + r.line);
    }
  }
  if (!registryReadable) return { verdict: 'UNKNOWN', detail: 'skills.jsonl 不可读', data: out };
  if (out.retrievable === 0) return { verdict: 'UNKNOWN', detail: 'registry 里没有可检索技能', data: out };
  if (out.actualEntries === 0) return { verdict: 'NOT_COVERED', detail: '运行期上下文 0 条 skill entry（0 不算通过）', data: out };
  if (out.deliverableWithBody === 0) return { verdict: 'MISMATCH', detail: '有命中但正文都取不到', data: out };
  return { verdict: 'MATCH', detail: 'retrievable=' + out.retrievable + ' 命中=' + out.actualEntries + ' 可取正文=' + out.deliverableWithBody + ' bodyMissing=' + out.bodyMissing + ' readFailed=' + out.readFailed, data: out };
}
function build(card, streams, opts) {
  const rows = [];
  const push = (id, name, verdict, detail) => rows.push({ id, name, verdict, detail });

  // R1 why 交付
  const fr = card && card.finalRequest;
  if (!fr || fr.status === 'UNKNOWN' || !fr.total) push('R1', 'why 交付', 'UNKNOWN', '没有 final_request 事件');
  else if (fr.delivered && fr.delivered.split('/')[0] === fr.delivered.split('/')[1]) push('R1', 'why 交付', 'MATCH', fr.delivered);
  else push('R1', 'why 交付', 'MISMATCH', fr.delivered || '无交付数');

  // R2 结算核验
  const se = card && card.settle;
  const judged = se && se.coverage && se.coverage.judged;
  if (!se || se.status === 'UNKNOWN' || !judged) push('R2', '结算核验', 'UNKNOWN', '没有可判定的结算事件');
  else if (String(judged).split('/')[0] === String(judged).split('/')[1]) push('R2', '结算核验', 'MATCH', judged);
  else push('R2', '结算核验', 'MISMATCH', judged);

  // R3 knowledge_gap
  const ev = (streams && streams.events) || '';
  const rd = (streams && streams.rdd) || '';
  const gaps = [...parse(ev).rows, ...parse(rd).rows].filter(isGap);
  if (!gaps.length) push('R3', 'knowledge_gap', 'UNKNOWN', '没有 body-missing/read-failed 事件');
  else {
    const okShape = gaps.every((g) => g.data && (g.data.reason || g.data.gapReason));
    push('R3', 'knowledge_gap', okShape ? 'MATCH' : 'MISMATCH', 'gap 事件 ' + gaps.length + ' 条');
  }

  // R4 SIDE_CONTEXT 身份不符只允许 UNKNOWN
  const all = [...parse(ev).rows, ...parse(rd).rows];
  const side = all.filter((o) => /side_context/i.test(String(o.type || '')));
  if (!side.length) push('R4', 'SIDE_CONTEXT 身份', 'UNKNOWN', '没有 side context 事件');
  else {
    const claimedVerified = side.filter((o) => o.data && (o.data.identityVerified === true || o.data.status === 'PRESENT'));
    push('R4', 'SIDE_CONTEXT 身份', claimedVerified.length ? 'MISMATCH' : 'MATCH',
      claimedVerified.length ? '出现身份已验证声明（应为 UNKNOWN）' : '全部 UNKNOWN（符合预期）');
  }

  const r5 = skillsRow(opts, streams);
  rows.push({ id: 'R5', name: 'skills 检索', verdict: r5.verdict, detail: r5.detail, data: r5.data });
  const rank = { MISMATCH: 3, NOT_COVERED: 2, UNKNOWN: 1, MATCH: 0 };
  const overall = rows.reduce((worst, r) => (rank[r.verdict] > rank[worst] ? r.verdict : worst), 'MATCH');
  return { overall, rows };
}

module.exports = { build };