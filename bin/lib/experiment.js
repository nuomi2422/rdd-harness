'use strict';
/**
 * experiment.js —— A7（99 号）实验对比与周指标。
 *
 * 只读 envelope，不重算事实。两条铁律：
 *   1. 条件不一致（目标/母版不同）或样本 <3 → `INCONCLUSIVE`，不许写「变好了」；
 *   2. 缺字段一律 `UNKNOWN`，不进分子也不进分母，**不补 0**。
 */

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function metricOf(env, name) {
  const a0 = env && env.a0 ? env.a0 : {};
  switch (name) {
    case 'deaths':
      return env && env.deaths && typeof env.deaths.count === 'number' ? env.deaths.count : null;
    case 'stalled':
      return num(a0.stalledSubtasks) !== null ? a0.stalledSubtasks : null;
    case 'minutes':
      return env && env.timings && typeof env.timings.watchSeconds === 'number'
        ? Math.round(env.timings.watchSeconds / 6) / 10 : null;
    case 'kept':
      return env && env.context_delivery && Array.isArray(env.context_delivery.kept.refs)
        ? env.context_delivery.kept.refs.length : null;
    case 'dropped':
      return env && env.context_delivery && Array.isArray(env.context_delivery.dropped.refs)
        ? env.context_delivery.dropped.refs.length : null;
    case 'delivered':
      return env && env.context_delivery && Array.isArray(env.context_delivery.delivered.refs)
        ? env.context_delivery.delivered.refs.length : null;
    case 'interventions':
      return env && env.interventions && typeof env.interventions.count === 'number'
        ? env.interventions.count : null;
    default:
      return null;
  }
}

const METRICS = ['deaths', 'stalled', 'minutes', 'kept', 'dropped', 'delivered', 'interventions'];

function goalOf(env) {
  return env && (env.goal || (env.stimulus && env.stimulus.goal) || env.label || '') || '';
}

function masterOf(env) {
  return env && env.master && env.master.sha256 ? env.master.sha256 : '';
}

/**
 * @returns {{verdict:string, reasons:string[], rows:Array, sample:{a:number,b:number}}}
 */
function compare(envA, envB) {
  const reasons = [];
  const ga = goalOf(envA);
  const gb = goalOf(envB);
  if (ga && gb && ga !== gb) reasons.push('goal-mismatch');
  const ma = masterOf(envA);
  const mb = masterOf(envB);
  if (ma && mb && ma !== mb) reasons.push('master-mismatch');

  const rows = METRICS.map((m) => {
    const a = metricOf(envA, m);
    const b = metricOf(envB, m);
    return { metric: m, a, b, delta: a !== null && b !== null ? Math.round((b - a) * 100) / 100 : null };
  });
  const verdict = reasons.length ? 'INCONCLUSIVE' : 'DIRECTIONAL';
  return { verdict, reasons, rows, sample: { a: 1, b: 1 } };
}

/**
 * 周指标：只统计给定 run 列表，缺字段 → UNKNOWN（不计入分母）。
 * @param {Array} envs
 */
function weekly(envs) {
  const list = Array.isArray(envs) ? envs.filter(Boolean) : [];
  const out = { runs: list.length, metrics: {} };
  if (!list.length) {
    out.metrics.deathRate = 'UNKNOWN';
    return out;
  }
  const sum = (f) => list.reduce((n, e) => n + (f(e) || 0), 0);
  const known = (f) => list.filter((e) => f(e) !== null).length;

  const deaths = list.reduce((n, e) => n + (metricOf(e, 'deaths') || 0), 0);
  const deathKnown = known((e) => metricOf(e, 'deaths'));
  const minutes = sum((e) => metricOf(e, 'minutes'));
  out.metrics.deaths = deathKnown === list.length ? deaths : { value: deaths, coverage: deathKnown + '/' + list.length };
  out.metrics.deathRatePer100min = minutes > 0 && deathKnown === list.length
    ? Math.round((deaths / minutes) * 100 * 100) / 100 : 'UNKNOWN';
  const kept = sum((e) => metricOf(e, 'kept'));
  const dropped = sum((e) => metricOf(e, 'dropped'));
  out.metrics.budgetDropRate = kept + dropped > 0 ? Math.round((dropped / (kept + dropped)) * 1000) / 10 : 'UNKNOWN';
  const inter = sum((e) => metricOf(e, 'interventions'));
  out.metrics.interventionsPerRun = Math.round((inter / list.length) * 100) / 100;
  out.metrics.stalledKnownRuns = known((e) => metricOf(e, 'stalled'));
  return out;
}

/**
 * 两臂多轮对比（A7 §2）：每臂 ≥3 轮才算一轮实验。
 * 中位数 + 极差；n<3 → INCONCLUSIVE；n>=5 且两臂区间不重叠才 SUPPORTED（保守，不做显著性检验）。
 * @param {Array} envsA
 * @param {Array} envsB
 */
function compareGroups(envsA, envsB) {
  const A = (envsA || []).filter(Boolean);
  const B = (envsB || []).filter(Boolean);
  const reasons = [];
  if (A.length < 3 || B.length < 3) reasons.push('sample<3');
  const goals = new Set([...A, ...B].map(goalOf).filter(Boolean));
  if (goals.size > 1) reasons.push('goal-mismatch');
  const masters = new Set([...A, ...B].map(masterOf).filter(Boolean));
  if (masters.size > 1) reasons.push('master-mismatch');

  const stat = (envs, m) => {
    const vals = envs.map((e) => metricOf(e, m)).filter((v) => v !== null).sort((x, y) => x - y);
    if (!vals.length) return { n: 0, median: null, min: null, max: null };
    const mid = Math.floor(vals.length / 2);
    const median = vals.length % 2 ? vals[mid] : Math.round(((vals[mid - 1] + vals[mid]) / 2) * 100) / 100;
    return { n: vals.length, median, min: vals[0], max: vals[vals.length - 1] };
  };

  const rows = METRICS.map((m) => ({ metric: m, a: stat(A, m), b: stat(B, m) }));
  let verdict = reasons.length ? 'INCONCLUSIVE' : 'DIRECTIONAL';
  if (!reasons.length && A.length >= 5 && B.length >= 5) {
    const disjoint = rows.every((r) => r.a.median === null || r.b.median === null
      || r.a.max < r.b.min || r.b.max < r.a.min);
    if (disjoint) verdict = 'SUPPORTED';
  }
  return { verdict, reasons, rows, sample: { a: A.length, b: B.length } };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const mk = (goal, deaths, kept, dropped, minutes) => ({
    goal, master: { sha256: 'm1' }, label: goal,
    deaths: { status: 'PRESENT', count: deaths },
    timings: { watchSeconds: (minutes || 0) * 60 },
    context_delivery: { kept: { refs: new Array(kept || 0).fill('x') }, dropped: { refs: new Array(dropped || 0).fill('x') }, delivered: { refs: [] } },
    interventions: { count: 0 },
    a0: {},
  });

  ok(compare(mk('A', 1, 2, 0, 1), mk('A', 0, 2, 0, 1)).verdict === 'DIRECTIONAL', '① 同目标同母版 → DIRECTIONAL');
  ok(compare(mk('A'), mk('B')).verdict === 'INCONCLUSIVE', '② 目标不同 → INCONCLUSIVE');
  ok(compare(mk('A'), { ...mk('A'), master: { sha256: 'm2' } }).verdict === 'INCONCLUSIVE', '③ 母版不同 → INCONCLUSIVE');

  const w = weekly([mk('A', 2, 1, 0, 10), mk('A', 0, 1, 1, 10)]);
  ok(w.metrics.deathRatePer100min === 10, '④ 10 分钟 1 死 ×2 = 10/100min，实得 ' + w.metrics.deathRatePer100min);
  ok(w.metrics.budgetDropRate === 33.3, '⑤ dropped 1 / (kept 2 + dropped 1) = 33.3，实得 ' + w.metrics.budgetDropRate);
  ok(weekly([]).metrics.deathRate === 'UNKNOWN', '⑥ 空样本 → UNKNOWN');

  const missing = { goal: 'A', context_delivery: null, timings: {}, master: {} };
  const w2 = weekly([missing]);
  ok(w2.metrics.deathRatePer100min === 'UNKNOWN', '⑦ 缺字段 → UNKNOWN（不补 0）');

  // ⑧ 两臂多轮：样本 <3 → INCONCLUSIVE；3 轮 → DIRECTIONAL；目标不同 → INCONCLUSIVE
  const g = (goal, d) => [mk(goal, d, 1, 0, 5), mk(goal, d, 1, 0, 5), mk(goal, d, 1, 0, 5)];
  ok(compareGroups(g('A', 1).slice(0, 2), g('A', 0)).verdict === 'INCONCLUSIVE', '⑧ 样本 <3 → INCONCLUSIVE');
  ok(compareGroups(g('A', 1), g('A', 0)).verdict === 'DIRECTIONAL', '⑨ 3 轮同向 → DIRECTIONAL');
  ok(compareGroups(g('A', 1), g('B', 0)).verdict === 'INCONCLUSIVE', '⑩ 目标不同 → INCONCLUSIVE');
  ok(compareGroups(g('A', 1), g('A', 0)).rows.find((r) => r.metric === 'deaths').a.median === 1, '⑪ 中位数计算');

  console.log(fails.length ? 'experiment selftest FAIL: ' + fails.join(' | ') : 'experiment selftest PASS（11 组）');
  return fails.length ? 1 : 0;
}

module.exports = { compare, compareGroups, weekly, selftest, METRICS, metricOf };

if (require.main === module) {
  if (process.argv[2] === 'selftest') process.exit(selftest());
  console.error('usage: experiment.js selftest');
  process.exit(2);
}
