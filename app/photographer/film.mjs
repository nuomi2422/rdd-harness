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

// ── 游戏内 AI 当时在干什么（只读工具；get_events 是消费式收件箱，绝对不碰）──
function numenCall(cfg, tool, args2) {
  const post = (body) => new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: cfg.host || '127.0.0.1', port: cfg.port, path: '/mcp', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length,
        accept: 'application/json, text/event-stream', ...(cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}) },
      timeout: 3000,
    }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload); req.end();
  });
  return (async () => {
    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'photographer', version: '1' } } });
    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args2 || {} } });
    const txt = ((r && r.result && r.result.content) || []).map((c) => c.text).filter(Boolean).join('\n');
    try { return JSON.parse(txt); } catch { return null; }
  })();
}

function aiStatus() {
  const cfgFile = path.join(process.env.RDD_LIVE || 'D:\\rdd\\mc\\The Best of Twilight Forest', 'config', 'numen', 'mcp_server.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); } catch { return Promise.resolve(null); }
  if (!cfg || !cfg.port) return Promise.resolve(null);
  return numenCall(cfg, 'get_self_status', { companion: 'RDD' }).catch(() => null);
}

function worldInfo() {
  const cfgFile = path.join(process.env.RDD_LIVE || 'D:\\rdd\\mc\\The Best of Twilight Forest', 'config', 'numen', 'mcp_server.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); } catch { return Promise.resolve(null); }
  if (!cfg || !cfg.port) return Promise.resolve(null);
  return numenCall(cfg, 'get_world_info', { companion: 'RDD' }).catch(() => null);
}

const FRAMING_FILE = path.join(SHOTS, '_photographer', 'framing.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2), 'utf8'); } catch { /* ignore */ } };

function aiTaskNow() {
  const cfgFile = path.join(process.env.RDD_LIVE || 'D:\\rdd\\mc\\The Best of Twilight Forest', 'config', 'numen', 'mcp_server.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
  if (!cfg || !cfg.port) return null;
  return numenCall(cfg, 'task_status', { companion: 'RDD' }).then((r) => (r && r.message) || null).catch(() => null);
}

(async () => {
  // ── 0 取景前检查 ─────────────────────────────────────────────────────────
  let st = await call('GET', '/state');
  if (!st || !st.ok) die('相机控制口不通（游戏没开？）', 2);
  if (!st.inWorld) die('还没进世界', 2);
  if (st.rec && st.rec.recording) die('已经有一路录像在跑，不抢', 2);
  // 目标跑出渲染范围是最常见的「拍空」原因：先自己补位一次，补不回来才放弃。
  // （这不是猜测：body 停在旧位置，目标走远后相机就对着空气。）
  if (st.target && !st.targetVisible) {
    // 它走路时会短暂离开加载区，一次补位常常不够 —— 给 3 次机会，每次 4 秒
    console.log('[film] 目标不在渲染范围 → 开牵引补位（dist 64），最多重试 3 次');
    await call('POST', '/follow', { on: true, dist: 64 });
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const st2 = await call('GET', '/state');
      if (st2 && st2.targetVisible) { st = st2; ok = true; console.log('[film] 第 ' + (i + 1) + ' 次补位后可见'); }
    }
    if (!ok) die('3 次补位后仍看不到目标 ' + st.target + '（可能已死亡/在别的维度/未传送）', 3);
  }

  const cam0 = st.camera || {}, tgt0 = st.targetEntity || {};
  let dist = (cam0.x != null && tgt0.x != null) ? Math.hypot(cam0.x - tgt0.x, cam0.y - tgt0.y, cam0.z - tgt0.z) : null;
  if (dist !== null && dist > 24) {
    // 机位被甩在几百格开外（切机位/传送后常见）——先补位再看，别直接放弃
    console.log('[film] 机位离目标 ' + dist.toFixed(0) + ' 格 → 开牵引补位');
    await call('POST', '/follow', { on: true, dist: 64 });
    await new Promise((r) => setTimeout(r, 4000));
    st = (await call('GET', '/state')) || st;
    const cam1 = st.camera || {}, tgt1 = st.targetEntity || {};
    dist = (cam1.x != null && tgt1.x != null) ? Math.hypot(cam1.x - tgt1.x, cam1.y - tgt1.y, cam1.z - tgt1.z) : null;
    if (dist === null || dist > 24) die('补位后仍离目标 ' + (dist === null ? '?' : dist.toFixed(0)) + ' 格', 3);
  }

  // ── 自动机位 + 自动夜视（--auto 才开）──────────────────────────────────
  if (args.includes('--auto')) {
    const self = await aiStatus();
    const world = await worldInfo();
    const biome = (self && self.biome) || '';
    const y = self && self.position ? self.position.y : null;
    // 天暗 或 目标在地下（y<50）都算「看不清」——地表是白天、洞里还是黑
    const dark = !!(world && (world.is_dark_outside === true || world.is_bright_outside === false)) ||
      (y !== null && y < 50);
    // 夜视：天暗就开，天亮就还。干预会写 cam_interventions.log，取证时要标。
    if (dark && !(st.lens && st.lens.nightVision)) {
      // 只开夜视，gamma 保持 0.5 —— 两个一起上会整片泛白（这轮踩到的）
      await call('POST', '/lens', { nightVision: true, gamma: 0.5 });
      console.log('[film] 天暗 → 开夜视');
    } else if (!dark && st.lens && st.lens.nightVision) {
      await call('POST', '/lens', { restore: true });
      console.log('[film] 天亮 → 收回夜视');
    }
    // 机位：密林/地下 → BODY（第一人称不会穿墙）；开阔 → ORBIT。
    // 上一轮用同一个机位没剪出东西 → 换一个再试（自纠正，不靠人肉试错）。
    // 读代码才发现的关键一条：只有 CINEMATIC/SHOULDER 走 numencam$maxZoom（8 角射线拉近），
    // ORBIT 是硬算坐标、完全不躲方块 —— 所以密林/洞里要 CINEMATIC，不是 BODY。
    // 地下挖矿：第三人称会被 maxZoom 拉到贴脸（画面里只剩一个大头），第一人称反而是「它在挖什么」
    const underground = y !== null && y < 50;
    const dense = /forest|taiga|jungle|swamp/.test(biome) || (y !== null && y < 62);
    let mode = underground ? 'BODY' : (dense ? 'CINEMATIC' : 'ORBIT');
    // ★ 不再自动换机位：两次实测证明「PNG 小」不等于「画面被挡」（水下/暗处/大色块都小），
    //   自动翻转反而把能用的 CINEMATIC 换成了更差的 ORBIT。机位改由摄影师看帧决定。
    const shot = mode === 'BODY' ? { mode: 'BODY' }
      : mode === 'CINEMATIC'
        ? { mode: 'CINEMATIC', distance: 4.5, height: 1.15, shoulder: 0.8 }
        : { mode: 'SHOULDER', distance: 4.5, height: 1.2, shoulder: 0.4 };
    const r2 = await call('POST', '/shot', shot);
    console.log('[film] 自动机位 → ' + mode + '（biome=' + biome + ' y=' + (y === null ? '?' : Math.round(y)) +
      ' 天暗=' + dark + '）' + (r2 && r2.msg ? ' · ' + r2.msg : ''));
    // 试镜头：CINEMATIC 的 maxZoom 可能把机位拉到贴脸（气泡占满画面），
    // 先试 1.6s 量一下实际距离，太近就退到 BODY，再开录。
    await new Promise((r) => setTimeout(r, 1600));
    const probe = await call('GET', '/state');
    const pc = probe && probe.camera, pg = probe && probe.targetEntity;
    if (pc && pg) {
      const d = Math.hypot(pc.x - pg.x, pc.y - pg.y, pc.z - pg.z);
      if (d < 3 && mode !== 'BODY') {
        await call('POST', '/shot', { mode: 'BODY' });
        mode = 'BODY';
        console.log('[film] 试镜头只有 ' + d.toFixed(1) + ' 格（会拍成大头）→ 退到 BODY');
      } else {
        console.log('[film] 试镜头 ' + d.toFixed(1) + ' 格，可用');
      }
    }
    writeJson(FRAMING_FILE, { mode, biome, y, dark, at: new Date().toISOString() });
  }

  if (args.includes('--auto')) st = (await call('GET', '/state')) || st; // 机位刚改过，重读一次再报
  console.log('[film] 取景 OK：mode=' + st.mode + ' target=' + st.target + ' dist=' + (dist === null ? '?' : dist.toFixed(1)) +
    ' 夜视=' + (st.lens && st.lens.nightVision ? '开' : '关') + ' 计划 ' + SECONDS + 's @' + FPS + 'fps');

  // ── 1 录 ────────────────────────────────────────────────────────────────
  const taskNow = await aiTaskNow();
  if (taskNow) console.log('[film] 它现在：' + taskNow.slice(0, 90));

  // 只在「真在干活」的时候拍：身体空闲 + 挂着定时器 = 等炉子/等天亮，拍下来是静止画面。
  // 用户明确说过不要拍太多 —— 这一条就是省存储的第一道闸。
  if (taskNow && /身体空闲/.test(taskNow) && /挂着\s*\d+\s*个表/.test(taskNow)) {
    die('它在等定时器（' + taskNow.slice(0, 60) + '），不拍，省存储', 6);
  }
  if (taskNow && /身体空闲/.test(taskNow) && !/挂着/.test(taskNow)) {
    console.log('[film] 提示：它现在空闲（没有任务），这轮大概率拍不到动作');
  }

  const before = new Set(fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter((n) => n.startsWith('numencam_')) : []);
  const start = await call('POST', '/rec', { on: true, fps: FPS });
  if (!start || !start.ok) die('开录失败：' + JSON.stringify(start).slice(0, 160));

  // 录制期间盯距离：CINEMATIC 的 maxZoom 会把镜头拉到贴脸（画面全是气泡/大头），
  // 这种素材画面变化很大、却是废片。每隔 2s 采一次，记最小距离，当作质量门。
  let minDist = Infinity, maxDist = 0;
  let switched = false;
  for (let t = 0; t < SECONDS; t += 2) {
    await new Promise((r) => setTimeout(r, 2000));
    const s2 = await call('GET', '/state');
    const c2 = s2 && s2.camera, g2 = s2 && s2.targetEntity;
    if (c2 && g2) {
      const d2 = Math.hypot(c2.x - g2.x, c2.y - g2.y, c2.z - g2.z);
      if (d2 < minDist) minDist = d2;
      if (d2 > maxDist) maxDist = d2;
      // 拍摄中自我纠正：镜头被挤到贴脸（<2.3 格）就停录、切 BODY、继续录。
      // 这一条是「树叶墙/大头」反复出现之后加的，比事后丢弃划算。
      if (d2 < 2.3 && !switched) {
        switched = true;
        await call('POST', '/rec', { on: false });
        await new Promise((r) => setTimeout(r, 1200));
        await call('POST', '/shot', { mode: 'BODY' });
        await new Promise((r) => setTimeout(r, 900));
        await call('POST', '/rec', { on: true, fps: FPS });
        console.log('[film] 机位贴到 ' + d2.toFixed(1) + ' 格 → 停录、切 BODY、续录');
      }
    }
  }
  if (minDist !== Infinity) console.log('[film] 录制期间机位距离：最近 ' + minDist.toFixed(1) + ' 格 / 最远 ' + maxDist.toFixed(1) + ' 格');
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
  if (!fs.existsSync(highlight)) {
    // 区分两种「没素材」：画面被挡（桌面大小 PNG 很小、全同色）还是主体没动（画面有细节但帧间不变）。
    // 前者要换机位，后者换机位也没用 —— 这一条是这轮踩出来的。
    const frames = fs.readdirSync(takeDir).filter((f) => /^f_\d{5}\.png$/.test(f)).sort();
    const midFile = path.join(takeDir, frames[Math.floor(frames.length / 2)] || frames[0]);
    let pngBytes = 0;
    try { pngBytes = fs.statSync(midFile).size; } catch { /* ignore */ }
    const blocked = pngBytes < 250000;
    const prevF = readJson(FRAMING_FILE) || {};
    writeJson(FRAMING_FILE, { ...prevF, result: blocked ? 'blocked' : 'static', pngBytes, at: new Date().toISOString() });
    die(blocked
      ? '没产出 highlight.mp4（画面被挡，PNG 只有 ' + Math.round(pngBytes / 1024) + 'KB → 下一轮换机位）'
      : '没产出 highlight.mp4（主体在这 ' + SECONDS + 's 里没动，PNG ' + Math.round(pngBytes / 1024) + 'KB）', 5);
  }
  {
    const prevF = readJson(FRAMING_FILE) || {};
    writeJson(FRAMING_FILE, { ...prevF, result: 'clips', at: new Date().toISOString() });
  }

  // ── 3 记一笔 ────────────────────────────────────────────────────────────
  const tl = path.join(SHOTS, '_timeline', 'numencam.jsonl');
  fs.mkdirSync(path.dirname(tl), { recursive: true });
  fs.appendFileSync(tl, JSON.stringify({
    ts: new Date().toISOString(), kind: 'take', take: takeName, frames, fps: FPS, seconds: SECONDS,
    reason: REASON || null, task: taskNow || null,
    minDist: minDist === Infinity ? null : Number(minDist.toFixed(2)), maxDist: maxDist ? Number(maxDist.toFixed(2)) : null,
    highlight: path.relative(SHOTS, highlight),
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
