#!/usr/bin/env node
/**
 * bench-digest —— 把实验台观测压成一段能塞进上下文的摘要（2026-11-08 主人要求）。
 *
 * 为什么需要：bench live 每 15 秒产 strand/chat/context，但**没有通道送到外部编码 AI 的上下文**；
 *   本命令给它一个一键出口：说（ai.jsonl）/ 做（tools.jsonl）/ 果 / 链（rdd.jsonl）/ 死，
 *   外加**异常摘要**（重复失败、连续只读、原地打转、死亡）——这才是找盲点的部分。
 *
 * 用法：
 *   node bin/bench-digest.js                 # 默认最近 120 分钟，≤1200 字
 *   node bin/bench-digest.js --since 30m     # 30m / 90m / 2h
 *   node bin/bench-digest.js --full          # 不截断（给人看，不给 AI）
 *   node bin/bench-digest.js --json          # 机器可读
 *
 * 每次运行写一条痕迹到 .harness/audit/bench-digest.jsonl（门禁 Q21 用它判「退游戏后有没有看」）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HARNESS = path.resolve(__dirname, '..');
const RDD = path.resolve(HARNESS, '..', '..');
const LIVE = path.join(RDD, 'mc', 'The Best of Twilight Forest');
const MON = path.join(LIVE, 'config', 'numen', 'monitor');
const AUDIT = path.join(RDD, '.harness', 'audit', 'bench-digest.jsonl');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (n) => process.argv.includes('--' + n);

function parseSince(s) {
  const m = String(s || '120m').match(/^(\d+)\s*(m|h)?$/i);
  if (!m) return 120;
  const minutes = Number(m[1]) * (String(m[2] || 'm').toLowerCase() === 'h' ? 60 : 1);
  return Number.isSafeInteger(minutes) && minutes <= 52560000 ? minutes : 120;
}

// 读尾部时任何缺失、坏行或截断都必须留在覆盖说明中。
function readJsonl(file, maxBytes = 8 * 1024 * 1024) {
  const issues = [], events = [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (!n) break;
      read += n;
    }
    if (read !== buf.length) issues.push('读取不完整');
    const text = buf.subarray(0, read).toString('utf8');
    const lines = text.split(/\r?\n/);
    if (start) { issues.push('超过读取上限，前部截断'); lines.shift(); }
    if (text && !text.endsWith('\n')) issues.push('末行未结束，可能截断');
    let bad = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.timestamp !== 'string' || !Number.isFinite(Date.parse(e.timestamp))) { bad++; continue; }
        events.push(e);
      } catch { bad++; }
    }
    if (bad) issues.push('坏行或无效时间 ' + bad + ' 条');
  } catch (e) { issues.push('读取失败: ' + (e.code || e.message)); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return { events, issues };
}

const CLOCK = ['get_self_status', 'task_status', 'rdd_status', 'look_around', 'inspect_block', 'scan_blocks', 'scan_nearby_entities', 'rdd_nearby_entities', 'world_fact_probe', 'report_task_concern', 'ask_companion', 'world_state'];

function receipt(e) {
  const d = e.data || {};
  let r = d.result;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = null; } }
  if (!r || typeof r !== 'object' || Array.isArray(r)) r = {};
  const status = String(d.async_status || r.status || r.data?.status || '').toLowerCase();
  const async = r.async === true || r.data?.async === true || /accepted|pending|running|queued/.test(status) || /受理|后台执行|执行中/.test(String(r.message || ''));
  const ok = typeof r.success === 'boolean' ? r.success : typeof d.success === 'boolean' ? d.success : null;
  return { at: e.timestamp, name: String(d.tool || d.name || 'UNKNOWN'), id: String(d.tool_call_id || 'UNKNOWN'),
    state: ok === false ? '回执失败' : async && !/^(done|completed|failed|timeout)$/.test(status) ? '受理/执行中，终态 UNKNOWN' : ok === true ? '回执成功（不证明世界结果）' : 'UNKNOWN',
    err: String(r.error || r.message || d.message || '').slice(0, 80) };
}

function buildDigest(opts) {
  const sinceMin = opts.sinceMin, now = Date.now(), cutoff = now - sinceMin * 60000;
  const sources = ['ai', 'tools', 'rdd'].map((name) => ({ name, ...readJsonl(path.join(MON, name + '.jsonl')) }));
  for (const source of sources) source.events = source.events.filter((e) => {
    const t = Date.parse(e.timestamp);
    return t >= cutoff && t <= now;
  });
  const [ai, tools, rdd] = sources.map((s) => s.events);
  const says = ai.filter((e) => e.type === 'assistant').map((e) => ({ at: e.timestamp, text: String(e.data?.text || e.data?.content || '').replace(/\s+/g, ' ').slice(0, 120) }));
  const calls = tools.filter((e) => e.type === 'tool_call').map((e) => ({ at: e.timestamp, name: String(e.data?.tool || e.data?.name || 'UNKNOWN'), id: String(e.data?.tool_call_id || 'UNKNOWN') }));
  const results = tools.filter((e) => e.type === 'tool_result').map(receipt);
  // 仅使用回执自身的工具名；不以相同下标、时间或缺失世界身份猜配。
  const failCount = new Map();
  for (const r of results) if (r.state === '回执失败' && r.name !== 'UNKNOWN') {
    const key = r.name + '|' + r.err.replace(/\d+/g, 'N').slice(0, 60);
    failCount.set(key, (failCount.get(key) || 0) + 1);
  }
  const repeatFails = [...failCount].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);
  let runRead = 0, maxRead = 0;
  for (const c of calls) { if (CLOCK.includes(c.name)) { runRead++; maxRead = Math.max(maxRead, runRead); } else runRead = 0; }
  const toolCount = new Map();
  for (const c of calls) toolCount.set(c.name, (toolCount.get(c.name) || 0) + 1);
  const toolHot = [...toolCount].filter(([name, n]) => name !== 'UNKNOWN' && n >= 10).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const deaths = rdd.filter((e) => /death/i.test(String(e.type) + String(e.data?.kind || '')));
  const stalled = rdd.filter((e) => /stall/i.test(String(e.data?.kind || e.type)));
  const lines = [
    '# 实验台摘要 · 最近 ' + sinceMin + ' 分钟',
    '时间范围：' + new Date(cutoff).toISOString() + ' 至 ' + new Date(now).toISOString() + '（含边界）',
    '世界身份：UNKNOWN；未按世界分组或配对，混合世界可能影响统计。',
    '覆盖：' + sources.map((s) => s.name + '=' + (s.issues.length ? 'UNKNOWN（' + s.issues.join('；') + '）' : '读取完成（不保证日志完整）')).join(' / '),
    '统计：说 ' + says.length + ' 条 / 做 ' + calls.length + ' 次 / 果 ' + results.length + ' 条 / 事件 ' + rdd.length + ' 条', '',
    '## 异常（仅为线索，非完整性证明）'
  ];
  if (repeatFails.length) lines.push('- 重复失败回执（可能重复记账，未去重）：' + repeatFails.map(([k,n]) => k.replace('|', '：') + ' ×' + n).join('；'));
  if (maxRead >= 5) lines.push('- 未分组日志中有 ' + maxRead + ' 条相邻只读调用记录；世界/身份及缺行未知，不能证明同一主体连续只读');
  if (toolHot.length) lines.push('- 高频同工具：' + toolHot.map(([k,n]) => k + ' ×' + n).join('；') + '（参数需另查）');
  if (deaths.length) lines.push('- 死亡事件 ' + deaths.length + ' 条');
  if (stalled.length) lines.push('- 停滞事件 ' + stalled.length + ' 条');
  if (!repeatFails.length && maxRead < 5 && !toolHot.length && !deaths.length && !stalled.length) lines.push('- 未检出上述线索；覆盖及世界身份 UNKNOWN，不能断言无异常');
  lines.push('', '## 最近的说法');
  says.slice(-5).forEach((s) => lines.push('- [' + s.at + '] ' + s.text));
  lines.push('', '## 最近的调用（不与回执猜配）');
  calls.slice(-8).forEach((c) => lines.push('- [' + c.at + '] ' + c.name + ' id=' + c.id));
  lines.push('', '## 最近的回执（不代表世界事实）');
  results.slice(-8).forEach((r) => lines.push('- [' + r.at + '] ' + r.name + ' id=' + r.id + '：' + r.state + (r.err ? ' ' + r.err : '')));
  return lines.join('\n');
}

function logDigest(meta) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify(meta) + '\n', 'utf8');
  } catch { /* 痕迹写不进不影响主流程 */ }
}

const sinceMin = parseSince(arg('since', '120m'));
let text = buildDigest({ sinceMin });
const MAX = 1200;
const truncated = !has('full') && text.length > MAX;
if (truncated) text = text.slice(0, MAX) + '\n…（已截断，用 --full 看全）';

if (has('json')) {
  console.log(JSON.stringify({ sinceMin, chars: text.length, truncated, text }, null, 2));
} else {
  console.log(text);
}
logDigest({ at: new Date().toISOString(), sinceMin, chars: text.length, truncated });
