'use strict';
// Reuse the frozen fixture, never alter its original 25 assertions or invoke production preflight.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const frozen = fs.readFileSync(path.join(__dirname, 'p7-trace.test.js'), 'utf8');
const boundary = frozen.indexOf("test('P7 tracked record content diff");
assert.ok(boundary > 0);
const { fixture, pass, block } = vm.runInNewContext(
  frozen.slice(0, boundary) + '\n({fixture,pass,block});', { require, __dirname, process, console });

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
