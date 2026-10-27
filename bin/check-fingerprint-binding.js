#!/usr/bin/env node
/**
 * check-fingerprint-binding.js —— 目标指纹 ↔ 经验绑定到底走没走过（只读核查）
 *
 * 为什么（2026-10-27 主人问）：「查看目标指纹绑定经验走没走过」。
 *
 * 背景（A6 判据）：目标指纹（TaskFingerprint）存在的唯一理由是回答
 * 「这是不是同一类场景」——同类任务再来时，同一条经验应被再次命中。
 * 所以「绑定走没走过」不能看代码里有没有 print，要看**数据里**：
 *
 *   ① 有没有指纹字段（之前补过：executor + planning 两条路都要有）
 *   ② **同一个指纹**在多少个快照里出现过（= 同类场景重复了没有）
 *   ③ 这些同指纹快照里，`entries` 是否非 0（= 真的命中了经验）
 *   ④ 命中条目数是否稳定（同类场景 → 同类命中，抖得厉害说明指纹没在起作用）
 *
 * 判据（刻意保守，不冒充结论）:
 *   - 只有 1 个指纹 → 「还没重复」，不能说绑定生效（n=1 没有对照）
 *   - 有 ≥2 个快照同指纹且 entries>0 → binding=EXERCISED
 *   - 有同指纹但 entries 恒 0 → binding=NO_HIT（指纹有了，库里没东西命中）
 *   - 没有指纹字段 → binding=NO_FIELD（说明了修复没生效/旧数据）
 *
 * 用法:
 *   node check-fingerprint-binding.js [--monitor <dir>] [--json] [--since <YYYY-MM-DD>]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MONITOR = 'D:\\rdd\\mc\\The Best of Twilight Forest\\config\\numen\\monitor';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/** 只读尾部若干 MB，避免把 16 MB 的 context.jsonl 整个读进来。 */
function tailLines(file, maxBytes) {
  const st = fs.statSync(file);
  const take = Math.min(st.size, maxBytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(take);
  fs.readSync(fd, buf, 0, take, st.size - take);
  fs.closeSync(fd);
  return buf.toString('utf8').split(/\r?\n/).filter(Boolean);
}

function main() {
  const monitor = arg('monitor', DEFAULT_MONITOR);
  const since = arg('since', null);
  const json = process.argv.includes('--json');
  const ctxFile = path.join(monitor, 'context.jsonl');

  const out = {
    ok: true,
    monitor,
    file: ctxFile,
    snapshots: 0,
    withFingerprint: 0,
    distinctFingerprints: 0,
    repeatedFingerprints: 0,
    binding: 'UNKNOWN',
    why: '',
    top: [],
  };

  if (!fs.existsSync(ctxFile)) {
    out.ok = false;
    out.binding = 'NO_DATA';
    out.why = `context.jsonl 不存在：${ctxFile}（没跑过游戏，不折成"没走过"）`;
    return emit(out, json, 2);
  }

  const snaps = [];
  for (const line of tailLines(ctxFile, 24 * 1024 * 1024)) {
    if (!line.includes('retrieval_snapshot')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'retrieval_snapshot' || !o.data) continue;
    if (since && String(o.timestamp || '') < since) continue;
    snaps.push(o);
  }
  out.snapshots = snaps.length;
  if (!snaps.length) {
    out.binding = 'NO_DATA';
    out.why = '尾部窗口里没有 retrieval_snapshot（没进过游戏 / 事件被轮转）';
    return emit(out, json, 2);
  }

  const byFp = new Map();
  for (const s of snaps) {
    const fp = s.data.task_fingerprint;
    if (!fp) continue;
    out.withFingerprint++;
    const key = String(fp);
    const rec = byFp.get(key) || { fingerprint: key, count: 0, entriesSeen: [], timesMs: [], roles: new Set(), first: null, last: null };
    rec.count++;
    rec.entriesSeen.push(Number(s.data.entries || 0));
    if (s.data.role) rec.roles.add(String(s.data.role));
    const ts = String(s.timestamp || '');
    if (!rec.first || ts < rec.first) rec.first = ts;
    if (!rec.last || ts > rec.last) rec.last = ts;
    byFp.set(key, rec);
  }

  out.distinctFingerprints = byFp.size;
  const repeated = [...byFp.values()].filter((r) => r.count >= 2);
  out.repeatedFingerprints = repeated.length;
  out.top = [...byFp.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((r) => ({
      fingerprint: r.fingerprint.slice(0, 12),
      count: r.count,
      entries: [...new Set(r.entriesSeen)].slice(0, 5),
      roles: [...r.roles].slice(0, 3),
      span: `${r.first || '?'} → ${r.last || '?'}`,
    }));

  if (out.withFingerprint === 0) {
    out.binding = 'NO_FIELD';
    out.why = `${snaps.length} 条快照里一条带 task_fingerprint —— 指纹修复没生效，或全是旧数据`;
  } else if (repeated.length === 0) {
    out.binding = 'NOT_REPEATED';
    out.why = `${out.withFingerprint} 条带指纹，但 ${out.distinctFingerprints} 个指纹各出现 1 次 —— `
      + `**同类场景还没重复过**，A6「同类任务再次命中」没有被检验过（n=1 没有对照）`;
  } else {
    // ★ 度量陷阱（2026-10-27 发现，与 #349「哈希=增长」同族）：
    //   同一个指纹连续出现 25 次，很可能只是**同一次任务的 25 个连续轮次**——
    //   那不是「同类任务再次发生」，那是「同一个任务还在跑」。
    //   A6 要的是**跨会话的复发**：同一类场景隔了一段时间/换了目标之后又回来。
    //   所以必须把「同指纹的连续出现」和「同指纹的再次出现」分开算。
    const gapMs = 30 * 60 * 1000;
    const recurrence = [];
    for (const r of repeated) {
      const times = r.timesMs.slice().sort((a, b) => a - b);
      let episodes = 1;
      for (let i = 1; i < times.length; i++) {
        if (times[i] - times[i - 1] > gapMs) episodes++;
      }
      recurrence.push({ fingerprint: r.fingerprint, count: r.count, episodes, entries: r.entriesSeen });
    }
    const crossSession = recurrence.filter((r) => r.episodes >= 2);
    out.recurrenceEpisodes = recurrence.map((r) => ({
      fingerprint: r.fingerprint.slice(0, 12), occurrences: r.count, episodes: r.episodes,
    }));

    const hitCounts = repeated.flatMap((r) => r.entriesSeen);
    const anyHit = hitCounts.some((n) => n > 0);
    const stable = new Set(hitCounts).size === 1;

    if (!anyHit) {
      out.binding = 'NO_HIT';
      out.why = `${repeated.length} 个指纹重复出现，但 entries 恒为 0 —— 指纹有了、库里没有条目命中`;
    } else if (crossSession.length === 0) {
      out.binding = 'SAME_EPISODE_ONLY';
      out.why = `${repeated.length} 个指纹重复出现，但都落在**同一个连续片段**里（间隔 <30 分钟）—— `
        + `那只是「同一个任务还在跑」，不是「同类任务再次发生」；A6 的对照条件**尚未成立**`
        + `（命中条目数 ${[...new Set(hitCounts)].join('/')} 稳定，说明检索本身一致，但不证明跨场景复用）`;
    } else {
      out.binding = 'EXERCISED_CROSS_SESSION';
      out.why = `${crossSession.length} 个指纹在**不同片段**里再次出现（≥2 段），且命中条目数`
        + `${stable ? '稳定' : '有波动'}（${[...new Set(hitCounts)].join('/')}）—— `
        + `这才是 A6 要的「同类场景再来一次、同一条经验再次命中」`;
    }
  }
  return emit(out, json, 0);
}

function emit(out, json, code) {
  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log('目标指纹 ↔ 经验绑定核查');
    console.log(`  快照总数：${out.snapshots}（带指纹 ${out.withFingerprint}）`);
    console.log(`  不同指纹：${out.distinctFingerprints}（重复出现 ${out.repeatedFingerprints}）`);
    console.log(`  结论：${out.binding} —— ${out.why}`);
    if (out.top.length) {
      console.log('  指纹分布（前 5）：');
      for (const t of out.top) {
        console.log(`    ${t.fingerprint}… ×${t.count} entries=${t.entries.join('/') || '-'} roles=${t.roles.join(',')}`);
      }
    }
  }
  process.exit(code);
}

main();
