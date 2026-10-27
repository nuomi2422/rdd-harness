#!/usr/bin/env node
'use strict';
/**
 * mf-observer.js —— Mineflayer 观测器/驱动器入口（验证环节工具，2026-10-27）
 *
 * 座位：D:/rdd/tools/mineflayer（npm 标准版 PrismarineJS/mineflayer@4.39.0，无 fork 无私有改动）。
 * 用途：给外部编码 AI 一个「用代码玩游戏」的标准接口——读状态（位置/血量/背包/环境）并驱动角色。
 *
 * 只连原版协议服（NeoForge 客户端会被 FML 握手门挡，实测见 杂项 #382 与 tools/mineflayer/README.md）。
 *
 * 用法：
 *   node mf-observer.js smoke [--port 25565]        # 登录+读状态+挖脚下方块+事件计数（退出码 0=通）
 *   node mf-observer.js eval <file.js> [--port N]   # 在 bot 上下文里跑一段外部代码：
 *                                                    #   file.js 导出 async ({bot, mineflayer}) => {}
 *
 * 环境变量：MF_SEAT（默认 D:/rdd/tools/mineflayer）、MF_HOST（默认 127.0.0.1）。
 */
const fs = require('fs');
const path = require('path');

const SEAT = process.env.MF_SEAT || 'D:/rdd/tools/mineflayer';
const HOST = process.env.MF_HOST || '127.0.0.1';
const mineflayer = require(path.join(SEAT, 'node_modules', 'mineflayer'));

const argv = process.argv.slice(2);
const cmd = argv[0];

function argFlag(name, def) {
  const i = argv.indexOf(name);
  return i > 0 && i + 1 < argv.length ? argv[i + 1] : def;
}

function makeBot(port) {
  return mineflayer.createBot({ host: HOST, port, username: 'MF_Observer', version: false, auth: 'offline' });
}

function withTimeout(sec, fn) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout after ' + sec + 's')), sec * 1000);
    fn().then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function smoke(port) {
  const bot = makeBot(port);
  let events = 0;
  ['chat', 'entitySpawn', 'playerCollect', 'blockUpdate', 'health'].forEach((n) => bot.on(n, () => { events++; }));
  await withTimeout(45, () => new Promise((res, rej) => {
    bot.once('spawn', () => res());
    bot.once('kicked', (r) => rej(new Error('kicked ' + JSON.stringify(r).slice(0, 120))));
    bot.on('error', (e) => rej(e));
  }));
  console.log('smoke: logged in, pos=' + JSON.stringify(bot.entity.position));
  await new Promise((r) => setTimeout(r, 3000)); // 等区块
  const p = bot.entity.position.floored().offset(0, -1, 0);
  const b = bot.blockAt(p);
  console.log('smoke: blockBelow=' + (b ? b.name : '?'));
  if (b && b.diggable) {
    await withTimeout(30, () => bot.dig(b, true));
    console.log('smoke: dig ok');
  } else {
    console.log('smoke: dig skipped (not diggable)');
  }
  console.log('smoke: events=' + events);
  bot.quit();
  setTimeout(() => process.exit(0), 1200);
}

async function evalFile(file, port) {
  const bot = makeBot(port);
  await withTimeout(45, () => new Promise((res, rej) => {
    bot.once('spawn', () => res());
    bot.once('kicked', (r) => rej(new Error('kicked ' + JSON.stringify(r).slice(0, 120))));
    bot.on('error', (e) => rej(e));
  }));
  const mod = require(path.resolve(file));
  const r = await mod({ bot, mineflayer });
  if (r !== undefined) console.log(typeof r === 'string' ? r : JSON.stringify(r));
  bot.quit();
  setTimeout(() => process.exit(0), 1200);
}

(async () => {
  const port = parseInt(argFlag('--port', '25565'), 10);
  if (cmd === 'smoke') await smoke(port);
  else if (cmd === 'eval' && argv[1]) await evalFile(argv[1], port);
  else { console.error('用法：mf-observer.js smoke | eval <file.js> [--port N]'); process.exit(2); }
})().catch((e) => {
  console.error('mf-observer FAIL: ' + (e && e.message ? e.message : String(e)));
  process.exit(3);
});
