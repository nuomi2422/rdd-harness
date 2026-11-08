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
  return Number(m[1]) * (String(m[2] || 'm').toLowerCase() === 'h' ? 60 : 1);
}

function readJsonl(file, maxBytes = 8 * 1024 * 1024) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const txt = buf.toString('utf8');
    const lines = txt.split(/\r?\n/);
    if (start > 0) lines.shift();
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch { return []; }
}

const CLOCK = ['get_self_status', 'task_status', 'rdd_status', 'look_around', 'inspect_block', 'scan_blocks', 'scan_nearby_entities', 'rdd_nearby_entities', 'world_fact_probe', 'report_task_concern', 'ask_companion', 'world_state'];

function buildDigest(opts) {
  const sinceMin = opts.sinceMin;
  const cutoff = Date.now() - sinceMin * 60000;
  const cutIso = new Date(cutoff).toISOString();

  const ai = readJsonl(path.join(MON, 'ai.jsonl')).filter((e) => e.timestamp >= cutIso);
  const tools = readJsonl(path.join(MON, 'tools.jsonl')).filter((e) => e.timestamp >= cutIso);
  const rdd = readJsonl(path.join(MON, 'rdd.jsonl')).filter((e) => e.timestamp >= cutIso);

  const says = ai.filter((e) => e.type === 'assistant').map((e) => ({ at: e.timestamp, text: String(e.data?.text || e.data?.content || '').replace(/\s+/g, ' ').slice(0, 120) }));
  // 注意：tools.jsonl 的 tool_call 只有 tool 与 args_chars，**参数不在这个文件**（在 context.jsonl）。
  const calls = tools.filter((e) => e.type === 'tool_call').map((e) => ({ at: e.timestamp, name: String(e.data?.tool || e.data?.name || '?'), argsChars: Number(e.data?.args_chars || 0) }));
  const results = tools.filter((e) => e.type === 'tool_result').map((e) => {
    let ok = null, err = '';
    const r = e.data?.result;
    if (typeof r === 'string') {
      try { const j = JSON.parse(r); ok = j.success === true; err = String(j.error || j.message || ''); }
      catch { ok = !/fail|error|blocked/i.test(r); err = r.slice(0, 80); }
    } else if (r && typeof r === 'object') { ok = r.success === true; err = String(r.error || r.message || ''); }
    return { at: e.timestamp, ok, err };
  });

  // 异常一：重复失败（同 tool + 相似错误 ≥3）
  const failCount = new Map();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.ok === true) continue;
    const name = calls[i]?.name || '?';
    const key = name + '|' + String(r.err || '').replace(/\d+/g, 'N').slice(0, 60);
    failCount.set(key, (failCount.get(key) || 0) + 1);
  }
  const repeatFails = [...failCount.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // 异常二：连续只读（≥5 次只读调用，中间没有世界变更类动作）
  let runRead = 0, maxRead = 0;
  for (const c of calls) {
    if (CLOCK.includes(c.name)) { runRead++; maxRead = Math.max(maxRead, runRead); }
    else runRead = 0;
  }

  // 异常三：高频同工具（参数在 context.jsonl，这里只能按工具名数；同工具 ≥10 次就算打转嫌疑）
  const toolCount = new Map();
  for (const c of calls) toolCount.set(c.name, (toolCount.get(c.name) || 0) + 1);
  const toolHot = [...toolCount.entries()].filter(([, n]) => n >= 10).sort((a, b) => b[1] - a[1]).slice(0, 4);

  // 死亡与停滞
  const deaths = rdd.filter((e) => /death/.test(String(e.type) + String(e.data?.kind || '')));
  const stalled = rdd.filter((e) => /stall/i.test(String(e.data?.kind || e.type)));

  const lines = [];
  lines.push('# 实验台摘要 · 最近 ' + sinceMin + ' 分钟（' + new Date().toISOString().slice(11, 19) + ' 生成）');
  lines.push('');
  lines.push('统计：说 ' + says.length + ' 条 / 做 ' + calls.length + ' 次 / 果 ' + results.length + ' 条 / 事件 ' + rdd.length + ' 条');
  lines.push('');
  lines.push('## 异常（先看这里，找盲点）');
  if (repeatFails.length) lines.push('- 重复失败：' + repeatFails.map(([k, n]) => k.replace('|', ' ×') + '「' + n + ' 次」').join('；'));
  if (maxRead >= 5) lines.push('- 连续只读 ' + maxRead + ' 次（没改世界，纯消耗）');
  if (toolHot.length) lines.push('- 高频同工具（打转嫌疑）：' + toolHot.map(([k, n]) => k + ' ×' + n).join('；') + '（参数在 context.jsonl，需另查）');
  if (deaths.length) lines.push('- 死亡 ' + deaths.length + ' 次：' + deaths.slice(-3).map((d) => String(d.data?.cause || d.data?.deathCause || '?')).join('、'));
  if (stalled.length) lines.push('- 停滞事件 ' + stalled.length + ' 次');
  if (!repeatFails.length && maxRead < 5 && !toolHot.length && !deaths.length) lines.push('- 本轮没有明显异常');
  lines.push('');
  lines.push('## 最近的说法（她自称在干什么）');
  says.slice(-5).forEach((s) => lines.push('- [' + String(s.at).slice(11, 19) + '] ' + s.text));
  lines.push('');
  lines.push('## 最近的动作与结果');
  const tail = Math.min(calls.length, results.length);
  for (let i = Math.max(0, tail - 8); i < tail; i++) {
    const c = calls[i], r = results[i] || {};
    lines.push('- [' + String(c.at).slice(11, 19) + '] ' + c.name + (r.ok === true ? ' ✔' : r.ok === false ? ' ✘ ' + String(r.err || '').slice(0, 50) : ' ?'));
  }
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
