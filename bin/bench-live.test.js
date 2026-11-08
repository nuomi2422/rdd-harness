'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const L = require('./lib/bench-live');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'ai.jsonl');
}
test('partial UTF-8 and line survive polls and restart', t => {
  const f = fixture(t), c = {};
  const b = Buffer.from('{"text":"中文"}\n');
  fs.writeFileSync(f, b.subarray(0, 11));
  let r = L.readTail(f, 0, 100, c);
  assert.deepEqual(r.lines, []); assert.equal(r.offset, 0);
  fs.appendFileSync(f, b.subarray(11));
  r = L.readTail(f, r.offset, 100, c);
  assert.equal(JSON.parse(r.lines[0]).text, '中文');
  assert.equal(L.readTail(f, r.offset, 100, c).lines.length, 0);
  assert.equal(L.readTail(f, 0, 100, {}).lines.length, 1);
});
test('truncation, same-size overwrite and replacement detected', t => {
  const f = fixture(t), c = {};
  fs.writeFileSync(f, '{"a":1}\n'); let r = L.readTail(f, 0, 100, c);
  fs.writeFileSync(f, '{"b":2}\n'); r = L.readTail(f, r.offset, 100, c);
  assert.equal(r.reset, true); assert.deepEqual(r.lines, ['{"b":2}']);
  fs.writeFileSync(f, 'x\n'); r = L.readTail(f, r.offset, 100, c);
  assert.equal(r.reason, 'truncated');
  const replacement = f + '.new'; fs.writeFileSync(replacement, 'y\n'); fs.renameSync(replacement, f);
  r = L.readTail(f, r.offset, 100, c); assert.equal(r.reset, true);
});
test('window drops fragment even when it resembles valid JSON across polls', t => {
  const f = fixture(t), c = {};
  fs.writeFileSync(f, 'abcdefghij{"ok":1}');
  let r = L.readTail(f, 0, 8, c); assert.ok(r.skipped); assert.deepEqual(r.lines, []);
  fs.appendFileSync(f, '\n{"ok":2}\n');
  r = L.readTail(f, r.offset, 100, c); assert.deepEqual(r.lines, ['{"ok":2}']);
});
test('watch once exposes malformed and window gaps in status and view', t => {
  const f = fixture(t), dir = path.dirname(f), out = path.join(dir, 'out');
  fs.writeFileSync(f, 'x'.repeat(2 * 1024 * 1024) + '\nnot-json\n' + JSON.stringify({type:'assistant',data:{text:'ok'}}) + '\n');
  fs.writeFileSync(path.join(dir, 'context.jsonl'), JSON.stringify({type:'llm_response',data:{actor:'supervisor',response:{tool_calls:{}}}}) + '\n' + JSON.stringify({type:'llm_response',data:{actor:'supervisor',response:{content:'after malformed'}}}) + '\n');
  const r = spawnSync(process.execPath, [path.join(__dirname,'bench-watch.js'),'--once','--monitor',dir,'--out',out], {encoding:'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(fs.readFileSync(path.join(out,'status.json')));
  assert.ok(st.files['ai.jsonl'].gaps); assert.equal(st.files['ai.jsonl'].malformed, 1);
  const chat = fs.readFileSync(path.join(out,'chat.md'),'utf8');
  assert.match(chat, /UNKNOWN.*gaps=1/);
  assert.match(chat, /after malformed/);
  assert.equal(st.files['context.jsonl'].malformed, 1);
  assert.match(st.files['context.jsonl'].lastMalformedError, /map/);
  assert.equal(st.files['tools.jsonl'].gapReason, 'unavailable');
});
test('live loop rejects malformed observer and recovers on later ticks', { timeout: 25000 }, async t => {
  const f = fixture(t), dir = path.dirname(f), out = path.join(dir, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'watch.json'), JSON.stringify({enabled:true, interval_s:5}));
  const observer = path.join(dir, 'observer.jsonl');
  fs.writeFileSync(observer, JSON.stringify({type:'observer_tick',data:{nearby:{}}}) + '\n');
  const rdd = path.join(dir, 'rdd.jsonl');
  const record = (type, data) => JSON.stringify({type, data}) + '\n';
  fs.writeFileSync(rdd, record('taskchain_snapshot', {taskChain:{goalId:'valid-first',primaries:[{id:'good'}]}}) + record('requirement_manifest', {rows:[{key:'valid-row'}]}));
  const child = spawn(process.execPath, [path.join(__dirname,'bench-watch.js'),'--monitor',dir,'--out',out], {stdio:'ignore'});
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const until = async predicate => {
    const end = Date.now() + 18000;
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error('watch exited ' + child.exitCode);
      try { const s = JSON.parse(fs.readFileSync(path.join(out,'status.json'))); if (predicate(s)) return s; } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('watch tick timeout');
  };
  const first = await until(s => s.ticks >= 1 && s.files && s.files['observer.jsonl']);
  assert.equal(first.files['observer.jsonl'].malformed, 1);
  assert.match(fs.readFileSync(path.join(out,'snapshot.md'),'utf8'), /UNKNOWN/);
  assert.match(fs.readFileSync(path.join(out,'chain.md'),'utf8'), /valid-first/);
  fs.appendFileSync(observer, JSON.stringify({type:'observer_tick',data:{nearby:[],watched:{position:{x:17,y:8,z:9}}}}) + '\n');
  fs.appendFileSync(rdd, record('taskchain_snapshot', {taskChain:{goalId:'bad',primaries:[null]}}) + record('requirement_manifest', {rows:[null]}));
  const second = await until(s => s.ticks >= 2);
  assert.equal(second.files['observer.jsonl'].malformed, 1);
  assert.equal(second.files['rdd.jsonl'].malformed, 2);
  const chain = fs.readFileSync(path.join(out,'chain.md'),'utf8');
  assert.match(chain, /valid-first/); assert.match(chain, /valid-row/);
  assert.doesNotMatch(chain, /goal_id=bad/); assert.match(chain, /UNKNOWN/);
  assert.match(fs.readFileSync(path.join(out,'snapshot.md'),'utf8'), /pos=\(17,8,9\)/);
  assert.match(fs.readFileSync(path.join(out,'chat.md'),'utf8'), /UNKNOWN/);
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
});

for (const failure of ['render', 'write']) {
  test('single view ' + failure + ' failure falls back and recovers', { timeout: 20000 }, async t => {
    const f = fixture(t), dir = path.dirname(f), out = path.join(dir, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'watch.json'), JSON.stringify({enabled:true, interval_s:5, views:['chat','chain']}));
    fs.writeFileSync(path.join(out, 'chat.md'), 'STALE VIEW');
    const marker = path.join(dir, 'inject-failure');
    fs.writeFileSync(marker, 'on');
    const rdd = path.join(dir, 'rdd.jsonl');
    const record = goalId => JSON.stringify({type:'taskchain_snapshot',data:{taskChain:{goalId,primaries:[{id:'good'}]}}}) + '\n';
    fs.writeFileSync(rdd, record('other-first'));
    fs.writeFileSync(f, JSON.stringify({type:'assistant',data:{text:'chat-recovers'}}) + '\n');
    // Patch only this child process; fault affects chat once per tick, not its fallback write.
    const script =       'const fs=require("fs"),path=require("path");' +
      'const [lib,watch,monitor,out,marker,mode]=process.argv.slice(1);' +
      'const L=require(lib),render=L.render,write=L.writeAtomic;' +
      'L.render=function(v,...args){if(mode==="render"&&v==="chat"&&fs.existsSync(marker))throw Error("injected render failure");return render.call(this,v,...args)};' +
      'L.writeAtomic=function(file,text){if(mode==="write"&&file===path.join(out,"chat.md")&&fs.existsSync(marker)&&!String(text).startsWith("# chat\\n\\nUNKNOWN"))throw Error("injected write failure");return write.call(this,file,text)};' +
      'process.argv=[process.execPath,watch,"--monitor",monitor,"--out",out];require(watch);';
    const child = spawn(process.execPath, ['-e', script, path.join(__dirname,'lib','bench-live.js'), path.join(__dirname,'bench-watch.js'), dir, out, marker, failure], {stdio:'ignore'});
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const until = async predicate => {
      const end = Date.now() + 14000;
      while (Date.now() < end) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('watch exited: ' + child.exitCode + '/' + child.signalCode);
        try { const s = JSON.parse(fs.readFileSync(path.join(out,'status.json'))); if (predicate(s)) return s; }
        catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('watch tick timeout');
    };
    const first = await until(s => s.ticks >= 1 && !s.starting);
    assert.ok(first.errors.some(e => e.includes('view chat: injected ' + failure + ' failure')));
    assert.ok(!first.last_writes.includes('chat.md'));
    assert.ok(first.last_writes.includes('chain.md'));
    const fallback = fs.readFileSync(path.join(out,'chat.md'),'utf8');
    assert.match(fallback, /^# chat\n\nUNKNOWN：本拍视图生成失败/);
    assert.doesNotMatch(fallback, /STALE VIEW/);
    assert.match(fs.readFileSync(path.join(out,'chain.md'),'utf8'), /other-first/);
    fs.unlinkSync(marker);
    fs.appendFileSync(rdd, record('other-second'));
    const second = await until(s => s.ticks >= 2);
    assert.ok(second.last_writes.includes('chat.md'));
    assert.ok(second.last_writes.includes('chain.md'));
    const recovered = fs.readFileSync(path.join(out,'chat.md'),'utf8');
    assert.match(recovered, /chat-recovers/);
    assert.doesNotMatch(recovered, /本拍视图生成失败/);
    assert.match(fs.readFileSync(path.join(out,'chain.md'),'utf8'), /other-second/);
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  });
}

