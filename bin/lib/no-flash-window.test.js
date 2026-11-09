'use strict';
// 防回归：bin/ 下所有 spawn/spawnSync 调用必须显式 windowsHide（stdio:'inherit' 除外，它复用父控制台）。
// 2026-11-09 主人反馈"脚本窗闪一下抢焦点"，根因排查中；这条防同类遗漏。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const files = ['bench.js', 'bench-watch.js', 'bench-live.js', 'exp-runner.js'].map((n) => path.join(__dirname, '..', n));

test('子进程调用必须带 windowsHide（inherit 除外）', () => {
  const offenders = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/spawnSync\(|\bspawn\(/.test(line)) return;
      if (/windowsHide/.test(line)) return;
      if (/stdio:\s*'inherit'/.test(line)) return;
      // 允许 opts 在下一行续写已含 windowsHide 的情况
      const next = lines[i + 1] || '';
      if (/windowsHide/.test(next)) return;
      offenders.push(path.basename(f) + ':' + (i + 1) + ' ' + line.trim().slice(0, 80));
    });
  }
  assert.deepEqual(offenders, []);
});
