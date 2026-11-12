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
  // 2026-11-09：原来 stdio:'ignore'，子进程异常退出时**没有任何证据**可查
  // （19:53 那次 "watch exited 1" 就因此无法定位）。这里捕获 stderr 尾部，仅用于报错，
  // 不改断言、不改超时。
  let childErr = '';
  const child = spawn(process.execPath, [path.join(__dirname,'bench-watch.js'),'--monitor',dir,'--out',out], {stdio:['ignore','ignore','pipe']});
  child.stderr.on('data', (b) => { if (childErr.length < 8000) childErr += b.toString('utf8'); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const until = async predicate => {
    const end = Date.now() + 18000;
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error('watch exited ' + child.exitCode + ' stderr=' + childErr.slice(-600));
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
      'process.argv=[process.execPath,watch,"--monitor",monitor,"--out",out];require(watch).main();';
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


test('late-arriving rows are counted as a gap, and rotation resets the baseline', t => {
  const f = fixture(t), dir = path.dirname(f), out = path.join(dir, 'out');
  const rec = (type, ts, extra) => JSON.stringify({ type, timestamp: ts, data: extra || {} }) + '\n';
  // 先写较新的一条，再写一条业务时间更早的 —— 这条就是"事后才补写进来"的晚到行
  fs.writeFileSync(f, rec('assistant', '2026-11-08T10:00:10.000Z', { text: 'newer' })
    + rec('assistant', '2026-11-08T10:00:00.000Z', { text: 'late-arrived' }));
  let r = spawnSync(process.execPath, [path.join(__dirname, 'bench-watch.js'), '--once', '--monitor', dir, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  let st = JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8'));
  assert.equal(st.files['ai.jsonl'].late, 1, '晚到行要计 1');
  assert.equal(st.files['ai.jsonl'].lastLateBizAt, '2026-11-08T10:00:00.000Z');
  assert.match(fs.readFileSync(path.join(out, 'chat.md'), 'utf8'), /late=1/);
  // 轮转后不应把整个新文件误判成晚到
  fs.writeFileSync(f + '.new', rec('assistant', '2026-11-08T09:00:00.000Z', { text: 'after-rotate' }));
  fs.renameSync(f + '.new', f);
  r = spawnSync(process.execPath, [path.join(__dirname, 'bench-watch.js'), '--once', '--monitor', dir, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  st = JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8'));
  assert.equal(st.files['ai.jsonl'].late, 0, '轮转后基线必须重置');
});

// 047: production collectOnce -> existing evidence-pack -> plugin official boundary.
function windowFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-end-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const monitor = path.join(dir, 'monitor'), out = path.join(dir, 'live');
  fs.mkdirSync(monitor); fs.mkdirSync(out);
  for (const stream of ['tools', 'events', 'context', 'rdd']) fs.writeFileSync(path.join(monitor, stream + '.jsonl'), stream === 'tools' ? JSON.stringify({timestamp:'2026-11-12T00:00:30Z',session:'run047',category:stream,event_seq:1,world_id:'world047',server_session:'server047',type:'tool_call',data:{companion_id:'companion047',tool_call_id:'call047',tool:'mine'}})+'\n' : '');
  const logFile = path.join(dir, 'latest.log'); fs.writeFileSync(logFile, '');
  const st = fs.statSync(logFile);
  const binding = {windowKey:'window047',worldId:'world047',serverSession:'server047',companion:'companion047',run:'run047',targetSession:'session-047',since:'2026-11-12T00:00:00Z',logFile,encoding:'utf-8',timezone:'+00:00',source:{offset:0,size:0,identity:st.dev+':'+st.ino,anchorStart:0,anchor:'',boundAt:'2026-11-12T00:00:00Z'}};
  const state = L.newState({monitor});
  const tick = () => require('./bench-watch').collectOnce(state,{monitor,out,views:['snapshot'],now:Date.parse('2026-11-12T00:02:00Z'),bridgeWindow:binding});
  const stop = '[1211月2026 00:00:59.000] [Render thread/INFO] [net.minecraft.client.Minecraft/]: Stopping!\r\n';
  const save = '[1211月2026 00:01:00.000] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: All dimensions are saved\r\n';
  return {dir,monitor,out,logFile,binding,state,tick,stop,save,notice:path.join(out,'bench-bridge-binding.json')};
}
test('normal end writer connects actual collectOnce package and plugin once', async t => {
  const f = windowFixture(t); Object.assign(f.binding,L.bindWindow(f.out,f.binding,Date.parse(f.binding.since))); fs.appendFileSync(f.logFile, f.stop + f.save);
  f.tick();
  assert.ok(fs.existsSync(f.notice), 'actual collectOnce must export normal-end binding');
  const b = JSON.parse(fs.readFileSync(f.notice,'utf8'));
  const bytes = fs.readFileSync(b.packageFile), pack=JSON.parse(bytes);
  const hash = require('crypto').createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash,b.packageSha256); assert.equal(pack.rows[0].ref,'tools.jsonl:1');
  assert.equal(pack.rows[0].identityStatus,'UNKNOWN'); assert.equal(b.end.kind,'normal-end');
  assert.equal(b.logProof.saved.byteOffset,Buffer.byteLength(f.stop));
  const {apply} = await import('../plugins/dsh-bench-bridge/lib/index.js'); const sent=[];
  const ctx={agents:{get:id=>({id,session:{header:{origin:'primary'}},followup:m=>sent.push(m)})},effect:cb=>cb(),logger:{info(){}}};
  const bridge=apply(ctx,{enabled:true,targetSession:f.binding.targetSession,bindingFile:f.notice,stateFile:path.join(f.dir,'delivery.json')},{createUserMessage:x=>x,now:()=>Date.parse('2026-11-12T00:02:00Z')});
  t.after(()=>bridge.dispose());
  assert.equal((await bridge.tick()).state,'DELIVERED'); f.tick();
  assert.equal((await bridge.tick()).state,'DELIVERED'); assert.equal(sent.length,1);
  assert.equal(sent[0].source.kind,'plugin:dsh-bench-bridge'); assert.ok(sent[0].content[0].text.length<=1200);
  console.log('writer fixture scope and notice',JSON.stringify({binding:f.binding,notice:b,pack,logBase64:fs.readFileSync(f.logFile).toString('base64'),toolsBase64:fs.readFileSync(path.join(f.monitor,'tools.jsonl')).toString('base64'),packageBase64:bytes.toString('base64'),sent}));
});

for (const [name,edit,reason] of [
  ['autosave only', f=>fs.appendFileSync(f.logFile,f.save)],
  ['save before stopping', f=>fs.appendFileSync(f.logFile,f.save+f.stop)],
  ['half saved line', f=>fs.appendFileSync(f.logFile,f.stop+f.save.trimEnd()),'partial-log-line'],
  ['missing scope', f=>{delete f.binding.companion;fs.appendFileSync(f.logFile,f.stop+f.save)},'window-scope-incomplete'],
  ['old marker timestamps', f=>{f.binding.since='2026-11-12T00:01:30Z';f.binding.source.boundAt=f.binding.since;fs.appendFileSync(f.logFile,f.stop+f.save)},'log-time-outside-window'],
  ['reversed timestamps', f=>fs.appendFileSync(f.logFile,f.stop.replace('00:00:59','00:01:01')+f.save),'log-time-reversed'],
  ['future timestamp', f=>fs.appendFileSync(f.logFile,f.stop+f.save.replace('00:01:00','00:03:00')),'log-time-outside-window'],
  ['invalid calendar', f=>fs.appendFileSync(f.logFile,f.stop.replace('1211月','3211月')+f.save),'log-time-invalid'],
  ['invalid utf8', f=>fs.appendFileSync(f.logFile,Buffer.concat([Buffer.from(f.stop),Buffer.from([255,10]),Buffer.from(f.save)])),'invalid-log-encoding'],
  ['lookalike chat payload', f=>fs.appendFileSync(f.logFile,f.stop.replace('net.minecraft.client.Minecraft/','Numen/')+f.save)],
  ['skipped log budget', f=>fs.appendFileSync(f.logFile,'x'.repeat(2*1024*1024)+f.stop+f.save),'log-read-gap'],
]) test('normal end writer rejects '+name,t=>{
  const f=windowFixture(t);edit(f);f.tick();assert.equal(fs.existsSync(f.notice),false);
  if(reason) {assert.equal(f.state.bridge.status,'UNKNOWN');assert.equal(f.state.bridge.reason,reason);}
});
test('normal end writer waits for LF then consumes exact CRLF byte hashes',t=>{
  const f=windowFixture(t);fs.appendFileSync(f.logFile,f.stop+f.save.slice(0,-1));f.tick();assert.equal(fs.existsSync(f.notice),false);
  fs.appendFileSync(f.logFile,'\n');f.tick();const b=JSON.parse(fs.readFileSync(f.notice));
  assert.equal(b.logProof.saved.sha256,require('crypto').createHash('sha256').update(Buffer.from(f.save.slice(0,-1))).digest('hex'));
});
test('normal end writer replacement and truncation fail closed after bound prefix',t=>{
  for(const replace of [false,true]){
    const f=windowFixture(t);fs.writeFileSync(f.logFile,'bound-prefix\n');
    f.binding=L.bindWindow(f.out,f.binding,Date.parse(f.binding.since));
    if(replace){fs.renameSync(f.logFile,f.logFile+'.old');fs.writeFileSync(f.logFile,f.stop+f.save);}else fs.writeFileSync(f.logFile,f.stop+f.save);
    // fixture tick closes over the original binding; invoke production with the captured binding explicitly.
    require('./bench-watch').collectOnce(f.state,{monitor:f.monitor,out:f.out,views:['snapshot'],now:Date.parse('2026-11-12T00:02:00Z'),bridgeWindow:f.binding});
    assert.equal(f.state.bridge.status,'UNKNOWN');assert.equal(fs.existsSync(f.notice),false);
  }
});
test('normal end writer detects same-window mutation and restart avoids rewriting package',t=>{
  const f=windowFixture(t);fs.appendFileSync(f.logFile,f.stop+f.save);f.tick();const before=fs.readFileSync(f.notice,'utf8');
  const fresh=L.newState({monitor:f.monitor});require('./bench-watch').collectOnce(fresh,{monitor:f.monitor,out:f.out,views:['snapshot'],bridgeWindow:f.binding});
  assert.equal(fresh.bridge.status,'NOTIFIED');assert.equal(fs.readFileSync(f.notice,'utf8'),before);
  f.binding.targetSession='another-session';f.tick();assert.equal(f.state.bridge.status,'UNKNOWN');assert.equal(f.state.bridge.reason,'window-binding-conflict');
  assert.equal(fs.readFileSync(f.notice,'utf8'),before);
});
test('normal end writer generated notice binds plugin target and queue rejection remains pending',async t=>{
  const f=windowFixture(t);fs.appendFileSync(f.logFile,f.stop+f.save);f.tick();const {apply}=await import('../plugins/dsh-bench-bridge/lib/index.js');let attempts=0;
  const ctx={agents:{get:id=>({id,followup:()=>{attempts++;throw new Error('queue rejected')}})},effect:cb=>cb(),logger:{info(){}}};
  const cfg={enabled:true,targetSession:f.binding.targetSession,bindingFile:f.notice,stateFile:path.join(f.dir,'delivery.json')};
  const runtime={createUserMessage:x=>x,now:()=>Date.parse('2026-11-12T00:02:00Z')};
  const p=apply(ctx,cfg,runtime);t.after(()=>p.dispose());assert.equal((await p.tick()).state,'PENDING');f.tick();assert.equal((await p.tick()).state,'PENDING');assert.equal(attempts,1);
  const wrong=apply(ctx,{...cfg,targetSession:'other'},runtime);t.after(()=>wrong.dispose());assert.equal((await wrong.tick()).reason,'host-target-conflict');assert.equal(attempts,1);
});
test('unconfigured production collectOnce has no bridge state or artifacts',t=>{
  const f=windowFixture(t);require('./bench-watch').collectOnce(f.state,{monitor:f.monitor,out:f.out,views:['snapshot']});
  assert.equal(f.state.bridge,undefined);assert.deepEqual(fs.readdirSync(f.out),['snapshot.md']);
});
test('bind-window snapshots EOF through existing reader, keeps binding on ordinary control edits and rejects same-window changes',t=>{
  const f=windowFixture(t);fs.appendFileSync(f.logFile,f.stop+f.save);const b=L.bindWindow(f.out,f.binding,Date.parse('2026-11-12T00:01:30Z'));
  assert.equal(b.source.offset,Buffer.byteLength(f.stop+f.save));L.saveControl(f.out,{interval_s:10},'test');assert.deepEqual(L.loadControl(f.out).bridgeWindow,b);
  assert.deepEqual(L.bindWindow(f.out,f.binding),b);assert.throws(()=>L.bindWindow(f.out,{...f.binding,targetSession:'another'}),/window-binding-conflict/);
  const state=L.newState({monitor:f.monitor});require('./bench-watch').collectOnce(state,{monitor:f.monitor,out:f.out,views:['snapshot'],bridgeWindow:b});
  assert.equal(fs.existsSync(f.notice),false,'old complete stop/save before EOF never replayed');
});
test('bind-window public CLI uses the same production binder with explicit temporary out',t=>{
  const f=windowFixture(t), input=path.join(f.dir,'host.json');
  const b={...f.binding,since:new Date(Date.now()-1000).toISOString()};delete b.source;fs.writeFileSync(input,JSON.stringify(b));
  const run=spawnSync(process.execPath,[path.join(__dirname,'bench.js'),'live','bind-window',input,'--out',f.out],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(JSON.parse(run.stdout).windowKey,b.windowKey);assert.equal(L.loadControl(f.out).bridgeWindow.source.offset,0);
});
test('normal end writer explicit gb18030 source decodes real localized date markers',t=>{
  const f=windowFixture(t);f.binding.encoding='gb18030';
  // These markers are ASCII except 月, encoded D4 C2 in GB18030.
  const encode=s=>Buffer.concat(s.split('月').flatMap((part,i)=>i?[Buffer.from([0xd4,0xc2]),Buffer.from(part)]:[Buffer.from(part)]));
  fs.appendFileSync(f.logFile,encode(f.stop+f.save));f.tick();assert.equal(f.state.bridge.status,'NOTIFIED');
});

test('normal end writer actual watch --once loads persisted host binding',t=>{
  const f=windowFixture(t);L.saveControl(f.out,{bridgeWindow:f.binding},'test');fs.appendFileSync(f.logFile,f.stop+f.save);
  const run=spawnSync(process.execPath,[path.join(__dirname,'bench-watch.js'),'--once','--monitor',f.monitor,'--out',f.out],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(JSON.parse(fs.readFileSync(path.join(f.out,'status.json'))).bridge.status,'NOTIFIED');
  assert.equal(JSON.parse(fs.readFileSync(f.notice)).targetSession,f.binding.targetSession);
});
