'use strict';
// 隔离测试：node bin/lib/p22-digest.test.js；不读写真实审计或游戏。
const assert = require('node:assert/strict');
const { evaluateDigestLedger } = require('./p22-digest');
const now = Date.parse('2026-11-08T10:00:00.000Z');
const row = (offset) => JSON.stringify({ at: new Date(now + offset).toISOString() });
const check = (text, pass, ageMs) => assert.deepEqual(evaluateDigestLedger(text, now), { pass, ageMs });
check(row(-1800000), true, 1800000);
check(row(-1800001), false, 1800001);
check(row(1), false, null);
check(row(-5000) + '\n' + row(1), true, 5000);
check('bad json\n' + JSON.stringify({ at: 'not-a-date' }), false, null);
check('', false, null);
check(null, false, null);
check(row(0), true, 0);
check(row(-1800001) + '\n' + row(1), false, 1800001);
check('bad json\n' + row(-5000), true, 5000);
console.log('p22-digest: 10 tests passed');
