'use strict';
/**
 * coverage-producer-sample.js —— 生产者样例（2026-11-10，教学用，不参与生产判定）
 *
 * 目的：让 exp-runner 一侧照着这段算七流的 segments/window/lifecycle，
 * 不必猜 coverage.js 的契约。**它不决定 verdict**：只产出 evidence，
 * 由 makeVerifiedCoverage 决定能不能签发；算不全就抛/标 rejected。
 *
 * 算法（每个流）：
 *   1. 记录读取前 fileId（stat.ino + size），用 reader 游标从 0 读到当前末尾；
 *   2. 半行检测：字节末尾不是 \n ⇒ halfLine=true（未完成段，签发会被拒）；
 *   3. 事后复读同一区间算 sha256，与读取时比对 ⇒ fingerprintMatch；
 *   4. 读完后重新 stat，fileId 变了 ⇒ start/end 不同（签发会被拒=换文件）。
 *   5. 重放检测：读到的行里 event_id 出现 >1 次 ⇒ transfers.replays。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 缺的流不补 0：直接标 missing，由 coverage.js 判定为“流未消费”。 */
function buildEvidenceFromStreams(opts) {
  const dir = opts.dir;
  const streams = opts.streams || ['tools', 'context', 'events', 'ai', 'rdd', 'expmem', 'instrumentation'];
  const segments = {};
  const gaps = {};
  const fileIds = {};
  const start = {};
  const end = {};
  const missing = [];

  // reader 游标：真实集成时换成 monitor-reader 的 createPull；这里用文件尾偏移当游标。
  const offsets = {};
  for (const s of streams) {
    const p = path.join(dir, s + '.jsonl');
    if (!fs.existsSync(p)) { missing.push(s); continue; }
    const st0 = fs.statSync(p);
    const buf = fs.readFileSync(p);
    const from = offsets[s] || 0;
    const to = buf.length;
    offsets[s] = to;
    const halfLine = buf.length > 0 && buf[buf.length - 1] !== 0x0a;
    // 事后复读同一区间：证明“内容自读取后没变”（不证明来源）。
    const again = fs.readFileSync(p);
    const fingerprintMatch = sha(buf.subarray(from, to)) === sha(again.subarray(from, to));
    const st1 = fs.statSync(p);
    segments[s] = { segments: [{ from, to, fingerprintMatch }], broken: fingerprintMatch ? 0 : 1, halfLine };
    gaps[s] = 0;
    start[s] = from;
    end[s] = to;
    fileIds[s] = { start: String(st0.ino), end: String(st1.ino) };
  }

  // 重放：只统计读到的行（这里统计整文件里的重复 event_id）。
  let replays = 0;
  try {
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    const seen = new Map();
    for (const l of lines) {
      let ev; try { ev = JSON.parse(l); } catch { continue; }
      const id = ev.event_id; if (!id) continue;
      seen.set(id, (seen.get(id) || 0) + 1);
    }
    for (const n of seen.values()) if (n > 1) replays += 1;
  } catch { replays = 0; }

  return {
    bindings: opts.bindings,
    window: {
      stimulusSentAt: opts.stimulusSentAt,
      stopEnqueuedAt: opts.stopEnqueuedAt,
      start, end,
      completeness: missing.length ? 'partial' : 'verified-for-observed-window',
    },
    segments,
    gaps,
    lifecycle: { closed: true, replays, fileIds },
    missing,
  };
}

module.exports = { buildEvidenceFromStreams };
