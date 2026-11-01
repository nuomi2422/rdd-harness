#!/usr/bin/env node
/**
 * patrol.mjs —— 摄影师的「巡查 + 收摊」。
 *
 * 三件事，全部可单次跑，也可 --loop 常驻：
 *   1. 采样：每隔一段时间读一次镜头状态，落到 _photographer/patrol.jsonl。
 *      为什么要有这个：剪辑时要把「画面变化的秒数」对到「AI 当时在干什么」，
 *      没有时间对齐的现场记录，剪出来的东西只能靠回忆编故事。
 *   2. 体检：距离/可见性/游戏在不在。目标死了没传送过去时，镜头会对着空气，
 *      这种素材拍一小时也是废片 —— 必须当时就发现，不能等剪的时候才发现。
 *   3. 收摊：素材是本机会爆的东西。剪完的 take 只留 highlight.mp4，帧序列删掉。
 *
 * 用法:
 *   node patrol.mjs --once                 # 采一次样
 *   node patrol.mjs --clean                # 按策略清一次
 *   node patrol.mjs --loop 60              # 每 60 秒采一次（常驻）
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const API = process.env.NUMENCAM_API || 'http://127.0.0.1:8767';
const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const STATE_DIR = path.join(SHOTS, '_photographer');
const PATROL = path.join(STATE_DIR, 'patrol.jsonl');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const num = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d; };

fs.mkdirSync(STATE_DIR, { recursive: true });

function get(endpoint, ms = 2500) {
  return new Promise((resolve) => {
    const u = new URL(API + endpoint);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET', timeout: ms }, (r) => {
      let b = ''; r.setEncoding('utf8');
      r.on('data', (c) => b += c);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function lastSample() {
  const txt = (() => { try { return fs.readFileSync(PATROL, 'utf8'); } catch { return ''; } })();
  const lines = txt.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o.kind === 'sample' && o.tpos) return o; } catch { /* ignore */ }
  }
  return null;
}

function append(line) {
  fs.appendFileSync(PATROL, JSON.stringify({ ts: new Date().toISOString(), ...line }) + '\n', 'utf8');
}

async function sample() {
  const st = await get('/state');
  if (!st || !st.ok) { append({ kind: 'offline', note: '8767 不通（游戏没开？）' }); return { ok: false }; }
  const cam = st.camera || {};
  const tgt = st.targetEntity || null;
  const dist = tgt ? Math.hypot(cam.x - tgt.x, cam.y - tgt.y, cam.z - tgt.z) : null;
  // 位置也记下来：卡住不动是「拍摄能发现 bug」的主要判据之一
  const tpos = tgt ? { x: Math.round(tgt.x * 10) / 10, y: Math.round(tgt.y * 10) / 10, z: Math.round(tgt.z * 10) / 10 } : null;
  const rec = {
    kind: 'sample',
    tpos,
    inWorld: !!st.inWorld,
    mode: st.mode, target: st.target, targetVisible: !!st.targetVisible,
    dist: dist === null ? null : Number(dist.toFixed(2)),
    rec: !!(st.rec && st.rec.recording),
    night: !!(st.lens && st.lens.nightVision),
    gamma: st.lens ? st.lens.gamma : null,
    gameTime: st.gameTime || null,
  };
  // 判据：目标不可见 / 距离异常 → 这一刻的画面大概率是废片，当场标出来
  const flags = [];
  if (st.target && !st.targetVisible) flags.push('target-not-visible（目标不在渲染范围：死了没传送/走太远）');
  if (dist !== null && dist > 24) flags.push('target-too-far（' + dist.toFixed(0) + ' 格，超过 24）');
  if (dist !== null && dist < 1.2) flags.push('target-too-close（贴脸，画面里只剩一个头）');
  if (!st.inWorld) flags.push('not-in-world');
  // 卡住判据：连续两次采样位置几乎没变、且间隔够长 → 记一条 stuck
  // （只记事实，不下结论：站着不动也可能是在合成、翻箱子、等天亮）
  try {
    const prev = lastSample();
    if (prev && prev.tpos && tpos) {
      const dt = (Date.now() - Date.parse(prev.ts)) / 1000;
      const moved = Math.hypot(tpos.x - prev.tpos.x, tpos.y - prev.tpos.y, tpos.z - prev.tpos.z);
      if (dt >= 45 && moved < 0.5) flags.push('maybe-stuck（' + Math.round(dt) + 's 内位置只动了 ' + moved.toFixed(1) + ' 格）');
    }
  } catch { /* ignore */ }
  if (flags.length) rec.flags = flags;
  append(rec);
  return { ok: true, rec, flags };
}

function dirSize(p) {
  let s = 0;
  const walk = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q); else { try { s += fs.statSync(q).size; } catch { /* ignore */ } }
    }
  };
  walk(p);
  return s;
}

/** 收摊：剪过的 take 只留 cut/ 里的成片；没剪的老 take 整卷删。 */
function clean({ keepDays = 3, keepRaw = 2, apply = false } = {}) {
  const now = Date.now();
  // ★ 不能用目录 mtime 判新旧：一往 take 里写 cut/ 就会刷新 mtime，等于「刚剪完的永远算新的」。
  //   take 名字里本来就有开拍时间（numencam_YYYYMMDD-HHMMSS），用它才是事实。
  const takeTime = (name) => {
    const m = name.match(/(\d{8})-(\d{6})/);
    if (!m) return 0;
    const [, d, t] = m;
    return Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)),
      Number(t.slice(0, 2)) - 8, Number(t.slice(2, 4)), Number(t.slice(4, 6)));
  };
  const takes = fs.readdirSync(SHOTS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^numencam_/.test(e.name))
    .map((e) => ({ name: e.name, dir: path.join(SHOTS, e.name), mtime: takeTime(e.name) }))
    .sort((a, b) => b.mtime - a.mtime);

  let freed = 0;
  const log = [];
  console.log('[patrol] clean 扫描到 ' + takes.length + ' 个 take（SHOTS=' + SHOTS + '）');
  takes.forEach((t, i) => {
    const cut = path.join(t.dir, 'cut', 'highlight.mp4');
    const ageDays = (now - t.mtime) / 86400000;
    const before = dirSize(t.dir);

    if (!apply) {
      // 演练模式：只报计划，不动文件。删素材是不可逆的，默认不该发生。
      if (fs.existsSync(cut) && ageDays > 0.02) log.push(t.name + '：将删帧序列（保留 cut/），预计省 ' + (before / 1048576 * 0.9).toFixed(1) + 'MB');
      else if (i >= keepRaw && ageDays > keepDays) log.push(t.name + '：将整卷删（' + ageDays.toFixed(1) + ' 天未剪），' + (before / 1048576).toFixed(1) + 'MB');
      return;
    }
    if (fs.existsSync(cut) && ageDays > 0.02) {
      // 有成品：删掉帧序列（它就是那 90% 的体积），保留 cut/ 与 take 根下的 mp4
      let n = 0;
      for (const f of fs.readdirSync(t.dir)) {
        if (/^f_\d{5}\.png$/.test(f) || f === 'base.mp4') { try { fs.unlinkSync(path.join(t.dir, f)); n++; } catch { /* ignore */ } }
      }
      const after = dirSize(t.dir);
      freed += before - after;
      log.push(t.name + '：已剪过 → 删 ' + n + ' 个帧文件，省 ' + ((before - after) / 1048576).toFixed(1) + 'MB');
      return;
    }
    if (i >= keepRaw && ageDays > keepDays) {
      fs.rmSync(t.dir, { recursive: true, force: true });
      freed += before;
      log.push(t.name + '：没剪过的老 take（' + ageDays.toFixed(1) + ' 天）→ 整卷删，省 ' + (before / 1048576).toFixed(1) + 'MB');
    }
  });

  return { freedMb: Number((freed / 1048576).toFixed(1)), log, shotsMb: Number((dirSize(SHOTS) / 1048576).toFixed(1)) };
}

(async () => {
  if (has('--clean')) {
    const r = clean({ keepDays: num('--keep-days', 3), keepRaw: num('--keep-raw', 2), apply: has('--apply') });
    console.log('[patrol] 收摊' + (has('--apply') ? '完成' : '演练（加 --apply 才真删）') + '：释放 ' + r.freedMb + 'MB，素材目录现在 ' + r.shotsMb + 'MB');
    r.log.forEach((l) => console.log('  - ' + l));
    return;
  }
  if (has('--loop')) {
    const every = Math.max(15, num('--loop', 60)) * 1000;
    console.log('[patrol] 每 ' + every / 1000 + ' 秒采一次；Ctrl+C 停');
    for (;;) {
      const r = await sample();
      if (r.ok && r.flags && r.flags.length) console.log('[patrol] 告警 ' + r.flags.join(' / '));
      await new Promise((res) => setTimeout(res, every));
    }
  }
  const r = await sample();
  if (!r.ok) { console.log('[patrol] 游戏不在线，已记一条 offline'); return; }
  console.log('[patrol] ' + JSON.stringify(r.rec));
  if (r.flags.length) console.log('[patrol] 告警 ' + r.flags.join(' / '));
})();
