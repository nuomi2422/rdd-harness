'use strict';
/**
 * runstore.js —— Harness RunStore（设计草案 §9.1）
 *
 * 现状（诚实标注）：**JSONL + 原子 JSON 文件**，不是 SQLite。
 *   设计草案建议 SQLite 事务日志；M1 先在零依赖前提下落这一版：
 *   - 每个 run 一个目录，天然隔离；
 *   - 所有 JSON 写入走 tmp + rename（原子替换，防半截文件）；
 *   - events.jsonl 追加写，seq 单调递增；
 *   - 证据按内容哈希命名，写后可校验。
 *   ⚠ 未实现：跨 run 事务、并发多写者仲裁、SQLite 迁移。都记为 not_connected。
 *
 * 目录结构（root 由 registry.roots.runs 或环境变量 RDD_HARNESS_RUNS 决定）：
 *   runs/<runId>/spec.lock.json
 *   runs/<runId>/events.jsonl
 *   runs/<runId>/evidence/<sha256>-<name>
 *   runs/<runId>/manifest.json
 *   runs/<runId>/report.json
 *   runs/<runId>/report.md
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; }
}

function defaultRoot(env) {
  const e = env || process.env;
  if (e.RDD_HARNESS_RUNS) return path.resolve(e.RDD_HARNESS_RUNS);
  try {
    const reg = require('../../bin/lib/registry.js').load();
    if (reg.roots.runs) return reg.roots.runs;
  } catch { /* 独立测试时不依赖 registry */ }
  return path.join(__dirname, '..', '..', 'runs');
}

function runIdFor(now) {
  const d = now || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `run-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

class RunStore {
  constructor(root) {
    this.root = path.resolve(root || defaultRoot());
    fs.mkdirSync(this.root, { recursive: true });
  }

  dir(runId) { return path.join(this.root, runId); }
  file(runId, ...parts) { return path.join(this.root, runId, ...parts); }

  createRun(meta) {
    const runId = (meta && meta.runId) || runIdFor();
    const dir = this.dir(runId);
    if (fs.existsSync(dir)) throw new Error(`runId 已存在：${runId}`);
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    atomicWrite(this.file(runId, 'manifest.json'), JSON.stringify(Object.assign({
      runId,
      createdAt: new Date().toISOString(),
      harnessStore: 'jsonl-atomic@1',
      note: 'SQLite 事务日志未实现（not_connected）；当前为原子 JSON + 追加 JSONL。',
    }, meta || {}), null, 2));
    atomicWrite(this.file(runId, 'events.jsonl'), '');
    return { runId, dir };
  }

  writeSpec(runId, specLock) { atomicWrite(this.file(runId, 'spec.lock.json'), JSON.stringify(specLock, null, 2)); }

  appendEvent(runId, event) {
    const file = this.file(runId, 'events.jsonl');
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const seq = prev ? prev.trim().split('\n').length + 1 : 1;
    const rec = Object.assign({ seq, at: new Date().toISOString() }, event);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  }

  putEvidence(runId, name, content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
    const rel = path.join('evidence', `${hash.slice(0, 12)}-${safe}`);
    const abs = this.file(runId, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    return { ref: rel.replace(/\\/g, '/'), sha256: hash, bytes: buf.length };
  }

  writeManifest(runId, manifest) {
    const file = this.file(runId, 'manifest.json');
    const cur = readJson(file, {});
    atomicWrite(file, JSON.stringify(Object.assign(cur, manifest), null, 2));
  }

  writeReport(runId, report) {
    atomicWrite(this.file(runId, 'report.json'), JSON.stringify(report, null, 2));
    atomicWrite(this.file(runId, 'report.md'), renderReport(report));
  }

  readRun(runId) {
    return {
      runId,
      dir: this.dir(runId),
      manifest: readJson(this.file(runId, 'manifest.json'), null),
      spec: readJson(this.file(runId, 'spec.lock.json'), null),
      events: (() => {
        try {
          return fs.readFileSync(this.file(runId, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        } catch { return []; }
      })(),
      report: readJson(this.file(runId, 'report.json'), null),
    };
  }

  listRuns() {
    let ents = [];
    try { ents = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return []; }
    return ents.filter((e) => e.isDirectory() && /^run-/.test(e.name)).map((e) => {
      const m = readJson(path.join(this.root, e.name, 'manifest.json'), {});
      return { runId: e.name, createdAt: m.createdAt || null, cardId: m.cardId || null, verdict: (readJson(path.join(this.root, e.name, 'report.json'), {}) || {}).verdict || null };
    }).sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
  }

  verifyEvidence(runId, ref, sha256) {
    try {
      const buf = fs.readFileSync(this.file(runId, ...String(ref).split('/')));
      return crypto.createHash('sha256').update(buf).digest('hex') === sha256;
    } catch { return false; }
  }
}

function renderReport(report) {
  const L = [];
  L.push(`# Run ${report.runId}`);
  L.push('');
  L.push(`- 测试卡：\`${report.cardId}\` v${report.cardVersion || '?'}`);
  L.push(`- 结果：**${report.verdict}**（task=${report.taskVerdict || '-'}）`);
  L.push(`- flags：${(report.flags || []).join(', ') || '无'}`);
  L.push(`- 生成于：${report.ranAt}`);
  L.push('');
  L.push('## 裁决理由');
  L.push('');
  for (const r of report.reasons || []) L.push(`- \`${r.code}\` ${r.detail}`);
  if (!(report.reasons || []).length) L.push('- 无');
  L.push('');
  L.push('## 证据');
  L.push('');
  L.push(`- 置信度：${(report.evidence || {}).ok ? '齐全' : '不齐全'}`);
  for (const i of ((report.evidence || {}).issues || [])) L.push(`  - [${i.severity}] ${i.code} ${i.detail}`);
  L.push('');
  L.push('## 模型调用');
  L.push('');
  for (const c of report.calls || []) L.push(`- ${c.role} ${c.modelRef} → ${c.status}${c.reasonCode ? ' (' + c.reasonCode + ')' : ''}${c.cost ? ' 费用 ' + c.cost : ''}`);
  if (!(report.calls || []).length) L.push('- 本轮没有模型调用');
  L.push('');
  L.push('## 预算');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(report.budget || {}, null, 2));
  L.push('```');
  L.push('');
  L.push('> 本报告由确定性裁决引擎生成。模型的「完成了」不在判据里；');
  L.push('> 「未进游戏就写 verified_in_game」在本 Harness 里被明确禁止。');
  return L.join('\n');
}

module.exports = { RunStore, defaultRoot, atomicWrite, renderReport, runIdFor };
