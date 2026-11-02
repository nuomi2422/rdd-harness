#!/usr/bin/env node
/**
 * cam-guard.mjs —— 机位位移的「存档/复原」。
 *
 * 为什么需要它（2026-11-02 事故）：
 * 机位玩家 RDDDev 就是同伴的 owner。为了拍下界死亡现场，我把 RDDDev tp 到岩浆台，
 * 结果 respawn 的 findNear(owner) 恒为 null → 同伴 7 分钟不复活。
 * 结论：**拍摄可以动 owner，但必须记下原位、拍完立刻复原，且同伴死亡/复活期间绝不移动 owner**。
 *
 * 用法:
 *   node cam-guard.mjs save      # 记下 owner 当前位置到 _photographer/cam-pos.json
 *   node cam-guard.mjs restore   # 用 /execute 回到记录的位置（跨维度安全）
 *   node cam-guard.mjs status    # 显示当前与记录
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const FILE = path.join(SHOTS, '_photographer', 'cam-pos.json');
const SEND = 'D:\\rdd\\harness\\rdd-harness\\bin\\send-mc-command.ps1';
const API = 'http://127.0.0.1:8767';

const state = () => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: 8767, path: '/state', method: 'GET', timeout: 4000 },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end();
});
const cmd = (t) => new Promise((resolve) => execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SEND, '-Text', t], { timeout: 30000 }, (e, so) => resolve(so || '')));

const action = process.argv[2] || 'status';
const s = await state();
if (!s || !s.body) { console.error('[cam-guard] 拿不到机位状态（游戏没开？）'); process.exit(2); }
const cur = { x: Math.round(s.body.x), y: Math.round(s.body.y), z: Math.round(s.body.z), at: new Date().toISOString() };

if (action === 'save') {
  fs.writeFileSync(FILE, JSON.stringify(cur, null, 2), 'utf8');
  console.log('[cam-guard] 已记录 owner 位置 ' + cur.x + ',' + cur.y + ',' + cur.z);
} else if (action === 'restore') {
  if (!fs.existsSync(FILE)) { console.error('[cam-guard] 没有记录，无法复原'); process.exit(2); }
  const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const out = await cmd('/execute in minecraft:overworld run tp @s ' + p.x + ' ' + p.y + ' ' + p.z);
  await new Promise((r) => setTimeout(r, 1500));
  const s2 = await state();
  const now = s2 && s2.body ? Math.round(s2.body.x) + ',' + Math.round(s2.body.y) + ',' + Math.round(s2.body.z) : '?';
  console.log('[cam-guard] 复原到 ' + p.x + ',' + p.y + ',' + p.z + ' → 现在 ' + now + '  (' + out.trim().slice(0, 40) + ')');
} else {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* ignore */ }
  console.log('[cam-guard] 当前 ' + cur.x + ',' + cur.y + ',' + cur.z + '  记录 ' + (saved ? saved.x + ',' + saved.y + ',' + saved.z : '（无）'));
}
