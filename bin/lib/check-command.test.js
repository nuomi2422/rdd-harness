'use strict';
// bench.js check：一条命令给全部读端结论；MISMATCH 必须非零退出（可被脚本判）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');

const BENCH = path.join(__dirname, '..', 'bench.js');
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
  for (const [n, rows] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), rows.join("\n") + "\n");
  return dir;
}

test('check：输出验收表与证据卡两段', () => {
  const d = fixture({ 'tools.jsonl': [], 'events.jsonl': [] });
  const r = spawnSync(process.execPath, [BENCH, 'check', '--dir', d], { encoding: 'utf8' });
  assert.match(r.stdout, /== 验收表 ==/);
  assert.match(r.stdout, /== 证据卡 ==/);
  assert.equal(r.status, 0, '无 MISMATCH 时应 0');
  fs.rmSync(d, { recursive: true, force: true });
});

test('check：出现 MISMATCH 时退出码非零（不被静默吞）', () => {
  const req = JSON.stringify({ type: 'final_request', timestamp: '2026-11-09T06:00:00Z', data: { companion_id: 'c', requestKind: 'execute', turn: 1, rationalePresent: true, whyPresent: false, whyStatus: 'ABSENT', risksPresent: true, sourcePresent: true, conditionsPresent: false, rationaleSource: '' } });
  const d = fixture({ 'tools.jsonl': [], 'events.jsonl': [], 'context.jsonl': [req] });
  const r = spawnSync(process.execPath, [BENCH, 'check', '--dir', d], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'R1 MISMATCH 应让 check 非零退出');
  fs.rmSync(d, { recursive: true, force: true });
});
test('check --json：给自动化用，字段与文本段对应；无 MISMATCH 时 0', () => {
  const d = fixture({ 'tools.jsonl': [], 'events.jsonl': [] });
  const r = spawnSync(process.execPath, [BENCH, 'check', '--json', '--dir', d], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  assert.ok(j.table && Array.isArray(j.table.rows));
  assert.ok(j.verdict && typeof j.verdict.verdict === 'string');
  assert.ok('budget' in j && 'chain' in j);
  assert.ok(Array.isArray(j.open), 'JSON 必须带待判列表');
  assert.equal(j.hasMismatch, false);
  assert.equal(r.status, 0);
  fs.rmSync(d, { recursive: true, force: true });
});