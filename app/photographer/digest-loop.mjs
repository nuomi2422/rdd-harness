#!/usr/bin/env node
/**
 * digest-loop.mjs —— 每 2 小时写一条剪辑摘要。
 *
 * 2026-11-03 修复：原来用 setInterval(2h)，实测 09:36 那次没触发（只写到 07:36）。
 * 改成「每 5 分钟检查一次最新摘要文件的 mtime，超过 2 小时就写」——
 * 不再依赖长定时器，进程被挂起/重启后也能自愈。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIGEST = path.join(HERE, 'digest.mjs');
const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const OUT_DIR = path.join(SHOTS, '_photographer');
const HOURS = Number(process.env.DIGEST_HOURS || 2);
const DUE_MS = HOURS * 3600 * 1000;
const CHECK_MS = 5 * 60 * 1000;

const latestMtime = () => {
  try {
    const files = fs.readdirSync(OUT_DIR).filter((f) => /^digest-.*\.md$/.test(f)).map((f) => fs.statSync(path.join(OUT_DIR, f)).mtimeMs);
    return files.length ? Math.max(...files) : 0;
  } catch { return 0; }
};

const run = () => new Promise((resolve) => {
  execFile(process.execPath, [DIGEST, '--hours=' + HOURS, '--write'], { timeout: 90000 }, (e, so, se) => {
    const last = (so || se || '').trim().split('\n').slice(-1)[0];
    console.log('[digest-loop] ' + new Date().toISOString() + ' ' + last);
    resolve();
  });
});

console.log('[digest-loop] 每 5 分钟检查一次「最新摘要是否超过 ' + HOURS + ' 小时」');
let lastRun = 0;
const tick = async () => {
  const mt = latestMtime();
  const age = Date.now() - Math.max(mt, lastRun);
  if (age >= DUE_MS) { lastRun = Date.now(); await run(); }
};
await tick();
setInterval(tick, CHECK_MS);
