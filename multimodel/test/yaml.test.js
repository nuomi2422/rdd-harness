'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { parseYaml, YamlError } = require('../lib/yaml.js');

test('块状 mapping / sequence / flow 都能解析', () => {
  const doc = parseYaml([
    'apiVersion: rdd.harness/v1alpha1',
    'spec:',
    '  goal: "收集 3 个原木"',
    '  requires:',
    '    - worldstate.inventory.snapshot',
    '    - camera.capture',
    '  assertions:',
    '    - id: logs-net-gain',
    '      predicate: inventory.delta_gte',
    '      args: { itemTag: "minecraft:logs", value: 3 }',
    '  flags: [a, b]',
    '  nested:',
    '    a: 1',
    '    b: null',
    '    c: true',
  ].join('\n'));
  assert.equal(doc.apiVersion, 'rdd.harness/v1alpha1');
  assert.equal(doc.spec.requires.length, 2);
  assert.equal(doc.spec.assertions[0].id, 'logs-net-gain');
  assert.deepEqual(doc.spec.assertions[0].args, { itemTag: 'minecraft:logs', value: 3 });
  assert.deepEqual(doc.spec.flags, ['a', 'b']);
  assert.equal(doc.spec.nested.b, null);
  assert.equal(doc.spec.nested.c, true);
});

test('重复键必须被拒绝（YAML 会静默取后者）', () => {
  assert.throws(() => parseYaml('a: 1\na: 2\n'), (e) => e instanceof YamlError && /重复键/.test(e.message));
});

test('tab 缩进必须被拒绝', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), (e) => e instanceof YamlError && /tab/.test(e.message));
});

test('锚点 / 别名 / 标签 / 合并键 / 块标量 全部拒绝', () => {
  assert.throws(() => parseYaml('a: &anchor 1\n'), YamlError);
  assert.throws(() => parseYaml('a: *anchor\n'), YamlError);
  assert.throws(() => parseYaml('a: !tag 1\n'), YamlError);
  assert.throws(() => parseYaml('a:\n  <<: {b: 1}\n'), YamlError);
  assert.throws(() => parseYaml('a: |\n  text\n'), YamlError);
});

test('多文档分隔符拒绝', () => {
  assert.throws(() => parseYaml('a: 1\n---\nb: 2\n'), YamlError);
});

test('注释在引号内不算注释', () => {
  const doc = parseYaml('a: "x # y"  # 真注释\nb: 1\n');
  assert.equal(doc.a, 'x # y');
});

test('缩进跳级必须报错', () => {
  assert.throws(() => parseYaml('a:\n    b: 1\n  c: 2\n'), YamlError);
});

test('超过 maxBytes 拒绝（测试卡有大小上限）', () => {
  assert.throws(() => parseYaml('a: ' + 'x'.repeat(300), { maxBytes: 100 }), YamlError);
});

test('嵌套超过 maxDepth 拒绝', () => {
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push('  '.repeat(i) + `k${i}:`);
  lines.push('  '.repeat(40) + 'v: 1');
  assert.throws(() => parseYaml(lines.join('\n')), YamlError);
});

test('JSON 是 YAML 子集这条不许乱用：双引号串里的转义按 JSON 规', () => {
  const doc = parseYaml('a: "line\\nbreak"\n');
  assert.equal(doc.a, 'line\nbreak');
});

test('真实测试卡可以解析（回归：cards/*.yaml 全部可读）', () => {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'cards');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yaml'))) {
    const doc = parseYaml(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(doc.kind, 'TaskCard', f);
  }
});
