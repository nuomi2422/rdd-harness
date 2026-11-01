#!/usr/bin/env node
/**
 * film.mjs —— 摄影师的「一轮」：看 → 拍 → 剪 → 清。
 *
 * 为什么做成一条命令：拍、剪、清是同一个动作的三个阶段，分开做必然出现
 * 「拍了没剪」「剪了没清」的半成品堆在盘上。一轮结束要么产出成片，要么明确失败。
 *
 * 安全底线：
 *   - 游戏不在线 / 目标不可见 / 距离异常 → 直接不拍（拍了也是废片，还占盘）
 *   - 正在录像 → 不抢
 *   - 清理只在成片落盘之后发生
 *
 * 用法:
 *   node film.mjs --seconds 20 [--fps 8] [--max-clips 5] [--keep-raw 2] [--reason "在挖矿"]
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const API = process.env.NUMENCAM_API || 'http://127.0.0.1:8767';
const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const SECONDS = Number(arg('--seconds', 20));
const FPS = Math.max(1, Math.min(10, Number(arg('--fps', 8))));
const MAX_CLIPS = Number(arg('--max-clips', 5));
const KEEP_RAW = Number(arg('--keep-raw', 2));
const REASON = arg('--reason', '');

function call(method, endpoint, body, ms = 4000) {
  return new Promise((resolve) => {
    const u = new URL(API + endpoint);
    const payload = method === 'GET' ? null : Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      timeout: ms,
    }, (r) => {
      let b = ''; r.setEncoding('utf8');
      r.on('data', (c) => b += c);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

const die = (msg, code = 1) => { console.error('[film] ' + msg); process.exit(code); };

(async () => {
  // ── 0 取景前检查 ─────────────────────────────────────────────────────────
  let st = await call('GET', '/state');
  if (!st || !st.ok) die('相机控制口不通（游戏没开？）', 2);
  if (!st.inWorld) die('还没进世界', 2);
  if (st.rec && st.rec.recording) die('已经有一路录像在跑，不抢', 2);
  // 目标跑出渲染范围是最常见的「拍空」原因：先自己补位一次，补不回来才放弃。
  // （这不是猜测：body 停在旧位置，目标走远后相机就对着空气。）
  if (st.target && !st.targetVisible) {
    console.log('[film] 目标不在渲染范围 → 开牵引补位（dist 64），等 3s 再看');
    await call('POST', '/follow', { on: true, dist: 64 });
    await new Promise((r) => setTimeout(r, 3000));
    const st2 = await call('GET', '/state');
    if (!st2 || !st2.targetVisible) die('补位后仍看不到目标 ' + st.target + '（可能已死亡/未传送）', 3);
    st = st2;
  }

  const cam = st.camera || {}, tgt = st.targetEntity || {};
  const dist = (cam.x != null && tgt.x != null) ? Math.hypot(cam.x - tgt.x, cam.y - tgt.y, cam.z - tgt.z) : null;
  if (dist !== null && dist > 24) die('机位离目标 ' + dist.toFixed(0) + ' 格，太远（画面里只剩个点）', 3);

  console.log('[film] 取景 OK：mode=' + st.mode + ' target=' + st.target + ' dist=' + (dist === null ? '?' : dist.toFixed(1)) +
    ' 夜视=' + (st.lens && st.lens.nightVision ? '开' : '关') + ' 计划 ' + SECONDS + 's @' + FPS + 'fps');

  // ── 1 录 ────────────────────────────────────────────────────────────────
  const before = new Set(fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter((n) => n.startsWith('numencam_')) : []);
  const start = await call('POST', '/rec', { on: true, fps: FPS });
  if (!start || !start.ok) die('开录失败：' + JSON.stringify(start).slice(0, 160));

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  await call('POST', '/rec', { on: false });
  await new Promise((r) => setTimeout(r, 2500));

  const takeName = fs.readdirSync(SHOTS).filter((n) => n.startsWith('numencam_') && !before.has(n)).sort().pop();
  if (!takeName) die('录完没找到新 take 目录', 4);
  const takeDir = path.join(SHOTS, takeName);
  const frames = fs.readdirSync(takeDir).filter((f) => /^f_\d{5}\.png$/.test(f)).length;
  console.log('[film] 落盘 ' + takeName + '：' + frames + ' 帧');
  if (frames < 3) die('只录到 ' + frames + ' 帧，画面没起来（窗口最小化？渲染卡住？）', 4);

  // ── 2 剪 ────────────────────────────────────────────────────────────────
  try {
    execFileSync(process.execPath, [path.join(HERE, 'cut.mjs'), takeDir, '--max-clips', String(MAX_CLIPS)], { stdio: 'inherit' });
  } catch (e) {
    console.error('[film] 剪辑失败（帧已保留，可手动重跑 cut.mjs）：' + e.message);
  }

  const highlight = path.join(takeDir, 'cut', 'highlight.mp4');
  if (!fs.existsSync(highlight)) die('没产出 highlight.mp4（这一段没有可剪的变化）', 5);

  // ── 3 记一笔 ────────────────────────────────────────────────────────────
  const tl = path.join(SHOTS, '_timeline', 'numencam.jsonl');
  fs.mkdirSync(path.dirname(tl), { recursive: true });
  fs.appendFileSync(tl, JSON.stringify({
    ts: new Date().toISOString(), kind: 'take', take: takeName, frames, fps: FPS, seconds: SECONDS,
    reason: REASON || null, highlight: path.relative(SHOTS, highlight),
  }) + '\n', 'utf8');

  // ── 4 清 ────────────────────────────────────────────────────────────────
  let cleanOut = '';
  try {
    cleanOut = execFileSync(process.execPath, [path.join(HERE, 'patrol.mjs'), '--clean', '--apply', '--keep-raw', String(KEEP_RAW)],
      { encoding: 'utf8' });
  } catch (e) { cleanOut = '清理失败：' + e.message; }
  console.log(cleanOut.trim());

  console.log('[film] 本轮完成 → ' + highlight);
})();
