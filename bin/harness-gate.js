#!/usr/bin/env node
'use strict';
/**
 * Only two project gates: preflight deployment, postflight record quality.
 * Why: user 2026-11-21 removed unrelated workflow/role/commit/timer gates.
 * preflight [--manifest expected-jars.json]; postflight --record path [--section heading].
 * An expected manifest is {instance:"absolute game directory",jars:[{file:"name.jar",sha256:"..."}]}.
 * No record argument means reminder only, never a claim that documentation passed.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const {spawnSync} = require('child_process');
const retired = new Set(['round','learn','code','precommit']);
const help = [
 'RDD: preflight = 部署/包件；postflight = 本次记录质量。',
 'node bin/harness-gate.js preflight [--manifest <目标制品清单>]',
 'node bin/harness-gate.js postflight --record <现有知识库文件> [--section <本次小节标题>]',
 '不传 --record 只提醒；同一文件可追加，不要求另建卡或多写索引。',
 'selftest / registry / explain；旧 --role/--since/--keyword 参数不再形成门禁。'
].join('\n');
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const inside = (root,file) => {const r=path.relative(path.resolve(root),path.resolve(file));return !path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);};
function value(argv,key) {
 const i=argv.indexOf(key);
 if(i<0)return null;
 if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error(key+' 缺少值');
 return argv[i+1];
}
function packages(mods, zip, io=fs) {
 const names=io.readdirSync(mods).filter(n=>/^(numen[-_]|numen_api)/i.test(n)&&/\.jar$/i.test(n)&&!/^_backup|\.bak[-_.]/i.test(n));
 if(!names.length)throw Error('目标实例没有启用的 Numen jar：'+mods);
 const mixins=new Map(), found=[];
 for(const name of names){
  const bytes=io.readFileSync(path.join(mods,name)),entries=zip.listEntries(bytes);
  if(!entries.some(e=>e.name.endsWith('.class')))throw Error(name+' 没有class或包损坏');
  for(const e of entries){
   if(!e.name.endsWith('.class')||e.name.includes('$')||!(/\/mixins?\//i.test(e.name)||/Mixin[A-Z]|Accessor\.class$/.test(e.name)))continue;
   if(mixins.has(e.name))throw Error('重复mixin：'+e.name+' 位于 '+mixins.get(e.name)+' 与 '+name);
   mixins.set(e.name,name);
  }
  found.push({file:name,sha256:sha(bytes)});
 }
 return found;
}
function expectedManifest(file,gameRoot,mods,io=fs) {
 const m=JSON.parse(io.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 if(!m.instance||path.resolve(m.instance)!==path.resolve(gameRoot))throw Error('清单实例与本次目标不符');
 if(!Array.isArray(m.jars)||!m.jars.length)throw Error('清单缺少目标jar及sha256');
 const seen=new Set();
 for(const entry of m.jars){
  if(typeof entry.file!=='string'||path.basename(entry.file)!==entry.file||!entry.file.endsWith('.jar')||!/^[a-f0-9]{64}$/i.test(entry.sha256||'')||seen.has(entry.file))
   throw Error('目标制品清单条目无效或重复');
  seen.add(entry.file);
  if(sha(io.readFileSync(path.join(mods,entry.file))).toLowerCase()!==entry.sha256.toLowerCase())throw Error('安装件哈希不符：'+entry.file);
 }
 return m.jars;
}
function preflight(reg,argv,ops={}) {
 const io=ops.io||fs,run=ops.run||spawnSync,gameRoot=value(argv,'--game-root')||reg.roots.live,mods=path.join(gameRoot,'mods');
 const zip=ops.zip||require(path.join(reg.roots.scripts,'verify-tools','classrefs.js'));
 const installed=packages(mods,zip,io),manifest=value(argv,'--manifest');
 if(manifest){
   const expected=expectedManifest(path.resolve(manifest),gameRoot,mods,io);
   const actual=new Map(installed.map(x=>[x.file,x.sha256.toLowerCase()]));
   const missing=expected.filter(x=>!actual.has(x.file)).map(x=>x.file);
   const extra=installed.filter(x=>!expected.some(e=>e.file===x.file)).map(x=>x.file);
   const changed=expected.filter(x=>actual.has(x.file)&&actual.get(x.file)!==x.sha256.toLowerCase()).map(x=>x.file);
   if(actual.size!==expected.length||missing.length||extra.length||changed.length)
    throw Error('实际启用jar集合与清单不一致：缺少='+missing.join(',')+'；多余='+extra.join(',')+'；哈希变化='+changed.join(','));
  const refs=zip.check(mods);
  if(!refs.ok)throw Error('当前包引用了缺失的Numen类：'+JSON.stringify(refs.missing).slice(0,1400));
  return {id:'DEPLOY',state:'PASS',detail:'目标实例、启用jar集合、逐件哈希、包可读性、类引用和mixin核对通过；只证明已安装，不代签游戏效果。',instance:gameRoot,installed};
 }
 const checker=path.join(reg.roots.scripts,'verify-tools','check-runtime-deployment.js');
 const r=run(process.execPath,[checker,'--src',reg.roots.numen,'--mods',mods],{encoding:'utf8',timeout:240000,windowsHide:true,maxBuffer:16<<20});
 const out=((r.stdout||'')+'\n'+(r.stderr||'')).trim();
 if(r.status!==0||!/VERDICT=DEPLOYED\b/.test(out))throw Error('部署核验未通过：exit='+r.status+'\n'+out.slice(-6000));
 return {id:'DEPLOY',state:'PASS',detail:out,instance:gameRoot,installed};
}
function sectionText(text,heading) {
 if(!heading){
  const body=text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'');
  if(body.split(/\r?\n/).filter(line=>/^#{2,6}\s+/.test(line)).length>1)
   throw Error('文件包含多个小节，必须用 --section 指定本次记录，避免旧记录掩盖本次缺项');
  return body;
 }
 const lines=text.split(/\r?\n/),start=lines.findIndex(l=>l.trim()===heading.trim()||l.replace(/^#+\s*/,'').trim()===heading.trim());
 if(start<0)throw Error('找不到本次小节：'+heading);
 const level=(lines[start].match(/^#+/)||[''])[0].length;
 let end=lines.length;
 if(level)for(let i=start+1;i<lines.length;i++){const m=lines[i].match(/^(#+)\s/);if(m&&m[1].length<=level){end=i;break;}}
 return lines.slice(start,end).join('\n');
}
function recordQuality(file,knowledge,heading,io=fs) {
 const real=io.realpathSync(file),root=io.realpathSync(knowledge);
 if(!inside(root,real))throw Error('记录应更新现有知识库主题，不放Harness或旧档案目录');
 const all=io.readFileSync(real,'utf8').replace(/^\uFEFF/,''),body=sectionText(all,heading);
 const metadata=all.match(/^---\r?\n([\s\S]*?)\r?\n---/);
 if(!metadata)throw Error('记录缺少知识库元数据');
 for(const key of ['docId','kind','status','updatedAt'])if(!new RegExp('^'+key+':\\s*\\S','m').test(metadata[1]))throw Error('记录缺元数据：'+key);
 // Accept existing field names. Test the selected current section, not another run in the file.
 for(const [name,re]of [
  ['目标/判据',/(?:目标|判据|预期|目的|意图)[^\n:：]*[:：][ \t]*\S/],
  ['实际动作',/(?:实际动作|实际操作|操作|动作|做了什么)[^\n:：]*[:：][ \t]*\S/],
  ['原证',/(?:看到什么|原始证据|原证|证据|数据源|观察)[^\n:：]*[:：][ \t]*\S/],
  ['结果/未知与下一步',/(?:结论|结果)[^\n:：]*[:：][ \t]*\S/]
 ])if(!re.test(body))throw Error('本次记录缺少有内容的'+name);
 if(!/\b(?:PASS|FAIL|UNKNOWN|NOT_COVERED)\b|通过|失败|未知|未覆盖/.test(body))throw Error('结论需说清通过、失败、未知或未覆盖');
 if(!/\d{4}-\d{2}-\d{2}|run[-_:=： ]|V-\d{8}-|时间[码窗：:]/i.test(body))throw Error('本次记录缺少可定位的时间或run身份');
 if(/(?:待填|TODO|TBD|<[^>]*(?:填写|填入)[^>]*>)/i.test(body))throw Error('本次记录还有未填占位符');
 const unknown=/\bUNKNOWN\b|\bNOT_COVERED\b|未知|未覆盖/.test(body);
 if(!unknown&&!/\.jsonl(?:[#:]|\b)|\.log\b|sha256|[a-f0-9]{64}|!\[|https?:\/\/|时间码|退出码/i.test(body))
  throw Error('有明确结果但缺原始日志、制品哈希、媒体或命令退出码等原证位置');
 return {id:'RECORD',state:'PASS',detail:'本次记录的落点、结构及证据字段已核对；事实是否足以支持结论仍由复核者看原件。',file:real,body};
}
function postflight(reg,argv,ops={}) {
 const record=value(argv,'--record');
 if(!record)return {id:'RECORD',state:'REMINDER',detail:'退场请更新原主题：目标/判据、实际动作、原证、结果。写完用 --record 路径检查；未进行记录质量核验。'};
 const io=ops.io||fs,r=recordQuality(path.resolve(record),reg.roots.knowledge,value(argv,'--section'),io);
 const run=ops.run||spawnSync;
 if(/\.jsonl\b/i.test(r.body)){
  const checker=path.join(reg.roots.scripts,'verify-tools','check-evidence-anchor.js');
  // Check only the selected current section; old runs in the same file cannot block it.
  const temp=fs.mkdtempSync(path.join(require('os').tmpdir(),'rdd-record-'));
  try{
   fs.writeFileSync(path.join(temp,'record.md'),r.body);
   const p=run(process.execPath,[checker,'--cards',temp,'--card','record.md','--monitor',path.join(reg.roots.live,'config','numen','monitor'),'--json'],
     {encoding:'utf8',timeout:120000,windowsHide:true,maxBuffer:8<<20});
   if(p.status!==0)throw Error('证据坐标未对上或读取失败：'+((p.stdout||'')+(p.stderr||'')).slice(-4000));
   const evidence=JSON.parse(p.stdout);
   if(!Array.isArray(evidence.hard)||evidence.hard.length)throw Error('证据校验结果不完整或仍有错误');
   r.detail+=' 坐标核对：'+evidence.total+'条；警告'+(evidence.warn||[]).length+'条。';
  }finally{
   if(path.dirname(temp)===path.resolve(require('os').tmpdir())&&path.basename(temp).startsWith('rdd-record-'))fs.rmSync(temp,{recursive:true,force:true});
  }
 }
 delete r.body;
 return r;
}
function audit(reg,phase,row) {
 try{
  const dir=path.join(reg._meta.root,'.harness','audit');fs.mkdirSync(dir,{recursive:true});
  fs.appendFileSync(path.join(dir,'gate-usage.jsonl'),JSON.stringify({at:new Date().toISOString(),schema:'two-gates-v1',gate:phase,result:row.state,items:[row.id],detail:row.detail,record:row.file||null,instance:row.instance||null})+'\n');
 }catch(e){console.error('记录门禁回执失败：'+e.message);}
}
function main(argv=process.argv.slice(2),ops={}) {
 const [mode,...args]=argv;
 if(!mode||['help','--help','-h'].includes(mode)){console.log(help);return 0;}
 if(retired.has(mode)){console.log('VERDICT=RETIRED '+mode+'流程门禁已删除；仅保留部署和记录质量两项。');return 0;}
 if(mode==='selftest'){
  const r=(ops.run||spawnSync)(process.execPath,['--test',path.join(__dirname,'two-gates.test.js')],{stdio:'inherit',windowsHide:true});
  return r.status===0?0:3;
 }
 const reg=ops.reg||require('./lib/registry').load();
 if(mode==='registry'||mode==='explain'){console.log(help+'\nDEPLOY: 核对目标实例的安装件，拒绝错包、坏包、缺失引用、重复mixin。\nRECORD: 仅核本次记录及原证，不查角色、闹钟、提交、索引数或记忆灌入。');return 0;}
 if(!['preflight','postflight'].includes(mode)){console.error(help);return 2;}
 if(args.includes('--title-only')||args.includes('--instance')){console.log('VERDICT=DIAGNOSTIC_ONLY 旧标题页探测不是游戏安装/世界验证，不读live实例。');return 2;}
 let row;
 try{row=mode==='preflight'?preflight(reg,args,ops):postflight(reg,args,ops);}
 catch(e){row={id:mode==='preflight'?'DEPLOY':'RECORD',state:'BLOCK',detail:e.message};}
 console.log(row.state==='BLOCK'?'✘ '+row.id+' '+row.detail:row.id+' '+row.detail);
 console.log(' PASS='+(row.state==='PASS'?1:0)+'  WARN=0  BLOCK='+(row.state==='BLOCK'?1:0));
 console.log(' VERDICT='+(row.state==='BLOCK'?'BLOCKED':row.state));
 audit(reg,mode,row);
 return row.state==='BLOCK'?1:0;
}
module.exports={packages,expectedManifest,sectionText,recordQuality,preflight,postflight,main};
if(require.main===module){try{process.exit(main());}catch(e){console.error(e.message);process.exit(3);}}
