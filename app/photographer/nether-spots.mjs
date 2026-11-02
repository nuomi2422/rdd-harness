#!/usr/bin/env node
/**
 * nether-spots.mjs —— 进下界前先找「看得见的落点」。
 * 为什么要这个：跨维度 tp 后如果落在实心方块里，画面全黑，20 秒录制全是废片。
 * 做法：等游戏起来 → 切 BODY → 依次 tp 到候选点 → 各录 2 帧 → 报每帧的字节数（太小=全黑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const SEND = 'D:\\rdd\\harness\\rdd-harness\\bin\\send-mc-command.ps1';
const API = 'http://127.0.0.1:8767';
const SPOTS = [[39, 42, 34], [39, 44, 34], [39, 46, 34], [41, 40, 36]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (p) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: 8767, path: p, method: 'GET', timeout: 4000 },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end();
});
const post = (p, body) => new Promise((resolve) => {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const req = http.request({ host: '127.0.0.1', port: 8767, path: p, method: 'POST', timeout: 8000,
    headers: { 'content-type': 'application/json', 'content-length': payload.length } },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.write(payload); req.end();
});
const cmd = (text) => new Promise((resolve) => execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SEND, '-Text', text], { timeout: 30000 }, (e, so) => resolve(so || '')));

// 等游戏起来
for (let i = 0; i < 60; i++) { const s = await get('/state'); if (s && s.inWorld) break; await sleep(10000); console.log('[spots] 等游戏…' + i); }

await post('/shot', { mode: 'BODY' });
await sleep(2000);
const results = [];
for (const [x, y, z] of SPOTS) {
  const out = await cmd('/execute in minecraft:the_nether run tp @s ' + x + ' ' + y + ' ' + z);
  await sleep(2500);
  await post('/rec', { on: true, fps: 1 });
  await sleep(2500);
  await post('/rec', { on: false });
  await sleep(2500);
  const take = fs.readdirSync(SHOTS).filter((n) => n.startsWith('numencam_')).sort().pop();
  const dir = path.join(SHOTS, take);
  const frames = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^f_\d{5}\.png$/.test(f)).sort() : [];
  const sizes = frames.map((f) => Math.round(fs.statSync(path.join(dir, f)).size / 1024));
  results.push({ spot: [x, y, z], take, frames: sizes.length, kb: sizes });
  console.log('[spots] ' + x + ',' + y + ',' + z + ' → ' + take + ' frames=' + sizes.length + ' kb=' + sizes.join('/') + '  send=' + out.trim().slice(0, 40));
}
console.log('[spots] 结果: ' + JSON.stringify(results));
// 回到主世界
await cmd('/cam tp');
