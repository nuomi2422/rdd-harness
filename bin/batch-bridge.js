#!/usr/bin/env node
'use strict';
/**
 * batch-bridge.js —— G7b 第一刀：给 `engineering-request` 接一个**真实消费者**
 *
 * 为什么要有它：`bin/lib/engineering-request.js` 是纯契约，如果没人调用，按 S-CODE-04
 * 就是「接线前状态」的死代码。这个 CLI 把它接进**批次收尾**这条真实流程：
 * 每批开一张请求 → 实现时交证据 → 收尾时由**别人的**核验签字。
 *
 * 存储：`runs/engineering-requests.jsonl`（append-only 事件流，**只增不改**）
 *   - 每行一条事件：{v, at, requestId, kind:'created'|'transition'|'spend', ...}
 *   - 状态靠**重放**得到（与 engineering-request R7 同一口径：事实在事件里，结论随时可算）
 *
 * 用法：
 *   node bin/batch-bridge.js start   --batch G7b --scope harness --revision <sha> [--submitter ai] [--budget bud-1]
 *   node bin/batch-bridge.js accept  --id <requestId> [--by ai]
 *   node bin/batch-bridge.js implement --id <requestId> --evidence "card.md:12" [--evidence "..."] [--by ai]
 *   node bin/batch-bridge.js verify  --id <requestId> --reviewer <name> --evidence "a:1" --evidence "b:2" [--by ai]
 *   node bin/batch-bridge.js block   --id <requestId> --reason "..."
 *   node bin/batch-bridge.js list [--json]
 *   node bin/batch-bridge.js show    --id <requestId>
 *   node bin/batch-bridge.js selftest
 */
const fs = require('node:fs');
const path = require('node:path');
const er = require('./lib/engineering-request');

const HARNESS = path.resolve(__dirname, '..');
function ledgerFile() {
  return process.env.RDD_BRIDGE_LEDGER || path.join(HARNESS, 'runs', 'engineering-requests.jsonl');
}

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function args(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === '--' + name && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  });
  return out;
}

function readEvents() {
  const file = ledgerFile();
  if (!fs.existsSync(file)) return [];
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try {
      out.push(JSON.parse(l));
    } catch (e) {
      // 坏行要能定位，且不许因此冻结整个账本（跳过并记住）
      out.push({ kind: '__bad_line__', line: i + 1, error: e.message });
    }
  });
  return out;
}

function appendEvent(e) {
  const file = ledgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ v: 1, at: Date.now(), ...e }) + '\n', 'utf8');
}

/** 重放：事件流 → 当前状态（与 R7 同一口径）。 */
function replay(events, requestId) {
  let req = null;
  for (const e of events) {
    if (e.requestId !== requestId) continue;
    if (e.kind === 'created') {
      req = er.create({
        requestId: e.requestId, contractRevision: e.contractRevision, batchId: e.batchId,
        scope: e.scope, expectedBaseRevision: e.expectedBaseRevision,
        budgetAuthorizationRef: e.budgetAuthorizationRef, submitter: e.submitter,
      });
    } else if (e.kind === 'transition' && req) {
      const opts = { by: e.by, reason: e.reason, reviewer: e.reviewer, evidenceRefs: e.evidenceRefs || [] };
      if (e.to === 'ACCEPTED') req = er.accept(req, opts);
      else if (e.to === 'IMPLEMENTED') req = er.implement(req, opts);
      else if (e.to === 'VERIFIED') req = er.verify(req, opts);
      else if (e.to === 'BLOCKED') req = er.block(req, opts);
      else if (e.to === 'REJECTED') req = er.reject(req, opts);
    }
  }
  return req;
}

function allRequests(events) {
  const ids = [];
  for (const e of events) if (!ids.includes(e.requestId)) ids.push(e.requestId);
  return ids.map((id) => replay(events, id)).filter(Boolean);
}

function cmdStart() {
  const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const e = {
    kind: 'created', requestId,
    contractRevision: arg('contract') || arg('revision') || '',
    batchId: arg('batch') || '',
    scope: arg('scope') || '',
    expectedBaseRevision: arg('base') || arg('revision') || '',
    budgetAuthorizationRef: arg('budget') || '',
    submitter: arg('submitter') || 'ai',
  };
  // ★ 断点要认基线：--revision 必须与宿主实际 HEAD 一致，否则当场拒（不落盘）
  const wantRev = arg('revision') || '';
  if (wantRev) {
    const { spawnSync } = require('node:child_process');
    const GIT = 'C:\\\\Users\\\\admin\\\\AppData\\\\Local\\\\Programs\\\\MinGit\\\\cmd\\\\git.exe';
    const got = spawnSync(GIT, ['-C', HARNESS, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    const actual = (got.stdout || '').trim();
    if (!actual) throw new Error('BASE_REVISION_MISMATCH: 读不到宿主 HEAD');
    if (actual !== wantRev && !actual.startsWith(wantRev) && !wantRev.startsWith(actual)) {
      const e = new Error(`BASE_REVISION_MISMATCH: 期望 ${wantRev}，实际 ${actual}`);
      e.code = 'BASE_REVISION_MISMATCH';
      throw e;
    }
  }
  // ★ 预算：给了 --budget 就必须能在 --budget-json 里解析到有效授权（未填不等于无限）
  if (e.budgetAuthorizationRef) {
    const raw = arg('budget-json');
    if (!raw) {
      const err = new Error('NO_AUTHORIZATION: 给了 --budget 就必须同时给 --budget-json（否则无法校验）');
      err.code = 'NO_AUTHORIZATION';
      throw err;
    }
    er.assertBudget({ budgetAuthorizationRef: e.budgetAuthorizationRef }, JSON.parse(raw), {}, { scope: e.scope });
  }
  // 先用契约校验一遍（缺字段会抛），再落盘
  er.create({
    requestId, contractRevision: e.contractRevision, batchId: e.batchId, scope: e.scope,
    expectedBaseRevision: e.expectedBaseRevision, budgetAuthorizationRef: e.budgetAuthorizationRef,
    submitter: e.submitter,
  });
  appendEvent(e);
  console.log(JSON.stringify({ ok: true, requestId, ledger: ledgerFile() }));
}

function transitionCmd(to) {
  const id = arg('id');
  if (!id) throw new Error('缺 --id');
  const events = readEvents();
  const req = replay(events, id);
  if (!req) throw new Error(`没有这个请求：${id}`);
  const opts = {
    by: arg('by') || 'ai', reason: arg('reason') || '',
    reviewer: arg('reviewer') || '', evidenceRefs: args('evidence'),
  };
  // 先在内存里跑一遍（非法迁移在这里就抛），再落事件
  if (to === 'ACCEPTED') er.accept(req, opts);
  else if (to === 'IMPLEMENTED') er.implement(req, opts);
  else if (to === 'VERIFIED') er.verify(req, opts);
  else if (to === 'BLOCKED') er.block(req, opts);
  else if (to === 'REJECTED') er.reject(req, opts);
  appendEvent({ kind: 'transition', requestId: id, to, ...opts });
  const after = replay(readEvents(), id);
  console.log(JSON.stringify({ ok: true, id, state: after.state, transitions: after.transitions.length }));
}

function cmdList() {
  const reqs = allRequests(readEvents());
  if (process.argv.includes('--json')) return console.log(JSON.stringify(reqs, null, 2));
  if (!reqs.length) return console.log('（还没有请求）');
  for (const r of reqs) {
    console.log(`${r.requestId}  ${r.state.padEnd(11)}  ${r.batchId}  ev=${r.evidenceRefs.length}  ${r.transitions.length} 步`);
  }
}

function cmdShow() {
  const id = arg('id');
  const req = replay(readEvents(), id);
  if (!req) return console.log('没有这个请求：' + id);
  console.log(JSON.stringify(req, null, 2));
}

function selftest() {
  const tmp = path.join(require('node:os').tmpdir(), `bridge-${Date.now()}.jsonl`);
  const keep = process.env.RDD_BRIDGE_LEDGER;
  process.env.RDD_BRIDGE_LEDGER = tmp;
  const failures = [];
  const step = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message}`); } };

  step('start→accept→implement→verify', () => {
    const before = process.argv.slice();
    const head = require('node:child_process')
      .spawnSync('C:\\\\Users\\\\admin\\\\AppData\\\\Local\\\\Programs\\\\MinGit\\\\cmd\\\\git.exe',
        ['-C', HARNESS, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    const sha = (head.stdout || '').trim();
    process.argv = ['node', 'batch-bridge.js', 'start', '--batch', 'T', '--scope', 's', '--revision', sha];
    cmdStart();
    const id = JSON.parse(fs.readFileSync(tmp, 'utf8').trim()).requestId;
    process.argv = ['node', 'b', 'accept', '--id', id];
    transitionCmd('ACCEPTED');
    process.argv = ['node', 'b', 'implement', '--id', id, '--evidence', 'x:1'];
    transitionCmd('IMPLEMENTED');
    process.argv = ['node', 'b', 'verify', '--id', id, '--reviewer', 'auditor', '--evidence', 'y:2'];
    transitionCmd('VERIFIED');
    const req = replay(readEvents(), id);
    if (req.state !== 'VERIFIED') throw new Error('终态不是 VERIFIED');
    if (!req.verifiedBy) throw new Error('没记核验者');
    process.argv = before;
  });

  step('重放稳定', () => {
    const reqs = allRequests(readEvents());
    if (reqs.length !== 1) throw new Error('请求数 ' + reqs.length);
    const again = replay(readEvents(), reqs[0].requestId);
    if (again.state !== reqs[0].state) throw new Error('重放不一致');
  });

  step('非法迁移被拒且不落盘', () => {
    const id = allRequests(readEvents())[0].requestId;
    const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n').length;
    process.argv = ['node', 'b', 'accept', '--id', id];
    try {
      transitionCmd('ACCEPTED');
      throw new Error('应当被拒');
    } catch (e) {
      if (e.message === '应当被拒') throw e;   // 契约错误是预期
    }
    const after = fs.readFileSync(tmp, 'utf8').trim().split('\n').length;
    if (after !== lines) throw new Error('被拒的迁移不该落盘');
  });

  if (keep === undefined) delete process.env.RDD_BRIDGE_LEDGER;
  else process.env.RDD_BRIDGE_LEDGER = keep;
  try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  const r = { ok: failures.length === 0, failures };
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

try {
  const cmd = process.argv[2];
  if (cmd === 'start') cmdStart();
  else if (cmd === 'accept') transitionCmd('ACCEPTED');
  else if (cmd === 'implement') transitionCmd('IMPLEMENTED');
  else if (cmd === 'verify') transitionCmd('VERIFIED');
  else if (cmd === 'block') transitionCmd('BLOCKED');
  else if (cmd === 'reject') transitionCmd('REJECTED');
  else if (cmd === 'list') cmdList();
  else if (cmd === 'show') cmdShow();
  else if (cmd === 'selftest') selftest();
  else {
    console.log('用法：start|accept|implement|verify|block|reject|list|show|selftest（见文件头）');
    process.exit(1);
  }
} catch (e) {
  console.error(JSON.stringify({ ok: false, code: e.code || 'ERROR', message: e.message }));
  process.exit(2);
}
