#!/usr/bin/env node
/**
 * story.mjs —— 把散在各条 take 里的 highlight 拼成一条「干活历程」。
 *
 * 目标不是炫技剪辑，而是回答一句话：这个 AI 在游戏里到底干了什么、顺序是什么。
 * 所以每段只保留：时间 + 当时在干什么（来自 patrol/timeline 的现场记录）+ 画面。
 *
 * 产出：
 *   _photographer/story/story.mp4        按时间顺序拼接的成片
 *   _photographer/story/storyboard.html  带说明的分镜页（用浏览器截图就是一张总览图）
 *   _photographer/story/story.json       机器可读的事件表
 *
 * 用法: node story.mjs [--render]   （--render 会用 Edge 无头模式截一张 storyboard.png）
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'D:\\rdd\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const OUT = path.join(SHOTS, '_photographer', 'story');
fs.mkdirSync(OUT, { recursive: true });

const takeTime = (name) => {
  const m = name.match(/(\d{8})-(\d{6})/);
  if (!m) return 0;
  const [, d, t] = m;
  return Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)),
    Number(t.slice(0, 2)) - 8, Number(t.slice(2, 4)), Number(t.slice(4, 6)));
};

// ── 收集：有成片的 take，按开拍时间排 ─────────────────────────────────────
const takes = fs.readdirSync(SHOTS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^numencam_/.test(e.name))
  .map((e) => ({ name: e.name, dir: path.join(SHOTS, e.name), t: takeTime(e.name) }))
  .sort((a, b) => a.t - b.t);

// 人工策展：摄影师看帧之后可以把「机位被挡/画面无信息」的 take 排除掉。
// 放在文件里而不是写死代码：下一轮再看帧时还能改主意。
const CURATION = path.join(SHOTS, '_photographer', 'curation.json');
let exclude = new Set();
try { exclude = new Set((JSON.parse(fs.readFileSync(CURATION, 'utf8')).exclude) || []); } catch { /* 没配就全收 */ }

// 质量门：录制期间机位距离过近（<2.5 格）的 take 直接不收 —— 画面里全是气泡/大头。
// 这个判据来自 film.mjs 每 2 秒采一次的实测距离，不是猜的。
function takeMeta(name) {
  try {
    const tl = fs.readFileSync(path.join(SHOTS, '_timeline', 'numencam.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    return tl.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o) => o && o.kind === 'take' && o.take === name).pop() || null;
  } catch { return null; }
}

let skippedClose = 0;
const entries = [];
for (const tk of takes) {
  const cutDir = path.join(tk.dir, 'cut');
  const hl = path.join(cutDir, 'highlight.mp4');
  if (!fs.existsSync(hl)) continue;
  if (exclude.has(tk.name)) continue;
  const meta0 = takeMeta(tk.name);
  if (meta0 && meta0.minDist != null && meta0.minDist < 2.5) { skippedClose++; continue; }
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(cutDir, 'highlights.json'), 'utf8')); } catch { /* 老目录没有 json */ }
  const clips = (meta.clips || []);
  // 封面取「最长那一段」的中点：分最高的往往是镜头猛地扫过一片树叶，作封面反而看不懂
  const mid = clips.length ? clips.reduce((a, b) => ((b.end - b.start) > (a.end - a.start) ? b : a)) : null;
  // 用同一条 take 里最靠前那一段的中点帧当封面
  let cover = null;
  if (mid) {
    const frames = fs.readdirSync(tk.dir).filter((f) => /^f_\d{5}\.png$/.test(f)).sort();
    if (frames.length) {
      const fps = meta.fps || 20;
      const idx = Math.min(frames.length - 1, Math.round(((mid.start + mid.end) / 2) * fps));
      cover = path.join(tk.dir, frames[idx]);
    }
  }
  // 封面：帧被清掉的就从成片里抽一帧（成片是永久保留的那份）
  if (!cover) {
    const covers = path.join(OUT, '_covers');
    fs.mkdirSync(covers, { recursive: true });
    const c = path.join(covers, tk.name + '.png');
    if (!fs.existsSync(c)) {
      try {
        execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', '0.5', '-i', hl, '-frames:v', '1', c], { stdio: 'ignore' });
      } catch { /* 抽不出来就算了 */ }
    }
    if (fs.existsSync(c)) cover = c;
  }

  // 说明：优先用剪辑时对上的事件；没有就用台账里这条 take 的拍摄理由
  let label = (mid && mid.events && mid.events.length && mid.events[0].text) ? mid.events[0].text : '';
  if (!label) {
    try {
      const tl = fs.readFileSync(path.join(SHOTS, '_timeline', 'numencam.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
      const hit = tl.map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((o) => o && o.kind === 'take' && o.take === tk.name).pop();
      if (hit && hit.task) label = '当时在做：' + hit.task;
      else if (hit && hit.reason) label = '拍摄理由：' + hit.reason;
      else if (hit) label = '本轮拍摄：' + (hit.frames || '?') + ' 帧 / ' + (hit.seconds || '?') + 's';
    } catch { /* ignore */ }
  }
  entries.push({
    take: tk.name, at: new Date(tk.t).toISOString(), file: hl,
    seconds: meta.clipSeconds || null, clips: clips.length, cover,
    note: label.slice(0, 120),
  });
}

if (entries.length === 0) { console.error('[story] 没有任何 take 有成片（先跑 film.mjs）'); process.exit(2); }

// 成片要「简单」：超长就从最旧的开始丢，保住最近这一段完整的干活链
const CAP_SECONDS = Number(process.env.STORY_MAX_SECONDS || 70);
const MAX_SEGMENTS = Number(process.env.STORY_MAX_SEGMENTS || 6);
let dropped = 0;
// 前缀和不可靠（老 take 的 clipSeconds 可能缺失），所以两道闸：段数 + 时长估计
while (entries.length > MAX_SEGMENTS) { entries.shift(); dropped++; }
while (entries.length > 1 && entries.reduce((s, e) => s + (e.seconds || 8), 0) > CAP_SECONDS) {
  entries.shift();
  dropped++;
}
if (dropped) console.log('[story] 成片要短：丢掉最早的 ' + dropped + ' 段（保留最近 ' + entries.length + ' 段）');

// ── 拼片 ──────────────────────────────────────────────────────────────────
const listFile = path.join(OUT, 'concat.txt');
fs.writeFileSync(listFile, entries.map((e) => "file '" + e.file.replace(/'/g, "'\\''") + "'").join('\n') + '\n', 'utf8');
const story = path.join(OUT, 'story.mp4');
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', story], { stdio: 'inherit' });

let total = 0;
try {
  const out = execFileSync(process.env.FFPROBE || 'D:\\rdd\\tools\\ffmpeg\\bin\\ffprobe.exe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', story], { encoding: 'utf8' });
  total = Number(out.trim()) || 0;
} catch { /* 没 ffprobe 就算了 */ }

// ── 行动轨迹（巡查采样里的坐标）──────────────────────────────────────────
// 用户要的「有趣」不是画面好看，是「它的行动轨迹」：去哪儿、下多深、绕没绕圈。
// 采样是 60s 一次，够画路线；不够细也没关系，这是索引，不是测绘图。
function buildTrack() {
  const file = path.join(SHOTS, '_photographer', 'patrol.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return null; }
  const pts = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o.kind === 'sample' && o.tpos) pts.push({ t: Date.parse(o.ts), x: o.tpos.x, y: o.tpos.y, z: o.tpos.z });
    } catch { /* ignore */ }
  }
  if (pts.length < 3) return null;
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const spanX = Math.max(1, maxX - minX), spanZ = Math.max(1, maxZ - minZ);
  const W = 420, H = 260, PAD = 12;
  const sx = (x) => PAD + ((x - minX) / spanX) * (W - PAD * 2);
  const sz = (z) => H - PAD - ((z - minZ) / spanZ) * (H - PAD * 2);
  return { pts, path: pts.map((p, i) => (i ? 'L' : 'M') + sx(p.x).toFixed(1) + ',' + sz(p.z).toFixed(1)).join(' '),
    ys, yMin: Math.min(...ys), yMax: Math.max(...ys), W, H, locals: pts.map((p) => localTime(new Date(p.t).toISOString())) };
}

// ── 分镜页 ────────────────────────────────────────────────────────────────
// 给人看的页面一律本地时间（UTC+8），UTC 只留在 story.json 里
const localTime = (iso) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19) + ' +08';
const rows = entries.map((e, i) => {
  const cover = e.cover ? 'file:///' + e.cover.replace(/\\/g, '/').replace(/ /g, '%20') : '';
  return '<div class="row"><div class="idx">' + String(i + 1).padStart(2, '0') + '</div>' +
    '<div class="pic">' + (cover ? '<img src="' + cover + '">' : '') + '</div>' +
    '<div class="txt"><div class="ts">' + localTime(e.at) + '</div>' +
    '<div class="note">' + (e.note || '（这段时间现场没有记录到事件）') + '</div>' +
    '<div class="meta">' + e.take + ' · ' + (e.seconds || '?') + 's · ' + e.clips + ' 段</div></div></div>';
}).join('\n');

// ── 轨迹图（俯视路线 + 高度曲线）─────────────────────────────────────────
let trackHtml = '';
{
  const T = buildTrack();
  if (T) {
    const yW = 420, yH = 100;
    const yPath = T.ys.map((y, i) => (i ? 'L' : 'M') + (8 + i * (yW - 16) / Math.max(1, T.ys.length - 1)).toFixed(1) + ',' +
      (yH - 8 - ((y - T.yMin) / Math.max(1, T.yMax - T.yMin)) * (yH - 20)).toFixed(1)).join(' ');
    const first = T.pts[0], last = T.pts[T.pts.length - 1];
    const dot = (p, c) => '<circle cx="' + (12 + ((p.x - T.pts[0].x) * 0 + 0)) + '" cy="0" r="0" fill="' + c + '"/>';
    trackHtml = '<div class="card"><h2>行动轨迹 <span class="r">' + T.pts.length + ' 个采样 · ' +
      T.locals[0].slice(11, 16) + ' → ' + T.locals[T.locals.length - 1].slice(11, 16) + '</span></h2>' +
      '<div class="track">' +
      '<div><div class="cap">俯视路线（横 x / 纵 z）</div>' +
      '<svg width="' + T.W + '" height="' + T.H + '"><rect width="' + T.W + '" height="' + T.H + '" fill="#141517" stroke="#3A3C42"/>' +
      '<path d="' + T.path + '" fill="none" stroke="#3ED1E8" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<circle cx="' + T.path.split(' ')[0].slice(1).split(',')[0] + '" cy="' + T.path.split(' ')[0].slice(1).split(',')[1] + '" r="3" fill="#45C46A"/>' +
      '<circle cx="' + T.path.split(' ').pop().slice(1).split(',')[0] + '" cy="' + T.path.split(' ').pop().slice(1).split(',')[1] + '" r="3" fill="#F9B93F"/>' +
      '</svg></div>' +
      '<div><div class="cap">高度（y，' + T.yMin.toFixed(0) + ' ~ ' + T.yMax.toFixed(0) + '）</div>' +
      '<svg width="' + yW + '" height="' + yH + '"><rect width="' + yW + '" height="' + yH + '" fill="#141517" stroke="#3A3C42"/>' +
      '<path d="' + yPath + '" fill="none" stroke="#F9B93F" stroke-width="1.4"/></svg></div>' +
      '</div></div>';
  }
}

const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>干活历程</title>' +
  '<style>body{background:#17181A;color:#E6E7E9;font:13.5px/1.6 "Segoe UI","Microsoft YaHei UI",sans-serif;margin:0;padding:20px}' +
  'h1{font-size:15px;letter-spacing:.2em;color:#F9B93F;text-transform:uppercase;margin:0 0 4px}' +
  '.sub{color:#9A9DA3;font-size:12px;margin-bottom:16px}' +
  '.row{display:grid;grid-template-columns:44px 320px 1fr;gap:14px;align-items:center;border-bottom:1px solid #3A3C42;padding:10px 0}' +
  '.idx{font:700 20px/1 Consolas,monospace;color:#5A5D63}' +
  '.pic img{width:320px;display:block;border:1px solid #5A5D66}' +
  '.ts{font:12px/1.6 Consolas,monospace;color:#3ED1E8}' +
  '.note{font-size:13.5px;margin:4px 0}' +
  '.meta{font:11px/1.5 Consolas,monospace;color:#5A5D63}' +
  '.card{margin:8px 0 18px;border:1px solid #3A3C42;padding:10px 12px}' +
  '.card h2{font-size:11px;letter-spacing:.2em;color:#9A9DA3;margin:0 0 8px;text-transform:uppercase}' +
  '.card h2 .r{float:right;color:#5A5D63;letter-spacing:.06em;text-transform:none}' +
  '.track{display:flex;gap:24px;align-items:flex-start}.cap{font:11px/1.8 Consolas,monospace;color:#5A5D63}</style>' +
  '<h1>AI 干活历程 · 实拍摘要</h1>' +
  '<div class="sub">' + entries.length + ' 段 / ' + total.toFixed(1) + 's · 由 numencam 相机逐轮拍摄，按「画面有变化」筛出</div>' +
  trackHtml + rows + '</html>';
const htmlFile = path.join(OUT, 'storyboard.html');
fs.writeFileSync(htmlFile, html, 'utf8');

fs.writeFileSync(path.join(OUT, 'story.json'), JSON.stringify({
  builtAt: new Date().toISOString(), entries: entries.length, seconds: Number(total.toFixed(2)),
  takes: entries.map((e) => ({ take: e.take, at: e.at, seconds: e.seconds, note: e.note })),
}, null, 2), 'utf8');

if (skippedClose) console.log('[story] 按「机位贴脸」跳过滤掉 ' + skippedClose + ' 条 take');
console.log('[story] ' + entries.length + ' 段 / ' + total.toFixed(1) + 's → ' + story);
console.log('[story] 分镜页 → ' + htmlFile);

// ── 可选：无头浏览器截一张 ────────────────────────────────────────────────
if (args().includes('--render')) {
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
  if (!edge) { console.error('[story] 找不到 Edge，跳过分镜截图'); process.exit(0); }
  const png = path.join(OUT, 'storyboard.png');
  execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1400,900',
    '--screenshot=' + png, '--virtual-time-budget=4000', 'file:///' + htmlFile.replace(/\\/g, '/').replace(/ /g, '%20')],
    { stdio: 'ignore' });
  console.log('[story] 分镜图 → ' + png);
}
function args() { return process.argv.slice(2); }
