'use strict';
/**
 * noshot.js —— 读 H21 判别性观测（150 号 §6）的账。
 *
 * 输入只有两样：`evidence/tools.jsonl`（server-async 终态行里的 data.noshot）
 * 与可选的 `latest.log`（`[numen-attack] noshot {...}` 摘要行）。
 *
 * 它只做三件事：**列出每个攻击任务的六个数、判观测是否可信、把还缺什么写清楚**。
 * 它**不**替人三选一 —— A（未进入）/ B（进入后被复位）/ C（进入但不满 40）可以同时成立，
 * 报告必须把数摆全（150 §6.1）。
 *
 * 严格口径（150 §6.4）：
 *   只有 observerVersion 匹配**且** coverage=FULL 时，entered==0 才支持「未进入」；
 *   缺摘要 => UNKNOWN，既不当 0，也不当"未进入"。
 */

const EXPECTED_OBSERVER = 'h21-obs-2';
const GIVE_UP_TICKS = 40;

function parseLines(text) {
  const out = [];
  let bad = 0;
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o = null;
    try { o = JSON.parse(t); } catch { o = null; }
    if (o && typeof o === 'object') out.push(o); else bad++;
  }
  return { events: out, bad };
}

/** latest.log 里的摘要行：{observerVersion=h21-obs-2, coverage=FULL, entered=3, ...} */
function parseLogSummaries(logText) {
  const out = [];
  for (const line of String(logText || '').split('\n')) {
    const i = line.indexOf('[numen-attack] noshot');
    if (i < 0) continue;
    const start = line.indexOf('{', i);
    const end = line.lastIndexOf('}');
    if (start < 0 || end <= start) { out.push({ raw: line.slice(i).trim(), parsed: null }); continue; }
    const body = line.slice(start + 1, end);
    const obj = {};
    for (const part of body.split(',')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      obj[k] = /^-?\d+$/.test(v) ? Number(v) : v;
    }
    out.push({ raw: line.slice(i).trim(), parsed: obj });
  }
  return out;
}

/**
 * @param {string} toolsText
 * @param {string} [logText]
 * @param {{expectObserver?:string}} [opts]
 */
function analyze(toolsText, logText, opts) {
  const expect = (opts && opts.expectObserver) || EXPECTED_OBSERVER;
  const { events, bad } = parseLines(toolsText);
  const attackRows = events.filter((e) => e && e.data && e.data.tool === 'attack' && e.type === 'tool_result');
  // ★ 同一个 call 会写好几行：受理回执、client journal、server-async 终态。
  //   只有 server-async（或带 async_status）那行才是**终态**；把受理行也数成"缺摘要的任务"
  //   会凭空造出 PARTIAL_SUMMARY（2026-10-30 实测：1 个攻击任务被数成了 3 个）。
  const isTerminalRow = (e) => e.data.journaled_by === 'server-async' || typeof e.data.async_status === 'string';
  const byCall = new Map();
  for (const e of attackRows) {
    const id = e.data.tool_call_id || '(no-id)';
    const rec = byCall.get(id) || { rows: 0, terminal: null };
    rec.rows += 1;
    if (isTerminalRow(e)) rec.terminal = e;
    byCall.set(id, rec);
  }
  const callIds = [...byCall.keys()];
  const terminalRows = [...byCall.values()].filter((r) => r.terminal).map((r) => r.terminal);
  const withNoshot = terminalRows.filter((e) => e.data.noshot && typeof e.data.noshot === 'object');
  const logSums = parseLogSummaries(logText || '');

  const tasks = withNoshot.map((e) => {
    const n = e.data.noshot;
    return {
      callId: e.data.tool_call_id || '',
      asyncStatus: e.data.async_status || '',
      success: e.data.success === true,
      observerVersion: n.observerVersion || '',
      coverage: n.coverage || '',
      entered: numOrNull(n.entered),
      resetByTarget: numOrNull(n.resetByTarget),
      resetByShooter: numOrNull(n.resetByShooter),
      resetByInit: numOrNull(n.resetByInit),
      maxStreak: numOrNull(n.maxStreak),
      streakAtExit: numOrNull(n.streakAtExit),
      liveStreak: numOrNull(n.liveStreak),
      giveUpTicks: numOrNull(n.giveUpTicks),
      terminalReason: n.terminalReason || '',
      targetId: n.targetId === undefined ? null : n.targetId,
      scope: n.scope || '',
      message: String(e.data.result || '').slice(0, 120),
    };
  });

  // 观测可信性：这是全部结论的前提，先判它
  const reasons = [];
  let verdict;
  if (!callIds.length) {
    verdict = 'NO_ATTACK_TASK';
    reasons.push('这次 run 里没有 attack 任务（tools.jsonl 没有 attack 的 tool_result）——不可能判 H21');
  } else if (!terminalRows.length) {
    verdict = 'UNOBSERVED';
    reasons.push('有 ' + callIds.length + ' 次 attack 调用，但一条**终态**（server-async）都没有'
      + ' ⇒ 缺观测。**不得**读成「未进入分支」，只能记 UNKNOWN');
  } else if (!tasks.length) {
    verdict = 'UNOBSERVED';
    reasons.push('有 ' + terminalRows.length + ' 个 attack 终态，但没有任何一条带 noshot 摘要'
      + ' ⇒ 缺观测。**不得**读成「未进入分支」，只能记 UNKNOWN');
  } else {
    const badObs = tasks.filter((t) => t.observerVersion !== expect);
    const badCov = tasks.filter((t) => t.coverage !== 'FULL');
    if (badObs.length) {
      verdict = 'OBSERVER_MISMATCH';
      reasons.push(badObs.length + ' 个任务 observerVersion 不是 ' + expect + '（实得 '
        + [...new Set(badObs.map((t) => t.observerVersion || '(空)'))].join(',') + '）⇒ 观测代码没生效');
    } else if (badCov.length) {
      verdict = 'COVERAGE_PARTIAL';
      reasons.push(badCov.length + ' 个任务 coverage 不是 FULL（实得 '
        + [...new Set(badCov.map((t) => t.coverage || '(空)'))].join(',') + '）⇒ 不能据 entered==0 说「未进入」');
    } else if (tasks.length < terminalRows.length) {
      verdict = 'PARTIAL_SUMMARY';
      reasons.push(terminalRows.length + ' 个 attack 终态里只有 ' + tasks.length + ' 个带摘要 —— 其余任务的覆盖未知');
    } else {
      verdict = 'OBSERVED';
      reasons.push('全部 ' + tasks.length + ' 个攻击任务都带 ' + expect + ' 的摘要，coverage=FULL');
    }
  }

  const agg = {
    tasks: tasks.length,
    entered: sum(tasks.map((t) => t.entered)),
    resetByTarget: sum(tasks.map((t) => t.resetByTarget)),
    resetByShooter: sum(tasks.map((t) => t.resetByShooter)),
    resetByInit: sum(tasks.map((t) => t.resetByInit)),
    maxStreak: tasks.length ? Math.max(...tasks.map((t) => t.maxStreak || 0)) : null,
    terminalReasons: [...new Set(tasks.map((t) => t.terminalReason).filter(Boolean))],
  };

  // 解释清单：列出**所有**与数据相符的解释，不做三选一
  const plausible = [];
  if (verdict === 'OBSERVED') {
    if (agg.entered === 0) plausible.push('A 未进入过 aim==null（观测已启用且覆盖完整，才支持这一句）');
    if (agg.entered > 0 && (agg.resetByTarget + agg.resetByShooter) >= agg.entered * 0.5) {
      plausible.push('B 进入过但被复位（复位次数与进入次数同量级）');
    }
    if (agg.entered > 0 && agg.maxStreak !== null && agg.maxStreak < GIVE_UP_TICKS) {
      plausible.push('C 进入过但没到 ' + GIVE_UP_TICKS + ' tick（maxStreak=' + agg.maxStreak + '）');
    }
    if (agg.entered >= GIVE_UP_TICKS && (agg.resetByTarget + agg.resetByShooter) === 0) {
      plausible.push('D 连续进入且没复位 —— 放弃分支本应触发；若终态不是 FAILED，说明判据没走到');
    }
  }

  return {
    verdict,
    reasons,
    expectedObserver: expect,
    attackCalls: callIds.length,
    attackTerminals: terminalRows.length,
    summaries: tasks.length,
    logSummaryLines: logSums.length,
    logParsed: logSums.filter((s) => s.parsed).length,
    aggregate: agg,
    plausible,
    tasks,
    badToolsLines: bad,
    note: '三种解释可同时成立；本工具只摆数，不替你三选一（150 §6.1）',
  };
}

function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function sum(list) { const xs = list.filter((v) => typeof v === 'number'); return xs.length ? xs.reduce((a, b) => a + b, 0) : null; }

function render(r) {
  const L = [];
  L.push('H21 noshot 观测：' + r.verdict + '（期望 observerVersion=' + r.expectedObserver + '）');
  for (const why of r.reasons) L.push('  · ' + why);
  L.push('');
  L.push('  attack 调用=' + r.attackCalls + '  终态=' + r.attackTerminals + '  带摘要=' + r.summaries + '  latest.log 摘要行=' + r.logSummaryLines);
  if (r.summaries) {
    L.push('');
    L.push('  | callId | 终态 | entered | resetT | resetS | resetInit | maxStreak | exitStreak | terminal |');
    L.push('  |---|---|---|---|---|---|---|---|---|');
    for (const t of r.tasks) {
      L.push('  | ' + (t.callId || '—') + ' | ' + (t.asyncStatus || '—') + ' | ' + t.entered + ' | ' + t.resetByTarget
        + ' | ' + t.resetByShooter + ' | ' + t.resetByInit + ' | ' + t.maxStreak + ' | ' + t.streakAtExit
        + ' | ' + (t.terminalReason || '—') + ' |');
    }
    L.push('');
    L.push('  合计：entered=' + r.aggregate.entered + ' resetT=' + r.aggregate.resetByTarget
      + ' resetS=' + r.aggregate.resetByShooter + ' resetInit=' + r.aggregate.resetByInit
      + ' maxStreak=' + r.aggregate.maxStreak + ' 终态=' + (r.aggregate.terminalReasons.join(',') || '—'));
    if (r.plausible.length) {
      L.push('');
      L.push('  与数据相符的解释（可同时成立，不许只留一个）：');
      for (const p of r.plausible) L.push('   - ' + p);
    }
  }
  L.push('');
  L.push('  ★ 缺摘要 => UNKNOWN，不是「未进入」；entered==0 只有在观测已启用且 coverage=FULL 时才支持「未进入」。');
  return L.join('\n');
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const J = (o) => JSON.stringify(o);
  const row = (data) => J({ type: 'tool_result', data });

  const observed = [
    row({ tool: 'attack', tool_call_id: 'c1', journaled_by: 'server-async', async_status: 'failed', success: false, result: 'no feasible arrow shot',
      noshot: { observerVersion: 'h21-obs-2', coverage: 'FULL', entered: 12, resetByTarget: 0, resetByShooter: 0, resetByInit: 1, maxStreak: 11, streakAtExit: 11, giveUpTicks: 40, terminalReason: 'FAILED', targetId: 7, scope: 'named_ids:1' } }),
    row({ tool: 'attack', tool_call_id: 'c2', journaled_by: 'server-async', async_status: 'done', success: true, result: 'defeated 1/1',
      noshot: { observerVersion: 'h21-obs-2', coverage: 'FULL', entered: 0, resetByTarget: 0, resetByShooter: 0, resetByInit: 0, maxStreak: 0, streakAtExit: 0, giveUpTicks: 40, terminalReason: 'SUCCESS', targetId: 9, scope: 'named_ids:1' } }),
  ].join('\n');
  const r1 = analyze(observed, '');
  ok(r1.verdict === 'OBSERVED', '① 两条都有摘要 → OBSERVED（实得 ' + r1.verdict + '）');
  ok(r1.aggregate.entered === 12, '①b entered 合计 12（实得 ' + r1.aggregate.entered + '）');
  ok(r1.plausible.some((p) => p.startsWith('C')), '①c 应列 C（maxStreak=11<40）');
  ok(!r1.plausible.some((p) => p.startsWith('A')), '①d 不该列 A（entered≠0）');

  // ② 有 attack 但没有摘要 → UNOBSERVED，且绝不能出现 A
  const r2 = analyze(row({ tool: 'attack', tool_call_id: 'c3', journaled_by: 'server-async', async_status: 'timeout', success: false, result: 'attack timed out' }), '');
  ok(r2.verdict === 'UNOBSERVED', '② 缺摘要 → UNOBSERVED（实得 ' + r2.verdict + '）');
  ok(!r2.plausible.length, '②b 缺摘要时不许给任何解释');

  // ③ observerVersion 不对 → OBSERVER_MISMATCH
  const r3 = analyze(row({ tool: 'attack', tool_call_id: 'c4', journaled_by: 'server-async', noshot: { observerVersion: 'h21-obs-1', coverage: 'FULL', entered: 0 } }), '');
  ok(r3.verdict === 'OBSERVER_MISMATCH', '③ 旧观测版本 → OBSERVER_MISMATCH（实得 ' + r3.verdict + '）');

  // ④ coverage 不是 FULL → COVERAGE_PARTIAL，entered=0 也不能说「未进入」
  const r4 = analyze(row({ tool: 'attack', tool_call_id: 'c5', journaled_by: 'server-async', noshot: { observerVersion: 'h21-obs-2', coverage: 'PARTIAL', entered: 0 } }), '');
  ok(r4.verdict === 'COVERAGE_PARTIAL', '④ coverage 不完整 → COVERAGE_PARTIAL（实得 ' + r4.verdict + '）');
  ok(!r4.plausible.length, '④b 覆盖不完整时不许说「未进入」');

  // ⑤ 完全没有 attack → NO_ATTACK_TASK
  const r5 = analyze(row({ tool: 'goto', tool_call_id: 'c6', journaled_by: 'server-async' }), '');
  ok(r5.verdict === 'NO_ATTACK_TASK', '⑤ 没有攻击任务 → NO_ATTACK_TASK（实得 ' + r5.verdict + '）');

  // ⑥ latest.log 摘要行能解析
  const logs = '[13:00:01] [Server thread/INFO] [numen/]: [numen-attack] noshot {observerVersion=h21-obs-2, coverage=FULL, entered=7, resetByTarget=3, resetByShooter=2, resetByInit=0, maxStreak=5, streakAtExit=5, giveUpTicks=40, terminalReason=TIMEOUT}';
  const r6 = analyze('', logs);
  ok(r6.logSummaryLines === 1 && r6.logParsed === 1, '⑥ 日志摘要行解析（实得 ' + r6.logSummaryLines + '/' + r6.logParsed + '）');
  ok(r6.verdict === 'NO_ATTACK_TASK', '⑥b 只有日志、没有 tools.jsonl 行时仍判 NO_ATTACK_TASK（不冒充已观测）');

  // ⑦ 部分任务缺摘要 → PARTIAL_SUMMARY
  const r7 = analyze([
    row({ tool: 'attack', tool_call_id: 'c7', journaled_by: 'server-async', noshot: { observerVersion: 'h21-obs-2', coverage: 'FULL', entered: 1, maxStreak: 1, resetByTarget: 1, resetByShooter: 0, resetByInit: 0, terminalReason: 'FAILED' } }),
    row({ tool: 'attack', tool_call_id: 'c8', journaled_by: 'server-async', async_status: 'timeout' }),
  ].join('\n'), '');
  ok(r7.verdict === 'PARTIAL_SUMMARY', '⑦ 一个有一个没有 → PARTIAL_SUMMARY（实得 ' + r7.verdict + '）');

  console.log(fails.length
    ? 'noshot selftest FAIL: ' + fails.join(' | ')
    : 'noshot selftest PASS（7 组：观测启用/缺摘要/旧版本/覆盖不全/无攻击/日志解析/部分摘要）');
  return fails.length ? 1 : 0;
}

module.exports = { analyze, render, parseLogSummaries, selftest, EXPECTED_OBSERVER };

if (require.main === module) {
  if (process.argv[2] === 'selftest') process.exit(selftest());
  console.error('usage: noshot.js selftest');
  process.exit(2);
}
