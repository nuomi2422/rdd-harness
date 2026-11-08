#!/usr/bin/env node
'use strict';
/**
 * verify-take.js —— 相机 take 的「动态有效性」核验器（离线，只读）
 *
 * 为什么存在（2026-11-09）：take 里出现了「810 张 PNG 只有 82 种画面」，
 * 但仅凭 PNG 无法区分三种情况：
 *   A) 世界停了（gameTime 不走）
 *   B) 世界在走、相机不动（画面本来就不该变）
 *   C) 世界在走、相机在动，但画面没更新（渲染/采集取到旧缓冲）——这才是真故障
 * frames.csv（capture,epochNanos,gameTime,cameraX,cameraY,cameraZ）正好能把三者分开。
 *
 * 用法：node verify-take.js <take目录>
 * 退出码：0 可判（结论已给出）/ 2 用法错或数据不足（不得当通过）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('frames.csv 为空');
  const head = lines[0].split(',').map((s) => s.trim());
  const need = ['capture', 'epochNanos', 'gameTime', 'cameraX', 'cameraY', 'cameraZ'];
  const missing = need.filter((k) => !head.includes(k));
  if (missing.length) throw new Error('frames.csv 缺列：' + missing.join(','));
  const idx = Object.fromEntries(need.map((k) => [k, head.indexOf(k)]));
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    const num = (k) => { const v = Number(c[idx[k]]); return Number.isFinite(v) ? v : null; };
    return {
      capture: num('capture'), epochNanos: num('epochNanos'), gameTime: num('gameTime'),
      x: num('cameraX'), y: num('cameraY'), z: num('cameraZ'),
    };
  });
}

function pngHashes(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^f_\d+\.png$/i.test(f)).sort();
  return files.map((f) => {
    const p = path.join(dir, f);
    return { name: f, hash: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') };
  });
}

function monotonic(rows, key) {
  let breaks = 0, minDelta = Infinity;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1][key], b = rows[i][key];
    if (a === null || b === null) continue;
    const d = b - a;
    if (d < 0) breaks++;
    if (d < minDelta) minDelta = d;
  }
  return { breaks, minDelta: Number.isFinite(minDelta) ? minDelta : null };
}

function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('用法：node verify-take.js <take目录>'); process.exit(2); }
  const csv = path.join(dir, 'frames.csv');
  if (!fs.existsSync(csv)) { console.error('没有 frames.csv（旧版录像或采集元数据未启用）→ 不可判'); process.exit(2); }

  const rows = readCsv(csv);
  const pngs = pngHashes(dir);
  const out = [];
  out.push('行数(csv)=' + rows.length + '  画面数(png)=' + pngs.length + (rows.length === pngs.length ? '  一致' : '  ✗ 不一致'));

  const uniq = new Set(pngs.map((p) => p.hash));
  out.push('唯一画面=' + uniq.size + '/' + pngs.length + '（重复率 ' + ((1 - uniq.size / pngs.length) * 100).toFixed(1) + '%）');

  const et = monotonic(rows, 'epochNanos');
  const gt = monotonic(rows, 'gameTime');
  out.push('epochNanos 单调性：倒退 ' + et.breaks + ' 次' + (et.minDelta !== null ? '，最小步长 ' + et.minDelta + 'ns' : ''));
  out.push('gameTime  单调性：倒退 ' + gt.breaks + ' 次' + (gt.minDelta !== null ? '，最小步长 ' + gt.minDelta + ' tick' : ''));

  let camMoves = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.x === null || b.x === null) continue;
    if (a.x !== b.x || a.y !== b.y || a.z !== b.z) camMoves++;
  }
  out.push('相机坐标变化次数=' + camMoves + '/' + Math.max(0, rows.length - 1));

  // 逐段对照：同一画面连续重复时，gameTime 与相机是否在变
  const n = Math.min(rows.length, pngs.length);
  let seg = 0, worldStopped = 0, camStill = 0, camMovedNoPixel = 0;
  for (let i = 0; i < n; i++) {
    const isDup = i > 0 && pngs[i].hash === pngs[i - 1].hash;
    if (!isDup) { seg++; continue; }
    const a = rows[i - 1], b = rows[i];
    const gtMoved = a.gameTime !== null && b.gameTime !== null && b.gameTime !== a.gameTime;
    const camMoved = a.x !== null && b.x !== null && (a.x !== b.x || a.y !== b.y || a.z !== b.z);
    if (!gtMoved) worldStopped++;
    else if (!camMoved) camStill++;
    else camMovedNoPixel++;
  }
  out.push('重复帧分类：世界没走 ' + worldStopped + ' / 相机没动 ' + camStill + ' / **相机在动但画面没变 ' + camMovedNoPixel + '**');

  let verdict;
  if (!uniq.size || rows.length < 2) verdict = 'UNKNOWN（数据不足）';
  else if (et.breaks > 0) verdict = 'UNKNOWN（采集时刻倒序，不能定因果）';
  else if (camMovedNoPixel > 0) verdict = '疑似渲染/采集停滞：相机在动而画面不变（' + camMovedNoPixel + ' 帧）';
  else if (worldStopped > 0) verdict = '世界确实停过（' + worldStopped + ' 帧），画面不变属真实';
  else if (camStill > 0) verdict = '相机基本静止（' + camStill + ' 帧），画面重复不构成故障';
  else verdict = '未发现异常重复';
  out.push('结论：' + verdict);
  out.push('口径：本工具只看对照关系，不判断画面好不好；已确认的"有效画面数"要同时报唯一画面数与写入帧数。');
  console.log(out.join('\n'));
  process.exit(verdict.startsWith('UNKNOWN') ? 2 : 0);
}

main();
