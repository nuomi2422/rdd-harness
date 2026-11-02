#!/usr/bin/env node
/**
 * digest.mjs —— 每 2 小时一条「剪辑摘要」（目标要求，不提交工单，只落盘 + 可发 peer）。
 *
 * 内容：
 *   - 覆盖时段、采样数、状态分布
 *   - 本期新 take / 成片 / 被排除
 *   - 触发事件（trigger-log）
 *   - 存储水位（<20% 用 ⚠️ 标）
 *   - 异常项一律 ⚠️ 前缀
 *
 * 用法: node digest.mjs [--hours 2] [--write]
 */
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const OUT_DIR = path.join(SHOTS, '_photographer');
const args = process.argv.slice(2);
const hours = Number((args.find((a) => a.startsWith('--hours=')) || '--hours=2').split('=')[1]);
const write = args.includes('--write');

const readJsonl = (p) => { try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const from = Date.now() - hours * 3600 * 1000;
const local = (t) => new Date(Date.parse(t) + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);

// 巡查采样
const allPatrol = readJsonl(path.join(OUT_DIR, 'patrol.jsonl')).filter((o) => Date.parse(o.ts) >= from);
const samples = allPatrol.filter((o) => o.kind === 'sample');
// 离线时段也要计入，否则「游戏关着」会被摘要悄悄吞掉
const offline = allPatrol.filter((o) => o.kind === 'offline');
const cnt = { working: 0, idle: 0, waiting: 0, dead: 0, unknown: 0 };
for (const s of samples) {
  const st = s.state || (s.task ? (/刚死了|复活途中/.test(s.task) ? 'dead' : (/身体空闲/.test(s.task) ? 'idle' : 'working')) : 'unknown');
  cnt[st] = (cnt[st] || 0) + 1;
}
const total = Math.max(1, samples.length);
const pct = (n) => Math.round((n / total) * 100) + '%';

// 本期新 take
const takes = fs.readdirSync(SHOTS).filter((n) => n.startsWith('numencam_')).map((n) => {
  const p = path.join(SHOTS, n);
  let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch { /* ignore */ }
  const cut = fs.existsSync(path.join(p, 'cut', 'highlight.mp4'));
  return { n, mtime, cut };
}).filter((t) => t.mtime >= from).sort((a, b) => a.n.localeCompare(b.n));

// 真实活跃度：ai.jsonl 的 turn 事件（每次 AI 决策一轮），不受「身体空闲」误导
const turnStats = (() => {
  try {
    const p = path.join(process.env.RDD_LIVE || 'D:\\rdd\\mc\\The Best of Twilight Forest', 'config', 'numen', 'monitor', 'ai.jsonl');
    const all = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).slice(-20000);
    const ts = [];
    for (const l of all) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type !== 'turn') continue;
      const t = Date.parse(j.timestamp || '');
      if (t >= from) ts.push(t);
    }
    ts.sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 1000);
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
    const long = gaps.filter((g) => g >= 120).length;
    return { n: ts.length, median, long, total: gaps.length };
  } catch { return null; }
})();

// 触发事件
const trig = readJsonl(path.join(OUT_DIR, 'trigger-log.jsonl')).filter((o) => Date.parse(o.ts) >= from);

// 存储
let freePct = null, freeGB = null;
try {
  const st = fs.statfsSync ? fs.statfsSync('D:') : null;
  if (st) { const tot = st.blocks * st.bsize, free = st.bavail * st.bsize; freeGB = +(free / 1073741824).toFixed(1); freePct = +(free / tot * 100).toFixed(1); }
} catch { /* ignore */ }

const anomalies = [];
// 口径提醒：'身体空闲' 是任务状态，不是活跃度。实测 2026-11-03 03:36 它连续调用 build/eat/set_timer，
// 而 task_status 仍显示"身体空闲"——所以 idle 占比会高估"没干活"。
if (cnt.idle / total > 0.5) anomalies.push('口径：idle 是「没有长任务」，不等于没做事（它可能在做 build/eat 等前台调用）');
if (cnt.dead > total * 0.1) anomalies.push('死亡/复活采样占 ' + pct(cnt.dead) + '（>10%）');
// 只有「turn 也少」时，空闲才算问题；否则 turn 正常就说明它在做事
if (cnt.idle > total * 0.6 && (!turnStats || turnStats.n < hours * 20)) {
  anomalies.push('空闲 ' + pct(cnt.idle) + ' 且 turn 仅 ' + (turnStats ? turnStats.n : '?') + ' 个（每 5 分钟不足 2 轮）');
}
if (freePct !== null && freePct < 20) anomalies.push('磁盘余量 ' + freePct + '%（<20%，需优先删无标记片段）');
if (trig.length === 0 && takes.length > 0) anomalies.push('有 ' + takes.length + ' 条新 take 但零触发事件（触发器可能没命中）');

const md = '# 剪辑摘要 · ' + (samples.length ? local(samples[0].ts) + ' → ' + local(samples[samples.length - 1].ts) : '无采样') + '\n\n' +
  '> 覆盖 ' + hours + ' 小时，' + samples.length + ' 个采样。异常项以 ⚠️ 开头。\n\n' +
  '## 状态分布\n\n| 状态 | 采样 | 占比 |\n|---|---|---|\n' +
  Object.entries(cnt).map(([k, v]) => '| ' + k + ' | ' + v + ' | ' + pct(v) + ' |').join('\n') + '\n\n' +
  '## 真实活跃度（turn 口径）\n\n' +
  (turnStats
    ? '- 本段 **' + turnStats.n + ' 个 turn**（AI 决策轮次）' +
      (turnStats.median != null ? '，间隔中位数 **' + turnStats.median.toFixed(1) + ' 秒**' : '') + '\n' +
      '- ≥2 分钟的停顿：' + turnStats.long + ' 次' + (turnStats.total ? '（占 ' + (turnStats.long / turnStats.total * 100).toFixed(1) + '%）' : '') + '\n' +
      '- 注：「身体空闲」只表示没有长任务，不代表没做事\n\n'
    : '- 读不到 ai.jsonl\n\n') +
  '## 本段素材\n\n- 新 take **' + takes.length + '** 条，其中有成片 **' + takes.filter((t) => t.cut).length + '** 条\n' +
  (takes.length ? '- 最近 5 条：' + takes.slice(-5).map((t) => '\`' + t.n + '\`' + (t.cut ? '(已成片)' : '(未成片)')).join('、') + '\n' : '') + '\n' +
  '## 触发事件\n\n' + (trig.length ? trig.map((t) => '- ' + local(t.ts) + '：' + (t.reasons || []).join(' / ') + ' → \`' + t.take + '\`').join('\n') : '- 本段无触发') + '\n\n' +
  '## 存储\n\n- D 盘余量 **' + (freeGB ?? '?') + 'GB（' + (freePct ?? '?') + '%）**\n' +
  (offline.length ? '- 游戏离线采样 **' + offline.length + '** 条（' + local(offline[0].ts) + ' → ' + local(offline[offline.length - 1].ts) + '）\n' : '') + '\n' +
  '## 异常\n\n' + (anomalies.length ? anomalies.map((a) => '- ⚠️ ' + a).join('\n') : '- 无') + '\n';

console.log(md);
if (write) {
  const f = path.join(OUT_DIR, 'digest-' + new Date().toISOString().slice(0, 13).replace('T', '-') + '.md');
  fs.writeFileSync(f, md, 'utf8');
  console.log('[digest] 写入 ' + f);
}
