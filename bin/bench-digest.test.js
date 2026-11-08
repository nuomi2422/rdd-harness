'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-test-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const bin = path.join(root, 'harness', 'rdd-harness', 'bin');
  const mon = path.join(root, 'mc', 'The Best of Twilight Forest', 'config', 'numen', 'monitor');
  fs.mkdirSync(bin, {recursive:true}); fs.mkdirSync(mon, {recursive:true});
  fs.copyFileSync(path.join(__dirname, 'bench-digest.js'), path.join(bin, 'bench-digest.js'));
  const put = (name, text) => fs.writeFileSync(path.join(mon, name + '.jsonl'), text);
  const run = () => { const p = spawnSync(process.execPath, [path.join(bin, 'bench-digest.js'), '--full', '--json'], {encoding:'utf8'}); assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout).text; };
  return {root, put, run};
}
const row = (type, data, timestamp = new Date().toISOString()) => JSON.stringify({type, data, timestamp}) + '\n';
test('missing, broken and unterminated sources are UNKNOWN', t => {
  const f = fixture(t); f.put('ai', 'bad\n'); f.put('tools', row('tool_call', {tool:'goto'}).trim());
  const s = f.run(); assert.match(s, /坏行/); assert.match(s, /末行未结束/); assert.match(s, /读取失败/); assert.doesNotMatch(s, /本轮没有明显异常/); assert.match(s, /世界身份：UNKNOWN/);
  assert.ok(fs.existsSync(path.join(f.root,'.harness','audit','bench-digest.jsonl')));
});
test('future events excluded and results are never positionally paired', t => {
  const f = fixture(t); f.put('ai', ''); f.put('rdd', row('death', {}, new Date(Date.now()+86400000).toISOString()));
  f.put('tools', row('tool_call',{tool:'mine',tool_call_id:'a'}) + row('tool_call',{tool:'goto',tool_call_id:'b'}) + row('tool_result',{tool:'goto',tool_call_id:'b',result:{success:true,data:{async:true,task_id:'t'}}}) + row('tool_result',{tool_call_id:'a',result:{success:false,message:'bad'}}));
  const s=f.run(); assert.match(s,/事件 0 条/); assert.ok(s.includes('goto id=b：受理/执行中，终态 UNKNOWN')); assert.match(s,/UNKNOWN id=a：回执失败/); assert.doesNotMatch(s,/mine id=a：回执失败/);
});
test('tail truncation is visible and stall is not called clean', t => {
  const f=fixture(t); f.put('ai', ' '.repeat(8*1024*1024+100)+'\n'); f.put('tools',''); f.put('rdd',row('stall',{}));
  const s=f.run(); assert.match(s,/前部截断/); assert.match(s,/停滞事件 1 条/); assert.doesNotMatch(s,/未检出上述线索/);
});

test('explicit async rejection stays failure and unscoped read calls are not claimed continuous', t => {
  const f=fixture(t); f.put('ai',''); f.put('rdd','');
  f.put('tools', Array.from({length:5},()=>row('tool_call',{tool:'get_self_status'})).join('') + row('tool_result',{tool:'goto',tool_call_id:'x',result:{success:false,data:{async:true}}}));
  const s=f.run(); assert.match(s,/goto id=x：回执失败/); assert.match(s,/不能证明同一主体连续只读/); assert.doesNotMatch(s,/连续只读调用 5 次/);
});
