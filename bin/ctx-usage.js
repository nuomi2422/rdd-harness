#!/usr/bin/env node
'use strict';
/**
 * ctx-usage.js —— 查 dsh-smart-compact（换窗插件）到底有没有被用起来。
 *
 * 为什么有它：2026-11-07 主人问「ctx 运行一晚上应该调用几十次，到底调没调」，
 * 而 PTC 模式（run_code 包一切）会让会话日志里只看到 run_code，
 * 真实工具名藏在 tool/ptc-dispatch 事件里 —— 肉眼看日志根本看不出来。
 *
 * 用法：
 *   node bin/ctx-usage.js              # 汇总所有会话
 *   node bin/ctx-usage.js --session <id前缀>   # 只看某个会话
 *   node bin/ctx-usage.js --json       # 机器可读
 *
 * 数据源：C:\Users\admin\.dsh\sessions\**\session.v4.jsonl.zstd（多帧 zstd，逐帧解）
 * 判据：ctx_notes 用量 / 换窗次数(compaction/start) / ctx_history 回查 / new_context 主动换窗
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = 'C:\\Users\\admin\\.dsh\\sessions';
const CTX_TOOLS = ['ctx_notes', 'ctx_history', 'new_context', 'get_context_remaining'];
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function listSessionDirs(root) {
  const out = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (fs.existsSync(path.join(p, 'session.v4.jsonl.zstd'))) out.push({ id: e.name, dir: p });
        else walk(p);
      }
    }
  };
  walk(root);
  return out;
}

function decode(file) {
  const raw = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i < raw.length - 4; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i);
  }
  let text = '', ok = 0, fail = 0;
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : raw.length;
    try { text += zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8'); ok++; } catch { fail++; }
  }
  return { text, frames: starts.length, ok, fail, bytes: raw.length };
}

function analyze(text) {
  const tools = {};
  let rollovers = 0, title = null, first = null, last = null;
  for (const ln of text.split(/\r?\n/)) {
    if (!ln) continue;
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (e.time) { if (first === null) first = e.time; last = e.time; }
    if (e.type === 'tool/ptc-dispatch' || e.type === 'tool/ptc-dispatch-start') {
      const n = e.data?.name; if (n) tools[n] = (tools[n] || 0) + 1;
    } else if (e.type === 'tool/call') {
      const n = e.data?.name; if (n) tools[n] = (tools[n] || 0) + 1;
    } else if (e.type === 'compaction/start') rollovers++;
    else if (e.type === 'session/title' && e.data?.title) title = e.data.title;
  }
  const ctx = {};
  for (const t of CTX_TOOLS) ctx[t] = tools[t] || 0;
  return { tools, ctx, rollovers, title, first, last };
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const only = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;

const rows = [];
for (const s of listSessionDirs(ROOT)) {
  if (only && !s.id.includes(only)) continue;
  const f = path.join(s.dir, 'session.v4.jsonl.zstd');
  const d = decode(f);
  const a = analyze(d.text);
  rows.push({ id: s.id, frames: d.frames, fail: d.fail, bytesMB: +(d.bytes / 1048576).toFixed(1), ...a });
}
rows.sort((x, y) => (y.last || 0) - (x.last || 0));

if (asJson) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }

const fmt = (ms) => ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-';
console.log('══ ctx（换窗插件）使用情况 ══');
console.log('会话数=' + rows.length + '  数据源=' + ROOT);
console.log('');
console.log('会话 | 时间跨度 | 换窗 | ctx_notes | ctx_history | new_context | 查预算 | 标题');
console.log('---|---|---|---|---|---|---|---');
let sumRoll = 0, sumNotes = 0, sumHist = 0, sumNew = 0, sumRem = 0;
for (const r of rows) {
  if (!r.last) continue;
  sumRoll += r.rollovers; sumNotes += r.ctx.ctx_notes; sumHist += r.ctx.ctx_history;
  sumNew += r.ctx.new_context; sumRem += r.ctx.get_context_remaining;
  console.log([r.id.slice(0, 18), fmt(r.first).slice(5) + '~' + fmt(r.last).slice(5), r.rollovers,
    r.ctx.ctx_notes, r.ctx.ctx_history, r.ctx.new_context, r.ctx.get_context_remaining, (r.title || '-')].join(' | '));
}
console.log('');
console.log('合计：换窗 ' + sumRoll + ' 次 · ctx_notes ' + sumNotes + ' 次 · ctx_history ' + sumHist +
  ' 次 · new_context ' + sumNew + ' 次 · 查预算 ' + sumRem + ' 次');

// 诊断结论
console.log('');
console.log('── 诊断 ──');
const maxRoll = rows.reduce((m, r) => Math.max(m, r.rollovers), 0);
if (maxRoll === 0) console.log('✘ 一次换窗都没发生 → 插件没生效，查 engine-state.json 的 engineMounted/rolloverCount');
else console.log('✔ 换窗在工作（最多 ' + maxRoll + ' 次）');
if (sumNotes === 0) console.log('✘ ctx_notes 一次没用 → 提醒没让 AI 写笔记，查 reminderObserved.briefed');
else console.log('✔ ctx_notes 在用（' + sumNotes + ' 次）');
if (sumHist === 0) console.log('⚠ ctx_history 一次没用 → 换窗后 AI 从不回查旧窗口（锚点虽要求，但没人照做）—— 这是「有些没用上」的主因');
else console.log('✔ ctx_history 在用（' + sumHist + ' 次）');
if (sumNew === 0 && sumRem === 0) console.log('⚠ new_context / get_context_remaining 全 0 → AI 从不主动管理上下文，全靠自动阈值');
