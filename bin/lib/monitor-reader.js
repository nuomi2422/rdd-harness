'use strict';
/**
 * monitor-reader.js —— 监控流增量读取器（可测模块，2026-11-09 从 exp-runner 内嵌 pull 抽出）
 *
 * 为什么抽出来：这段逻辑决定"缺了一段"能否被看见，是判断"完整/不完整"的地基。
 * 内嵌在 CLI 里就没有独立单测，等于地基不可测。抽成模块后行为不变，CLI 只换调用方式。
 *
 * 缺口语义（任一发生都记 gaps[file]，消费者据此判 UNKNOWN，绝不静默当完整）：
 *   missing-file       文件消失
 *   truncated-or-rotated 变小（截断/轮转）
 *   replaced-same-size 大小相同但 inode 变了（轮转出同名新文件）
 *   short-read         读到的字节少于应读
 *   read-failed        读抛异常
 *   stalled-partial    末行半行连续两次轮询不变（写入方停住，可能永远补不齐）
 *
 * 已知**识别不了**的情形（不得声称已覆盖）：
 *   ① 同 inode 原地覆写（inode 不变、大小不变或变大）
 *   ② 文件先增长、随后被更大内容整体覆盖（新大小 ≥ 旧 offset）
 * 这两种只能靠外部证据（如生产者写的 run/epoch）兜底，本模块不假装能识别。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createPull(opts) {
  const dir = opts.dir;
  const evidenceDir = opts.evidenceDir;
  const nowIso = opts.nowIso || (() => new Date().toISOString());
  const offsets = Object.assign({}, opts.offsets || {});
  const gaps = {};
  const fileId = {};
  const pending = {};
  // 2026-11-09：窗口起点锚。窗口开始后**文件开头 64 字节必须保持不变**，
  // 一旦被改写（原地覆写的常见形态）就说明"这段内容已经不是你当初读的那段"，
  // 记 anchor-changed 缺口。这是对"同 inode 原地覆写"部分盲区的**有界**缓解，不是全覆盖。
  const anchors = {};
  // 窗口起点偏移：第一个被消费字节的位置。窗口完整性只对 [起点, 当前位置) 有意义。
  const windowStartOffset = {};
  // 已消费的字节段：用于事后复核（我读到的内容现在是否还在磁盘上）
  const segments = {};
  // 2026-11-10 P1-A（R-20261110-02 第 1 点）：生产重放检测。
  // 身份域 = event_id 全局（同一事件在任意流里出现两次即重放）；只看窗口内已消费字节。
  const seenEventIds = new Set();
  let replays = 0;
  const scanEventIds = (s) => {
    const re = /"event_id"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (seenEventIds.has(m[1])) replays += 1;
      else seenEventIds.add(m[1]);
    }
  };
  const ANCHOR_BYTES = 64;
  // 只读前 len 字节做比较：窗口起点时文件可能还不到 64 字节，若每次都读满 64 再比，
  // 文件正常增长就会被误判成"锚变了"。所以比较长度固定为**起点时的长度**。
  const readAnchor = (p, len) => {
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const b = Buffer.alloc(len || ANCHOR_BYTES);
        const n = fs.readSync(fd, b, 0, b.length, 0);
        return b.subarray(0, n);
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  };

  const noteGap = (f, reason, extra) => {
    if (!gaps[f]) gaps[f] = { at: nowIso(), reason, ...(extra || {}) };
  };

  function pull(f) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) {
      // A missing required stream is never evidence of a complete empty window,
      // including at offset zero before the first record arrives.
      noteGap(f, 'missing-file', { from: offsets[f] || 0 });
      return '';
    }
    let st;
    try { st = fs.statSync(p, { bigint: true }); }
    catch (e) { noteGap(f, 'stat-failed', { error: String((e && e.message) || e).slice(0, 120) }); return ''; }
    // 不是普通文件（目录/设备等）：直接判缺口，别拿 size=0 当成"没新内容"。
    if (typeof st.isFile === 'function' && !st.isFile()) {
      noteGap(f, 'not-a-file', { path: p });
      return '';
    }
    const size = Number(st.size);
    const ino = String(st.ino);

    if (size < (offsets[f] || 0)) {
      noteGap(f, 'truncated-or-rotated', { from: offsets[f], to: size });
      offsets[f] = 0;
      delete fileId[f];
    }
    if (fileId[f] && fileId[f] !== ino) {
      noteGap(f, 'replaced-same-size', { from: offsets[f], to: size });
      offsets[f] = 0;
    }
    fileId[f] = ino;
    // 锚校验：窗口起点内容变了就是缺口（只覆盖"开头被改写"，不改后半段仍可能漏）
    if (!anchors[f]) { const a = readAnchor(p, ANCHOR_BYTES); if (a && a.length) anchors[f] = a; }
    else {
      const now = readAnchor(p, anchors[f].length);
      if (now && now.length === anchors[f].length && !now.equals(anchors[f])) noteGap(f, 'anchor-changed', { bytes: anchors[f].length });
    }
    // 零字节流也要留下窗口起点：否则"合法空流"与"根本没消费"分不开。
    if (windowStartOffset[f] === undefined) windowStartOffset[f] = offsets[f] || 0;
    if (size <= (offsets[f] || 0)) return '';

    let fd;
    try { fd = fs.openSync(p, 'r'); }
    catch (e) { noteGap(f, 'read-failed', { error: String((e && e.message) || e).slice(0, 120) }); return ''; }
    try {
      const len = size - (offsets[f] || 0);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, offsets[f] || 0);
      if (n !== len) noteGap(f, 'short-read', { want: len, got: n });
      const text = buf.subarray(0, n).toString('utf8');
      const cut = text.lastIndexOf('\n');
      if (cut < 0) {
        if (pending[f] && pending[f].size === size) noteGap(f, 'stalled-partial', { size });
        pending[f] = { size };
        return '';
      }
      const complete = Buffer.from(text.slice(0, cut + 1), 'utf8');
      scanEventIds(complete.toString('utf8'));
      if (complete.length < n && pending[f] && pending[f].size === size) noteGap(f, 'stalled-partial', { size });
      pending[f] = complete.length < n ? { size } : null;
      const from = offsets[f] || 0;
      if (windowStartOffset[f] === undefined) windowStartOffset[f] = from;
      (segments[f] || (segments[f] = [])).push({
        from, to: from + complete.length,
        sha256: crypto.createHash('sha256').update(complete).digest('hex'),
      });
      offsets[f] = (offsets[f] || 0) + complete.length;
      if (evidenceDir) fs.appendFileSync(path.join(evidenceDir, f), complete);
      return complete.toString('utf8');
    } catch (e) {
      noteGap(f, 'read-failed', { error: String((e && e.message) || e).slice(0, 120) });
      return '';
    } finally { fs.closeSync(fd); }
  }

  return {
    pull, gaps, offsets, fileId, pending, anchors, segments, windowStartOffset, verifySegments, verifyWindow,
    // 生产重放计数（只增不减；消费方拿不到就读不到，不得默认 0）。
    get replays() { return replays; },
    get eventIds() { return seenEventIds.size; },
  };

  /**
   * 窗口完整性（**有界声明**）：只证明"从窗口起点偏移到当前已读位置，每个字节都被读过一次，
   * 连续、无截断/轮转/跳读"。它**不能**证明：
   *   - 窗口起点之前的内容（那些我们本来就没打算读）；
   *   - 读到之前文件是否已被原地改写（锚只能发现开头被改）。
   * 所以签发的等级叫 verified-for-observed-window，不是全局"完整"。
   */
  function verifyWindow(requiredFiles) {
    const files = {};
    let ok = true;
    for (const [f, list] of Object.entries(segments)) {
      const from = windowStartOffset[f];
      const to = offsets[f] || 0;
      const contiguous = list.every((seg, i) => (i === 0 ? seg.from === from : seg.from === list[i - 1].to));
      const endsAtNow = list.length > 0 && list[list.length - 1].to === to;
      const noGap = !gaps[f];
      if (!(contiguous && endsAtNow && noGap)) ok = false;
      files[f] = { from, to, contiguous, endsAtNow, noGap };
    }
    // 任何"应被覆盖但没读到段"的流都算窗口不完整（多流缺一不能算完整）。
    if (Array.isArray(requiredFiles)) {
      for (const f of requiredFiles) { if (!files[f]) { ok = false; files[f] = { missing: true }; } }
    }
    if (!Object.keys(files).length) ok = false;
    return { ok, files };
  }

  /**
   * 事后复核：把每段已消费字节从磁盘重读并比对摘要。
   * 能证明的只有：我读到的那些字节，现在磁盘上还是同样的字节。
   * 不能证明：来源、历史时刻、读之前是否已被替换。
   */
  function verifySegments() {
    const files = {};
    let ok = true;
    for (const [f, list] of Object.entries(segments)) {
      const p = path.join(dir, f);
      let verified = 0, broken = 0, contiguous = true, expect = null;
      for (const seg of list) {
        if (expect !== null && seg.from !== expect) contiguous = false;
        expect = seg.to;
        try {
          const fd = fs.openSync(p, 'r');
          try {
            const b = Buffer.alloc(seg.to - seg.from);
            const n = fs.readSync(fd, b, 0, b.length, seg.from);
            const h = crypto.createHash('sha256').update(b.subarray(0, n)).digest('hex');
            if (n === b.length && h === seg.sha256) verified++; else broken++;
          } finally { fs.closeSync(fd); }
        } catch { broken++; }
      }
      if (broken || !contiguous || !list.length) ok = false;
      files[f] = { segments: list.length, verified, broken, contiguous, from: list.length ? list[0].from : null, to: expect };
    }
    if (!Object.keys(files).length) ok = false;
    return { ok, files };
  }
}

module.exports = { createPull };