#!/usr/bin/env node
'use strict';
/**
 * pit-ledger.js —— 坑账本：把散在两处（registry.timeLocks / workbench.tips）的"踩过的坑"
 * 合成一份**统一索引**，并给出可关闭的状态机。
 *
 * 为什么要有这份（2026-10-30）：
 *   19 个时间锁全部 open、最早的挂了 27 天；18 条 tips 也各有各的状态词（open/fixed/…）。
 *   两处格式不同、看到的地方不同，结果就是「清单只增不减」——
 *   每次出事往 registry 加一条锁，没人关，门禁里就多两行噪音，真的红灯被淹。
 *
 * ★ 本模块不改 registry、不改 workbench：它只**读**两处、生成一份索引 `pit-ledger.json`。
 *   真源仍在原处。想关一条坑 = 改本文件里的 status（见下），再 `bench pit build` 回写索引。
 *
 * 状态机（必须能关，否则等于没清单）：
 *   watching  还没修 / 还没判据 → 靠人记着（默认）
 *   guarded   已有机器判据（judge 命令非空）→ 已进某道门禁
 *   fixed     已修且有回归 → 不再进任何清单
 *   museum    长期没动也没判据 → 归档，默认不读
 *
 * ★ 准入规则（这是砍噪音的那一刀）：
 *   只有 canMachineJudge === true 且 judge 非空的坑，才允许升级成门禁判据；
 *   其余全部留在账本里给模型读，不占门禁位。
 *   `null` = 还没判定过，**不当作"能机器判"**。
 */

const fs = require('fs');
const path = require('path');

const HARNESS = path.resolve(__dirname, '..', '..');
const REGISTRY = path.join(HARNESS, 'registry.json');
const WORKBENCH = path.join(HARNESS, 'experiments', 'workbench.json');
const LEDGER = path.join(HARNESS, 'pit-ledger.json');

const STATUSES = ['watching', 'guarded', 'fixed', 'museum'];

/** 已知的机器判据。只写**真的跑过**的那条；没跑过就留 null，不许编命令。 */
const KNOWN_JUDGE = {
  'TL-2026-10-29-01': {
    canMachineJudge: true,
    judge: 'node bin/harness-gate.js selftest',
    judgeWhy: 'selftest 内 6 条 planner-entry 用例（PLANNED/goal_sink/BYPASSED/NO_CHAIN/NO_DATA/坏行不崩），事件名一改就 FAIL',
  },
  'TL-2026-10-30-01': {
    canMachineJudge: true,
    judge: 'node bin/harness-gate.js selftest',
    judgeWhy: '编号正则已放宽为三位号；P10/Q9 系列 selftest 覆盖',
  },
};

function readJson(p, label) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    const err = new Error('读不了 ' + label + '（' + p + '）：' + e.message);
    err.code = 'EPIT';
    throw err;
  }
}

/** 锁 → 账本条目 */
function fromLock(L) {
  const known = KNOWN_JUDGE[L.id] || {};
  return {
    id: L.id,
    source: 'timeLock',
    sourceRef: 'registry.json → timeLocks.locks',
    kind: L.class || null,
    title: L.title || '',
    detected: L.detected || null,
    symptom: L.title || '',
    fake: null,
    cause: L.rootCause || '',
    impact: L.impact || null,
    guard: L.guard || '',
    verifiedBy: L.verifiedBy || null,
    reviewBy: L.reviewBy || null,
    canMachineJudge: known.canMachineJudge === undefined ? null : known.canMachineJudge,
    judge: known.judge || null,
    judgeWhy: known.judgeWhy || null,
    status: L.status === 'open' ? 'watching' : (STATUSES.includes(L.status) ? L.status : 'watching'),
    link: null,
  };
}

/** tip → 账本条目 */
function fromTip(t) {
  const known = KNOWN_JUDGE[t.id] || {};
  return {
    id: t.id,
    source: 'tip',
    sourceRef: 'experiments/workbench.json → tips',
    kind: t.kind || null,
    title: t.symptom || '',
    detected: (t.added_at || '').slice(0, 10) || null,
    symptom: t.symptom || '',
    fake: t.fake || null,
    cause: t.cause || '',
    impact: null,
    guard: t.guard || '',
    verifiedBy: null,
    reviewBy: null,
    canMachineJudge: known.canMachineJudge === undefined ? null : known.canMachineJudge,
    judge: known.judge || null,
    judgeWhy: known.judgeWhy || null,
    status: t.status === 'open' ? 'watching' : (STATUSES.includes(t.status) ? t.status : 'watching'),
    link: t.link || null,
  };
}

/**
 * 生成索引。已存在的 ledger 里手改过的 status / judge / canMachineJudge 会被保留
 * （人工判定优先于自动推导）——否则每次 build 都会把手动关闭的坑又冲回 watching。
 */
function build(opts) {
  const o = opts || {};
  const reg = readJson(o.registry || REGISTRY, 'registry.json');
  const wb = readJson(o.workbench || WORKBENCH, 'workbench.json');
  const ledgerFile = o.ledger || LEDGER;

  let manual = new Map();
  if (fs.existsSync(ledgerFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
      for (const e of old.pits || []) {
        manual.set(e.id, { status: e.status, judge: e.judge, canMachineJudge: e.canMachineJudge, judgeWhy: e.judgeWhy, reviewBy: e.reviewBy });
      }
    } catch { /* 坏文件就当没有，重建 */ }
  }

  const locks = (reg.timeLocks && reg.timeLocks.locks) || [];
  const tips = wb.tips || [];
  const pits = locks.map(fromLock).concat(tips.map(fromTip));
  for (const p of pits) {
    const m = manual.get(p.id);
    if (!m) continue;
    for (const k of ['status', 'judge', 'canMachineJudge', 'judgeWhy', 'reviewBy']) {
      if (m[k] !== undefined && m[k] !== null) p[k] = m[k];
    }
  }
  pits.sort((a, b) => (a.source === b.source ? a.id.localeCompare(b.id) : a.source.localeCompare(b.source)));

  const counts = { total: pits.length, timeLock: locks.length, tip: tips.length };
  for (const s of STATUSES) counts[s] = pits.filter((p) => p.status === s).length;
  counts.gateEligible = pits.filter((p) => p.canMachineJudge === true && p.judge).length;

  const out = {
    schema: 1,
    updated_at: new Date().toISOString(),
    purpose: '坑账本：把 registry.timeLocks 与 workbench.tips 合成一份可关闭的索引。真源仍在原处，本文件是索引 + 状态。',
    policy: {
      admission: '只有 canMachineJudge===true 且 judge 非空的坑才允许升级成门禁判据；其余只进账本让模型读，不占门禁位。null=未判定，不当作"能机器判"。',
      close: 'watching→guarded（有 judge）/ fixed（已修且有回归）/ museum（长期没动且无判据）。必须能关，否则等于没清单。',
      manual: '本文件的 status/judge/canMachineJudge/reviewBy 人工改过会被 build 保留（人工优先）。',
    },
    counts,
    pits,
  };
  if (o.write !== false) fs.writeFileSync(ledgerFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}

function load(file) {
  return readJson(file || LEDGER, 'pit-ledger.json');
}

function list(opts) {
  const o = opts || {};
  const L = o.ledger ? readJson(o.ledger, 'pit-ledger.json') : load();
  let rows = L.pits || [];
  if (o.status) rows = rows.filter((p) => p.status === o.status);
  if (o.source) rows = rows.filter((p) => p.source === o.source);
  if (o.eligible) rows = rows.filter((p) => p.canMachineJudge === true && p.judge);
  return { counts: L.counts, rows, updated_at: L.updated_at };
}

function renderText(res) {
  const c = res.counts || {};
  const out = [];
  out.push('# 坑账本（pit-ledger）');
  out.push('共 ' + (c.total || 0) + ' 条：timeLock ' + (c.timeLock || 0) + ' / tip ' + (c.tip || 0) +
    '｜watching ' + (c.watching || 0) + ' · guarded ' + (c.guarded || 0) + ' · fixed ' + (c.fixed || 0) + ' · museum ' + (c.museum || 0) +
    '｜可进机器判据 ' + (c.gateEligible || 0));
  out.push('读法：node bin/bench.js pit [--status watching|guarded|fixed|museum] [--source timeLock|tip] [--eligible] [--json]');
  out.push('');
  for (const p of res.rows) {
    out.push('- [' + p.status + '] `' + p.id + '` ' + (p.title || ''));
    if (p.judge) out.push('    judge: ' + p.judge);
    if (p.guard) out.push('    护栏: ' + p.guard.slice(0, 160).replace(/\n/g, ' '));
  }
  if (!res.rows.length) out.push('（没有匹配的条目）');
  return out.join('\n');
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const reg = { timeLocks: { locks: [
    { id: 'X-1', title: 't1', class: 'c', rootCause: 'r', guard: 'g', reviewBy: '2026-12-01', status: 'open' },
    { id: 'X-2', title: 't2', guard: '', status: 'open' },
  ] } };
  const wb = { tips: [
    { id: 'T-1', kind: 'pitfall', symptom: 's1', fake: 'f', cause: 'c', guard: 'g', status: 'open' },
    { id: 'T-2', kind: 'win', symptom: 's2', guard: 'g', status: 'fixed' },
  ] };
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-'));
  const rf = path.join(dir, 'registry.json'); fs.writeFileSync(rf, JSON.stringify(reg));
  const wf = path.join(dir, 'workbench.json'); fs.writeFileSync(wf, JSON.stringify(wb));
  const lf = path.join(dir, 'pit-ledger.json');
  const L = build({ registry: rf, workbench: wf, ledger: lf });
  ok(L.counts.total === 4, '总数应为 4，实得 ' + L.counts.total);
  ok(L.counts.timeLock === 2 && L.counts.tip === 2, '来源计数错');
  ok(L.counts.watching === 3, 'open 应映射成 watching，实得 ' + L.counts.watching);
  ok(L.counts.fixed === 1, 'fixed 应保留，实得 ' + L.counts.fixed);
  ok(L.counts.gateEligible === 0, '没有 judge 时不许算可进门禁');
  ok(fs.existsSync(lf), 'ledger 应落盘');
  // 人工改状态后重建必须保留
  const old = JSON.parse(fs.readFileSync(lf, 'utf8'));
  old.pits.find((p) => p.id === 'X-2').status = 'museum';
  old.pits.find((p) => p.id === 'T-1').canMachineJudge = true;
  old.pits.find((p) => p.id === 'T-1').judge = 'node -e "process.exit(0)"';
  fs.writeFileSync(lf, JSON.stringify(old));
  const L2 = build({ registry: rf, workbench: wf, ledger: lf });
  ok(L2.pits.find((p) => p.id === 'X-2').status === 'museum', '人工 museum 必须被保留');
  ok(L2.counts.gateEligible === 1, '人工给 judge 后应算 1 条可进门禁，实得 ' + L2.counts.gateEligible);
  const filt = list({ ledger: lf, status: 'museum' });
  ok(filt.rows.length === 1 && filt.rows[0].id === 'X-2', 'status 过滤错');
  ok(/坑账本/.test(renderText(filt)), 'renderText 应输出标题');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails.length ? 'pit-ledger selftest FAIL: ' + fails.join(' | ') : 'pit-ledger selftest PASS（9 组）');
  return fails.length ? 1 : 0;
}

module.exports = { build, load, list, renderText, selftest, LEDGER, STATUSES };

if (require.main === module) {
  if (process.argv[2] === 'selftest') process.exit(selftest());
  console.error('usage: pit-ledger.js selftest');
  process.exit(2);
}
