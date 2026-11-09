'use strict';
/**
 * evidence-verdict.js —— 把证据卡与事前截止"合成一条消费端结论"（2026-11-09，只读）
 *
 * 目的：避免读卡的人自己拼结论（"有数据=没问题"）。这里给一个**保守的**总判定，
 * 只允许在证据链齐全且未降级时给 PRESENT，否则明确说出"卡在哪"。
 *
 * 判定优先级：
 *   1. 有任何读取缺口/时间冲突/无时区 → UNKNOWN（连部分结论都不给）；
 *   2. 窗口过滤过 → 最多 PARTIAL；
 *   3. 身份不可归属（attributable !== PRESENT）→ UNKNOWN（无法判断是谁的）；
 *   4. 事前截止违规 → VIOLATION；
 *   5. 事前截止 UNKNOWN → UNKNOWN；
 *   6. 以上都过 → PRESENT（仅表示"这份证据在声明范围内自洽"，不代表业务成功）。
 */
function buildVerdict(card, preDeadline) {
  const reasons = [];
  const c = card || {};
  if (c.reasons && c.reasons.includes('log-gap')) reasons.push('log-gap');
  if (c.reasons && c.reasons.includes('time-conflict')) reasons.push('time-conflict');
  if (c.reasons && c.reasons.includes('timezone-ambiguous')) reasons.push('timezone-ambiguous');
  if (reasons.length) return { verdict: 'UNKNOWN', reasons };
  const filtered = !!(c.window && c.window.applied);
  const attributable = c.actions && c.actions.attributable;
  if (attributable !== 'PRESENT') reasons.push('identity-not-attributable');
  if (preDeadline) {
    if (preDeadline.status === 'VIOLATION') { reasons.push('evidence-after-use'); return { verdict: 'VIOLATION', reasons }; }
    if (preDeadline.status !== 'PRESENT') reasons.push('pre-deadline-' + String(preDeadline.status || 'UNKNOWN').toLowerCase());
  }
  if (reasons.includes('identity-not-attributable') || reasons.some((r) => r.startsWith('pre-deadline-'))) {
    return { verdict: 'UNKNOWN', reasons };
  }
  if (filtered) { reasons.push('window-filtered'); return { verdict: 'PARTIAL', reasons }; }
  return { verdict: 'PRESENT', reasons: ['self-consistent-within-declared-scope'] };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const card = (over) => ({ reasons: [], actions: { attributable: 'PRESENT' }, ...(over || {}) });
  ok(buildVerdict(card({ reasons: ['log-gap'] })).verdict === 'UNKNOWN', '①缺口 → UNKNOWN');
  ok(buildVerdict(card({ actions: { attributable: 'UNKNOWN' } })).verdict === 'UNKNOWN', '②身份不可归属 → UNKNOWN');
  ok(buildVerdict(card({ window: { applied: true } })).verdict === 'PARTIAL', '③窗口过滤 → PARTIAL');
  ok(buildVerdict(card(), { status: 'VIOLATION' }).verdict === 'VIOLATION', '④事前截止违规 → VIOLATION');
  ok(buildVerdict(card(), { status: 'UNKNOWN' }).verdict === 'UNKNOWN', '⑤事前截止未知 → UNKNOWN');
  ok(buildVerdict(card(), { status: 'PRESENT' }).verdict === 'PRESENT', '⑥全齐 → PRESENT');
  return fails;
}

module.exports = { buildVerdict, selftest };

if (require.main === module) {
  const fails = selftest();
  if (fails.length) { console.error('evidence-verdict selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
  console.log('evidence-verdict selftest PASS（6 组）');
}
