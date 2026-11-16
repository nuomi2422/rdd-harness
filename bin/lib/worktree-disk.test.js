'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspect } = require('./worktree-disk');
test('counts separate build outputs without descending or deleting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdd-disk-test-'));
  const a = path.join(root, 'tree a'), b = path.join(root, 'tree b');
  fs.mkdirSync(path.join(a, 'plugins', 'rdd', 'build', 'build'), { recursive: true });
  fs.mkdirSync(path.join(a, '.gradle'), { recursive: true });
  fs.mkdirSync(path.join(b, 'build'), { recursive: true });
  const result = inspect(a, () => ({ status: 0, stdout: 'worktree ' + a + '\0HEAD abc\0\0worktree ' + b + '\0HEAD def\0\0' }));
  assert.equal(result.trees, 2); assert.equal(result.builtTrees, 2); assert.equal(result.outputs, 3);
  assert.equal(result.inaccessible, 0); assert.ok(result.volumes[0].free > 0);
  assert.ok(fs.existsSync(path.join(a, 'plugins', 'rdd', 'build', 'build')));
});
test('reports git failure and unreadable worktree', () => {
  assert.ok(inspect('missing', () => ({ status: 1, stdout: '' })).error);
  const r = inspect('missing', () => ({ status: 0, stdout: 'worktree ' + path.join(os.tmpdir(), 'rdd-absent-tree-1524') + '\0' }));
  assert.equal(r.inaccessible, 1); assert.equal(r.volumes[0].free, null);
});
