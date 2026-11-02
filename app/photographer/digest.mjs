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
const samples = readJsonl(path.join(OUT_DIR, 'patrol.jsonl')).filter((o) => o.kind === 'sample' && Date.parse(o.ts) >= from);
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

// 触发事件
const trig = readJsonl(path.join(OUT_DIR, 'trigger-log.jsonl')).filter((o) => Date.parse(o.ts) >= from);

// 存储
let freePct = null, freeGB = null;
try {
  const st = fs.statfsSync ? fs.statfsSync('D:') : null;
  if (st) { const tot = st.blocks * st.bsize, free = st.bavail * st.bsize; freeGB = +(free / 1073741824).toFixed(1); freePct = +(free / tot * 100).toFixed(1); }
} catch { /* ignore */ }

const anomalies = [];
if (cnt.dead > total * 0.1) anomalies.push('死亡/复活采样占 ' + pct(cnt.dead) + '（>10%）');
if (cnt.idle > total * 0.6) anomalies.push('空闲采样占 ' + pct(cnt.idle) + '（>60%，派工节奏可疑）');
if (freePct !== null && freePct < 20) anomalies.push('磁盘余量 ' + freePct + '%（<20%，需优先删无标记片段）');
if (trig.length === 0 && takes.length > 0) anomalies.push('有 ' + takes.length + ' 条新 take 但零触发事件（触发器可能没命中）');

const md = '# 剪辑摘要 · ' + (samples.length ? local(samples[0].ts) + ' → ' + local(samples[samples.length - 1].ts) : '无采样') + '\n\n' +
  '> 覆盖 ' + hours + ' 小时，' + samples.length + ' 个采样。异常项以 ⚠️ 开头。\n\n' +
  '## 状态分布\n\n| 状态 | 采样 | 占比 |\n|---|---|---|\n' +
  Object.entries(cnt).map(([k, v]) => '| ' + k + ' | ' + v + ' | ' + pct(v) + ' |').join('\n') + '\n\n' +
  '## 本段素材\n\n- 新 take **' + takes.length + '** 条，其中有成片 **' + takes.filter((t) => t.cut).length + '** 条\n' +
  (takes.length ? '- 最近 5 条：' + takes.slice(-5).map((t) => '\`' + t.n + '\`' + (t.cut ? '(已成片)' : '(未成片)')).join('、') + '\n' : '') + '\n' +
  '## 触发事件\n\n' + (trig.length ? trig.map((t) => '- ' + local(t.ts) + '：' + (t.reasons || []).join(' / ') + ' → \`' + t.take + '\`').join('\n') : '- 本段无触发') + '\n\n' +
  '## 存储\n\n- D 盘余量 **' + (freeGB ?? '?') + 'GB（' + (freePct ?? '?') + '%）**\n\n' +
  '## 异常\n\n' + (anomalies.length ? anomalies.map((a) => '- ⚠️ ' + a).join('\n') : '- 无') + '\n';

console.log(md);
if (write) {
  const f = path.join(OUT_DIR, 'digest-' + new Date().toISOString().slice(0, 13).replace('T', '-') + '.md');
  fs.writeFileSync(f, md, 'utf8');
  console.log('[digest] 写入 ' + f);
}
