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
