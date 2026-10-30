'use strict';
/**
 * regress.js —— A7（99 号）回归守卫（离线部分）。
 *
 * 一条命令跑完各批的离线判据；任一失败即非零退出。
 * **不自动起游戏**：实机 smoke 仍由人触发（99 号 §2）。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname);
const node = process.execPath;

const STEPS = [
  ['A0 证据链', path.join(ROOT, 'lib', 'a0-evidence.js'), ['selftest']],
  ['A3 四层事实', path.join(ROOT, 'lib', 'situation.js'), ['selftest']],
  ['A7 实验口径', path.join(ROOT, 'lib', 'experiment.js'), ['selftest']],
  ['A7 动作证据账本', path.join(ROOT, 'lib', 'action-ledger.js'), ['selftest']],
  ['统一验收表', path.join(ROOT, 'lib', 'acceptance.js'), ['selftest']],
  ['H21 观测账', path.join(ROOT, 'lib', 'noshot.js'), ['selftest']],
  ['全新存档', path.join(ROOT, 'new-world.js'), ['--selftest']],
  ['H1 虚空守卫', path.join(ROOT, 'lib', 'guard.js'), ['selftest']],
  ['bench 自检', path.join(ROOT, 'bench.js'), ['selftest']],
  ['harness-gate 自检', path.join(ROOT, 'harness-gate.js'), ['selftest']],
];

const results = [];
for (const [name, file, args] of STEPS) {
  const r = spawnSync(node, [file, ...args], { encoding: 'utf8', timeout: 180000 });
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean).slice(-2).join(' | ');
  const ok = r.status === 0;
  results.push({ name, ok, tail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  ' + tail.slice(0, 140));
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length
  ? 'REGRESS FAIL: ' + failed.map((r) => r.name).join(', ')
  : 'REGRESS PASS: ' + results.length + ' 组'));
process.exit(failed.length ? 1 : 0);
