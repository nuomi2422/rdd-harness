'use strict';
// 端到端口径：regress 的退出码如何被验收表消费。
// 关键回归点（2026-11-09）：regress 在有 FLAKY 时返回 2；acceptance 的 cmd 判据只看 "exit 0 才 PASS"，
// 所以必须确认 exit 2 落到 FAIL 而不是 PASS —— 否则"首轮失败、重试通过"会被验收表悄悄当成成功。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const A = require('./lib/acceptance.js');

const manifest = {
  requirements: [{
    id: 'OFFLINE-REGRESS', batch: '底座', title: '离线回归全绿', required: true, level: 'offline',
    checks: [{ type: 'cmd', cmd: 'node bin/regress.js' }], uncovered: [],
  }],
};

const evalWithCode = (code, out) => A.evaluate(manifest, {
  root: path.resolve(__dirname, '..'),
  runCmd: () => ({ code, out: out || '' }),
  currentFp: 'testfp01',
  now: Date.parse('2026-11-09T00:00:00Z'),
});

test('regress 干净通过(exit 0) → 验收 PASS', () => {
  const r = evalWithCode(0, 'REGRESS PASS: 17 组');
  assert.equal(r.rows[0].status, 'PASS');
});

test('regress 有 FLAKY(exit 2) → 验收不得为 PASS', () => {
  const r = evalWithCode(2, 'REGRESS PASS: 17 组（FLAKY 1 组）');
  assert.notEqual(r.rows[0].status, 'PASS');
  assert.equal(r.rows[0].status, 'FAIL');
});

test('regress 有 FAIL(exit 1) → 验收 FAIL', () => {
  const r = evalWithCode(1, 'REGRESS FAIL: A1 尾读缺口');
  assert.equal(r.rows[0].status, 'FAIL');
});
