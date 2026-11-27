'use strict';
// 防"写了测试但没登记"：bin/lib 下每个 *.test.js 都必须在 regress.js 里有条目。
// 起因（2026-11-10）：timelock-scope.test.js 能跑通，却一直没进回归。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');

const LIB = __dirname;
const REGRESS = path.join(__dirname, '..', 'regress.js');

test('每个 lib 测试文件都已登记进回归清单', { skip: fs.existsSync(REGRESS) ? false : '无 regress.js' }, () => {
  const reg = fs.readFileSync(REGRESS, 'utf8');
  const files = fs.readdirSync(LIB).filter((n) => n.endsWith('.test.js'));
  const missing = files.filter((n) => !reg.includes(n));
  assert.deepEqual(missing, [], '未登记：' + missing.join(', ') + '（写了测试不登记 = 没测）');
});

test('根目录实验测试与自检脚本都已登记进回归清单', { skip: fs.existsSync(REGRESS) ? false : '无 regress.js' }, () => {
  const reg = fs.readFileSync(REGRESS, 'utf8');
  const bin = path.join(__dirname, '..');
  const files = fs.readdirSync(bin).filter((n) => /^exp-.*\.test\.js$/.test(n));
  const scripts = ['exp-card.js', 'exp-craft-ab.js', 'exp-night-ab.js', 'exp-curve.js'];
  const missing = files.filter((n) => !reg.includes(n)).concat(scripts.filter((n) => !reg.includes(n)));
  assert.deepEqual(missing, [], '未登记：' + missing.join(', ') + '（写了实验测试/自检不登记 = 没测）');
});
