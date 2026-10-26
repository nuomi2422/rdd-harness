#!/usr/bin/env node
'use strict';
/**
 * exp-card.js —— RDD 实机验证的「实验卡」（机器可复算，2026-10-25）
 *
 * 为什么存在：实机验证卡（V-YYYYMMDD-NN）是给人看的九段记录；「怎么算通过」以前只活在
 * 卡文的自然语言里。本工具把 Agene 实验卡里真正有用的部分搬过来，落到 RDD 的验证环节：
 *   可证伪主张 + 事前冻结的成功/失败阈值 + 正负对照 + 采样数 + 确定性/种子
 *   + 预算/恢复 + 原始数据路径 + 机械复算。
 *
 * 铁律（与 Agene experiment.js 同源）：
 *   - 结论只由 measurement.source 指向的原始数据、按事前冻结的阈值与聚合方式复算；
 *   - 口头 claim 只作对照：与数据矛盾记 CLAIM_CONTRADICTS_DATA，数据赢；
 *   - 采样数 < repeats → INCONCLUSIVE（不制造显著性）；缺字段/坏行 → INCONCLUSIVE；
 *   - 冻结后改卡（hash 变了）→ 拒绝出结论，必须新建版本。
 *
 * 用法：
 *   node exp-card.js new <id> [--title "..."] [--vcard V-YYYYMMDD-NN]
 *   node exp-card.js validate <card.json>
 *   node exp-card.js freeze <card.json> [--commit <sha>] [--apply]     # 默认干跑
 *   node exp-card.js conclude <card.json> [--claim "..."] [--json]
 *   node exp-card.js list
 *   node exp-card.js selftest
 *
 * 退出码：0 通过/结论已出（SUPPORTS/REFUTES 都算正常出结论）/ 1 INCONCLUSIVE / 2 输入或冻结问题 / 3 环境错
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HARNESS = path.resolve(__dirname, '..');
const RDD_ROOT = path.resolve(HARNESS, '..', '..');
const CARD_DIR = path.join(HARNESS, 'experiments', 'cards');
const BT = String.fromCharCode(96);

const AGG = ['count', 'sum', 'mean', 'median', 'min', 'max', 'rate', 'exact'];
const OPS = ['>=', '<=', '==', '!=', '>', '<'];

function sha(x) { return crypto.createHash('sha256').update(Buffer.from(String(x), 'utf8')).digest('hex'); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }
function rel(p) { return path.relative(RDD_ROOT, p).replace(/\\\\/g, '/'); }
function resolveData(p) { return path.isAbsolute(p) ? p : path.join(RDD_ROOT, p); }

function canonical(obj) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) if (k !== 'generatedAt') o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}

function compare(v, op, target, tol) {
  const t = Number(tol) || 0;
  switch (op) {
    case '>=': return v >= target;
    case '<=': return v <= target;
    case '>': return v > target;
    case '<': return v < target;
    case '==': return Math.abs(v - target) <= t;
    case '!=': return Math.abs(v - target) > t;
    default: throw new Error('BAD_OPERATOR ' + op);
  }
}

function aggregate(values, mode) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (mode === 'count') return values.length;
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (mode === 'sum') return sum;
  if (mode === 'mean') return sum / nums.length;
  if (mode === 'min') return Math.min(...nums);
  if (mode === 'max') return Math.max(...nums);
  if (mode === 'median') { const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  if (mode === 'rate') return nums.filter((v) => v === 1 || v === true).length / nums.length;
  if (mode === 'exact') { const u = [...new Set(nums)]; return u.length === 1 ? u[0] : null; }
  return null;
}

function getPath(obj, dot) {
  if (!dot) return obj;
  let cur = obj;
  for (const k of String(dot).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function validateCard(card) {
  const errors = [];
  const warns = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  const spec = card || {};
  need(spec.apiVersion === 'rdd.experiment/v1', 'apiVersion 必须是 rdd.experiment/v1');
  need(typeof spec.id === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(spec.id), 'id 必须是 [a-z0-9.-] 且以字母数字开头');
  need(typeof spec.title === 'string' && spec.title.length >= 4, 'title 至少 4 字');
  need(typeof spec.claim === 'string' && spec.claim.length >= 10, 'claim（可证伪主张）至少 10 字');
  const f = spec.falsification || {};
  need(typeof f.successCondition === 'string' && f.successCondition.length >= 4, 'falsification.successCondition 必填');
  need(typeof f.failureCondition === 'string' && f.failureCondition.length >= 4, 'falsification.failureCondition 必填');
  need(typeof f.inconclusiveCondition === 'string' && f.inconclusiveCondition.length >= 4, 'falsification.inconclusiveCondition 必填');
  const c = spec.controls || {};
  for (const k of ['positive', 'negative']) {
    const v = c[k];
    need(typeof v === 'string' && v.trim().length >= 3, 'controls.' + k + ' 必填（可写 n/a: <理由>）');
    if (typeof v === 'string' && v.trim().toLowerCase().startsWith('n/a')) {
      const reason = v.includes(':') ? v.slice(v.indexOf(':') + 1).trim() : '';
      need(v.includes(':') && reason.length >= 8, 'controls.' + k + ' 写 n/a 必须给理由（≥8 字）');
    }
  }
  const m = spec.measurement || {};
  need(Array.isArray(m.dataFields) && m.dataFields.length >= 1, 'measurement.dataFields 至少 1 个字段');
  need(typeof m.dataPath === 'string' && m.dataPath.length >= 1 || (m.source && typeof m.source.path === 'string'), 'measurement.dataPath 或 source.path 必填');
  need(AGG.includes(m.aggregation), 'measurement.aggregation 必须是 ' + AGG.join('|'));
  need(Number.isInteger(m.repeats) && m.repeats >= 1, 'measurement.repeats 必须 ≥1');
  need(typeof m.stopRule === 'string' && m.stopRule.length >= 3, 'measurement.stopRule 必填');
  const pp = spec.preRegisteredProbes;
  if (pp !== undefined) {
    need(pp && typeof pp.ifNot === 'string' && pp.ifNot.trim().length >= 4,
      'preRegisteredProbes.ifNot 必填（预期不符时先查什么）');
    need(pp && Array.isArray(pp.probes) && pp.probes.length >= 1
      && pp.probes.every((x) => typeof x === 'string' && x.trim().length > 0),
      'preRegisteredProbes.probes 至少 1 个非空探针 id');
  } else {
    warns.push('preRegisteredProbes 未填：实验卡缺「若不符先查哪几个探针」');
  }
  const th = m.thresholds || {};
  for (const k of ['success', 'failure']) {
    const t = th[k] || {};
    need(OPS.includes(t.operator), 'thresholds.' + k + '.operator 必须是 ' + OPS.join('|'));
    need(typeof t.value === 'number' && Number.isFinite(t.value), 'thresholds.' + k + '.value 必须是数字');
  }
  if (th.success && th.failure && th.success.operator === th.failure.operator && th.success.value === th.failure.value) {
    errors.push('成功与失败阈值完全相同 → 判据自相矛盾（必须能区分）');
  }
  const d = spec.determinism || {};
  need(d.kind === 'deterministic' || d.kind === 'statistical', 'determinism.kind 必须是 deterministic|statistical');
  const rep = spec.replications || {};
  need(Number.isInteger(rep.N) && rep.N >= 1, 'replications.N 必须 ≥1');
  if (d.kind === 'statistical') {
    need(typeof d.seed === 'string' && d.seed.length >= 1, 'statistical 实验必须锁 seed（无法复现=不诚实）');
    need(rep.N >= 3, 'statistical 实验 N 必须 ≥3（单次是轶事）');
  }
  if (d.kind === 'deterministic' && rep.N === 1 && rep.deterministic !== true) warns.push('N=1 的确定性实验建议显式写 replications.deterministic=true');
  const p = spec.permissions || {};
  need(Number.isInteger(p.maxMinutes) && p.maxMinutes >= 1, 'permissions.maxMinutes 必须 ≥1');
  need(typeof p.recovery === 'string' && p.recovery.trim().length >= 10, 'permissions.recovery 必填（出问题怎么恢复，≥10 字）');
  if (p.irreversible === true) need(!/^(无|n\/a|none)$/i.test(String(p.recovery || '').trim()), '不可逆实验必须给真实恢复方案');
  if (p.maxMinutes > 120) warns.push('maxMinutes>120：长跑请单独预算');
  const src = m.source || {};
  need(['jsonl', 'json', 'runs-dir'].includes(src.kind), 'measurement.source.kind 必须是 jsonl|json|runs-dir');
  if (src.kind === 'jsonl' && src.filter && src.filter.op && !OPS.includes(src.filter.op)) errors.push('source.filter.op 非法');
  if (m.aggregation !== 'count') need(typeof src.value === 'string' && src.value.length >= 1, '聚合非 count 时必须给 source.value（点路径）');
  return { errors, warns };
}

/** 监控文件不是严格 ndjson：有些事件字符串里带真换行。按顶层花括号切对象（字符串/转义感知）。 */
function splitJsonObjects(text) {
  const out = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; if (start < 0) start = i; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

function loadRuns(src, opts) {
  const dir = resolveData(src.path);
  if (!fs.existsSync(dir)) return { records: [], error: 'SOURCE_MISSING ' + rel(dir) };
  const rows = [];
  for (const d of fs.readdirSync(dir)) {
    if (!d.startsWith('exp-')) continue;
    const envP = path.join(dir, d, 'envelope.json');
    const vP = path.join(dir, d, 'verdict.json');
    if (!fs.existsSync(envP) || !fs.existsSync(vP)) continue;
    const env = readJson(envP), v = readJson(vP);
    const jarSig = sha((env.jarsAtPrepare || []).map((j) => j.file + ':' + j.sha256).sort().join('\n')).slice(0, 16);
    const A = {};
    for (const a of v.assertions || []) A[a.id] = a.verdict;
    const wb = (env.world && env.world.before) || {};
    rows.push({ runId: d, label: env.label, createdAt: env.createdAt, jarSig, verdict: v.overall, assertions: A, watchSeconds: (env.timings && env.timings.watchSeconds) || null, controlKey: wb.control_key || null, stableKey: wb.stable_key || null, worldComplete: wb.complete === true });
  }
  let recs = rows;
  const m = src.match || {};
  if (Array.isArray(m.verdictIn)) recs = recs.filter((r) => m.verdictIn.includes(r.verdict));
  if (m.assertions) for (const [k, val] of Object.entries(m.assertions)) recs = recs.filter((r) => r.assertions[k] === val);
  if (m.sinceFreeze && opts && opts.frozenAt) recs = recs.filter((r) => r.createdAt && Date.parse(r.createdAt) >= Date.parse(opts.frozenAt));
  if (m.sameJarSig) {
    const sigs = [...new Set(recs.map((r) => r.jarSig))];
    if (sigs.length > 1) return { records: recs, error: 'MIXED_BUILD ' + sigs.join(',') + '（不是同一构建，不能算两轮）' };
  }
  return { records: recs };
}

function loadRecords(src) {
  const p = resolveData(src.path);
  if (!fs.existsSync(p)) return { records: [], error: 'SOURCE_MISSING ' + rel(p) };
  const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  let records = [];
  let bad = 0;
  if (src.kind === 'json') {
    try { const j = JSON.parse(text); records = Array.isArray(j) ? j : [j]; } catch { bad = 1; }
  } else {
    for (const objText of splitJsonObjects(text)) {
      try { records.push(JSON.parse(objText)); } catch { bad++; }
    }
  }
  if (bad) return { records, badLines: bad, error: 'BAD_LINES ' + bad };
  if (src.filter) {
    const { field, equals, op, value } = src.filter;
    records = records.filter((r) => {
      const v = getPath(r, field);
      if (equals !== undefined) return v === equals;
      if (op !== undefined) return typeof v === 'number' && compare(v, op, Number(value));
      return v !== undefined && v !== null;
    });
  }
  return { records };
}

function conclude(card, sidecarPath, claim) {
  const sidecar = fs.existsSync(sidecarPath) ? readJson(sidecarPath) : null;
  if (!sidecar) return { verdict: 'NOT_FROZEN', error: '实验卡未冻结：先跑 freeze --apply（判据必须先于证据）' };
  const nowSha = sha(canonical(card));
  if (nowSha !== sidecar.cardSha256) return { verdict: 'CARD_CHANGED', error: '冻结后卡片被改动（hash 不符）→ 必须新建版本，不能用旧冻结盖章' };
  const m = card.measurement;
  const src = m.source.kind === 'runs-dir' ? loadRuns(m.source, { frozenAt: sidecar.frozenAt }) : loadRecords(m.source);
  if (src.error) return { verdict: 'INCONCLUSIVE', error: src.error, samples: src.records.length };
  const records = src.records;
  if (records.length < m.repeats) return { verdict: 'INCONCLUSIVE', error: 'samples=' + records.length + ' < repeats=' + m.repeats + '（证据不足）', samples: records.length };
  let control = null;
  if (m.source.kind === 'runs-dir') {
    const keys = [...new Set(records.map((r) => r.controlKey || null))];
    control = { keys, comparable: keys.length === 1 && !!keys[0] };
    if (m.requireSameControl === true && !control.comparable) {
      return { verdict: 'INCONCLUSIVE', error: 'MIXED_CONTROL ' + keys.map((k) => k || 'null').join(','), samples: records.length, control };
    }
  }
  let values = records;
  if (m.aggregation !== 'count') {
    const missing = records.filter((r) => getPath(r, m.source.value) === undefined || getPath(r, m.source.value) === null);
    if (missing.length) return { verdict: 'INCONCLUSIVE', error: 'MISSING_FIELD ' + m.source.value + '（坏记录 ' + missing.length + ' 条，采集器不可信）', samples: records.length };
    values = records.map((r) => getPath(r, m.source.value));
  }
  const agg = aggregate(values.map((v) => (typeof v === 'string' && v !== '' && !isNaN(Number(v)) ? Number(v) : v)), m.aggregation);
  if (agg === null) return { verdict: 'INCONCLUSIVE', error: 'aggregation=' + m.aggregation + ' 得不到单一值（exact 不一致或无数值）', samples: records.length };
  const tol = m.tolerance || 0;
  const successHit = compare(agg, m.thresholds.success.operator, m.thresholds.success.value, tol);
  const failureHit = compare(agg, m.thresholds.failure.operator, m.thresholds.failure.value, tol);
  let verdict = successHit ? 'SUPPORTS' : failureHit ? 'REFUTES' : 'INCONCLUSIVE';
  let claimCheck = null;
  if (typeof claim === 'string' && claim.trim()) {
    const claimsSuccess = /(成功|通过|达成|有效|SUPPORTS|PASS)/i.test(claim);
    claimCheck = { claim, claimsSuccess, aligned: claimsSuccess === (verdict === 'SUPPORTS') };
    if (claimsSuccess && verdict !== 'SUPPORTS') claimCheck.code = 'CLAIM_CONTRADICTS_DATA';
  }
  return {
    verdict, samples: records.length, aggregation: m.aggregation, value: agg,
    thresholds: m.thresholds, tolerance: tol, claimCheck, control,
    source: { path: rel(resolveData(m.source.path)), kind: m.source.kind, filter: m.source.filter || null },
    frozen: { at: sidecar.frozenAt, cardSha256: sidecar.cardSha256, commit: sidecar.commit || null },
  };
}

const TEMPLATE = {
  apiVersion: 'rdd.experiment/v1',
  id: 'exp-YYYYMMDD-slug',
  title: '一句话：这次要证伪什么',
  vcard: 'V-YYYYMMDD-NN',
  claim: '可证伪主张（例如：同一构建下连续两轮冒烟 S3 世界增量≥4 且停止后 0 条新请求）',
  falsification: {
    successCondition: '什么结果算支持主张',
    failureCondition: '什么结果算推翻主张',
    inconclusiveCondition: '什么结果算证据不足（缺字段/样本不足）',
  },
  variables: { independent: ['改了什么'], dependent: ['测什么'], controlled: ['保持不变的'] },
  controls: { positive: '正对照：证明采集器能测到预期信号', negative: '负对照：证明判据能拒绝错误结果（或 n/a: 理由）' },
  preRegisteredProbes: {
    ifNot: '预期结果不符时先查哪些世界侧探针',
    probes: ['difficulty', 'gamerules', 'players'],
  },
  determinism: { kind: 'deterministic', seed: '' },
  replications: { N: 1, deterministic: true },
  measurement: {
    source: { kind: 'jsonl', path: 'mc/The Best of Twilight Forest/config/numen/monitor/context.jsonl', filter: { field: 'type', equals: 'budget_gate' }, value: 'data.trimmed' },
    dataFields: ['data.trimmed'],
    aggregation: 'count',
    repeats: 1,
    requireSameControl: true,
    stopRule: '只统计本次验证窗口内的记录',
    thresholds: { success: { operator: '>=', value: 1 }, failure: { operator: '<=', value: 0 } },
    tolerance: 0,
  },
  permissions: { scopes: ['读 monitor 证据'], maxMinutes: 10, irreversible: false, recovery: '不写任何游戏状态；失败只需重跑采集' },
  deviationsAllowed: false,
  notes: [],
};

function cmdNew(args) {
  const id = args[0];
  if (!id) { console.error('用法：new <id> [--title "..."] [--vcard V-...]'); process.exit(2); }
  const outPath = path.join(CARD_DIR, id + '.json');
  if (fs.existsSync(outPath)) { console.error('已存在：' + rel(outPath)); process.exit(2); }
  fs.mkdirSync(CARD_DIR, { recursive: true });
  const card = JSON.parse(JSON.stringify(TEMPLATE));
  card.id = id;
  const ti = args.indexOf('--title'); if (ti >= 0) card.title = args[ti + 1];
  const vi = args.indexOf('--vcard'); if (vi >= 0) card.vcard = args[vi + 1];
  fs.writeFileSync(outPath, JSON.stringify(card, null, 2) + '\n', 'utf8');
  console.log('已建卡：' + rel(outPath) + '\n填完 claim/controls/thresholds 后：node exp-card.js validate "' + outPath + '"');
}

function cmdValidate(args) {
  const f = args[0];
  if (!f) { console.error('用法：validate <card.json>'); process.exit(2); }
  const card = readJson(f);
  const { errors, warns } = validateCard(card);
  for (const w of warns) console.log('WARN ' + w);
  if (errors.length) { for (const e of errors) console.error('BLOCK ' + e); process.exit(2); }
  console.log('OK ' + card.id + '（可冻结）');
}

function cmdFreeze(args) {
  const f = args[0];
  if (!f) { console.error('用法：freeze <card.json> [--commit <sha>] [--apply]'); process.exit(2); }
  const card = readJson(f);
  const { errors } = validateCard(card);
  if (errors.length) { for (const e of errors) console.error('BLOCK ' + e); process.exit(2); }
  const sidecarPath = f.replace(/\.json$/, '.freeze.json');
  if (fs.existsSync(sidecarPath)) { console.error('已冻结过（不可原地改）：' + rel(sidecarPath) + '（要改判据就新建 id）'); process.exit(2); }
  const ci = args.indexOf('--commit');
  const commit = ci >= 0 ? args[ci + 1] : null;
  const payload = { cardSha256: sha(canonical(card)), frozenAt: new Date().toISOString(), commit, card: rel(path.resolve(f)) };
  if (!args.includes('--apply')) { console.log('干跑：将写入 ' + rel(sidecarPath) + '\n  cardSha256=' + payload.cardSha256 + '\n  commit=' + (commit || '(未填——冻结坐标缺失，postflight 会查)')); return; }
  fs.writeFileSync(sidecarPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log('已冻结：' + rel(sidecarPath) + '  sha=' + payload.cardSha256.slice(0, 16) + '…');
}

function cmdConclude(args) {
  const f = args[0];
  if (!f) { console.error('用法：conclude <card.json> [--claim "..."] [--json]'); process.exit(2); }
  const card = readJson(f);
  const { errors } = validateCard(card);
  if (errors.length) { for (const e of errors) console.error('BLOCK ' + e); process.exit(2); }
  const ci = args.indexOf('--claim');
  const claim = ci >= 0 ? args[ci + 1] : null;
  const r = conclude(card, f.replace(/\.json$/, '.freeze.json'), claim);
  const outPath = f.replace(/\.json$/, '.verdict.json');
  if (r.verdict !== 'NOT_FROZEN' && r.verdict !== 'CARD_CHANGED') fs.writeFileSync(outPath, JSON.stringify(r, null, 2) + '\n', 'utf8');
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); }
  else {
    console.log('# 实验结论 · ' + card.id);
    console.log('> ' + card.claim);
    console.log('| 项 | 值 |');
    console.log('|---|---|');
    console.log('| 结论 | **' + r.verdict + '** |');
    if (r.value !== undefined) console.log('| 复算值 | ' + r.aggregation + '=' + r.value + '（样本 ' + r.samples + '） |');
    if (r.thresholds) console.log('| 阈值 | 成功 ' + JSON.stringify(r.thresholds.success) + '；失败 ' + JSON.stringify(r.thresholds.failure) + ' |');
    if (r.source) console.log('| 数据 | ' + BT + r.source.path + BT + (r.source.filter ? '（filter ' + JSON.stringify(r.source.filter) + '）' : '') + ' |');
    if (r.frozen) console.log('| 冻结 | ' + r.frozen.at + ' ｜ sha ' + String(r.frozen.cardSha256).slice(0, 12) + '… ｜ commit ' + (r.frozen.commit || '未填') + ' |');
    if (r.claimCheck) console.log('| 口头 claim | ' + (r.claimCheck.aligned ? '与数据一致' : '**与数据矛盾**（CLAIM_CONTRADICTS_DATA，以数据为准）') + ' |');
    if (r.error) console.log('| 说明 | ' + r.error + ' |');
    if (r.verdict !== 'NOT_FROZEN' && r.verdict !== 'CARD_CHANGED') console.log('\n已写：' + rel(outPath));
  }
  process.exit(r.verdict === 'SUPPORTS' ? 0 : r.verdict === 'REFUTES' ? 0 : 1);
}

function cmdList() {
  if (!fs.existsSync(CARD_DIR)) { console.log('（还没有实验卡）'); return; }
  for (const f of fs.readdirSync(CARD_DIR).filter((x) => x.endsWith('.json') && !x.endsWith('.freeze.json') && !x.endsWith('.verdict.json'))) {
    const p = path.join(CARD_DIR, f);
    const card = readJson(p);
    const frozen = fs.existsSync(p.replace(/\.json$/, '.freeze.json'));
    const vp = p.replace(/\.json$/, '.verdict.json');
    const verdict = fs.existsSync(vp) ? readJson(vp).verdict : '-';
    console.log(f.replace(/\.json$/, '') + '  frozen=' + (frozen ? 'yes' : 'no') + '  verdict=' + verdict + '  ' + (card.title || ''));
  }
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-card-'));
  const mk = (over) => Object.assign(JSON.parse(JSON.stringify(TEMPLATE)), over);
  let pass = 0; const total = 14;
  const check = (name, cond, detail) => { if (cond) { pass++; console.log('  ✅ ' + name); } else console.log('  ❌ ' + name + ' — ' + (detail || '')); };

  const dataOk = path.join(tmp, 'data.json');
  const good = mk({ id: 'exp-test-good', claim: '测试主张：窗口内裁剪次数≥1', measurement: { source: { kind: 'json', path: dataOk, value: 'v' }, dataFields: ['v'], aggregation: 'count', repeats: 2, stopRule: '全量统计', thresholds: { success: { operator: '>=', value: 2 }, failure: { operator: '<=', value: 1 } }, tolerance: 0 } });
  check('合法卡通过校验', validateCard(good).errors.length === 0, JSON.stringify(validateCard(good).errors));

  const bad1 = JSON.parse(JSON.stringify(good)); bad1.id = 'exp-test-bad1'; bad1.measurement.thresholds.failure = { operator: '>=', value: 2 };
  check('阈值自相矛盾被拒', validateCard(bad1).errors.some((e) => e.includes('自相矛盾')));

  const bad2 = JSON.parse(JSON.stringify(good)); bad2.id = 'exp-test-bad2'; bad2.determinism = { kind: 'statistical', seed: 'x' }; bad2.replications = { N: 1 };
  check('统计实验 N=1 被拒', validateCard(bad2).errors.some((e) => e.includes('N 必须 ≥3')));

  const bad3 = JSON.parse(JSON.stringify(good)); bad3.id = 'exp-test-bad3'; bad3.determinism = { kind: 'statistical' }; bad3.replications = { N: 3 };
  check('统计实验无种子被拒', validateCard(bad3).errors.some((e) => e.includes('seed')));

  const bad4 = JSON.parse(JSON.stringify(good)); bad4.id = 'exp-test-bad4'; bad4.controls = { positive: 'n/a', negative: 'n/a: 无对照可用' };
  check('n/a 无理由被拒', validateCard(bad4).errors.some((e) => e.includes('必须给理由')));

  const bad5 = JSON.parse(JSON.stringify(good)); bad5.id = 'exp-test-bad5'; bad5.preRegisteredProbes = { ifNot: '不符时', probes: [] };
  check('预登记探针为空被拒', validateCard(bad5).errors.some((e) => e.includes('preRegisteredProbes.probes')));

  fs.writeFileSync(dataOk, JSON.stringify([{ v: 1 }, { v: 1 }]));
  fs.writeFileSync(path.join(tmp, 'good.freeze.json'), JSON.stringify({ cardSha256: sha(canonical(good)), frozenAt: 't', commit: 'abc' }));
  const r1 = conclude(good, path.join(tmp, 'good.freeze.json'), '测试完成');
  check('数据满足 → SUPPORTS', r1.verdict === 'SUPPORTS', JSON.stringify(r1));

  fs.writeFileSync(dataOk, JSON.stringify([{ v: 1 }]));
  check('样本不足 → INCONCLUSIVE', conclude(good, path.join(tmp, 'good.freeze.json')).verdict === 'INCONCLUSIVE');
  fs.writeFileSync(dataOk, JSON.stringify([{ v: 1 }, { v: 1 }]));

  fs.writeFileSync(dataOk, JSON.stringify([{ x: 1 }, { x: 2 }]));
  const sumCard = JSON.parse(JSON.stringify(good));
  sumCard.measurement.aggregation = 'sum';
  fs.writeFileSync(path.join(tmp, 'sum.freeze.json'), JSON.stringify({ cardSha256: sha(canonical(sumCard)), frozenAt: 't' }));
  check('缺字段 → INCONCLUSIVE', conclude(sumCard, path.join(tmp, 'sum.freeze.json')).verdict === 'INCONCLUSIVE');
  fs.writeFileSync(dataOk, JSON.stringify([{ v: 1 }, { v: 1 }]));

  const changed = JSON.parse(JSON.stringify(good)); changed.title = '偷偷改标题';
  check('冻结后改卡 → CARD_CHANGED', conclude(changed, path.join(tmp, 'good.freeze.json')).verdict === 'CARD_CHANGED');

  const failCard = JSON.parse(JSON.stringify(good));
  failCard.measurement.thresholds = { success: { operator: '>=', value: 5 }, failure: { operator: '<=', value: 2 } };
  fs.writeFileSync(path.join(tmp, 'fail.freeze.json'), JSON.stringify({ cardSha256: sha(canonical(failCard)), frozenAt: 't' }));
  const r5 = conclude(failCard, path.join(tmp, 'fail.freeze.json'), '这次实验成功了');
  check('claim 与数据矛盾 → REFUTES + 标记', r5.verdict === 'REFUTES' && r5.claimCheck && r5.claimCheck.code === 'CLAIM_CONTRADICTS_DATA');

  const runsDir = path.join(tmp, 'runs');
  const mkRun = (id, jar, at, verdict, controlKey, dir = runsDir) => {
    const d = path.join(dir, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'envelope.json'), JSON.stringify({ label: id, createdAt: at, jarsAtPrepare: [{ file: 'a.jar', sha256: jar }], world: { before: { control_key: controlKey || null } }, timings: { watchSeconds: 40 } }));
    fs.writeFileSync(path.join(d, 'verdict.json'), JSON.stringify({ overall: verdict, assertions: [{ id: 'S1', verdict: 'PASS' }, { id: 'S3', verdict: 'PASS' }, { id: 'S4', verdict: 'PASS' }] }));
  };
  mkRun('exp-r1', 'aaa', '2026-10-25T23:00:00Z', 'PASS');
  mkRun('exp-r2', 'aaa', '2026-10-25T23:10:00Z', 'PASS');
  const rc = mk({ id: 'exp-test-runs', claim: '两轮独立运行都通过（测试）', measurement: { source: { kind: 'runs-dir', path: runsDir, match: { verdictIn: ['PASS'], assertions: { S3: 'PASS', S4: 'PASS' }, sinceFreeze: true, sameJarSig: true } }, dataFields: ['runId'], aggregation: 'count', repeats: 1, requireSameControl: false, stopRule: '冻结后', thresholds: { success: { operator: '>=', value: 2 }, failure: { operator: '<=', value: 1 } }, tolerance: 0 } });
  fs.writeFileSync(path.join(tmp, 'runs.freeze.json'), JSON.stringify({ cardSha256: sha(canonical(rc)), frozenAt: '2026-10-25T22:00:00Z' }));
  check('runs-dir 两轮同构建→SUPPORTS', conclude(rc, path.join(tmp, 'runs.freeze.json')).verdict === 'SUPPORTS', JSON.stringify(conclude(rc, path.join(tmp, 'runs.freeze.json'))));

  mkRun('exp-r3', 'bbb', '2026-10-25T23:20:00Z', 'PASS');
  const rc2 = JSON.parse(JSON.stringify(rc));
  rc2.id = 'exp-test-runs2';
  fs.writeFileSync(path.join(tmp, 'runs2.freeze.json'), JSON.stringify({ cardSha256: sha(canonical(rc2)), frozenAt: '2026-10-25T22:00:00Z' }));
  check('runs-dir 混构建→INCONCLUSIVE', conclude(rc2, path.join(tmp, 'runs2.freeze.json')).verdict === 'INCONCLUSIVE');

  const ctrlDir = path.join(tmp, 'runs-ctrl');
  mkRun('exp-c1', 'ccc', '2026-10-25T23:30:00Z', 'PASS', 'v1|difficulty=easy|weather=clear', ctrlDir);
  mkRun('exp-c2', 'ccc', '2026-10-25T23:40:00Z', 'PASS', 'v1|difficulty=peaceful|weather=rain', ctrlDir);
  const rc3 = mk({ id: 'exp-test-control', claim: '两轮世界状态必须可比（测试）', measurement: { source: { kind: 'runs-dir', path: ctrlDir, match: { verdictIn: ['PASS'], sinceFreeze: true, sameJarSig: true } }, dataFields: ['runId'], aggregation: 'count', repeats: 1, requireSameControl: true, stopRule: '冻结后', thresholds: { success: { operator: '>=', value: 2 }, failure: { operator: '<=', value: 1 } }, tolerance: 0 } });
  fs.writeFileSync(path.join(tmp, 'ctrl.freeze.json'), JSON.stringify({ cardSha256: sha(canonical(rc3)), frozenAt: '2026-10-25T22:00:00Z' }));
  const ctrlVerdict = conclude(rc3, path.join(tmp, 'ctrl.freeze.json'));
  check('两轮 control_key 不同 → INCONCLUSIVE(MIXED_CONTROL)', ctrlVerdict.verdict === 'INCONCLUSIVE' && String(ctrlVerdict.error).startsWith('MIXED_CONTROL'), JSON.stringify(ctrlVerdict));

  console.log('\nselftest: ' + pass + '/' + total + ' 通过');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(pass === total ? 0 : 1);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1);
if (cmd === 'new') cmdNew(args);
else if (cmd === 'validate') cmdValidate(args);
else if (cmd === 'freeze') cmdFreeze(args);
else if (cmd === 'conclude') cmdConclude(args);
else if (cmd === 'list') cmdList();
else if (cmd === 'selftest') selftest();
else { console.error('usage: exp-card.js new|validate|freeze|conclude|list|selftest'); process.exit(2); }
