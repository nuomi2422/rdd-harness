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
  // 只有"起真实子进程 + 按墙钟计时"的用例才允许重试（见下方 RETRYABLE 说明）。
  ['A1 尾读缺口', path.join(ROOT, 'bench-live.test.js'), [], 'node-test', 'wallclock'],
  ['A1 摘要读取', path.join(ROOT, 'bench-digest.test.js'), [], 'node-test'],
  ['P22 时间边界', path.join(ROOT, 'lib', 'p22-digest.test.js'), [], 'node-test'],
  ['Q9 登记读取', path.join(ROOT, 'q9-isolated.test.js'), [], 'node-test'],
  ['动作账本消费者', path.join(ROOT, 'exp-runner.test.js'), []],
  ['take 动态有效性', path.join(ROOT, 'verify-take.test.js'), [], 'node-test', 'wallclock'],
];

/**
 * 重试口径（2026-11-09，经另一位指挥官纠正后收紧）：
 * - 只对**起真实子进程 + 按墙钟计时**的用例（STEPS 第 5 项标 'wallclock'）重试一次。
 *   这类用例会在机器被并行会话压满时超时，属"间歇失败"，不是判据本身有问题。
 * - **数据完整性/身份/时间边界类用例一律不重试**（action-ledger / bench-digest / p22 / q9）：
 *   它们出现失败就是真信号，自动重试等于把丢数据刷成绿。
 * - 重试通过**不算干净通过**：状态记 'FLAKY'，首轮退出码/耗时/日志尾行全部保留并打印，
 *   汇总里单列。`--strict` 时 FLAKY 也判失败（机器空载跑基线时建议用）。
 * - 重试仍失败 → 'FAIL'，按失败处理。
 * - **"首轮失败、重试通过"只能说明这次是间歇失败；资源压力只是候选原因，也可能是真实竞态/丢数据**，
 *   所以必须保留首轮证据供复查，不能把 FLAKY 当"已排除风险"。
 */
const STRICT = process.argv.includes('--strict');
const results = [];
for (const [name, file, args, kind, retryKind] of STEPS) {
  const argv = kind === 'node-test' ? ['--test', file, ...args] : [file, ...args];
  const runOnce = () => {
    const t0 = Date.now();
    const r = spawnSync(node, argv, { encoding: 'utf8', timeout: 180000 });
    return { r, ms: Date.now() - t0 };
  };
  const tailOf = (r) => ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean).slice(-2).join(' | ');

  const first = runOnce();
  let final = first, state, firstEvidence = null;
  if (first.r.status === 0) {
    state = 'PASS';
  } else if (retryKind === 'wallclock') {
    firstEvidence = { exit: first.r.status, ms: first.ms, tail: tailOf(first.r).slice(0, 300) };
    const second = runOnce();
    final = second;
    state = second.r.status === 0 ? 'FLAKY' : 'FAIL';
  } else {
    state = 'FAIL';
  }

  const ok = state === 'PASS' || state === 'FLAKY';
  const label = state === 'PASS' ? 'PASS ' : state === 'FLAKY' ? 'FLAKY' : 'FAIL ';
  results.push({ name, ok, state, tail: tailOf(final.r), ms: final.ms, first: firstEvidence });
  console.log(label + ' ' + name + '  ' + tailOf(final.r).slice(0, 140) + '  [' + final.ms + 'ms]');
  if (firstEvidence) {
    console.log('      首轮失败证据（保留供复查，不代表已排除风险）：exit=' + firstEvidence.exit
      + ' ' + firstEvidence.ms + 'ms  尾行=' + firstEvidence.tail);
  }
}

const failed = results.filter((r) => r.state === 'FAIL' || (STRICT && r.state === 'FLAKY'));
const flaky = results.filter((r) => r.state === 'FLAKY');
console.log('\n' + (failed.length
  ? 'REGRESS FAIL: ' + failed.map((r) => r.name).join(', ')
  : 'REGRESS PASS: ' + results.length + ' 组'
    + (flaky.length ? '（**FLAKY ' + flaky.length + ' 组，不算干净通过**：' + flaky.map((r) => r.name).join('、')
        + '；这些是墙钟用例，间歇失败的原因未定，资源压力只是候选，需另行复查是否真实竞态）' : '')));
process.exit(failed.length ? 1 : 0);
