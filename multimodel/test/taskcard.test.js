'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadCard, safeJoin, stableStringify, TaskCardError } = require('../lib/taskcard.js');
const { loadCatalog } = require('../lib/capabilities.js');
const { loadPolicies } = require('../lib/router.js');

const MMM = path.resolve(__dirname, '..');
const CARDS = path.join(MMM, 'cards');

function ctx() {
  const catalog = loadCatalog();
  const policies = loadPolicies();
  return { predicates: catalog.predicates, roles: policies.routing.roles, budgets: policies.budgets };
}

function tmpCard(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdd-card-'));
  const file = path.join(dir, 'card.yaml');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const MINIMAL = [
  'apiVersion: rdd.harness/v1alpha1',
  'kind: TaskCard',
  'metadata:',
  '  id: test.minimal-card',
  '  version: 1',
  'spec:',
  '  goal: "最小可校验测试卡，用于单元测试"',
  '  environment:',
  '    profile: sandbox',
  '    controlMode: autonomous',
  '  requires:',
  '    - worldstate.inventory.snapshot',
  '  baseline:',
  '    - key: logsBefore',
  '      query: inventory.count',
  '  execution:',
  '    deadlineSeconds: 60',
  '    maxActions: 5',
  '  observation:',
  '    profile: state_exact_visual_context',
  '    requiredSources: [worldstate]',
  '  assertions:',
  '    - id: net-gain',
  '      predicate: inventory.delta_gte',
  '      args: { baselineKey: logsBefore, owner: targetCompanion, value: 1 }',
  '  budget:',
  '    policyRef: survival-small-v1',
  '',
].join('\n');

test('合法测试卡：加载成功并冻结两个哈希', () => {
  const info = loadCard(tmpCard(MINIMAL), ctx());
  assert.equal(info.card.metadata.id, 'test.minimal-card');
  assert.match(info.lock.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(info.lock.canonicalSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(info.lock.sourceSha256, info.lock.canonicalSha256);
});

test('冻结哈希对「注释/空白变化」稳定，对「语义变化」敏感', () => {
  const a = loadCard(tmpCard(MINIMAL), ctx());
  const b = loadCard(tmpCard('# 只是注释\n\n' + MINIMAL.replace('  version: 1', '  version: 1   ')), ctx());
  assert.equal(a.lock.canonicalSha256, b.lock.canonicalSha256);
  assert.notEqual(a.lock.sourceSha256, b.lock.sourceSha256);
  const c = loadCard(tmpCard(MINIMAL.replace('value: 1', 'value: 2')), ctx());
  assert.notEqual(a.lock.canonicalSha256, c.lock.canonicalSha256);
});

test('未知字段被 Schema 拒绝（不许悄悄忽略）', () => {
  const bad = MINIMAL + '  surprise: 1\n';
  assert.throws(() => loadCard(tmpCard(bad), ctx()), (e) => e.code === 'SCHEMA_INVALID' && /surprise/.test(JSON.stringify(e.details)));
});

test('未注册谓词被语义对账拒绝', () => {
  const bad = MINIMAL.replace('inventory.delta_gte', 'inventory.magic_check');
  assert.throws(() => loadCard(tmpCard(bad), ctx()), (e) => e.code === 'SEMANTIC_INVALID' && /未注册谓词/.test(e.details.join(' ')));
});

test('baselineKey 不存在必须拒绝（否则断言会永远算 0）', () => {
  const bad = MINIMAL.replace('baselineKey: logsBefore', 'baselineKey: logsNever');
  assert.throws(() => loadCard(tmpCard(bad), ctx()), (e) => /baselineKey/.test(e.details.join(' ')));
});

test('fixture 路径名字符集受限，且 safeJoin 挡住越界', () => {
  const bad = MINIMAL.replace('    profile: sandbox', '    profile: sandbox\n    fixture: "../../etc/passwd"');
  assert.throws(() => loadCard(tmpCard(bad), ctx()), (e) => e.code === 'SCHEMA_INVALID');
  assert.throws(() => safeJoin('D:\\base', '../outside.json'), (e) => e.code === 'PATH_ESCAPE');
  assert.equal(safeJoin('D:\\base', 'inside.json').endsWith('inside.json'), true);
});

test('strict_dual_quantity 缺 UI 能力 → 语义拒绝（不许只改档位名）', () => {
  const bad = MINIMAL
    .replace('state_exact_visual_context', 'strict_dual_quantity')
    .replace('requiredSources: [worldstate]', 'requiredSources: [worldstate, camera]');
  assert.throws(() => loadCard(tmpCard(bad), ctx()), (e) => e.code === 'SEMANTIC_INVALID' && /strict_dual_quantity/.test(e.details.join(' ')));
});

test('仓库里的示例卡全部合法', () => {
  for (const f of fs.readdirSync(CARDS).filter((n) => n.endsWith('.yaml'))) {
    const info = loadCard(path.join(CARDS, f), ctx());
    assert.ok(info.card.spec.assertions.length >= 1, f);
  }
});

test('stableStringify 与键序无关', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }), stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 }));
});
