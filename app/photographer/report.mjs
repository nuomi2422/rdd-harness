#!/usr/bin/env node
/**
 * report.mjs —— 从巡查数据里生成一份「它这段时间干了什么」的文字报告。
 *
 * 为什么要这个：成片只给「看得见的」部分；报告补上「没拍到的」——比如它有多少时间在空转、
 * 哪些目标反复出现、有没有长时间没动。这两样合起来才是完整的证据。
 *
 * 用法: node report.mjs [--hours 3]
 */

import fs from 'node:fs';
import path from 'node:path';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const OUT = path.join(SHOTS, '_photographer');
const args = process.argv.slice(2);
const hours = (() => { const i = args.indexOf('--hours'); return i >= 0 ? Number(args[i + 1]) : 3; })();

const lines = (() => { try { return fs.readFileSync(path.join(OUT, 'patrol.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } })();
const now = Date.now();
const from = now - hours * 3600 * 1000;
const samples = [];
for (const l of lines) {
  let o; try { o = JSON.parse(l); } catch { continue; }
  if (o.kind !== 'sample' || !o.ts) continue;
  const t = Date.parse(o.ts);
  if (t < from) continue;
  samples.push({ ...o, t });
}

if (!samples.length) { console.log('[report] 这段时间没有采样'); process.exit(2); }

// ── 状态占比（按采样间隔加权，采样是等间隔的，所以数量≈时间）──────────────
let working = 0, idle = 0, waiting = 0, unknown = 0;
const taskKinds = new Map();
const episodes = [];
let cur = null;
for (const s of samples) {
  const task = (s.task || '').trim();
  if (!task) { unknown++; continue; }
  const isIdle = /身体空闲/.test(task);
  const hasTimer = /挂着\s*\d+\s*个表/.test(task);
  if (isIdle && hasTimer) waiting++;
  else if (isIdle) idle++;
  else {
    working++;
    const m = task.match(/\(([^)0-9]+)/);
    const kind = (m ? m[1] : task).trim().replace(/[+].*$/, '');
    taskKinds.set(kind, (taskKinds.get(kind) || 0) + 1);
  }
  // 任务段（数字归一化）
  const key = task.replace(/\d+/g, '#');
  if (!cur || cur.key !== key) { cur = { key, text: task, from: s.ts, to: s.ts, n: 1 }; episodes.push(cur); }
  else { cur.to = s.ts; cur.n++; cur.text = task; }
}

const total = samples.length;
const pct = (n) => Math.round((n / total) * 100) + '%';

// ── 异常：连续静止 / 同目标反复 ───────────────────────────────────────────
const stuck = samples.filter((s) => (s.flags || []).join(',').includes('suspect-stuck'));
// 最长连续空闲：直接从任务段里量时长，比数采样稳（采样可能被重启打断）
const idleLong = (() => {
  let worst = 0;
  for (const e of episodes) {
    // 注意：「没有挂着的表」里也含「挂着」两个字，必须匹配「挂着 N 个表」
    if (/身体空闲/.test(e.text) && !/挂着\s*\d+\s*个表/.test(e.text)) {
      worst = Math.max(worst, (Date.parse(e.to) - Date.parse(e.from)) / 60000);
    }
  }
  return worst;
})();

const fmt = (iso) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const dur = (a, b) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 60000));

let md = '# 摄影师巡查报告\n\n';
md += '> 区间：' + fmt(samples[0].ts) + ' → ' + fmt(samples[samples.length - 1].ts) +
  '（' + samples.length + ' 个采样，约每 ' + Math.round((samples[samples.length - 1].t - samples[0].t) / Math.max(1, samples.length - 1) / 1000) + ' 秒一次）\n\n';
md += '## 时间分配\n\n';
md += '| 状态 | 采样数 | 占比 |\n|---|---|---|\n';
md += '| 在干活 | ' + working + ' | ' + pct(working) + ' |\n';
md += '| 空闲（无任务） | ' + idle + ' | ' + pct(idle) + ' |\n';
md += '| 等定时器 | ' + waiting + ' | ' + pct(waiting) + ' |\n';
md += '| 无任务数据 | ' + unknown + ' | ' + pct(unknown) + ' |\n\n';
if (taskKinds.size) {
  md += '干活时的任务种类：' + [...taskKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '×' + v).join('、') + '\n\n';
}

md += '## 任务序列（最近的 ' + episodes.length + ' 段）\n\n';
md += '| 开始 | 持续 | 在做什么 |\n|---|---|---|\n';
for (const e of episodes.slice(-20)) {
  md += '| ' + fmt(e.from).slice(11, 16) + ' | ' + dur(e.from, e.to) + ' 分 | ' + e.text.replace(/\|/g, '/') + ' |\n';
}
md += '\n## 异常\n\n';
md += '- 可疑卡住（任务说要走却在原地）：' + (stuck.length ? stuck.length + ' 次，最近一次 ' + fmt(stuck[stuck.length - 1].ts) : '无') + '\n';
md += '- 最长连续空闲：约 ' + Math.round(idleLong) + ' 分钟\n';
if (taskKinds.size) {
  const repeated = [...taskKinds.entries()].filter(([, v]) => v >= 5);
  md += '- 反复出现的任务：' + (repeated.length ? repeated.map(([k, v]) => k + '（' + v + ' 次）').join('、') : '无') + '\n';
}
md += '\n> 报告只陈述采样事实，不下「它有 bug」的结论。要下结论，得把「任务说要走 + 位置不动」连续多轮坐实。\n';

const out = path.join(OUT, 'report-' + new Date().toISOString().slice(0, 10) + '.md');
fs.writeFileSync(out, md, 'utf8');
console.log('[report] ' + out);
console.log(md);
