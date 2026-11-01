#!/usr/bin/env node
/**
 * cut.mjs —— 摄影师剪辑器：从一个 take 的帧序列里挑出「有事发生」的段落。
 *
 * 判定口径（刻意简单，不引入任何模型/依赖）：
 *   一段画面值不值得留，看它「变没变」。AI 在干活时，画面剧烈变化的时刻恰好是
 *   换地方、开挖、开打、传送 —— 也就是用户要的「重要事件」。反过来，长时间几乎不动
 *   的帧（站着、界面挂着）全是可以丢的。
 *
 * 这里只做「挑」，不做「讲故事」：事件语义来自 patrol.jsonl（巡查时记的状态快照）
 * 和 timeline（行为台账），本脚本负责把像素变化和时间轴对齐。
 *
 * 用法:
 *   node cut.mjs <take目录> [--max-clips 6] [--pad 1.2] [--min-score 0.18] [--max-seconds 45]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'D:\\rdd\\tools\\ffmpeg\\bin\\ffmpeg.exe';

const args = process.argv.slice(2);
const take = args[0];
if (!take) { console.error('用法: node cut.mjs <take目录> [--max-clips N] [--pad S] [--min-score X] [--max-seconds S]'); process.exit(2); }
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
}
const MAX_CLIPS = opt('max-clips', 6);
const PAD = opt('pad', 1.2);
const MIN_SCORE = opt('min-score', 0.18);
const MAX_SECONDS = opt('max-seconds', 45);

const dir = path.resolve(take);
const outDir = path.join(dir, 'cut');
fs.mkdirSync(outDir, { recursive: true });

// ── 1 读 take 事实 ─────────────────────────────────────────────────────────
const txt = (() => { try { return fs.readFileSync(path.join(dir, 'numencam.txt'), 'utf8'); } catch { return ''; } })();
const fps = Number((txt.match(/fps=(\d+)/) || [])[1] || 20);
const frames = fs.readdirSync(dir).filter((f) => /^f_\d{5}\.png$/.test(f)).sort();
if (frames.length === 0) { console.error('这个 take 没有帧'); process.exit(2); }
const pattern = path.join(dir, 'f_%05d.png');
const durationSec = frames.length / fps;

console.log('[cut] take=' + path.basename(dir) + '  frames=' + frames.length + '  fps=' + fps + '  ' + durationSec.toFixed(1) + 's');

// ── 2 合成基础片（如果还没有）──────────────────────────────────────────────
const baseMp4 = path.join(outDir, 'base.mp4');
if (!fs.existsSync(baseMp4)) {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', pattern,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', baseMp4], { stdio: 'inherit' });
  console.log('[cut] base.mp4 已合成 +' + (fs.statSync(baseMp4).size / 1048576).toFixed(1) + 'MB');
}

// ── 3 场景变化点：ffmpeg 的 scene 分数（0..1）──────────────────────────────
// ★ 过滤器里的 file= 不能带盘符/空格（会被当成 filter 选项解析），所以切到 outDir 用相对名
const metaFile = path.join(outDir, 'scenes.txt');
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', baseMp4,
  '-vf', "select='gt(scene,0.02)',metadata=print:file=scenes.txt", '-an', '-f', 'null', '-'],
  { stdio: 'inherit', cwd: outDir });

const marks = [];
(() => {
  let t = null;
  for (const line of fs.readFileSync(metaFile, 'utf8').split(/\r?\n/)) {
    const mt = line.match(/pts_time:([0-9.]+)/);
    if (mt) { t = Number(mt[1]); continue; }
    const ms = line.match(/lavfi\.scene_score=([0-9.]+)/);
    if (ms && t !== null) { marks.push({ t, score: Number(ms[1]) }); t = null; }
  }
})();
marks.sort((a, b) => b.score - a.score);
console.log('[cut] 候选变化点 ' + marks.length + ' 个，最强 ' + (marks[0] ? marks[0].score.toFixed(2) : '-'));

// ── 4 选段：按分数取前 N，段间重叠就合并，总长封顶 ─────────────────────────
const picked = [];
for (const m of marks) {
  if (m.score < MIN_SCORE) continue;
  const a = Math.max(0, m.t - PAD), b = Math.min(durationSec, m.t + PAD);
  const hit = picked.find((p) => a <= p.end + 0.15 && b >= p.start - 0.15);
  if (hit) { hit.end = Math.max(hit.end, b); hit.score = Math.max(hit.score, m.score); hit.hits++; }
  else picked.push({ start: a, end: b, score: m.score, hits: 1, at: m.t });
  if (picked.length >= MAX_CLIPS) break;
}
picked.sort((a, b) => a.start - b.start);
// 总长封顶：从尾部砍（宁可少剪，不要拼成 3 分钟垃圾）
let total = picked.reduce((s, p) => s + (p.end - p.start), 0);
while (total > MAX_SECONDS && picked.length > 1) {
  const last = picked.pop();
  total -= (last.end - last.start);
}

if (picked.length === 0) {
  console.error('[cut] 没挑出可用段落 —— 这卷素材基本没变化（可能界面挂着 / 画面被挡 / 主体没动）');
  fs.writeFileSync(path.join(outDir, 'highlights.json'), JSON.stringify({ take: path.basename(dir), fps, durationSec, clips: [], note: 'no-motion' }, null, 2));
  process.exit(3);
}

// ── 5 逐段切 + 拼接 ───────────────────────────────────────────────────────
const clips = [];
picked.forEach((p, i) => {
  const out = path.join(outDir, 'clip_' + String(i).padStart(2, '0') + '.mp4');
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', p.start.toFixed(2), '-to', p.end.toFixed(2),
    '-i', baseMp4, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-an', out], { stdio: 'inherit' });
  clips.push({ file: path.basename(out), start: Number(p.start.toFixed(2)), end: Number(p.end.toFixed(2)), score: Number(p.score.toFixed(3)), hits: p.hits });
});
const listFile = path.join(outDir, 'concat.txt');
fs.writeFileSync(listFile, clips.map((c) => "file '" + c.file + "'").join('\n') + '\n', 'utf8');
const highlight = path.join(outDir, 'highlight.mp4');
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
  '-c', 'copy', highlight], { stdio: 'inherit' });

// ── 6 联系表：每段取中点一帧拼一张图（一眼看全，不用播）──────────────────
const midFrames = picked.map((p) => Math.min(frames.length - 1, Math.round(((p.start + p.end) / 2) * fps)));
const sheetInputs = [];
midFrames.forEach((idx, i) => {
  const f = path.join(dir, frames[idx]);
  sheetInputs.push('-i', f);
});
const sheet = path.join(outDir, 'sheet.png');
const cols = Math.min(3, midFrames.length);
const rows = Math.ceil(midFrames.length / cols);
const filter = midFrames.map((_, i) => '[' + i + ':v]scale=426:240,setsar=1[v' + i + ']').join(';') +
  ';' + midFrames.map((_, i) => '[v' + i + ']').join('') + 'xstack=inputs=' + midFrames.length +
  ':layout=' + midFrames.map((_, i) => (i % cols) * 426 + '_' + Math.floor(i / cols) * 240).join('|') + '[out]';
try {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...sheetInputs, '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', sheet], { stdio: 'inherit' });
} catch (e) { console.error('[cut] 联系表没做出来：' + e.message); }

// ── 7 事件语义：挂上巡查快照 / 行为台账里最近的记录 ────────────────────────
function nearestEvents(sec) {
  const pool = [];
  const patrol = path.join(SHOTS(), '_photographer', 'patrol.jsonl');
  const timeline = path.join(SHOTS(), '_timeline', 'numencam.jsonl');
  for (const [file, kind] of [[patrol, 'patrol'], [timeline, 'event']]) {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { continue; }
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        const t = Date.parse(o.ts);
        if (!Number.isNaN(t)) pool.push({ kind, at: t, text: o.text || o.note || o.summary || (o.state && o.state.mode) || '' });
      } catch { /* 忽略坏行 */ }
    }
  }
  if (!pool.length) return [];
  const takeStart = fs.statSync(dir).birthtimeMs || fs.statSync(dir).mtimeMs;
  const want = takeStart + sec * 1000;
  return pool.map((p) => ({ ...p, d: Math.abs(p.at - want) })).sort((a, b) => a.d - b.d).slice(0, 2);
}
function SHOTS() {
  return process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
}

const finalClips = clips.map((c) => ({ ...c, events: nearestEvents(c.start) }));
const out = {
  take: path.basename(dir), fps, frames: frames.length, durationSec: Number(durationSec.toFixed(2)),
  clipSeconds: Number(finalClips.reduce((s, c) => s + (c.end - c.start), 0).toFixed(2)),
  clips: finalClips, highlight: path.basename(highlight), sheet: fs.existsSync(sheet) ? path.basename(sheet) : null,
};
fs.writeFileSync(path.join(outDir, 'highlights.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('[cut] 完成：' + finalClips.length + ' 段 / ' + out.clipSeconds + 's → ' + highlight);
console.log('[cut] 联系表：' + (out.sheet || '无'));
