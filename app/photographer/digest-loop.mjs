#!/usr/bin/env node
/**
 * digest-loop.mjs —— 每 2 小时自动写一条剪辑摘要（目标要求，减少「靠我记得」）。
 * 直接调用 digest.mjs --write，失败不退出，下一轮继续。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIGEST = path.join(HERE, 'digest.mjs');
const HOURS = Number(process.env.DIGEST_HOURS || 2);
const PERIOD_MS = HOURS * 3600 * 1000;

console.log('[digest-loop] 每 ' + HOURS + ' 小时一条，首个立即生成');
const run = () => new Promise((resolve) => {
  execFile(process.execPath, [DIGEST, '--hours=' + HOURS, '--write'], { timeout: 60000 }, (e, so, se) => {
    const last = (so || se || '').trim().split('\n').slice(-1)[0];
    console.log('[digest-loop] ' + new Date().toISOString() + ' ' + last);
    resolve();
  });
});
await run();
setInterval(run, PERIOD_MS);
