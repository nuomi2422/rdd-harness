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
  // P1-20261030：原来是 env.master.sha256 单一路径，取不到就返回 ''，
  // 而 '' 在 compareGroups 里既不算 mismatch 也不报错 —— 等于"不知道母版"被当成"母版一致"。这是假绿的来源之一。
  if (!env) return '';
  const m = env.master;
  if (typeof m === 'string') return m;
  // 真实 envelope 的母版哈希在 master.manifest.sha256（148 files）。
  // 旧代码只读 master.sha256 => 恒 undefined => 所有 run 的母版都算空
  // => "母版不同"永远检测不到，这是审计复现出的假绿机制。
  if (m && m.manifest && typeof m.manifest.sha256 === 'string') return m.manifest.sha256;
  if (m && typeof m.sha256 === 'string') return m.sha256;
  if (env.prepare && typeof env.prepare.masterSha256 === 'string') return env.prepare.masterSha256;
  return '';
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
  // P1-20261030（审计反例）：原来 inter / list.length，缺数据时得 0，等于"没有介入"。
  // 现在分母只算**已知**样本；一台都没有就是 UNKNOWN，并单独报覆盖率。
  const interKnown = known((e) => metricOf(e, 'interventions'));
  out.metrics.interventionsPerRun = interKnown > 0
    ? Math.round((inter / interKnown) * 100) / 100 : 'UNKNOWN';
  out.metrics.interventionsCoverage = interKnown + '/' + list.length;
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

  // P1-20261030（审计反例）：原实现里 "median === null" 会让 disjoint 判定**跳过**该指标，
  // 于是五份空数据 / 每臂只有 1 份有效样本，都能被判成 SUPPORTED。
  // 现在：任一臂某指标一台样本都没有 => 该指标整体不可判 => INSUFFICIENT，绝不 SUPPORTED。
  // P1-20261030（审计反例）：原实现把 "median === null" 当作"不冲突"跳过去，
  // 于是五份空数据 / 每臂 1 份有效样本都能判成 SUPPORTED。
  //
  // 现在的规则：
  //   - 只比较「两臂都有样本」的指标（单边有、另一边没有 => 不可比，单独记 reason）；
  //   - 一个可比较指标都没有 => INSUFFICIENT，绝不 SUPPORTED；
  //   - SUPPORTED 还要求两臂各 >=5 份、且每个可比较指标在两臂都 >=5 份已知样本、区间不重叠。
  const comparable = rows.filter((r) => r.a.n > 0 && r.b.n > 0);
  const oneSided = rows.filter((r) => (r.a.n > 0) !== (r.b.n > 0)).map((r) => r.metric);
  if (oneSided.length) reasons.push('metric-one-sided:' + oneSided.join(','));
  if (!comparable.length) reasons.push('all-metrics-no-samples');

  // 母版/目标未知也不许当"一致"
  if (![...A, ...B].map(masterOf).filter(Boolean).length) reasons.push('master-unknown');
  if (![...A, ...B].map(goalOf).filter(Boolean).length) reasons.push('goal-unknown');

  let verdict = reasons.length ? 'INCONCLUSIVE' : 'DIRECTIONAL';
  if (!comparable.length) verdict = 'INSUFFICIENT';

  if (!reasons.length && A.length >= 5 && B.length >= 5) {
    const enough = comparable.every((r) => r.a.n >= 5 && r.b.n >= 5);
    const disjoint = comparable.every((r) => r.a.max < r.b.min || r.b.max < r.a.min);
    if (enough && disjoint) verdict = 'SUPPORTED';
    else if (!enough) { reasons.push('metric-sample<5'); verdict = 'INSUFFICIENT'; }
  }
  return { verdict, reasons, rows, comparable: comparable.map((r) => r.metric), sample: { a: A.length, b: B.length } };
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

  // ---- P1-20261030 审计反例（修复前这三条会全绿，正是假绿）----
  // 反例 ⑫ 两臂各 5 份**空**记录：旧实现 disjoint 把 null 当"不冲突"跳过去 => SUPPORTED。
  const empty5 = [{}, {}, {}, {}, {}];
  const r12 = compareGroups(empty5, empty5);
  ok(r12.verdict !== 'SUPPORTED', '⑫ 两臂各5份空数据 → 不许 SUPPORTED（实得 ' + r12.verdict + '）');
  ok(r12.verdict === 'INSUFFICIENT', '⑫b 两臂各5份空数据 → 应为 INSUFFICIENT（实得 ' + r12.verdict + '）');

  // 反例 ⑬ 每臂 1 份有效 + 4 份空：旧实现每臂 n=1 也能判 SUPPORTED。
  const one4 = (g) => [mk(g, 1, 1, 0, 5), {}, {}, {}, {}];
  const r13 = compareGroups(one4('A'), [mk('A', 0, 1, 0, 5), {}, {}, {}, {}]);
  ok(r13.verdict !== 'SUPPORTED', '⑬ 1有效+4空 → 不许 SUPPORTED（实得 ' + r13.verdict + '）');

  // 反例 ⑭ 两臂母版不同：不许 SUPPORTED。
  const m5 = (g, sha, d) => [1, 2, 3, 4, 5].map(() => Object.assign(mk(g, d, 1, 0, 5), { master: { sha256: sha } }));
  const r14 = compareGroups(m5('A', 'mA', 1), m5('A', 'mB', 0));
  ok(r14.verdict !== 'SUPPORTED', '⑭ 母版不同 → 不许 SUPPORTED（实得 ' + r14.verdict + '）');

  // 反例 ⑮ 没有介入数据：不许算成 0 次介入。
  const w3 = weekly([{ goal: 'A', deaths: { status: 'PRESENT', count: 0 }, timings: { watchSeconds: 60 }, context_delivery: null }]);
  ok(w3.metrics.interventionsPerRun === 'UNKNOWN',
    '⑮ 无介入数据 → interventionsPerRun 必须是 UNKNOWN（实得 ' + w3.metrics.interventionsPerRun + '）');
  ok(w3.metrics.interventionsCoverage === '0/1', '⑮b 覆盖率应为 0/1（实得 ' + w3.metrics.interventionsCoverage + '）');

  console.log(fails.length ? 'experiment selftest FAIL: ' + fails.join(' | ') : 'experiment selftest PASS（16 组，含 4 组审计反例）');
  return fails.length ? 1 : 0;
}

module.exports = { compare, compareGroups, weekly, selftest, METRICS, metricOf };

if (require.main === module) {
  if (process.argv[2] === 'selftest') process.exit(selftest());
  console.error('usage: experiment.js selftest');
  process.exit(2);
}
