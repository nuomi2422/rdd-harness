#!/usr/bin/env node
/**
 * rescue.mjs —— 主人授权的救援：等游戏起来后把同伴传回主世界床边。
 * 授权来源：本会话人类用户 2026-11-02 20:14「救啊…我们只是为了实验，这玩意儿完全可以用作弊」。
 * 标为 intervention:teleport_to_bed，不计入自然行为。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const CFG = path.join(process.env.RDD_LIVE || 'D:\\rdd\\mc\\The Best of Twilight Forest', 'config', 'numen', 'mcp_server.json');
const LOG = path.join(SHOTS, '_photographer', 'rescue.log');
const DEST = '355 65 599';
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, ''));
const log = (m) => { const s = new Date().toISOString() + ' ' + m; console.log('[rescue] ' + m); fs.appendFileSync(LOG, s + '\n', 'utf8'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (body) => new Promise((resolve) => {
  const p = Buffer.from(JSON.stringify(body), 'utf8');
  const req = http.request({ host: cfg.host || '127.0.0.1', port: cfg.port, path: '/mcp', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': p.length, accept: 'application/json, text/event-stream',
      ...(cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}) }, timeout: 8000 },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
  req.write(p); req.end();
});
const mcp = async (tool, args) => {
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rescue', version: '1' } } });
  const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args || {} } });
  const t = ((r && r.result && r.result.content) || []).map((c) => c.text).filter(Boolean).join('\n');
  try { return JSON.parse(t); } catch { return null; }
};
const camState = () => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: 8767, path: '/state', method: 'GET', timeout: 4000 },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end();
});

log('等待游戏起来（最多 20 分钟）');
let up = false;
for (let i = 0; i < 120; i++) {
  const s = await camState();
  if (s && s.inWorld) { up = true; break; }
  await sleep(10000);
}
if (!up) { log('20 分钟内游戏没起来，放弃'); process.exit(2); }
log('游戏已就绪，开始救援');

await sleep(5000);
const before = await mcp('get_self_status', { companion: 'RDD' });
log('救援前: ' + JSON.stringify({ hp: before && before.hp, pos: before && before.position, dim: before && before.dimension, bag: before && before.backpack_slots }));

const cmd = 'execute in minecraft:overworld run tp @s ' + DEST;
const res = await mcp('rdd_admin_command', { companion: 'RDD', command: cmd, confirm: true });
log('执行 rdd_admin_command: command="' + cmd + '" confirm=true');
log('返回: ' + JSON.stringify(res));

await sleep(6000);
const after = await mcp('get_self_status', { companion: 'RDD' });
log('救援后: ' + JSON.stringify({ hp: after && after.hp, pos: after && after.position, dim: after && after.dimension, bag: after && after.backpack_slots }));
log('intervention:teleport_to_bed 完成');
