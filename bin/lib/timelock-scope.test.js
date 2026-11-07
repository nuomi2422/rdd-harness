'use strict';
const assert = require('node:assert');
const { excludedForRuntime, normalizeRuntime } = require('./timelock-scope');

const opencodeLock = { id: 'TL-2026-10-07-01', appliesTo: ['opencode'] };

assert.strictEqual(excludedForRuntime(opencodeLock, 'dsh'), true, 'dsh 应排除该锁');
assert.strictEqual(excludedForRuntime(opencodeLock, 'DSH'), true, '大小写归一');
assert.strictEqual(excludedForRuntime(opencodeLock, 'opencode'), false, 'opencode 仍适用');
assert.strictEqual(excludedForRuntime(opencodeLock, undefined), false, '缺省仍阻断');
assert.strictEqual(excludedForRuntime(opencodeLock, 'garbage'), false, '未知值仍阻断');
assert.strictEqual(excludedForRuntime({ id: 'x' }, 'dsh'), false, '无范围字段的锁照旧阻断');
assert.strictEqual(excludedForRuntime({ id: 'x', appliesTo: 'opencode' }, 'dsh'), false, '坏结构照旧阻断');
assert.strictEqual(excludedForRuntime({ id: 'x', appliesTo: ['dsh', 'bad'] }, 'dsh'), false, '含未知项视为坏结构');
assert.strictEqual(excludedForRuntime({ id: 'x', appliesTo: ['dsh'] }, 'dsh'), false, '合法 dsh 范围=适用于dsh，不排除');
assert.strictEqual(normalizeRuntime(''), null, '空值不归一');
console.log('timelock-scope tests: 10 passed');
