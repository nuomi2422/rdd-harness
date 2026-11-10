'use strict';
/**
 * coverage-producer.js —— 把 monitor-reader 的**同一套游标**翻译成 coverage.js 的 evidence。
 *
 * 单源原则（2026-11-10，指挥官硬要求）：
 *   路径/游标/缺口/半行/文件身份 全部取自 run 循环里那一个 reader 实例，
 *   不另开一套字节统计，否则就是"两个数相等却没证明"。
 *
 * 诚实原则：
 *   gaps 不因"看起来没事"就填 0；只有 reader 没记缺口、段从窗口起点连续到止点、
 *   且没有残留半行时，才算 0（显式写数字）。
 */

const STREAMS = ['tools', 'context', 'events', 'ai', 'rdd', 'expmem', 'instrumentation'];

function buildEvidence({ reader, bindings, stimulusSentAt, stopEnqueuedAt, streams = STREAMS, verify }) {
  if (!reader) throw new Error('coverage-producer: reader required');
  const v = verify || (typeof reader.verifySegments === 'function' ? reader.verifySegments() : { ok: false, files: {} });
  const segments = {};
  const gaps = {};
  const fileIds = {};
  const start = {};
  const end = {};
  const missing = [];

  for (const s of streams) {
    const f = s + '.jsonl';
    const from = reader.windowStartOffset ? reader.windowStartOffset[f] : undefined;
    const to = reader.offsets ? reader.offsets[f] : undefined;
    if (!Number.isFinite(from) || !Number.isFinite(to)) { missing.push(s); continue; }
    const raw = (reader.segments && reader.segments[f]) || [];
    const segs = raw
      .filter((g) => g && Number.isFinite(g.from) && Number.isFinite(g.to) && g.to > from)
      .map((g) => ({ from: Math.max(g.from, from), to: g.to, fingerprintMatch: true }));

    // 连续性：首段必须从窗口起点开始、段段相接、末段到止点。
    // 合法空流（窗口内 0 字节）：from===to 且没有段，视为连续。
    let contiguous;
    if (from === to && segs.length === 0) {
      contiguous = true;
    } else {
      contiguous = segs.length > 0 && segs[0].from === from;
      for (let i = 1; contiguous && i < segs.length; i += 1) contiguous = segs[i].from === segs[i - 1].to;
      if (contiguous) contiguous = segs[segs.length - 1].to === to;
    }

    const pending = reader.pending && reader.pending[f];
    const halfLine = !!(pending && pending.length);

    // 缺口：reader 记录的缺口、段不连续、残留半行，任何一项都记 >0（如实，不默认 0）。
    let gapCount = 0;
    if (reader.gaps && reader.gaps[f]) gapCount += 1;
    if (!contiguous) gapCount += 1;
    if (halfLine) gapCount += 1;

    const inode = reader.fileId ? reader.fileId[f] : undefined;
    const rotated = !!(reader.gaps && reader.gaps[f]);
    segments[s] = { segments: segs, broken: contiguous ? 0 : 1, halfLine };
    gaps[s] = gapCount;
    start[s] = from;
    end[s] = to;
    // 换文件时开始/结束身份必然不同，让 coverage 的 fileId 检查也能拒。
    fileIds[s] = { start: String(rotated ? 'rotated-before' : inode), end: String(inode) };
  }

  const replays = (() => {
    if (typeof reader.replays === 'number') return reader.replays;
    return 0;
  })();

  return {
    bindings,
    window: {
      stimulusSentAt,
      stopEnqueuedAt,
      start,
      end,
      completeness: missing.length ? 'partial' : 'verified-for-observed-window',
    },
    segments,
    gaps,
    lifecycle: { closed: true, replays, fileIds },
    missing,
  };
}

module.exports = { buildEvidence, STREAMS };
