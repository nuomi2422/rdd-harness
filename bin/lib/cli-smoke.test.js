'use strict';
// CLI 冒烟：真实数据上把读端命令各跑一次，防止命令层回归（不判业务结论，只看能不能跑出结果）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BENCH = path.join(ROOT, 'bench.js');
const DIR = process.env.RDD_MONITOR || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
const has = fs.existsSync(path.join(DIR, 'tools.jsonl'));

const CASES = [
  { name: 'check', args: ['check', '--dir', DIR], allowStatus: [0, 1] },
  { name: 'chain', args: ['chain', '--dir', DIR], allowStatus: [0] },
  { name: 'budget', args: ['budget', '--dir', DIR], allowStatus: [0] },
  { name: 'digest', args: ['digest', '--dir', DIR, '--since', '600m'], allowStatus: [0] },
  { name: 'moment', args: ['moment', '2026-11-09T05:00:00Z', '--dir', DIR], allowStatus: [0] },
];

for (const c of CASES) {
  test('CLI 冒烟：' + c.name + ' 在真实数据上不崩、有输出', { skip: has ? false : '无真实 monitor' }, () => {
    const r = spawnSync(process.execPath, [BENCH, ...c.args], { encoding: 'utf8' });
    assert.ok(c.allowStatus.includes(r.status), c.name + ' 退出码=' + r.status + ' stderr=' + String(r.stderr).slice(0, 200));
    assert.ok(String(r.stdout).trim().length > 0, c.name + ' 应有输出');
  });
}

test('CLI 冒烟：验收表脚本可跑', { skip: has ? false : '无真实 monitor' }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'acceptance-table.js'), '--dir', DIR], { encoding: 'utf8' });
  assert.ok([0, 1].includes(r.status), '退出码=' + r.status);
  assert.match(String(r.stdout), /验收表|总判定/);
});
