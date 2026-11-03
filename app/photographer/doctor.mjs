#!/usr/bin/env node
/**
 * doctor.mjs —— 任何「卡死/异常」结论之前先跑这个。
 *
 * 2026-11-03 教训：我把「游戏正在关服」误判成「AI 卡死 13 分钟」。
 * 规则变成代码：先确认环境（进程 / API / 最后写入），再谈 AI 状态。
 *
 * 输出：进程、API、ai.jsonl 最后写入、最近启动日志尾、CPU、内存、磁盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const GAME = process.env.RDD_LIVE || 'D:\\rdd\\mc\\The Best of Twilight Forest';
const MON = path.join(GAME, 'config', 'numen', 'monitor');
const LOGS = path.join(GAME, 'logs');

const ps = (cmd) => { try { return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { timeout: 20000, encoding: 'utf8' }).trim(); } catch { return '?'; } };
const mtime = (p) => { try { return new Date(fs.statSync(p).mtimeMs).toISOString().replace('T', ' ').slice(0, 19); } catch { return 'missing'; } };

const camState = () => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: 8767, path: '/state', method: 'GET', timeout: 4000 },
    (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end();
});

const proc = ps("(Get-Process javaw -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id)");
const cpu = ps("(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average");
const ram = ps("[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)");
const disk = ps("[math]::Round((Get-PSDrive D).Free/1GB,2)");
const st = await camState();

let lastLaunch = 'missing', tail = '';
try {
  const files = fs.readdirSync(LOGS).filter((f) => f.startsWith('rdd-launch-')).map((f) => ({ f, m: fs.statSync(path.join(LOGS, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  if (files.length) {
    lastLaunch = new Date(files[0].m).toISOString().replace('T', ' ').slice(0, 19);
    const content = fs.readFileSync(path.join(LOGS, files[0].f), 'utf8').trim().split(/\r?\n/).slice(-2);
    tail = content.map((l) => l.slice(0, 110)).join('\n');
  }
} catch { /* ignore */ }

console.log('[doctor] ' + new Date().toISOString());
console.log('  javaw 进程   : ' + (proc && proc !== '?' ? proc : '无进程'));
console.log('  camera API   : ' + (st ? 'inWorld=' + st.inWorld : '不通'));
console.log('  ai.jsonl 写入: ' + mtime(path.join(MON, 'ai.jsonl')));
console.log('  brain.jsonl  : ' + mtime(path.join(MON, 'brain.jsonl')));
console.log('  最近启动日志 : ' + lastLaunch);
if (tail) console.log('  日志尾:\n' + tail.split('\n').map((l) => '    ' + l).join('\n'));
console.log('  CPU=' + cpu + '%  可用内存=' + ram + 'GB  D盘余量=' + disk + 'GB');

// 结论提示：环境没在跑时，不要谈 AI 卡死
if (!proc || proc === '?') console.log('\n[doctor] 游戏进程不在 → 任何「AI 没动作」都应归因为「游戏没跑」，不是卡死。');
else if (!st) console.log('\n[doctor] 进程在但相机 API 不通 → 可能还在加载/启动中。');
else if (!st.inWorld) console.log('\n[doctor] 进程在但未进入世界 → 仍在加载。');
else console.log('\n[doctor] 环境正常，此时才可以把「AI 没动作」当卡死嫌疑。');
