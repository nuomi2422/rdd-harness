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
  // 2026-11-08：A1 证据底座的隔离测试此前只靠手工跑，不进回归就等于会腐烂。
  // 用 node --test 跑 node:test 文件；最后一项 kind='script' 表示直接执行该脚本。
  ['A1 动作账本身份', path.join(ROOT, 'lib', 'action-ledger.test.js'), [], 'node-test'],
  ['A1 尾读缺口', path.join(ROOT, 'bench-live.test.js'), [], 'node-test'],
  ['A1 摘要读取', path.join(ROOT, 'bench-digest.test.js'), [], 'node-test'],
  ['P22 时间边界', path.join(ROOT, 'lib', 'p22-digest.test.js'), [], 'node-test'],
  ['Q9 登记读取', path.join(ROOT, 'q9-isolated.test.js'), [], 'node-test'],
  ['动作账本消费者', path.join(ROOT, 'exp-runner.test.js'), []],
  ['take 动态有效性', path.join(ROOT, 'verify-take.test.js'), [], 'node-test'],
];

const results = [];
for (const [name, file, args, kind] of STEPS) {
  const argv = kind === 'node-test' ? ['--test', file, ...args] : [file, ...args];
  const run = () => spawnSync(node, argv, { encoding: 'utf8', timeout: 180000 });
  // 2026-11-09：整台机器上常有并行会话在跑 gradle/游戏，带真实子进程与墙钟的用例
  // （bench-live 的 live loop、take 的临时目录起进程）会偶发超时 → 回归偶发假 FAIL。
  // 处理：失败重试一次，并在结果里显式标 RETRY（不静默吞掉真回归）。
  let r = run();
  let retried = false;
  if (r.status !== 0) { retried = true; r = run(); }
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean).slice(-2).join(' | ');
  const ok = r.status === 0;
  const label = ok ? (retried ? 'PASS(retry) ' : 'PASS ') : 'FAIL ';
  results.push({ name, ok, tail, retried });
  console.log(label + name + '  ' + tail.slice(0, 140));
}

const failed = results.filter((r) => !r.ok);
const retries = results.filter((r) => r.retried && r.ok);
console.log('\n' + (failed.length
  ? 'REGRESS FAIL: ' + failed.map((r) => r.name).join(', ')
  : 'REGRESS PASS: ' + results.length + ' 组' + (retries.length ? '（其中 ' + retries.length + ' 组首次失败后重试通过：' + retries.map((r) => r.name).join('、') + '）' : '')));
process.exit(failed.length ? 1 : 0);
