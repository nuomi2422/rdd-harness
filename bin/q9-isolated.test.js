'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual builtinChecks function, with every dependency confined to memory.
const source = fs.readFileSync(path.join(__dirname, 'harness-gate.js'), 'utf8');
const start = source.indexOf('function builtinChecks(ctx, phase) {');
const end = source.indexOf('// ── selftest', start);
assert.ok(start >= 0 && end > start);
const code = source.slice(start, end) + ';builtinChecks(ctx, "postflight");';

function run({ names = ['100-new.md'], files = {}, fresh = [] } = {}) {
  const records = [];
  const targets = ['/index/a.md', '/index/b.md', '/index/c.md'];
  const fakeFs = {
    statSync(p) {
      if (!(p in files) || files[p] === 'STAT_FAIL') { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
      return { isFile: () => true };
    },
    readFileSync(p) {
      assert.ok(targets.includes(p), 'unexpected filesystem read: ' + p);
      if (files[p] === 'READ_FAIL') { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return files[p];
    },
  };
  const sandbox = {
    fs: fakeFs, path, process: { env: {} },
    REG: { timeLocks: { locks: [] }, roots: { docsUnified: '/docs' }, docNumbers: {
      root: '/docs', ledger: '/ledger', pattern: /^(\d{2,3})-/, nextDocNo: 100,
      registerIn: targets.map(p => p + ' §注释'),
    } },
    ctx: { since: new Date('2026-01-01'), stageTxt: '' },
    BLOCK: 'BLOCK', PASS: 'PASS', WARN: 'WARN',
    listDir: () => names, isFile: () => false, readText: () => '',
    freshEnough: p => fresh.includes(path.basename(p)),
    excludedForRuntime: () => false,
    record: (...args) => records.push(args),
    require: () => { throw new Error('unexpected require'); },
  };
  vm.runInNewContext(code, sandbox, { timeout: 1000 });
  const result = records.filter(r => r[0] === 'Q9');
  assert.equal(result.length, 1);
  return { state: result[0][4], detail: result[0][5] };
}
test('Q12 actual reminder uses the exit checklist without parallel document instructions', () => {
  const a = source.indexOf("    record('Q12',");
  const b = source.indexOf('\n  }', a);
  assert.ok(a >= 0 && b > a);
  const rows = [];
  vm.runInNewContext(source.slice(a, b), { ASK: 'ASK', record: (...args) => rows.push(args) });
  assert.equal(rows.length, 1);
  assert.deepEqual(Array.from(rows[0].slice(0, 5)), ['Q12', '写记录 + 写文档', 'ask', 'human', 'ASK']);
  const detail = rows[0][5];
  assert.match(detail, /001-退游戏检查单\.md/);
  assert.match(detail, /批次卡、实验数据\/验证卡/);
  assert.match(detail, /memory_create_entities \/ memory_add_observations/);
  assert.match(detail, /Q2 \/ Q3 \/ Q5 \/ Q9/);
  assert.doesNotMatch(detail, /docsUnified|NN-<中文名>|编号接现有最大号|同时登记 3 处/);
});

test('Q16 preserves records without automatic pruning or parallel checklist', () => {
  const a = source.indexOf("    record('Q16',");
  const b = source.indexOf('\n  }', a);
  const rows = [];
  vm.runInNewContext(source.slice(a, b), { ASK: 'ASK', record: (...args) => rows.push(args) });
  assert.equal(rows[0][4], 'ASK');
  assert.match(rows[0][5], /001-退游戏检查单\.md/);
  assert.match(rows[0][5], /验证卡.*记忆图谱/);
  assert.doesNotMatch(rows[0][5], /--prune --apply|自己删掉|别自己定了/);
});

test('Q10 sampling keeps original states without claiming a save receipt', () => {
  const a = source.indexOf("  if (roleCheck('Q10',");
  const b = source.indexOf('// Q11', a);
  for (const n of ['0', '2', '']) {
    const rows = [];
    vm.runInNewContext(source.slice(a, b), { WARN: 'WARN', PASS: 'PASS',
      roleCheck: () => true, titleSkip: () => false,
      spawnSync: () => ({ stdout: n }), record: (...args) => rows.push(args) });
    assert.equal(rows[0][4], n === '0' ? 'PASS' : 'WARN');
    assert.match(rows[0][5], /实停回执/);
    assert.doesNotMatch(rows[0][5], /用 mc.stop 关/);
  }
});

const all = text => ({ '/index/a.md': text, '/index/b.md': text, '/index/c.md': text });

test('readable registered targets pass', () => {
  assert.equal(run({ files: all('100-new.md'), fresh: ['100-new.md'] }).state, 'PASS');
});
test('missing target blocks even with no documents', () => {
  const r = run({ names: [], files: { '/index/a.md': '', '/index/b.md': '' } });
  assert.equal(r.state, 'BLOCK'); assert.match(r.detail, /无法读取/); assert.match(r.detail, /ENOENT/); assert.doesNotMatch(r.detail, /全部是历史债/);
});
test('successful stat followed by failed read blocks, not historical debt', () => {
  const r = run({ files: { ...all('100-new.md'), '/index/b.md': 'READ_FAIL' } });
  assert.equal(r.state, 'BLOCK'); assert.match(r.detail, /EACCES/); assert.match(r.detail, /不是历史债/); assert.doesNotMatch(r.detail, /b.md 缺/);
});
test('readable empty target is a genuine missing registration', () => {
  const files = { ...all('100-new.md'), '/index/b.md': '' };
  const fresh = run({ files, fresh: ['100-new.md'] });
  assert.equal(fresh.state, 'BLOCK'); assert.doesNotMatch(fresh.detail, /无法读取/);
  const old = run({ files });
  assert.equal(old.state, 'WARN'); assert.match(old.detail, /历史债/); assert.doesNotMatch(old.detail, /无法读取/);
});
test('multiple missing entries for a fresh document are not historical debt', () => {
  const r = run({ files: all(''), fresh: ['100-new.md'] });
  assert.equal(r.state, 'BLOCK'); assert.doesNotMatch(r.detail, /历史债/);
});
