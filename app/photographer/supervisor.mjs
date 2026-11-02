#!/usr/bin/env node
/**
 * supervisor.mjs —— 监工日报（正确口径版）。
 *
 * 关键修正（2026-11-02）：空闲段必须在「游戏离线」处切断。
 * 之前把「5 分钟空闲 + 关服 12 分钟 + 3 分钟空闲」算成「20 分钟空闲」，是错的。
 *
 * 输出：
 *   - 状态分布（只统计在线采样）
 *   - 空闲段（按离线切断，给出段数与最长）
 *   - 有效观察时长（在线采样覆盖的时间）
 *   - 走路距离估算
 *   - ⚠️ 异常
 * 用法: node supervisor.mjs [--write]
 */
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const P = path.join(SHOTS, '_photographer');
const OUT = path.join(P, 'supervisor-day.md');
const write = process.argv.includes('--write');

const readJsonl = (f) => { try { return fs.readFileSync(path.join(P, f), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const local = (t) => new Date(Date.parse(t) + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const deriveState = (s) => {
  if (s.state) return s.state;
  const t = (s.task || '').trim();
  if (!t) return 'unknown';
  if (/刚死了|复活途中/.test(t)) return 'dead';
  if (/身体空闲/.test(t)) return /挂着\s*\d+\s*个表/.test(t) ? 'waiting' : 'idle';
  return 'working';
};

const recs = readJsonl('patrol.jsonl').filter((o) => o.ts);
const vitals = readJsonl('vitals.jsonl');

const cnt = { working: 0, idle: 0, waiting: 0, dead: 0, unknown: 0 };
let onlineSamples = 0, offlineRecords = 0;
const runs = [];          // 空闲段（遇离线即切断）
let cur = null;
for (const o of recs) {
  if (o.kind === 'offline') {
    offlineRecords++;
    if (cur) { runs.push(cur); cur = null; }   // ★ 离线切断空闲段
    continue;
  }
  if (o.kind !== 'sample') continue;
  onlineSamples++;
  const st = deriveState(o);
  cnt[st] = (cnt[st] || 0) + 1;
  if (st === 'idle') {
    if (!cur) cur = { from: o.ts, to: o.ts };
    cur.to = o.ts;
  } else if (cur) { runs.push(cur); cur = null; }
}
if (cur) runs.push(cur);
const gaps = runs.map((r) => ({ ...r, mins: Math.round((Date.parse(r.to) - Date.parse(r.from)) / 60000) })).sort((a, b) => b.mins - a.mins);

// 走路距离（跨维度/大跳变不计）
let dist = 0;
for (let i = 1; i < vitals.length; i++) {
  const a = vitals[i - 1], b = vitals[i];
  if (!a.pos || !b.pos || a.dim !== b.dim) continue;
  const d = Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]) + Math.abs(b.pos[1] - a.pos[1]);
  if (d > 200) continue;
  dist += d;
}

const total = Math.max(1, onlineSamples);
const pct = (n) => Math.round((n / total) * 100) + '%';
const free = (() => { try { const st = fs.statfsSync('D:'); return { gb: +(st.bavail * st.bsize / 1073741824).toFixed(1), pct: +(st.bavail / st.blocks * 100).toFixed(1) }; } catch { return null; } })();
const spanH = recs.length ? ((Date.parse(recs[recs.length - 1].ts) - Date.parse(recs[0].ts)) / 3600000) : 0;

const anomalies = [];
if (cnt.idle / total > 0.6) anomalies.push('空闲 ' + pct(cnt.idle) + '（>60%）');
if (gaps.length && gaps[0].mins >= 10) anomalies.push('最长空闲 ' + gaps[0].mins + ' 分钟（已按离线切断，不是关服凑出来的）');
if (offlineRecords > 30) anomalies.push('离线采样 ' + offlineRecords + ' 条（游戏频繁启停）');
if (free && free.pct < 20) anomalies.push('磁盘 ' + free.pct + '% <20%');

const md = '# 监工日报 · 2026-11-02（口径修正版）\n\n' +
  '> 只读观察；拍摄已停。**空闲段在「游戏离线」处切断**，不再把关服时间算进空闲。\n\n' +
  '## 概况\n\n' +
  '- 观察跨度 **' + spanH.toFixed(1) + ' 小时**；在线采样 **' + onlineSamples + '** 条；离线记录 **' + offlineRecords + '** 条\n' +
  '- 状态（仅在线）：干活 ' + pct(cnt.working) + '｜空闲 ' + pct(cnt.idle) + '｜等定时器 ' + pct(cnt.waiting) + '｜死亡/复活 ' + pct(cnt.dead) + '｜无数据 ' + pct(cnt.unknown) + '\n' +
  '- 累计移动 ≈ **' + Math.round(dist) + ' 格**\n' +
  '- 磁盘 ' + (free ? free.gb + 'GB（' + free.pct + '%）' : '?') + '\n\n' +
  '## 空闲段（前 5，已按离线切断）\n\n' + (gaps.slice(0, 5).map((g) => '- ' + local(g.from) + ' → ' + local(g.to) + '：' + g.mins + ' 分钟').join('\n') || '- 无') + '\n\n' +
  '## ⚠️ 异常\n\n' + (anomalies.length ? anomalies.map((a) => '- ⚠️ ' + a).join('\n') : '- 无') + '\n';
console.log(md);
if (write) { fs.writeFileSync(OUT, md, 'utf8'); console.log('[supervisor] 写入 ' + OUT); }
