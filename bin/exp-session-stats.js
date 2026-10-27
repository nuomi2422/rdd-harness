#!/usr/bin/env node
/**
 * exp-session-stats.js —— 记录「死了几次 / 干了多久」（只读，实验台工具）
 *
 * 为什么（2026-10-27 主人指示）：「记录他的死亡，他的干活时长」。
 * 现有监测台有逐条事件，但没有**按会话汇总**的一张表：
 * 每次进游戏活了多久、干了几件事、死在哪、死之前在干什么。
 * 没有这张表，「她今天状态怎么样」只能靠翻 jsonl。
 *
 * 判据（全部可从磁盘事件算出，不猜）:
 *   - 会话 = ai.jsonl / tools.jsonl / rdd.jsonl 里相邻事件间隔 > 10 分钟就切一段
 *   - 干活时长 = 会话首末事件跨度（wall clock）；活跃分钟 = 其中有工具调用的分钟数
 *   - 死亡 = instrumentation.jsonl 的 death 事件（含 deathKind/attacker 若给了）
 *   - 死亡前在干什么 = 该死亡时刻之前 60 秒内最后一次工具调用
 *
 * 用法:
 *   node exp-session-stats.js                 # 最近 3 天，人读
 *   node exp-session-stats.js --json
 *   node exp-session-stats.js --days 7
 *   node exp-session-stats.js --monitor <dir>
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MONITOR = 'D:\\rdd\\mc\\The Best of Twilight Forest\\config\\numen\\monitor';
const GAP_MS = 10 * 60 * 1000;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/** 只读尾部 N MB（jsonl 可能很大）。 */
function tailLines(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    const take = Math.min(st.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, st.size - take);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
}

function parseTs(s) {
  const t = Date.parse(String(s || ''));
  return Number.isNaN(t) ? null : t;
}

function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' 分钟';
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
}

function main() {
  const monitor = arg('monitor', DEFAULT_MONITOR);
  const days = Number(arg('days', '3'));
  const only = arg('companion', '');   // 2026-10-28: 只统计某个同伴(RDD 的 UUID)，实验用的一次性探针不混进死亡序列
  const json = process.argv.includes('--json');
  const since = Date.now() - days * 24 * 3600 * 1000;

  const events = [];   // {t, kind, detail}
  const deaths = [];

  const toolLines = tailLines(path.join(monitor, 'tools.jsonl'), 24 * 1024 * 1024) || [];
  for (const line of toolLines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = parseTs(o.timestamp);
    if (t == null || t < since) continue;
      if (only && String((o.data && o.data.companionId) || '') !== only) continue;   // 只看指定同伴
    const tool = o && o.data ? (o.data.tool || o.data.name) : null;
    if (o.type === 'tool_call' && tool) events.push({ t, kind: 'tool', detail: tool });
  }

  const instrLines = tailLines(path.join(monitor, 'instrumentation.jsonl'), 8 * 1024 * 1024) || [];
  for (const line of instrLines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = parseTs(o.timestamp);
    if (t == null || t < since) continue;
    const type = String(o.type || '');
    if (/death/i.test(type)) {
      const d = o.data || {};
      // 2026-10-28: 一次性探针也会死（测 D-16 时熔岩/摔落死了好几只），
      // 不能混进主线死亡序列 —— 否则「今天她死了 9 次」是假账。
      if (only && String(d.companionId || '') !== only) continue;
      deaths.push({
        t,
        kind: String(d.deathKind || d.kind || type),
        attacker: String(d.deathAttacker || d.attacker || ''),
        ctx: d.context || d.note || '',
      });
      events.push({ t, kind: 'death', detail: String(d.deathKind || 'death') });
    }
  }

  const rddLines = tailLines(path.join(monitor, 'rdd.jsonl'), 24 * 1024 * 1024) || [];
  for (const line of rddLines) {
    if (!/subtask_completed|repair_task_succeeded|goal_staged/.test(line)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = parseTs(o.timestamp);
    if (t == null || t < since) continue;
    events.push({ t, kind: String(o.type || 'rdd') });
  }

  if (!events.length) {
    const out = { ok: false, code: 'NO_DATA', monitor, why: `最近 ${days} 天没有可读事件（没进过游戏？）` };
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log(`最近 ${days} 天没有可读事件：${monitor}`);
    process.exit(2);
  }

  events.sort((a, b) => a.t - b.t);

  // 切会话
  const sessions = [];
  let cur = null;
  for (const e of events) {
    if (!cur || e.t - cur.last > GAP_MS) {
      cur = { start: e.t, last: e.t, events: [], toolCalls: 0, deaths: 0, firstTool: null, lastTool: null };
      sessions.push(cur);
    }
    cur.last = e.t;
    cur.events.push(e);
    if (e.kind === 'tool') {
      cur.toolCalls++;
      if (!cur.firstTool) cur.firstTool = e.detail;
      cur.lastTool = e.detail;
    }
    if (e.kind === 'death') cur.deaths++;
  }

  // 活跃分钟（会话内有事件的不同分钟数）
  for (const s of sessions) {
    const mins = new Set(s.events.map((e) => Math.floor(e.t / 60000)));
    s.activeMinutes = mins.size;
    s.wallMs = s.last - s.start;
  }

  // 死亡前在干什么（60 秒内最后一次工具调用）
  for (const d of deaths) {
    let lastTool = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.t > d.t) continue;
      if (d.t - e.t > 60000) break;
      if (e.kind === 'tool') { lastTool = e.detail; break; }
    }
    d.beforeTool = lastTool;
  }

  const totalWall = sessions.reduce((a, s) => a + s.wallMs, 0);
  const totalActive = sessions.reduce((a, s) => a + s.activeMinutes, 0);
  const totalCalls = sessions.reduce((a, s) => a + s.toolCalls, 0);

  const out = {
    ok: true,
    monitor,
    days,
    sessions: sessions.length,
    totalWallMs: totalWall,
    totalActiveMinutes: totalActive,
    totalToolCalls: totalCalls,
    deaths: deaths.length,
    deathsByKind: deaths.reduce((m, d) => { m[d.kind] = (m[d.kind] || 0) + 1; return m; }, {}),
    perSession: sessions.slice(-8).map((s) => ({
      start: new Date(s.start).toISOString().slice(5, 16).replace('T', ' '),
      wall: fmtDur(s.wallMs),
      activeMinutes: s.activeMinutes,
      toolCalls: s.toolCalls,
      deaths: s.deaths,
    })),
    deathDetail: deaths.slice(-10).map((d) => ({
      at: new Date(d.t).toISOString().slice(5, 16).replace('T', ' '),
      kind: d.kind,
      attacker: d.attacker,
      beforeTool: d.beforeTool,
    })),
  };

  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`会话统计（最近 ${days} 天，${monitor}）`);
    console.log(`  会话 ${out.sessions} 段 · 累计在游戏里 ${fmtDur(totalWall)} · 活跃 ${totalActive} 分钟 · 工具调用 ${totalCalls} 次`);
    console.log(`  死亡 ${out.deaths} 次 ${JSON.stringify(out.deathsByKind)}`);
    console.log('  最近几段：');
    for (const s of out.perSession) {
      console.log(`    ${s.start}  跨度 ${s.wall}  活跃 ${s.activeMinutes} 分  调用 ${s.toolCalls}  死亡 ${s.deaths}`);
    }
    if (out.deathDetail.length) {
      console.log('  死亡明细（最后 10 次）：');
      for (const d of out.deathDetail) {
        console.log(`    ${d.at}  kind=${d.kind}${d.attacker ? ' 被 ' + d.attacker : ''}${d.beforeTool ? '  前一刻在做 ' + d.beforeTool : ''}`);
      }
    }
  }
  process.exit(0);
}

main();
