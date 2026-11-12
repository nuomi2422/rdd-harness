'use strict';
// Real P7 collector + record/output/verdict, with real temporary Git autocrlf checkout.
// Do not modify frozen 25/10 contracts or production memory/Git configuration.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const frozen = fs.readFileSync(path.join(__dirname, 'p7-trace.test.js'), 'utf8');
const boundary = frozen.indexOf("test('P7 tracked record content diff");
assert.ok(boundary > 0);
const { fixture, pass, block, entity, before, fresh } = vm.runInNewContext(
  frozen.slice(0, boundary) + '\n({fixture,pass,block,entity,before,fresh});', { require, __dirname, process, console });
const crlf = s => s.replace(/\r?\n/g, '\r\n');
function checkout(t) {
  const f = fixture(t), name = path.relative(f.docsRepo, f.memory).replace(/\\/g, '/');
  f.git(f.docsRepo, ['config', 'core.autocrlf', 'true']);
  const old = f.git(f.docsRepo, ['show', 'HEAD:'+name]);
  assert.ok(old.endsWith('\n')); assert.ok(!old.includes('\r'));
  f.git(f.docsRepo, ['checkout-index', '--force', '--', name]);
  const current = fs.readFileSync(f.memory, 'utf8');
  assert.equal(current, crlf(old)); assert.notEqual(current, old);
  assert.match(f.git(f.docsRepo, ['ls-files', '--eol', '--', name]), /i[/]lf\s+w[/]crlf/);
  assert.equal(f.git(f.docsRepo, ['config', '--get', 'core.autocrlf']).trim(), 'true');
  return { ...f, name, old, current };
}
function verify(t, transform, accept=false) {
  const f=checkout(t), current=transform(f);
  f.update(f.memory, current);
  const bytes=fs.readFileSync(f.memory);
  const result=f.run();
  if(accept) pass(result, /memory有效追加/); else block(result);
  assert.deepEqual(fs.readFileSync(f.memory), bytes, 'P7 must never rewrite the candidate');
  assert.equal(f.git(f.docsRepo, ['config', '--get', 'core.autocrlf']).trim(), 'true');
}
test('P7 Git LF baseline and CRLF checkout accepts valid uncommitted append', t => {
  verify(t, f => f.current + crlf(entity('new')), true);
});
test('P7 Git LF baseline and committed CRLF append remains evidence with old mtime', t => {
  const f=checkout(t);
  f.update(f.memory, f.current + crlf(entity('committed-new')));
  f.git(f.docsRepo, ['add', '--', f.name]);
  f.git(f.docsRepo, ['commit', '-qm', 'actual append'], {env:{...process.env,GIT_AUTHOR_DATE:fresh,GIT_COMMITTER_DATE:fresh}});
  fs.utimesSync(f.memory, new Date(before), new Date(before));
  const bytes=fs.readFileSync(f.memory); pass(f.run(), /memory有效追加/);
  assert.deepEqual(fs.readFileSync(f.memory), bytes);
});
test('P7 CRLF prefix content rewrite plus valid append is rejected', t => {
  verify(t, f => f.current.replace('Actual finding', 'Rewritten finding') + crlf(entity('new')));
});
test('P7 LF to CRLF conversion without new records is rejected', t => {
  verify(t, f => crlf(f.old));
});
test('P7 pure old CRLF records with fresh mtime remain rejected', t => {
  const f=checkout(t), bytes=fs.readFileSync(f.memory);
  fs.utimesSync(f.memory, new Date(fresh), new Date(fresh)); block(f.run());
  assert.deepEqual(fs.readFileSync(f.memory), bytes);
});
test('P7 CRLF prefix JSON whitespace rewrite plus append is rejected', t => {
  verify(t, f => ' ' + f.current + crlf(entity('new')));
});
test('P7 CRLF prefix JSON key reorder plus append is rejected', t => {
  verify(t, f => crlf(JSON.stringify({name:'old',type:'entity',entityType:'Verification',observations:['Actual finding and original evidence.']})+'\n') + crlf(entity('new')));
});
test('P7 CRLF prefix deletion and replacement is rejected', t => {
  verify(t, () => crlf(entity('new')));
});
test('P7 CRLF memory emptied is rejected', t => { verify(t, () => ''); });
test('P7 CRLF malformed appended JSON is rejected', t => { verify(t, f => f.current + '{bad}\r\n'); });
test('P7 CRLF duplicate-only append is rejected', t => { verify(t, f => f.current + f.current); });
