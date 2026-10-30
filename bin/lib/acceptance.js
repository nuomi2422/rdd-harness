'use strict';
/**
 * acceptance.js —— 151 号第三批「一个入口、一张表」的执行核心。
 *
 * 它不做实验、不改代码、不连游戏：只回答一个问题——**这件事现在能不能算验过**。
 * 要求清单在 experiments/acceptance.json；每项要求挂 0..n 个检查，检查只有三种：
 *
 *   cmd     跑一条离线命令，exit 0 才算 PASS（例如 regress / 各 lib 的自测）
 *   file    看一份证据文件是否存在；可要求「与当前部署同版本」（jarsAtLaunch 指纹）
 *   manual  需要实机或人工判据 —— 机器**永远不会**给 PASS，只报 NOT_RUN
 *
 * 状态集合（与 151 §4 对齐）：
 *   PASS / FAIL / NOT_RUN / UNKNOWN / VERSION_MISMATCH / STALE
 *
 * 铁律：
 *   1. 必验项只要不是 PASS，整张表就不许显示完成（overall=INCOMPLETE）；
 *   2. 「效果等级」（PILOT / DIRECTIONAL / SUPPORTED）不参与工程验收，另列一行说明；
 *   3. 改码/换 jar 之后，旧证据只能标 VERSION_MISMATCH —— 不是 PASS，也不是 FAIL；
 *   4. 表里每一格都要能追到文件或命令，禁止手写「通过」。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_RUN: 'NOT_RUN',
  UNKNOWN: 'UNKNOWN',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  STALE: 'STALE',
};

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 与 exp-runner 同口径：file:sha256 排序拼接。 */
function fingerprint(jars) {
  if (!Array.isArray(jars) || !jars.length) return '';
  return jars
    .filter((j) => j && typeof j.file === 'string' && typeof j.sha256 === 'string')
    .map((j) => j.file + ':' + j.sha256)
    .sort()
    .join('|');
}

function modsJars(modsDir) {
  if (!modsDir || !fs.existsSync(modsDir)) return [];
  return fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar'))
    .map((f) => ({ file: f, sha256: sha256File(path.join(modsDir, f)) }));
}

function loadManifest(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!m || !Array.isArray(m.requirements)) throw new Error('acceptance.json 缺少 requirements 数组');
  return m;
}

function short(fp) {
  return fp ? crypto.createHash('sha256').update(String(fp)).digest('hex').slice(0, 12) : '';
}

/**
 * @param {object} manifest
 * @param {{root:string, modsDir?:string, runCmd?:(cmd:string, opts?:object)=>object, now?:number}} ctx
 */
function evaluate(manifest, ctx) {
  const root = ctx.root;
  const now = ctx.now || Date.now();
  const runCmd = ctx.runCmd || defaultRunCmd(root);
  const currentFp = ctx.currentFp !== undefined ? ctx.currentFp : fingerprint(modsJars(ctx.modsDir));

  const rows = (manifest.requirements || []).map((req) => {
    const checks = Array.isArray(req.checks) ? req.checks : [];
    const results = checks.map((c) => runCheck(c, { root, runCmd, currentFp, now }));
    const uncovered = Array.isArray(req.uncovered) ? req.uncovered : [];
    let status = combine(req, results);
    // 清单自己都写着「还有分支没覆盖」的项，不许因为一条命令 exit 0 就显示 PASS
    if (status.status === STATUS.PASS && uncovered.length && req.uncoveredBlocks !== false) {
      status = { status: STATUS.UNKNOWN, reason: '清单自报仍有未覆盖项：' + uncovered.join('；'), version: status.version, coverage: status.coverage };
    }
    const evidence = results.filter((r) => r.evidence).map((r) => r.evidence);
    return {
      id: req.id,
      batch: req.batch || req.id,
      title: req.title || '',
      required: req.required !== false,
      level: req.level || 'offline',
      scenario: req.scenario || '',
      status: status.status,
      reason: status.reason,
      checks: results,
      evidence,
      version: status.version || '',
      coverage: status.coverage || '',
      uncovered,
      note: req.note || '',
    };
  });

  const required = rows.filter((r) => r.required);
  const blocking = required.filter((r) => r.status !== STATUS.PASS);
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

  return {
    generatedAt: new Date(now).toISOString(),
    manifest: { source: manifest.source || '', updated: manifest.updated || '' },
    currentBuild: short(currentFp),
    rows,
    summary: {
      total: rows.length,
      required: required.length,
      counts,
      overall: blocking.length ? 'INCOMPLETE' : 'COMPLETE',
      blocking: blocking.map((r) => ({ id: r.id, status: r.status, reason: r.reason })),
    },
  };
}

function defaultRunCmd(root) {
  return (cmd) => {
    const parts = String(cmd).split(/\s+/).filter(Boolean);
    if (!parts.length) return { code: 127, out: 'empty cmd' };
    const bin = parts[0] === 'node' ? process.execPath : parts[0];
    const out = spawnSync(bin, parts.slice(1), { cwd: root, encoding: 'utf8', timeout: 180000 });
    return { code: out.status === null ? 127 : out.status, out: ((out.stdout || '') + (out.stderr || '')).trim() };
  };
}

function runCheck(c, env) {
  const type = c && c.type;
  if (type === 'cmd') {
    const cmd = String(c.cmd || '').trim();
    if (!cmd) return { type, status: STATUS.UNKNOWN, reason: 'cmd 为空', evidence: '' };
    const r = env.runCmd(cmd);
    const tail = String(r.out || '').split('\n').filter(Boolean).slice(-1)[0] || '';
    return {
      type,
      status: r.code === 0 ? STATUS.PASS : STATUS.FAIL,
      reason: r.code === 0 ? '命令 exit 0' : '命令 exit ' + r.code + (tail ? '：' + tail.slice(0, 160) : ''),
      evidence: 'cmd: ' + cmd,
    };
  }
  if (type === 'file') {
    const rel = String(c.path || '').trim();
    const abs = path.isAbsolute(rel) ? rel : path.join(env.root, rel);
    if (!rel) return { type, status: STATUS.UNKNOWN, reason: 'path 为空', evidence: '' };
    if (!fs.existsSync(abs)) {
      return { type, status: STATUS.NOT_RUN, reason: '证据文件不存在：' + rel, evidence: rel };
    }
    let env0 = null;
    try { env0 = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')); } catch { env0 = null; }
    const fp = env0 ? fingerprint(env0.jarsAtLaunch) : '';
    let version = fp ? short(fp) : '';
    if (c.requireCurrentBuild) {
      if (!fp) return { type, status: STATUS.UNKNOWN, reason: '证据里没有 jarsAtLaunch，无法判版本', evidence: rel, version };
      if (env.currentFp && fp !== env.currentFp) {
        return {
          type,
          status: STATUS.VERSION_MISMATCH,
          reason: '证据是旧部署（' + short(fp) + '），当前 mods 指纹 ' + short(env.currentFp) + ' —— 对旧版本有效，对新版本未验',
          evidence: rel,
          version,
        };
      }
    }
    if (Number.isFinite(c.maxAgeDays) && c.maxAgeDays > 0) {
      const stamp = env0 && (env0.finishedAt || env0.createdAt) ? Date.parse(env0.finishedAt || env0.createdAt) : NaN;
      if (Number.isFinite(stamp) && env.now - stamp > c.maxAgeDays * 86400000) {
        return { type, status: STATUS.STALE, reason: '证据超过 ' + c.maxAgeDays + ' 天', evidence: rel, version };
      }
    }
    const coverage = env0 && env0.actions && env0.actions.coverage ? 'callId ' + env0.actions.coverage.callId + ' / 终态 ' + env0.actions.coverage.terminal : '';
    return { type, status: STATUS.PASS, reason: '证据存在' + (version ? '（构建 ' + version + '）' : ''), evidence: rel, version, coverage };
  }
  if (type === 'manual') {
    return {
      type,
      status: STATUS.NOT_RUN,
      reason: '需实机或人工判据：' + (c.what ? String(c.what).slice(0, 160) : '未写明判据'),
      evidence: '',
    };
  }
  return { type: type || '(none)', status: STATUS.UNKNOWN, reason: '未知检查类型', evidence: '' };
}

/** 一项要求 = 所有检查里最差的那个；有 manual 未做就永远不是 PASS。 */
function combine(req, results) {
  if (!results.length) return { status: STATUS.NOT_RUN, reason: '没有任何检查（等于没验）' };
  const order = [STATUS.FAIL, STATUS.VERSION_MISMATCH, STATUS.STALE, STATUS.UNKNOWN, STATUS.NOT_RUN, STATUS.PASS];
  let worst = STATUS.PASS;
  for (const r of results) {
    if (order.indexOf(r.status) < order.indexOf(worst)) worst = r.status;
  }
  const bad = results.filter((r) => r.status !== STATUS.PASS);
  const reason = worst === STATUS.PASS ? '全部检查通过' : bad.map((r) => r.reason).join('；');
  const version = (results.find((r) => r.version) || {}).version || '';
  const coverage = (results.find((r) => r.coverage) || {}).coverage || '';
  return { status: worst, reason, version, coverage };
}

function render(res) {
  const icon = {
    PASS: '✅', FAIL: '❌', NOT_RUN: '⬜', UNKNOWN: '❓', VERSION_MISMATCH: '🟠', STALE: '🟡',
  };
  const lines = [];
  lines.push('# 验收表 · ' + (res.manifest.source || 'acceptance') + '（' + res.manifest.updated + '）');
  lines.push('');
  lines.push('当前部署构建指纹：' + (res.currentBuild || '取不到') + '（mods 目录 jars 的 file:sha256）');
  lines.push('');
  lines.push('| 要求 | 批次 | 必验 | 层级 | 场景 | 结果 | 版本 | 覆盖 | 证据 | 未覆盖项 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of res.rows) {
    const ev = r.evidence.length
      ? r.evidence.map((e) => (e.startsWith('cmd: ') ? '`' + e.slice(5) + '`' : e)).join('<br>')
      : '—';
    lines.push('| ' + r.id + ' ' + r.title.slice(0, 18) + ' | ' + r.batch + ' | ' + (r.required ? '必验' : '选验')
      + ' | ' + r.level + ' | ' + (r.scenario || '—') + ' | ' + (icon[r.status] || '') + ' ' + r.status
      + ' | ' + (r.version || '—') + ' | ' + (r.coverage || '—')
      + ' | ' + ev + ' | ' + (r.uncovered.length ? r.uncovered.join('；') : '—') + ' |');
  }
  lines.push('');
  const s = res.summary;
  lines.push('**整体：' + s.overall + '** —— 必验 ' + s.required + ' 项，'
    + Object.entries(s.counts).map(([k, v]) => k + '=' + v).join('，'));
  if (s.blocking.length) {
    lines.push('');
    lines.push('未过（不算完成）：');
    for (const b of s.blocking) lines.push('- ' + b.id + ' → ' + b.status + '：' + b.reason.slice(0, 200));
  }
  lines.push('');
  lines.push('> 效果等级（PILOT / DIRECTIONAL / SUPPORTED）不是工程验收：它们说明「这轮看起来往哪走」，不说明「要求已验」。');
  return lines.join('\n');
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const manifest = {
    source: 'selftest',
    requirements: [
      { id: 'R1', required: true, checks: [{ type: 'cmd', cmd: 'node ok.js' }] },
      { id: 'R2', required: true, checks: [{ type: 'cmd', cmd: 'node bad.js' }] },
      { id: 'R3', required: true, checks: [{ type: 'manual', what: '实机判据' }] },
      { id: 'R4', required: false, checks: [{ type: 'cmd', cmd: 'node ok.js' }] },
      { id: 'R5', required: true, checks: [] },
    ],
  };
  const runCmd = (cmd) => ({ code: cmd.includes('bad') ? 1 : 0, out: cmd.includes('bad') ? 'boom' : 'ok' });
  const res = evaluate(manifest, { root: process.cwd(), runCmd, currentFp: 'abc12345', now: Date.parse('2026-10-30T00:00:00Z') });

  const byId = (id) => res.rows.find((r) => r.id === id);
  ok(byId('R1').status === 'PASS', '① cmd exit 0 → PASS（实得 ' + byId('R1').status + '）');
  ok(byId('R2').status === 'FAIL', '② cmd exit 非 0 → FAIL（实得 ' + byId('R2').status + '）');
  ok(byId('R3').status === 'NOT_RUN', '③ manual 永远 NOT_RUN（实得 ' + byId('R3').status + '）');
  ok(byId('R5').status === 'NOT_RUN', '④ 没有任何检查 → NOT_RUN（实得 ' + byId('R5').status + '）');
  ok(res.summary.overall === 'INCOMPLETE', '⑤ 有必验项未过 → 整体 INCOMPLETE（实得 ' + res.summary.overall + '）');
  ok(res.summary.blocking.length === 3, '⑥ 阻塞项 3 个（实得 ' + res.summary.blocking.length + '）');
  ok(byId('R4').status === 'PASS' && res.summary.required === 4, '⑦ 选验项不计入必验数（required=' + res.summary.required + '）');

  // ⑧ 版本不符：旧部署证据不得算 PASS
  const tmp = path.join(process.cwd(), '.tmp-acceptance-selftest');
  fs.mkdirSync(tmp, { recursive: true });
  const evFile = path.join(tmp, 'envelope.json');
  fs.writeFileSync(evFile, JSON.stringify({
    createdAt: '2026-10-30T00:00:00Z',
    jarsAtLaunch: [{ file: 'a.jar', sha256: 'old' }],
    actions: { coverage: { callId: '3/3', terminal: '1/3' } },
  }));
  const m2 = { requirements: [{ id: 'V1', required: true, checks: [{ type: 'file', path: evFile, requireCurrentBuild: true }] }] };
  const r2 = evaluate(m2, { root: process.cwd(), runCmd, currentFp: 'new', now: Date.parse('2026-10-30T00:00:00Z') });
  ok(r2.rows[0].status === 'VERSION_MISMATCH', '⑧ 旧构建证据 → VERSION_MISMATCH（实得 ' + r2.rows[0].status + '）');
  const r2b = evaluate(m2, { root: process.cwd(), runCmd, currentFp: fingerprint([{ file: 'a.jar', sha256: 'old' }]), now: Date.parse('2026-10-30T00:00:00Z') });
  ok(r2b.rows[0].status === 'PASS', '⑨ 同构建证据 → PASS（实得 ' + r2b.rows[0].status + '）');
  ok(r2b.rows[0].coverage.includes('1/3'), '⑩ 覆盖率带出来（实得 ' + r2b.rows[0].coverage + '）');

  // ⑪ 缺文件 → NOT_RUN；⑫ 过期 → STALE
  const m3 = { requirements: [{ id: 'M1', required: true, checks: [{ type: 'file', path: path.join(tmp, 'nope.json') }] }] };
  ok(evaluate(m3, { root: process.cwd(), runCmd, currentFp: '' }).rows[0].status === 'NOT_RUN', '⑪ 证据不存在 → NOT_RUN');
  const m4 = { requirements: [{ id: 'A1', required: true, checks: [{ type: 'file', path: evFile, maxAgeDays: 1 }] }] };
  ok(evaluate(m4, { root: process.cwd(), runCmd, currentFp: '', now: Date.parse('2026-11-30T00:00:00Z') }).rows[0].status === 'STALE',
    '⑫ 证据过期 → STALE');
  fs.rmSync(tmp, { recursive: true, force: true });

  // ⑬ FAIL 优先于 VERSION_MISMATCH（一项要求多检查时取最差）
  const m5 = { requirements: [{ id: 'X', required: true, checks: [{ type: 'cmd', cmd: 'node bad.js' }, { type: 'manual', what: 'x' }] }] };
  ok(evaluate(m5, { root: process.cwd(), runCmd, currentFp: '' }).rows[0].status === 'FAIL', '⑬ 多检查取最差（FAIL）');

  // ⑭ 自报未覆盖项 → 不许 PASS
  const m6 = { requirements: [{ id: 'U', required: true, uncovered: ['关键分支没覆盖'], checks: [{ type: 'cmd', cmd: 'node ok.js' }] }] };
  const r6 = evaluate(m6, { root: process.cwd(), runCmd, currentFp: '' });
  ok(r6.rows[0].status === 'UNKNOWN', '⑭ 命令绿但自报未覆盖 → UNKNOWN（实得 ' + r6.rows[0].status + '）');
  ok(r6.summary.overall === 'INCOMPLETE', '⑭b 整体仍 INCOMPLETE');

  console.log(fails.length
    ? 'acceptance selftest FAIL: ' + fails.join(' | ')
    : 'acceptance selftest PASS（14 组：命令/人工/版本/过期/未覆盖项/整体不合格）');
  return fails.length ? 1 : 0;
}

module.exports = { evaluate, render, loadManifest, fingerprint, modsJars, STATUS, selftest };

if (require.main === module) {
  if (process.argv[2] === 'selftest') process.exit(selftest());
  if (process.argv[2] === 'show') {
    const here = path.resolve(__dirname, '..', '..');
    const res = evaluate(loadManifest(path.join(here, 'experiments', 'acceptance.json')), {
      root: here, modsDir: path.join(here, '..', '..', 'mc', 'The Best of Twilight Forest', 'mods'),
    });
    console.log(render(res));
    process.exit(res.summary.overall === 'COMPLETE' ? 0 : 1);
  }
  console.error('usage: acceptance.js selftest|show');
  process.exit(2);
}
