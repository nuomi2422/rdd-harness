'use strict';
// Reuse the frozen fixture, never alter its original 25 assertions or invoke production preflight.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const frozen = fs.readFileSync(path.join(__dirname, 'p7-trace.test.js'), 'utf8');
const boundary = frozen.indexOf("test('P7 tracked record content diff");
assert.ok(boundary > 0);
const { fixture, pass, block, before, fresh } = vm.runInNewContext(
  frozen.slice(0, boundary) + '\n({fixture,pass,block,before,fresh});', { require, __dirname, process, console });

for (const word of ['memory_search_nodes', 'memory_create_entities', 'memory_add_observations']) {
  for (const separator of ['\n', ' ']) test('P7 old prose plus only tool word is not new prose: '+word+JSON.stringify(separator), t => {
    const f = fixture(t), old = fs.readFileSync(f.record, 'utf8');
    f.update(f.record, old.trimEnd() + separator + word + '\n');
    block(f.run());
  });
}
test('P7 old prose plus real new prose and tool word is accepted', t => {
  const f = fixture(t), old = fs.readFileSync(f.record, 'utf8');
  f.update(f.record, old + 'Newly verified cause and regression evidence. memory_search_nodes\n');
  pass(f.run(), /001-existing\.md/);
});
test('P7 Git failure cannot be masked by valid evidence in the other repo', t => {
  const f = fixture(t);
  f.update(f.standard, '# Standards\nNew actual rule.\n');
  const original = require('node:child_process').spawnSync;
  let failuresInjected = 0;
  require('node:child_process').spawnSync = function(exe, args, options) {
    if (args.includes('rev-list') && path.resolve(options.cwd) === path.resolve(f.docsRepo)) {
      failuresInjected++;
      return {status:1,stdout:'',stderr:'fixture Git read failure'};
    }
    return original.call(this, exe, args, options);
  };
  try { const r=f.run(); assert.equal(failuresInjected,1); block(r); assert.match(r.output,/UNKNOWN.*Git/); }
  finally { require('node:child_process').spawnSync=original; }
});
for (const operation of ['readFileSync', 'lstatSync']) test('P7 unreadable candidate '+operation+' cannot hide behind valid evidence', t => {
  const f = fixture(t);
  f.update(f.standard, '# Standards\nNew actual rule.\n');
  f.update(f.record, '# Finding\nReal changed content.\n');
  const original = fs[operation];
  fs[operation] = function(file,...args) {
    if (String(file)===f.record) throw Object.assign(new Error('fixture access denied'), {code:'EACCES'});
    return original.call(this,file,...args);
  };
  try { const r=f.run(); block(r); assert.match(r.output,/UNKNOWN.*fixture access denied/); }
  finally { fs[operation]=original; }
});

// Current knowledge bodies are not postflight verification-card roots; keep the original fixture intact.
const bodies = [
  ['架构意图', '034-架构思维导航MCP.md'],
  ['施工文档', '044-验证先行的任务链与学习闭环总施工单.md'],
  ['Bug修复', '008-修复台账-2026-11.md'],
  ['批次卡', '049-20261116-复杂类职责拆分与原档验证.md'],
];
function bodyFixture(t, folder, name) {
  const f = fixture(t), file = path.join(f.knowledge, folder, name);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  f.update(file, '# Original body\nOriginal finding.\n');
  f.git(f.docsRepo, ['add', '--', file]);
  f.git(f.docsRepo, ['commit', '-qm', 'existing current body'],
    {env:{...process.env,GIT_AUTHOR_DATE:before,GIT_COMMITTER_DATE:before}});
  fs.utimesSync(file, new Date(before), new Date(before));
  fs.utimesSync(path.dirname(file), new Date(before), new Date(before));
  assert.equal(f.git(f.docsRepo, ['status', '--porcelain']), '');
  return {...f, file};
}
for (const [folder, name] of bodies) {
  test('P7 current knowledge committed body with old mtime: '+folder, t => {
    const f = bodyFixture(t, folder, name);
    f.update(f.file, '# Current body\nVerified cause, precise change and remaining regression boundary.\n');
    f.git(f.docsRepo, ['add', '--', f.file]);
    f.git(f.docsRepo, ['commit', '-qm', 'real current body change'],
      {env:{...process.env,GIT_AUTHOR_DATE:fresh,GIT_COMMITTER_DATE:fresh}});
    fs.utimesSync(f.file, new Date(before), new Date(before));
    fs.utimesSync(path.dirname(f.file), new Date(before), new Date(before));
    const r = f.run();
    assert.equal(r.result.state, 'PASS', r.output);
    pass(r); assert.ok(r.output.includes(name), r.output);
  });
  test('P7 current knowledge new Markdown without record copy: '+folder, t => {
    const f = fixture(t), file = path.join(f.knowledge, folder, 'nested', name);
    fs.mkdirSync(path.dirname(file), {recursive:true});
    f.update(file, '# New current body\nActual finding, evidence and regression boundary.\n');
    fs.utimesSync(path.dirname(file), new Date(before), new Date(before));
    const r = f.run();
    assert.equal(r.result.state, 'PASS', r.output);
    pass(r); assert.ok(r.output.includes(name), r.output);
  });
}
for (const mode of ['mtime only', 'MCP words only', 'unchanged baseline with CRLF']) {
  test('P7 current knowledge rejects '+mode, t => {
    const f = bodyFixture(t, ...bodies[0]), old = fs.readFileSync(f.file, 'utf8');
    if (mode === 'mtime only') fs.utimesSync(f.file, new Date(fresh), new Date(fresh));
    else f.update(f.file, mode === 'MCP words only'
      ? old + 'memory_search_nodes memory_create_entities memory_add_observations\n'
      : old.replace(/\r?\n/g, '\r\n'));
    block(f.run());
  });
}
test('P7 current knowledge does not include sibling root with same prefix', t => {
  const f = fixture(t), file = path.join(f.docsRepo, '知识库-unrelated', 'real.md');
  fs.mkdirSync(path.dirname(file), {recursive:true});
  f.update(file, '# Unrelated\nReal prose outside the canonical knowledge root.\n');
  block(f.run());
});
test('P7 current knowledge unreadable body cannot hide behind standards', t => {
  const f = bodyFixture(t, ...bodies[0]);
  f.update(f.file, '# Current body\nNew real content.\n');
  f.update(f.standard, '# Standards\nNew actual rule.\n');
  const original = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (String(file) === f.file) throw Object.assign(new Error('current body access denied'), {code:'EACCES'});
    return original.call(this, file, ...args);
  };
  try { const r = f.run(); block(r); assert.match(r.output, /UNKNOWN.*current body access denied/); }
  finally { fs.readFileSync = original; }
});
