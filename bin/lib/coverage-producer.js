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
  // 2026-11-10 P1-A（思考者 R-20261110-01）：verify 结果必须逐流消费，拿不到就按失败处理。
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
    // 2026-11-10 P1-A：合法空流（窗口内 0 字节）reader 只留 windowStartOffset 与 fileId，
    // offsets 仍是 undefined；此时 to=from 是事实（读了 0 字节），不是"没读"。
    const rawTo = reader.offsets ? reader.offsets[f] : undefined;
    const hasIdentity = !!(reader.fileId && reader.fileId[f] !== undefined);
    const to = Number.isFinite(rawTo) ? rawTo : (hasIdentity ? from : undefined);
    if (!Number.isFinite(from) || !Number.isFinite(to)) { missing.push(s); continue; }
    const raw = (reader.segments && reader.segments[f]) || [];
    // 逐流验证：只有 verify.ok 为真且该流没有 broken 段，才允许 fingerprintMatch。
    const vf = (v && v.ok === true && v.files) ? v.files[f] : null;
    const filtered = raw.filter((g) => g && Number.isFinite(g.from) && Number.isFinite(g.to) && g.to > from);
    // 合法空流（from===to 且 0 段）不会出现在 verify.files 里：verify.ok 为真即视为"空得可信"。
    const zeroSeg = filtered.length === 0 && from === to;
    const fingerprintOk = vf ? vf.broken === 0 : (zeroSeg && !!(v && v.ok === true));
    const segs = filtered.map((g) => ({ from: Math.max(g.from, from), to: g.to, fingerprintMatch: fingerprintOk }));

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
    // broken 仍只数“连续性失败”（保持原语义）；复读失败单独用 verifyFailed 表达，
    // 这样空流（0 段）也能拒签，而不是靠段上指纹才拦。
    segments[s] = { segments: segs, broken: contiguous ? 0 : 1, halfLine, verifyFailed: !fingerprintOk };
    gaps[s] = gapCount;
    start[s] = from;
    end[s] = to;
    // 换文件时开始/结束身份必然不同，让 coverage 的 fileId 检查也能拒。
    // 2026-11-10 P1-A：拿不到 inode 时必须留空（让 coverage 拒），不能用 String(undefined) 冒充身份。
    fileIds[s] = (inode === undefined || inode === null)
      ? { start: undefined, end: undefined }
      : { start: String(rotated ? 'rotated-before' : inode), end: String(inode) };
  }

  // 2026-11-10 P1-A：replays 未知时不能默认 0（0 = "已核且无重放"）。
  // 用 -1 表示"未核"，coverage.checkLifecycle 会按非 0 拒签。
  const replays = (() => {
    if (typeof reader.replays === 'number') return reader.replays;
    return -1;
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
