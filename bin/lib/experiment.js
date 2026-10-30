'use strict';
/**
 * experiment.js —— A7（99 号）实验对比与周指标；151 号第一批「先修裁判」。
 *
 * 这个文件是**裁判**，不是统计平台。它唯一的职责是：在给定信封上，说清楚
 * 「能不能比、比出来是哪一档、还有哪些没看见」。五条铁律：
 *
 *   1. 缺字段 / status=UNKNOWN 一律返回 null（不可判），**绝不补 0**；
 *      「没发生」与「没记录」必须能分开 —— 这是 151 号 §2 的第一条。
 *   2. 没有任何可比较样本 => INSUFFICIENT（证据不足），**不许 DIRECTIONAL**。
 *   3. 场景/目标/母版/构建对不上、或取不到 => INCONCLUSIVE（不可比），不许当成「一致」。
 *   4. 单轮 compare 最高 DIRECTIONAL —— 单轮永远不是「已经变好」。
 *   5. SUPPORTED 必须有**预注册的主指标 + 方向**（prereg），否则封顶 DIRECTIONAL；
 *      「某些数不重叠」不是学习收益的证据。
 *
 * 信封真实形状（r39，2026-10-30）：
 *   contract.scenarioId / master.manifest.sha256 / jarsAtLaunch[{file,sha256}]
 *   deaths{status:'NONE'|'PRESENT'|'UNKNOWN',count}
 *   interventions{status,count,ids,byKind,entries}
 *   context_delivery{status, recalled{refs:null,refs_status:'AGGREGATE_ONLY'}, rendered{refs:[]},
 *                    kept{refs:[]}, dropped{refs:[]}, delivered{refs:[]}}
 *   a0{version,session_status,interventions_status,delivery_status,deaths_status}
 *
 * 预注册（可选，写在 envelope.prereg 或 contract.prereg）：
 *   { "metric": "deaths", "arm": "B", "direction": "LOWER" }
 *   => 期望 B 臂的 deaths 比 A 臂低，且两臂该指标区间不重叠、各 ≥5 份已知样本。
 */

/** 这些状态表示「取不到」，不是「等于零」。NONE / PRESENT 都算已知（NONE=观测到没有）。 */
const UNKNOWN_STATES = new Set([
  'UNKNOWN', 'MISSING', 'ERROR', 'NOT_COLLECTED', 'UNAVAILABLE', 'TIMEOUT', 'FAILED', 'ABORTED',
]);

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 取一个「状态容器」的状态。没有 status 字段的老信封按 PRESENT 算。 */
function stateOf(node) {
  if (!node || typeof node !== 'object') return 'MISSING';
  const s = typeof node.status === 'string' ? node.status.trim().toUpperCase() : '';
  return s || 'PRESENT';
}

function stateKnown(node) {
  return !UNKNOWN_STATES.has(stateOf(node));
}

/** refs 数组的长度；refs 为 null（聚合口径 AGGREGATE_ONLY）或缺字段 => null，不补 0。 */
function refsLen(delivery, key) {
  if (!delivery || typeof delivery !== 'object') return null;
  const node = delivery[key];
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.refs)) return node.refs.length;
  return null;
}

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

/**
 * 取一个指标的**可判值**：数字 = 已知；null = 不可判（缺字段 / UNKNOWN / 结构不对）。
 * @returns {number|null}
 */
function metricOf(env, name) {
  if (!env || typeof env !== 'object') return null;
  const a0 = env.a0 && typeof env.a0 === 'object' ? env.a0 : {};
  const cd = env.context_delivery;
  switch (name) {
    case 'deaths': {
      const d = env.deaths;
      if (!stateKnown(d)) return null;
      return typeof d.count === 'number' && Number.isFinite(d.count) ? d.count : null;
    }
    case 'stalled':
      return num(a0.stalledSubtasks);
    case 'minutes': {
      const t = env.timings;
      if (!t || typeof t !== 'object') return null;
      const s = num(t.watchSeconds);
      return s === null ? null : round1(s / 6) / 10; // 秒 -> 分钟，保留一位
    }
    case 'kept':
    case 'dropped':
    case 'delivered': {
      if (!cd || typeof cd !== 'object') return null;
      if (!stateKnown(cd)) return null; // context_delivery.status=UNKNOWN => 不可判
      return refsLen(cd, name);
    }
    case 'interventions': {
      const it = env.interventions;
      if (!stateKnown(it)) return null;
      return num(it.count);
    }
    default:
      return null;
  }
}

const METRICS = ['deaths', 'stalled', 'minutes', 'kept', 'dropped', 'delivered', 'interventions'];

function goalOf(env) {
  return (env && (env.goal || (env.stimulus && env.stimulus.goal) || env.label)) || '';
}

function scenarioOf(env) {
  if (!env) return '';
  if (env.contract && typeof env.contract.scenarioId === 'string') return env.contract.scenarioId;
  return typeof env.scenarioId === 'string' ? env.scenarioId : '';
}

/**
 * 151 §3：run 的用途。campaign=主线/长程，diagnostic=单问题探针，regression=不回退验证。
 * 没声明就是 unspecified —— 曲线默认不收它（诊断短局不能混进通关效率）。老信封一律 unspecified。
 */
const RUN_MODES = ['campaign', 'diagnostic', 'regression'];
function modeOf(env) {
  const m = env && env.mode;
  const k = typeof m === 'string' ? m : (m && typeof m.kind === 'string' ? m.kind : '');
  return RUN_MODES.includes(k) ? k : 'unspecified';
}

/** 持续学习 / 冷启动：只报声明，不猜。 */
function learningModeOf(env) {
  const l = env && env.learning;
  const k = l && typeof l.mode === 'string' ? l.mode : '';
  return k === 'continuous' || k === 'cold-start' ? k : 'unspecified';
}

function masterOf(env) {
  // P1-20261030：原来是 env.master.sha256 单一路径，取不到就返回 ''，
  // 而 '' 在 compareGroups 里既不算 mismatch 也不报错 —— 等于"不知道母版"被当成"母版一致"。
  // 真实 envelope 的母版哈希在 master.manifest.sha256。
  if (!env) return '';
  const m = env.master;
  if (typeof m === 'string') return m;
  if (m && m.manifest && typeof m.manifest.sha256 === 'string') return m.manifest.sha256;
  if (m && typeof m.sha256 === 'string') return m.sha256;
  if (env.prepare && typeof env.prepare.masterSha256 === 'string') return env.prepare.masterSha256;
  return '';
}

/** 实际部署制品指纹：jarsAtLaunch 的 file+sha256 排序后拼接；取不到 => ''。 */
function buildOf(env) {
  const jars = env && Array.isArray(env.jarsAtLaunch) ? env.jarsAtLaunch : null;
  if (!jars || !jars.length) return '';
  return jars
    .filter((j) => j && typeof j.file === 'string' && typeof j.sha256 === 'string')
    .map((j) => j.file + ':' + j.sha256)
    .sort()
    .join('|');
}

/** 预注册主指标与方向；字段不完整 => null（不猜）。 */
function preregOf(env) {
  const p = env && (env.prereg || (env.contract && env.contract.prereg));
  if (!p || typeof p !== 'object') return null;
  const metric = typeof p.metric === 'string' ? p.metric.trim() : '';
  const rawDir = typeof p.direction === 'string' ? p.direction.trim().toUpperCase() : '';
  const direction = ({ LOWER: 'LOWER', DOWN: 'LOWER', DECREASE: 'LOWER', HIGHER: 'HIGHER', UP: 'HIGHER', INCREASE: 'HIGHER' })[rawDir] || '';
  const arm = p.arm === 'A' || p.arm === 'B' ? p.arm : 'B';
  if (!METRICS.includes(metric) || !direction) return null;
  return { metric, arm, direction };
}

/**
 * 单轮对比：只说「方向是否一致」，从不说「变好了」。
 * @returns {{verdict:string, reasons:string[], notes:string[], rows:Array, sample:{a:number,b:number}, prereg:object|null}}
 */
function compare(envA, envB) {
  const reasons = [];
  const notes = [];

  const ga = goalOf(envA);
  const gb = goalOf(envB);
  if (!ga || !gb) reasons.push('goal-unknown');
  else if (ga !== gb) reasons.push('goal-mismatch');

  const ma = masterOf(envA);
  const mb = masterOf(envB);
  if (!ma || !mb) reasons.push('master-unknown');
  else if (ma !== mb) reasons.push('master-mismatch');

  const sa = scenarioOf(envA);
  const sb = scenarioOf(envB);
  if (sa && sb && sa !== sb) reasons.push('scenario-mismatch');
  else if (!sa || !sb) notes.push('scenario-unknown');

  const moa = modeOf(envA);
  const mob = modeOf(envB);
  if (moa !== 'unspecified' && mob !== 'unspecified' && moa !== mob) reasons.push('mode-mismatch');
  else if (moa === 'unspecified' || mob === 'unspecified') notes.push('mode-unknown');

  const ba = buildOf(envA);
  const bb = buildOf(envB);
  if (ba && bb && ba !== bb) reasons.push('build-mismatch');
  else if (!ba || !bb) notes.push('build-unknown');

  const prereg = preregOf(envA) || preregOf(envB);
  if (!prereg) notes.push('prereg-missing');

  const rows = METRICS.map((m) => {
    const a = metricOf(envA, m);
    const b = metricOf(envB, m);
    return { metric: m, a, b, delta: a !== null && b !== null ? round2(b - a) : null };
  });

  const comparable = rows.filter((r) => r.a !== null && r.b !== null);
  const oneSided = rows.filter((r) => (r.a !== null) !== (r.b !== null)).map((r) => r.metric);
  if (oneSided.length) notes.push('metric-one-sided:' + oneSided.join(','));

  let verdict;
  if (!comparable.length) {
    reasons.push('all-metrics-no-samples'); // 两臂都空 / 都 UNKNOWN
    verdict = 'INSUFFICIENT';
  } else if (reasons.length) {
    verdict = 'INCONCLUSIVE';
  } else {
    verdict = 'DIRECTIONAL';
    notes.push('single-round'); // 单轮不是「改善」，只是方向性观察
  }

  return {
    verdict,
    reasons,
    notes,
    rows,
    sample: { a: 1, b: 1 },
    comparable: comparable.map((r) => r.metric),
    prereg,
  };
}

/**
 * 周指标：只统计给定 run 列表；缺字段 → UNKNOWN，**不进分子也不进分母**。
 * 分子与分母必须来自同一个「都已知」的样本集合（151 §2：缺时间不能算完整死亡率）。
 *
 * 151 §3：默认只收 `mode=campaign` —— 诊断短局与回归局不混进通关/作弊曲线。
 * 要全量看一眼就传 `{ includeAll: true }`，但要记得那不是一条可比曲线。
 * @param {Array} envs
 * @param {{mode?:string, includeAll?:boolean}} [opts]
 */
function weekly(envs, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const wantMode = RUN_MODES.includes(o.mode) ? o.mode : 'campaign';
  const all = Array.isArray(envs) ? envs.filter(Boolean) : [];
  const byMode = { campaign: 0, diagnostic: 0, regression: 0, unspecified: 0 };
  for (const e of all) byMode[modeOf(e)] += 1;
  const list = o.includeAll ? all : all.filter((e) => modeOf(e) === wantMode);
  const get = (e, m) => metricOf(e, m);
  const knownFor = (m) => list.filter((e) => get(e, m) !== null);
  const cov = (m) => knownFor(m).length + '/' + list.length;
  const sumKnown = (m) => knownFor(m).reduce((n, e) => n + get(e, m), 0);

  const out = {
    runs: list.length,
    totalRuns: all.length,
    mode: o.includeAll ? 'all' : wantMode,
    excluded: { n: all.length - list.length, byMode },
    metrics: {},
    coverage: {},
  };
  for (const m of METRICS) out.coverage[m] = cov(m);
  out.metrics.stalledKnownRuns = knownFor('stalled').length;

  // 和：全知 -> 数字；一台都不知 -> UNKNOWN；部分 -> {value, coverage}（已知小计，不假装是总数）
  const total = (m) => {
    const n = knownFor(m).length;
    if (!list.length || n === 0) return 'UNKNOWN';
    if (n === list.length) return sumKnown(m);
    return { value: sumKnown(m), coverage: n + '/' + list.length };
  };

  out.metrics.deaths = total('deaths');
  out.metrics.interventions = total('interventions');

  // 死亡率：deaths 与 minutes 都已知的同一批 run 才算；不是全部已知 => UNKNOWN
  const rateSet = list.filter((e) => get(e, 'deaths') !== null && get(e, 'minutes') !== null);
  const rateMinutes = rateSet.reduce((n, e) => n + get(e, 'minutes'), 0);
  out.metrics.deathRateBasis = rateSet.length + '/' + list.length;
  out.metrics.deathRatePer100min = (list.length && rateSet.length === list.length && rateMinutes > 0)
    ? round2((rateSet.reduce((n, e) => n + get(e, 'deaths'), 0) / rateMinutes) * 100)
    : 'UNKNOWN';

  // 预算丢弃率：kept 与 dropped 都已知的同一批 run
  const dropSet = list.filter((e) => get(e, 'kept') !== null && get(e, 'dropped') !== null);
  const kept = dropSet.reduce((n, e) => n + get(e, 'kept'), 0);
  const dropped = dropSet.reduce((n, e) => n + get(e, 'dropped'), 0);
  out.metrics.budgetDropBasis = dropSet.length + '/' + list.length;
  out.metrics.budgetDropRate = (list.length && dropSet.length === list.length && kept + dropped > 0)
    ? round1((dropped / (kept + dropped)) * 100)
    : 'UNKNOWN';

  // 每局介入：分母只算**已知**样本；一台都没有就是 UNKNOWN
  const interKnown = knownFor('interventions').length;
  out.metrics.interventionsPerRun = interKnown > 0
    ? round2(sumKnown('interventions') / interKnown)
    : 'UNKNOWN';
  out.metrics.interventionsCoverage = interKnown + '/' + list.length;
  return out;
}

function medianOf(vals) {
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : round2((vals[mid - 1] + vals[mid]) / 2);
}

/**
 * 两臂多轮对比（A7 §2）：每臂 ≥3 轮才算一轮实验。
 * 中位数 + 极差；n<3 → INCONCLUSIVE；无从比较 → INSUFFICIENT；
 * SUPPORTED 需 n≥5、每个可比较指标两臂各≥5 份已知样本且区间不重叠，**并且**有预注册主指标+方向。
 * @param {Array} envsA
 * @param {Array} envsB
 */
function compareGroups(envsA, envsB) {
  const A = (envsA || []).filter(Boolean);
  const B = (envsB || []).filter(Boolean);
  const all = [...A, ...B];
  const reasons = [];
  const notes = [];

  if (A.length < 3 || B.length < 3) reasons.push('sample<3');

  const goals = new Set(all.map(goalOf).filter(Boolean));
  if (!goals.size) reasons.push('goal-unknown');
  else if (goals.size > 1) reasons.push('goal-mismatch');

  const masters = new Set(all.map(masterOf).filter(Boolean));
  if (!masters.size) reasons.push('master-unknown');
  else if (masters.size > 1) reasons.push('master-mismatch');

  const scenarios = new Set(all.map(scenarioOf).filter(Boolean));
  if (scenarios.size > 1) reasons.push('scenario-mismatch');
  else if (!scenarios.size) notes.push('scenario-unknown');

  // 151 §3：诊断/回归/主线不是同一类局，混着比就是拿排障短局当通关曲线
  const declaredModes = all.map(modeOf);
  const modes = new Set(declaredModes.filter((m) => m !== 'unspecified'));
  if (modes.size > 1) reasons.push('mode-mismatch');
  if (declaredModes.some((m) => m === 'unspecified')) notes.push('mode-unknown');

  const builds = new Set(all.map(buildOf).filter(Boolean));
  if (builds.size > 1) reasons.push('build-mismatch');
  else if (!builds.size) notes.push('build-unknown');

  // 预注册：多份不一致 => 不可比；一份都没有 => 封顶 DIRECTIONAL
  const preregs = all.map(preregOf).filter(Boolean);
  const preregKeys = new Set(preregs.map((p) => p.metric + '/' + p.arm + '/' + p.direction));
  let prereg = preregs[0] || null;
  if (preregKeys.size > 1) { reasons.push('prereg-conflict'); prereg = null; }
  if (!prereg) notes.push('prereg-missing');

  const stat = (envs, m) => {
    const vals = envs.map((e) => metricOf(e, m)).filter((v) => v !== null).sort((x, y) => x - y);
    if (!vals.length) return { n: 0, median: null, min: null, max: null };
    return { n: vals.length, median: medianOf(vals), min: vals[0], max: vals[vals.length - 1] };
  };

  const rows = METRICS.map((m) => ({ metric: m, a: stat(A, m), b: stat(B, m) }));
  const comparable = rows.filter((r) => r.a.n > 0 && r.b.n > 0);
  const oneSided = rows.filter((r) => (r.a.n > 0) !== (r.b.n > 0)).map((r) => r.metric);
  if (oneSided.length) notes.push('metric-one-sided:' + oneSided.join(','));
  if (!comparable.length) reasons.push('all-metrics-no-samples');

  let verdict;
  if (!comparable.length) {
    verdict = 'INSUFFICIENT';
  } else if (reasons.length) {
    verdict = 'INCONCLUSIVE';
  } else {
    verdict = 'DIRECTIONAL';
    if (A.length >= 5 && B.length >= 5) {
      const enough = comparable.every((r) => r.a.n >= 5 && r.b.n >= 5);
      if (!enough) {
        reasons.push('metric-sample<5');
        verdict = 'INSUFFICIENT';
      } else if (!prereg) {
        // 没有预注册就不许把「区间不重叠」升级成「支持」——151 §2
        notes.push('no-prereg=>ceiling-DIRECTIONAL');
      } else {
        // 只看**主指标**是否分离且方向相符：其余指标方向未预注册，不能拿它们的区间去凑支持。
        const prim = rows.find((r) => r.metric === prereg.metric);
        const primDisjoint = prim && prim.a.n >= 5 && prim.b.n >= 5
          && (prim.a.max < prim.b.min || prim.b.max < prim.a.min);
        const primLower = prereg.direction === 'LOWER';
        const primOk = prim && prim.a.median !== null && prim.b.median !== null && (prereg.arm === 'B'
          ? (primLower ? prim.b.median < prim.a.median : prim.b.median > prim.a.median)
          : (primLower ? prim.a.median < prim.b.median : prim.a.median > prim.b.median));
        if (!prim || prim.a.n < 5 || prim.b.n < 5) {
          reasons.push('primary-metric-underpowered');
          verdict = 'INSUFFICIENT';
        } else if (!primDisjoint) {
          reasons.push('primary-not-disjoint');
          verdict = 'INCONCLUSIVE';
        } else if (!primOk) {
          reasons.push('primary-direction-contrary');
          verdict = 'INCONCLUSIVE';
        } else {
          verdict = 'SUPPORTED';
          // 其余可比较指标照实报出来，供人复核是否被副作用污染（不参与判定）
          const others = comparable.filter((r) => r.metric !== prereg.metric);
          if (others.length) notes.push('primary-only:' + prereg.metric + ';others=' + others.map((r) => r.metric).join(','));
        }
      }
    }
  }

  return {
    verdict,
    reasons,
    notes,
    rows,
    comparable: comparable.map((r) => r.metric),
    prereg,
    sample: { a: A.length, b: B.length },
  };
}

// ── 自测：既有口径 + 审计反例 + 真实信封形状 ─────────────────────────────
function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };

  /** 造一封「形状接近真实信封」的样本：contract/master/jars/status 都在。 */
  const mk = (goal, deaths, kept, dropped, minutes, extra) => Object.assign({
    goal,
    label: goal,
    mode: { kind: 'campaign', source: 'flag' },
    learning: { mode: 'cold-start' },
    contract: { scenarioId: 'unit-scenario', revision: 'T-r1' },
    master: { world: 'w', manifest: { count: 148, sha256: 'm1' } },
    jarsAtLaunch: [{ file: 'numen.jar', sha256: 'j1' }],
    deaths: { status: 'NONE', count: deaths || 0, entries: [], reasons: [] },
    timings: { watchSeconds: (minutes || 0) * 60 },
    interventions: { status: 'NONE', count: 0, ids: [], byKind: {}, entries: [] },
    context_delivery: {
      status: 'PRESENT',
      recalled: { snapshots: 1, entriesAggregate: 2, refs: null, refs_status: 'AGGREGATE_ONLY' },
      rendered: { events: 0, refs: [] },
      kept: { refs: new Array(kept || 0).fill('x') },
      delivered: { refs: new Array(kept || 0).fill('x') },
      dropped: { refs: new Array(dropped || 0).fill('x') },
    },
    a0: { version: 'a0-v1', session_status: 'CLEAN', deaths_status: 'NONE' },
  }, extra || {});

  // ①–③ 既有口径
  ok(compare(mk('A', 1, 2, 0, 1), mk('A', 0, 2, 0, 1)).verdict === 'DIRECTIONAL', '① 同目标同母版 → DIRECTIONAL');
  ok(compare(mk('A'), mk('B')).verdict === 'INCONCLUSIVE', '② 目标不同 → INCONCLUSIVE');
  ok(compare(mk('A'), mk('A', 0, 0, 0, 0, { master: { manifest: { sha256: 'm2' } } })).verdict === 'INCONCLUSIVE',
    '③ 母版不同 → INCONCLUSIVE');

  // ④–⑦ 周指标
  const w = weekly([mk('A', 2, 1, 0, 10), mk('A', 0, 1, 1, 10)]);
  ok(w.metrics.deathRatePer100min === 10, '④ 10 分钟 1 死 ×2 = 10/100min，实得 ' + w.metrics.deathRatePer100min);
  ok(w.metrics.budgetDropRate === 33.3, '⑤ dropped 1 / (kept 2 + dropped 1) = 33.3，实得 ' + w.metrics.budgetDropRate);
  ok(weekly([]).metrics.deaths === 'UNKNOWN', '⑥ 空样本 → UNKNOWN');
  const w2 = weekly([{ goal: 'A', context_delivery: null, timings: {}, master: {} }]);
  ok(w2.metrics.deathRatePer100min === 'UNKNOWN', '⑦ 缺字段 → UNKNOWN（不补 0）');

  // ⑧–⑪ 两臂多轮
  const g = (goal, d) => [mk(goal, d, 1, 0, 5), mk(goal, d, 1, 0, 5), mk(goal, d, 1, 0, 5)];
  ok(compareGroups(g('A', 1).slice(0, 2), g('A', 0)).verdict === 'INCONCLUSIVE', '⑧ 样本 <3 → INCONCLUSIVE');
  ok(compareGroups(g('A', 1), g('A', 0)).verdict === 'DIRECTIONAL', '⑨ 3 轮同向 → DIRECTIONAL');
  ok(compareGroups(g('A', 1), g('B', 0)).verdict === 'INCONCLUSIVE', '⑩ 目标不同 → INCONCLUSIVE');
  ok(compareGroups(g('A', 1), g('A', 0)).rows.find((r) => r.metric === 'deaths').a.median === 1, '⑪ 中位数计算');

  // ⑫–⑭ 审计反例（P1-20261030）
  const empty5 = [{}, {}, {}, {}, {}];
  const r12 = compareGroups(empty5, empty5);
  ok(r12.verdict !== 'SUPPORTED', '⑫ 两臂各5份空数据 → 不许 SUPPORTED（实得 ' + r12.verdict + '）');
  ok(r12.verdict === 'INSUFFICIENT', '⑫b 两臂各5份空数据 → 应为 INSUFFICIENT（实得 ' + r12.verdict + '）');
  const one4 = (goal) => [mk(goal, 1, 1, 0, 5), {}, {}, {}, {}];
  ok(compareGroups(one4('A'), one4('A')).verdict !== 'SUPPORTED', '⑬ 1有效+4空 → 不许 SUPPORTED');
  const m5 = (goal, sha, d) => [1, 2, 3, 4, 5].map(() => mk(goal, d, 1, 0, 5, { master: { manifest: { sha256: sha } } }));
  ok(compareGroups(m5('A', 'mA', 1), m5('A', 'mB', 0)).verdict !== 'SUPPORTED', '⑭ 母版不同 → 不许 SUPPORTED');

  // ⑮ 无介入数据不得算 0
  const w3 = weekly([mk('A', 0, 1, 0, 1, { interventions: null })]);
  ok(w3.metrics.interventionsPerRun === 'UNKNOWN',
    '⑮ 无介入数据 → interventionsPerRun 必须是 UNKNOWN（实得 ' + w3.metrics.interventionsPerRun + '）');
  ok(w3.metrics.interventionsCoverage === '0/1', '⑮b 覆盖率应为 0/1（实得 ' + w3.metrics.interventionsCoverage + '）');

  // ── 151 §2 反例（本批新增）─────────────────────────────────────────────
  // ⑯ 单轮两个空对象：不得 DIRECTIONAL
  const c16 = compare({}, {});
  ok(c16.verdict === 'INSUFFICIENT',
    '⑯ compare({},{}) 应为 INSUFFICIENT（实得 ' + c16.verdict + '）');
  ok(c16.reasons.includes('all-metrics-no-samples'), '⑯b 应报 all-metrics-no-samples（实得 ' + c16.reasons.join(',') + '）');

  // ⑰ context_delivery 字段缺失/空心：不得抛错，也不得补 0
  let c17 = null;
  try { c17 = metricOf({ context_delivery: {} }, 'kept'); } catch (e) { c17 = 'THROW:' + e.message; }
  ok(c17 === null, '⑰ metricOf({context_delivery:{}}) 应为 null 且不抛错（实得 ' + c17 + '）');
  ok(metricOf({ context_delivery: { kept: {} } }, 'kept') === null, '⑰b kept 无 refs → null');
  ok(metricOf({ context_delivery: { kept: { refs: null } } }, 'kept') === null, '⑰c refs=null（聚合口径）→ null，不补 0');
  ok(metricOf({ context_delivery: { status: 'UNKNOWN' } }, 'kept') === null, '⑰d status=UNKNOWN → null');

  // ⑱ status=UNKNOWN + count=0：生产失败分支的真实形状，不得当成「0 次死亡 / 0 次介入」
  const unknownShape = {
    goal: 'A', contract: { scenarioId: 's' }, master: { manifest: { sha256: 'm1' } },
    deaths: { status: 'UNKNOWN', count: 0 },
    interventions: { status: 'UNKNOWN', count: 0 },
    context_delivery: { status: 'UNKNOWN' },
    timings: { watchSeconds: 60 },
  };
  ok(metricOf(unknownShape, 'deaths') === null, '⑱ status=UNKNOWN 的 deaths 必须不可判（实得 ' + metricOf(unknownShape, 'deaths') + '）');
  ok(metricOf(unknownShape, 'interventions') === null, '⑱b status=UNKNOWN 的 interventions 必须不可判');
  const w18 = weekly([unknownShape]);
  ok(w18.metrics.deaths === 'UNKNOWN', '⑱c 全是 UNKNOWN → deaths 应为 UNKNOWN（实得 ' + JSON.stringify(w18.metrics.deaths) + '）');
  ok(w18.metrics.interventionsPerRun === 'UNKNOWN', '⑱d interventionsPerRun 应为 UNKNOWN');

  // ⑲ 真实信封形状（r39 的字段布局，含 recalled.refs=null / rendered.refs=[] / status=NONE）
  const real = () => ({
    runId: 'exp-loop-r39-20261030-114944',
    goal: '观测投送是否到达',
    contract: { scenarioId: 'live-log-delivery', revision: 'SMOKE-r1', sha256: '8544dd' },
    master: { world: 'exp-loop-r39-114945', manifest: { count: 148, sha256: '0400fc' } },
    jarsAtLaunch: [{ file: 'numen-neoforge-1.21.1-0.1.3-dev.jar', sha256: '4234aa' }],
    timings: { watchSeconds: 62 },
    deaths: { status: 'NONE', count: 0, entries: [], reasons: [] },
    interventions: { count: 0, ids: [], status: 'NONE', byKind: {}, entries: [], rejected: [], duplicatesDropped: 0 },
    context_delivery: {
      status: 'PRESENT',
      recalled: { snapshots: 6, entriesAggregate: 42, refs: null, refs_status: 'AGGREGATE_ONLY' },
      rendered: { events: 0, autoEvents: 0, refs: [], note: 'auto_expanded 只报 hits，不含 ref' },
      kept: { refs: new Array(9).fill('k') },
      delivered: { events: 9, refs: new Array(9).fill('d') },
      dropped: { refs: [], count: 0, reasons: [], source: 'budget' },
      truncated: { refs: [], count: 0 },
    },
    a0: { version: 'a0-v1', session_status: 'CLEAN', interventions_status: 'NONE', delivery_status: 'PRESENT', deaths_status: 'NONE' },
  });
  ok(metricOf(real(), 'kept') === 9, '⑲ 真实信封 kept=9（实得 ' + metricOf(real(), 'kept') + '）');
  ok(metricOf(real(), 'deaths') === 0, '⑲b 真实信封 status=NONE + count=0 是「已知的零」（实得 ' + metricOf(real(), 'deaths') + '）');
  ok(metricOf(real(), 'stalled') === null, '⑲c a0.stalledSubtasks 缺失 → null');
  const c19 = compare(real(), real());
  ok(c19.verdict === 'DIRECTIONAL', '⑲d 同一封真实信封对比自己 → DIRECTIONAL 且不崩（实得 ' + c19.verdict + '）');

  // ⑳ 场景/构建不同 => 不可比
  ok(compare(mk('A'), mk('A', 0, 0, 0, 0, { contract: { scenarioId: 'other' } })).verdict === 'INCONCLUSIVE',
    '⑳ 场景不同 → INCONCLUSIVE');
  ok(compare(mk('A'), mk('A', 0, 0, 0, 0, { jarsAtLaunch: [{ file: 'numen.jar', sha256: 'j2' }] })).verdict === 'INCONCLUSIVE',
    '⑳b 构建不同 → INCONCLUSIVE');

  // ㉑ 预注册：没有 prereg 时 5v5 区间不重叠也只能 DIRECTIONAL；有且方向相符才 SUPPORTED；方向相反 → INCONCLUSIVE
  const five = (goal, d) => [1, 2, 3, 4, 5].map((i) => mk(goal, d + i, 1, 0, 5));
  const noPre = compareGroups(five('A', 5), five('A', 0));
  ok(noPre.verdict !== 'SUPPORTED', '㉑a 无预注册 → 不许 SUPPORTED（实得 ' + noPre.verdict + '）');
  ok(noPre.notes.includes('no-prereg=>ceiling-DIRECTIONAL') || noPre.verdict === 'DIRECTIONAL',
    '㉑b 无预注册应封顶 DIRECTIONAL 并留 note（实得 ' + noPre.verdict + ' / ' + noPre.notes.join(',') + '）');
  const withPre = (goal, d, dir) => five(goal, d).map((e) => Object.assign(e, { prereg: { metric: 'deaths', arm: 'B', direction: dir } }));
  ok(compareGroups(withPre('A', 5, 'LOWER'), withPre('A', 0, 'LOWER')).verdict === 'SUPPORTED',
    '㉑c 有预注册且方向相符 → SUPPORTED');
  ok(compareGroups(withPre('A', 5, 'HIGHER'), withPre('A', 0, 'HIGHER')).verdict === 'INCONCLUSIVE',
    '㉑d 预注册方向相反 → INCONCLUSIVE');

  // ㉒ 部分覆盖：只标 known/total，不假装是总数
  const w22 = weekly([mk('A', 2, 1, 0, 10), { goal: 'A', mode: { kind: 'campaign' }, contract: { scenarioId: 'unit-scenario' }, master: { manifest: { sha256: 'm1' } } }]);
  ok(w22.metrics.deaths && w22.metrics.deaths.coverage === '1/2',
    '㉒ 缺一半样本 → deaths 标 1/2（实得 ' + JSON.stringify(w22.metrics.deaths) + '）');
  ok(w22.metrics.deathRatePer100min === 'UNKNOWN', '㉒b 缺一半时间 → 死亡率 UNKNOWN（不拿半份算率）');

  // ── 151 §3 运行模式反例（第二批）─────────────────────────────────────────
  // ㉓ 周指标默认只收 campaign：诊断短局不能混进通关效率曲线
  const diag = mk('A', 0, 1, 0, 1, { mode: { kind: 'diagnostic', source: 'flag' } });
  const reg = mk('A', 0, 1, 0, 1, { mode: { kind: 'regression', source: 'flag' } });
  const w23 = weekly([mk('A', 1, 1, 0, 10), diag, reg]);
  ok(w23.runs === 1, '㉓ 默认只收 campaign（实得 runs=' + w23.runs + '）');
  ok(w23.excluded && w23.excluded.n === 2 && w23.excluded.byMode.diagnostic === 1 && w23.excluded.byMode.regression === 1,
    '㉓b 排除计数要按 mode 分开（实得 ' + JSON.stringify(w23.excluded) + '）');
  const w23b = weekly([mk('A', 1, 1, 0, 10), diag, reg], { includeAll: true });
  ok(w23b.runs === 3 && w23b.mode === 'all', '㉓c includeAll 收全量（实得 runs=' + w23b.runs + ' mode=' + w23b.mode + '）');
  // 没声明 mode 的老信封：默认不进曲线，且被计进 unspecified
  const w23c = weekly([{ goal: 'A', contract: { scenarioId: 's' }, master: { manifest: { sha256: 'm1' } }, deaths: { status: 'NONE', count: 1 } }]);
  ok(w23c.runs === 0 && w23c.excluded.byMode.unspecified === 1,
    '㉓d 未声明 mode → 不进曲线（实得 runs=' + w23c.runs + ' / ' + JSON.stringify(w23c.excluded) + '）');

  // ㉔ 诊断局与主线局直接比：不可比
  const c24 = compare(mk('A', 1, 1, 0, 5), mk('A', 0, 1, 0, 5, { mode: { kind: 'diagnostic', source: 'flag' } }));
  ok(c24.verdict === 'INCONCLUSIVE' && c24.reasons.includes('mode-mismatch'),
    '㉔ campaign vs diagnostic → INCONCLUSIVE + mode-mismatch（实得 ' + c24.verdict + '/' + c24.reasons.join(',') + '）');
  const g24 = compareGroups([1, 2, 3].map(() => mk('A', 1, 1, 0, 5)),
    [1, 2, 3].map(() => mk('A', 0, 1, 0, 5, { mode: { kind: 'diagnostic', source: 'flag' } })));
  ok(g24.reasons.includes('mode-mismatch'), '㉔b 两臂多轮混 mode → mode-mismatch');

  console.log(fails.length
    ? 'experiment selftest FAIL: ' + fails.join(' | ')
    : 'experiment selftest PASS（24 组：既有口径 + 审计反例 + 151 反例 + 真实信封形状 + 运行模式）');
  return fails.length ? 1 : 0;
}

module.exports = {
  compare, compareGroups, weekly, selftest, METRICS, metricOf,
  goalOf, masterOf, scenarioOf, buildOf, preregOf, stateOf,
  modeOf, learningModeOf, RUN_MODES,
};

if (require.main === module) {
  if (process.argv[2] === 'selftest') process.exit(selftest());
  console.error('usage: experiment.js selftest');
  process.exit(2);
}
