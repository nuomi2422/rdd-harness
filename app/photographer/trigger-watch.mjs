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

console.log('[trigger] 启动：血量骤降 / 战斗 / 工具丢失 / 换维度 → 录 ' + RECORD_SEC + 's');
let prev = null, lastFire = 0, recording = false;
for (;;) {
  const st = await mcp('get_self_status', { companion: 'RDD' });
  const task = await mcp('task_status', { companion: 'RDD' });
  const state = await cam('/state');
  const now = Date.now();
  if (st && typeof st.hp === 'number' && prev) {
    const reasons = [];
    if (prev.hp - st.hp >= 4) reasons.push('hp_drop ' + prev.hp + '->' + st.hp);
    if (st.dimension !== prev.dim) reasons.push('dim ' + prev.dim + '->' + st.dimension);
    const main = (st.equipment && st.equipment.mainhand && st.equipment.mainhand.item) || null;
    if (prev.main && !main) reasons.push('tool_lost ' + prev.main);
    const msg = (task && task.message) || '';
    if (/战斗/.test(msg) && !/战斗/.test(prev.msg || '')) reasons.push('combat ' + msg.slice(0, 30));
    if (reasons.length && !recording && now - lastFire > COOLDOWN_MS && state && state.inWorld) {
      lastFire = now; recording = true;
      const fps = 4;
      await cam('/rec', { on: true, fps });
      console.log('[trigger] 开录：' + reasons.join(' | '));
      await new Promise((r) => setTimeout(r, RECORD_SEC * 1000));
      await cam('/rec', { on: false });
      await new Promise((r) => setTimeout(r, 2500));
      const take = fs.readdirSync(SHOTS).filter((n) => n.startsWith('numencam_')).sort().pop();
      log({ take, reasons, recordSec: RECORD_SEC, hp: st.hp, pos: st.position, dim: st.dimension });
      recording = false;
    }
    prev = { hp: st.hp, dim: st.dimension, main, msg };
  } else if (st && typeof st.hp === 'number') {
    prev = { hp: st.hp, dim: st.dimension, main: (st.equipment && st.equipment.mainhand && st.equipment.mainhand.item) || null, msg: (task && task.message) || '' };
  }
  await new Promise((r) => setTimeout(r, 5000));
}
