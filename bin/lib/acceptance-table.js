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

function build(card, streams) {
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

  const overall = rows.some((r) => r.verdict === 'MISMATCH') ? 'MISMATCH'
    : rows.some((r) => r.verdict === 'UNKNOWN') ? 'UNKNOWN' : 'MATCH';
  return { overall, rows };
}

module.exports = { build };
