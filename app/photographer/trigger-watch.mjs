#!/usr/bin/env node
/**
 * trigger-watch.mjs —— 事件触发录制（今天的数据说：事件触发 > 定时轮拍）。
 *
 * 触发条件（任一）：
 *   1. 血量一次掉 >=4（挨打/坠落/岩浆）
 *   2. 任务文本出现「战斗」
 *   3. 主手从有变空（工具损坏）
 *   4. 维度变化（跨维度）
 * 触发后录 RECORD_SEC 秒，take 名与触发原因写进 _photographer/trigger-log.jsonl。
 *
 * 只读 MCP + 相机 API，不移动 owner（除维度变化时由 nether-watch 负责）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const CFG = path.join(process.env.RDD_LIVE || 'D:\\rdd\\mc\\The Best of Twilight Forest', 'config', 'numen', 'mcp_server.json');
const LOG = path.join(SHOTS, '_photographer', 'trigger-log.jsonl');
const RECORD_SEC = Number(process.env.TRIGGER_SEC || 45);
const COOLDOWN_MS = Number(process.env.TRIGGER_COOLDOWN || 90000);
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, ''));
const log = (o) => { fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n', 'utf8'); console.log('[trigger] ' + JSON.stringify(o)); };

const post = (body) => new Promise((resolve) => {
  const p = Buffer.from(JSON.stringify(body), 'utf8');
  const req = http.request({ host: cfg.host || '127.0.0.1', port: cfg.port, path: '/mcp', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': p.length, accept: 'application/json, text/event-stream',
      ...(cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}) }, timeout: 6000 },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.write(p); req.end();
});
const mcp = async (tool, args) => {
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tw', version: '1' } } });
  const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args || {} } });
  const t = ((r && r.result && r.result.content) || []).map((c) => c.text).filter(Boolean).join('\n');
  try { return JSON.parse(t); } catch { return null; }
};
const cam = (endpoint, body) => new Promise((resolve) => {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const req = http.request({ host: '127.0.0.1', port: 8767, path: endpoint, method: body === undefined ? 'GET' : 'POST',
    headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}, timeout: 6000 },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); if (payload) req.write(payload); req.end();
});

// 触发判据单独成函数，方便离线自测（改判据时先跑 --selftest，别等真事件才发现写错）
function reasonsFor(prev, st, msg, stillSec) {
  const out = [];
  if (!prev || !st || typeof st.hp !== 'number') return out;
  if (prev.hp - st.hp >= 4) out.push('hp_drop ' + prev.hp + '->' + st.hp);
  // 静止/原地循环 >2 分钟 = 卡死嫌疑（目标要求必留）
  if (stillSec >= 120 && !prev.stillFired) out.push('static ' + stillSec + 's');
  if (st.dimension !== prev.dim) out.push('dim ' + prev.dim + '->' + st.dimension);
  const main = (st.equipment && st.equipment.mainhand && st.equipment.mainhand.item) || null;
  if (prev.main && !main) out.push('tool_lost ' + prev.main);
  if (/战斗/.test(msg) && !/战斗/.test(prev.msg || '')) out.push('combat ' + msg.slice(0, 30));
  return out;
}

if (process.argv.includes('--selftest')) {
  // prev 用循环里的内部形状 {hp,dim,main,msg}；st 用 get_self_status 的原始形状 {hp,dimension,equipment}
  const prev = (hp, dim, main, msg) => ({ hp, dim, main, msg });
  const st = (hp, dim, main) => ({ hp, dimension: dim, equipment: main ? { mainhand: { item: main } } : {} });
  const OW = 'minecraft:overworld', NE = 'minecraft:the_nether', SW = 'minecraft:stone_sword';
  const base = prev(20, OW, SW, '身体空闲');
  const cases = [
    ['血量骤降', base, st(14, OW, SW), '身体空闲', ['hp_drop 20->14']],
    ['小幅掉血不触发', base, st(18, OW, SW), '身体空闲', []],
    ['换维度', base, st(20, NE, SW), '身体空闲', ['dim ' + OW + '->' + NE]],
    ['工具丢失', base, st(20, OW, null), '身体空闲', ['tool_lost ' + SW]],
    ['战斗开始', prev(20, OW, SW, '身体空闲'), st(20, OW, SW), 't9(战斗 0/10) running', ['combat t9(战斗 0/10) running']],
    ['战斗进行中不重复', prev(20, OW, SW, 't9(战斗 3/10) running'), st(20, OW, SW), 't9(战斗 4/10) running', []],
    ['静止 130 秒触发', base, st(20, OW, SW), '身体空闲', ['static 130s'], 130],
    ['静止 90 秒不触发', base, st(20, OW, SW), '身体空闲', [], 90],
  ];
  let bad = 0;
  for (const [name, pv, cur, msg, expect, still] of cases) {
    const got = reasonsFor(pv, cur, msg, still || 0);
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    if (!ok) bad++;
    console.log((ok ? 'PASS ' : 'FAIL ') + name + '  got=' + JSON.stringify(got) + (ok ? '' : '  expect=' + JSON.stringify(expect)));
  }
  process.exit(bad ? 1 : 0);
}

console.log('[trigger] 启动：血量骤降 / 战斗 / 工具丢失 / 换维度 → 录 ' + RECORD_SEC + 's');
let prev = null, lastFire = 0, recording = false, stillSince = 0, lastPos = null, stillFired = false;
for (;;) {
  const st = await mcp('get_self_status', { companion: 'RDD' });
  const task = await mcp('task_status', { companion: 'RDD' });
  const state = await cam('/state');
  const now = Date.now();
  if (st && typeof st.hp === 'number' && prev) {
    const msg = (task && task.message) || '';
    // 静止计时：位置不变就累计，变了就清零并解除已触发标记
    if (st.position && lastPos && st.position.x === lastPos.x && st.position.y === lastPos.y && st.position.z === lastPos.z) {
      if (!stillSince) stillSince = now;
    } else {
      stillSince = 0; stillFired = false;
      lastPos = st.position ? { x: st.position.x, y: st.position.y, z: st.position.z } : null;
    }
    const stillSec = stillSince ? Math.round((now - stillSince) / 1000) : 0;
    prev.stillFired = stillFired;
    const reasons = reasonsFor(prev, st, msg, stillSec);
    const main = (st.equipment && st.equipment.mainhand && st.equipment.mainhand.item) || null;
    if (reasons.length && !recording && now - lastFire > COOLDOWN_MS && state && state.inWorld) {
      lastFire = now; recording = true;
      const fps = 4;
      await cam('/rec', { on: true, fps });
      console.log('[trigger] 开录：' + reasons.join(' | '));
      await new Promise((r) => setTimeout(r, RECORD_SEC * 1000));
      await cam('/rec', { on: false });
      await new Promise((r) => setTimeout(r, 2500));
      const take = fs.readdirSync(SHOTS).filter((n) => n.startsWith('numencam_')).sort().pop();
      if (reasons.some((r) => r.startsWith('static'))) stillFired = true;
      log({ take, reasons, recordSec: RECORD_SEC, hp: st.hp, pos: st.position, dim: st.dimension });
      recording = false;
    }
    prev = { hp: st.hp, dim: st.dimension, main, msg };
  } else if (st && typeof st.hp === 'number') {
    prev = { hp: st.hp, dim: st.dimension, main: (st.equipment && st.equipment.mainhand && st.equipment.mainhand.item) || null, msg: (task && task.message) || '' };
  }
  await new Promise((r) => setTimeout(r, 5000));
}
