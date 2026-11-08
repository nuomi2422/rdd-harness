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
      if ((offsets[f] || 0) > 0) noteGap(f, 'missing-file', { from: offsets[f] });
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
      if (complete.length < n && pending[f] && pending[f].size === size) noteGap(f, 'stalled-partial', { size });
      pending[f] = complete.length < n ? { size } : null;
      offsets[f] = (offsets[f] || 0) + complete.length;
      if (evidenceDir) fs.appendFileSync(path.join(evidenceDir, f), complete);
      return complete.toString('utf8');
    } catch (e) {
      noteGap(f, 'read-failed', { error: String((e && e.message) || e).slice(0, 120) });
      return '';
    } finally { fs.closeSync(fd); }
  }

  return { pull, gaps, offsets, fileId, pending, anchors };
}

module.exports = { createPull };
