#!/usr/bin/env node
'use strict';
// coding-audit.js —— 编码 AI 当天合规红绿灯（只读）
// 数据源：gate-usage.jsonl / git log / 知识库记录 / 批次卡 / bench usage / bench live。
// 输出：--json 机器可读；默认文字。只报“有证据”和“未知”，不替 AI 补结论。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RDD = 'D:/rdd';
const LEDGER = path.join(RDD, '.harness/audit/gate-usage.jsonl');
const REPO = path.join(RDD, 'workspace/minecraft-numen');
const KNOW = path.join(RDD, 'docs/rdd-docs/知识库');
const BENCH_USAGE = path.join(RDD, 'harness/rdd-harness/experiments/usage.jsonl');
const BENCH_LIVE = path.join(RDD, 'harness/rdd-harness/experiments/live/strand.md');
const DAY = 24 * 3600 * 1000;

function readJsonl(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { const r = JSON.parse(l); if (r.gate === 'unknown') { const ids = Array.isArray(r.items) ? r.items : []; const hasP = ids.some((i) => String(i)[0] === 'P'); const hasQ = ids.some((i) => String(i)[0] === 'Q'); r.gate = hasP && hasQ ? 'selftest' : (hasQ ? 'postflight' : 'preflight'); } return r; } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
function mtime(p) { try { return fs.statSync(p).mtime; } catch (e) { return null; } }
function iso(d) { return d ? d.toISOString().slice(0, 19).replace('T', ' ') : null; }
function today(d) { return d && new Date(d).toDateString() === new Date().toDateString(); }

const ledger = readJsonl(LEDGER);
function lastOf(gate) { let r = null; for (const x of ledger) if (x.gate === gate || (x.gate === 'selftest' && (gate === 'preflight' || gate === 'postflight'))) r = x; return r; }
const lastCode = lastOf('code');
const lastPre = lastOf('preflight');
const lastPost = lastOf('postflight');

let commits = [];
try {
  const out = execFileSync('git', ['-C', REPO, 'log', '--since=24.hours.ago', '--format=%H %cI %s'], { encoding: 'utf8', timeout: 10000 });
  commits = out.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [hash, at, ...msg] = l.split(' '); return { hash, at, msg: msg.join(' ') }; });
} catch (e) { }

const codeAt = lastCode ? Date.parse(lastCode.at) : 0;
const afterCode = commits.filter((c) => Date.parse(c.at) > codeAt);

const recDir = path.join(KNOW, '记录');
let recs = [];
try { recs = fs.readdirSync(recDir).filter((n) => n.endsWith('.md') && !['README.md', '000-总汇报.md'].includes(n)).map((n) => ({ name: n, at: mtime(path.join(recDir, n)) })); } catch (e) { }
const mainRec = recs.find((r) => /主干活|编码|驾驶员/.test(r.name)) || null;
const latestRec = recs.sort((a, b) => b.at - a.at)[0] || null;

const cardDir = path.join(KNOW, '批次卡');
let cards = [];
try { cards = fs.readdirSync(cardDir).filter((n) => n.endsWith('.md')).map((n) => ({ name: n, at: mtime(path.join(cardDir, n)) })); } catch (e) { }
const latestCard = cards.sort((a, b) => b.at - a.at)[0] || null;

const benchUsage = readJsonl(BENCH_USAGE);
const benchLast = benchUsage[benchUsage.length - 1] || null;
const liveAt = mtime(BENCH_LIVE);

function verdict(ok, warn) { return ok ? 'GREEN' : warn ? 'YELLOW' : 'RED'; }

const checks = [
  { id: 'code-gate', label: '写代码门禁', state: (lastCode && lastCode.result !== 'BLOCK' && afterCode.length === 0) ? 'GREEN' : (afterCode.length > 0 ? 'RED' : 'YELLOW'), detail: lastCode ? ('last=' + lastCode.at + ' ' + lastCode.result + '；之后 commit=' + afterCode.length) : '从没跑过', evidence: LEDGER },
  { id: 'preflight', label: '进游戏门禁', state: (lastPre && lastPre.result !== 'BLOCK' && Date.now() - Date.parse(lastPre.at) < DAY) ? 'GREEN' : (lastPre && Date.now() - Date.parse(lastPre.at) < 7 * DAY && lastPre.result !== 'BLOCK' ? 'YELLOW' : 'RED'), detail: lastPre ? ('last=' + lastPre.at + ' ' + lastPre.result) : '从没跑过', evidence: LEDGER },
  { id: 'postflight', label: '退游戏门禁', state: (lastPost && lastPost.result !== 'BLOCK' && Date.now() - Date.parse(lastPost.at) < DAY) ? 'GREEN' : (lastPost && Date.now() - Date.parse(lastPost.at) < 7 * DAY && lastPost.result !== 'BLOCK' ? 'YELLOW' : 'RED'), detail: lastPost ? ('last=' + lastPost.at + ' ' + lastPost.result) : '从没跑过', evidence: LEDGER },
  { id: 'record', label: '主干活记录', state: (mainRec && today(mainRec.at)) ? 'GREEN' : (latestRec && today(latestRec.at) ? 'YELLOW' : 'RED'), detail: mainRec ? ('last=' + iso(mainRec.at)) : (latestRec ? ('无主干活记录；最近=' + latestRec.name + ' ' + iso(latestRec.at)) : '记录/ 为空'), evidence: recDir },
  { id: 'batch-card', label: '批次卡', state: (latestCard && today(latestCard.at)) ? 'GREEN' : 'RED', detail: latestCard ? ('last=' + iso(latestCard.at) + ' ' + latestCard.name) : '没有批次卡', evidence: cardDir },
  { id: 'bench', label: '实验台', state: (benchLast && Date.now() - Date.parse(benchLast.at) < DAY) ? 'GREEN' : ((liveAt && Date.now() - liveAt < 3600 * 1000) ? 'YELLOW' : 'RED'), detail: benchLast ? ('last=' + benchLast.at + ' ' + benchLast.cmd + '；live=' + iso(liveAt)) : ('usage 无记录；live=' + iso(liveAt)), evidence: BENCH_USAGE },
  { id: 'core-tools', label: '核心工具调用', state: 'UNKNOWN', detail: '编码侧工具日志未统一采集；游戏侧见 monitor/tools.jsonl', evidence: null },
];
const out = { at: new Date().toISOString(), checks, commits24h: commits.length, commitsAfterCodeGate: afterCode.length };
try { fs.writeFileSync('D:/rdd/.harness/audit/coding-audit.json', JSON.stringify(out, null, 2), 'utf8'); } catch (e) { }
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const mark = { GREEN: '✔', YELLOW: '!', RED: '✘', UNKNOWN: '?' };
  console.log('=== 编码 AI 当天合规（只读） ===');
  for (const c of checks) console.log('  ' + mark[c.state] + ' ' + c.label.padEnd(8) + ' ' + c.state.padEnd(7) + ' ' + c.detail);
  console.log('  24h commit=' + commits.length + '；code-gate 之后 commit=' + afterCode.length);
}
