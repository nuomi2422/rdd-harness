#!/usr/bin/env node
'use strict';
/**
 * selfcompile-drain.js —— 学习者 SELF_COMPILE_REQUEST 的**取件入口**（2026-10-27 v2）
 *
 * v2 变更（对齐 SelfCompileRequests 取件契约）：
 *   此前 v1 直接改 artifact-outbox 的 status —— 那是产物档案（append-only），
 *   而 B6/S2 的契约是「取件回执走旁路 ack 目录」：<configDir>/selfcompile-requests/<id>.ack.json。
 *   本版改写 ack 文件，产物档案不动。
 *
 * 用法：
 *   node selfcompile-drain.js                              # 列 UNCLAIMED（默认）
 *   node selfcompile-drain.js --all                        # 列全部（含 TAKEN/RESOLVED）
 *   node selfcompile-drain.js --take <artifactId> --by <人> [--note "..."]
 *   node selfcompile-drain.js --resolve <artifactId> --by <人> --note "结果"
 *   node selfcompile-drain.js --status
 *   node selfcompile-drain.js --self-test
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const INSTANCE_ROOT = 'D:\\rdd\\mc\\The Best of Twilight Forest\\config\\numen';

function rootDir(argv) {
  const i = argv.indexOf('--root');
  return i >= 0 ? argv[i + 1] : INSTANCE_ROOT;
}

function listArtifacts(root) {
  const base = path.join(root, 'artifact-outbox', 'SELF_COMPILE_REQUEST');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const comp of fs.readdirSync(base)) {
    const dir = path.join(base, comp);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push({ path: path.join(dir, f), data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) });
      } catch (e) { /* 坏文件跳过 */ }
    }
  }
  return out;
}

function ackPath(root, artifactId) {
  return path.join(root, 'selfcompile-requests', artifactId + '.ack.json');
}

function readAck(root, artifactId) {
  const p = ackPath(root, artifactId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { state: 'UNREADABLE', note: String(e) }; }
}

function writeAck(root, artifactId, state, by, note) {
  const p = ackPath(root, artifactId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const prev = readAck(root, artifactId) || {};
  fs.writeFileSync(p, JSON.stringify({
    artifact_id: artifactId,
    state, by, note: note || '',
    at: new Date().toISOString(),
    prev_state: prev.state || null,
  }), 'utf8');
}

function rows(root, all) {
  const out = [];
  for (const it of listArtifacts(root)) {
    const id = it.data.artifact_id;
    const ack = readAck(root, id);
    const state = ack ? (ack.state || 'UNREADABLE') : 'UNCLAIMED';
    if (!all && state !== 'UNCLAIMED') continue;
    out.push({ id, state, by: ack ? ack.by || '' : '', note: ack ? ack.note || '' : '',
      memo: it.data.memo_id || '', at: it.data.submitted_at || '',
      body: String(it.data.body || '').slice(0, 200) });
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const root = rootDir(argv);

  const take = argv.indexOf('--take');
  const resolve = argv.indexOf('--resolve');
  const byIdx = argv.indexOf('--by');
  const noteIdx = argv.indexOf('--note');
  const by = byIdx >= 0 ? argv[byIdx + 1] : '';
  const note = noteIdx >= 0 ? argv[noteIdx + 1] : '';

  if (take >= 0 || resolve >= 0) {
    const id = take >= 0 ? argv[take + 1] : argv[resolve + 1];
    if (!id) { console.error('artifactId required'); process.exit(3); }
    if (!by) { console.error('--by required：无主的认领等于没人认领'); process.exit(3); }
    const state = take >= 0 ? 'TAKEN' : 'RESOLVED';
    if (state === 'RESOLVED' && !note) { console.error('--note required for resolve'); process.exit(3); }
    writeAck(root, id, state, by, note);
    console.log(JSON.stringify({ ok: true, artifact: id, state, by }, null, 1));
    return 0;
  }
  if (argv.includes('--status')) {
    const all = rows(root, true);
    const by = {};
    for (const r of all) by[r.state] = (by[r.state] || 0) + 1;
    console.log(JSON.stringify({ total: all.length, by_state: by }, null, 1));
    return 0;
  }
  console.log(JSON.stringify({ root, items: rows(root, argv.includes('--all')) }, null, 1));
  return 0;
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scr-'));
  const dir = path.join(tmp, 'artifact-outbox', 'SELF_COMPILE_REQUEST', 'c1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SCR1.json'), JSON.stringify({
    artifact_id: 'SCR1', memo_id: 'm1', submitted_at: 't', body: 'x',
  }));
  const before = rows(tmp, false);
  const ok1 = before.length === 1 && before[0].state === 'UNCLAIMED';
  writeAck(tmp, 'SCR1', 'TAKEN', 'operator', 'wip');
  const mid = rows(tmp, false);
  const ok2 = mid.length === 0; // UNCLAIMED 只列未认领
  writeAck(tmp, 'SCR1', 'RESOLVED', 'operator', 'done: commit abc');
  const after = rows(tmp, true);
  const ok3 = after.length === 1 && after[0].state === 'RESOLVED' && after[0].note === 'done: commit abc';
  const ok = ok1 && ok2 && ok3;
  console.log(JSON.stringify({ selfTest: ok ? 'PASS' : 'FAIL', ok1, ok2, ok3 }));
  return ok ? 0 : 1;
}

process.exit(main() || 0);
