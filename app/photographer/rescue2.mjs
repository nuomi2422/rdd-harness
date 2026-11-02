#!/usr/bin/env node
/**
 * rescue2.mjs —— 等复活窗口，出现即传回床边。
 * 约束（读源码得来）：rdd_admin_command 白名单只有 give/setblock/fill/summon/gamemode/time/weather/tp，
 * 所以跨维度只能 "tp @s <已在主世界的实体>"；机位玩家 RDD0 已停在床边 (356,65,600)。
 * 每次尝试都逐条落盘，被拒写 FAILED_REFUSED，成功写 SUCCESS。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const CFG = path.join(process.env.RDD_LIVE || 'D:\\rdd\\mc\\The Best of Twilight Forest', 'config', 'numen', 'mcp_server.json');
const LOG = path.join(SHOTS, '_photographer', 'rescue.log');
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, ''));
const log = (m) => { const s = new Date().toISOString() + ' ' + m; console.log('[rescue2] ' + m); fs.appendFileSync(LOG, s + '\n', 'utf8'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (body) => new Promise((resolve) => {
  const p = Buffer.from(JSON.stringify(body), 'utf8');
  const req = http.request({ host: cfg.host || '127.0.0.1', port: cfg.port, path: '/mcp', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': p.length, accept: 'application/json, text/event-stream',
      ...(cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}) }, timeout: 8000 },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.write(p); req.end();
});
const mcp = async (tool, args) => {
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rescue2', version: '1' } } });
  const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args || {} } });
  const t = ((r && r.result && r.result.content) || []).map((c) => c.text).filter(Boolean).join('\n');
  try { return JSON.parse(t); } catch { return null; }
};

const STUCK = '下界岩浆台空手0物品，death49-56 循环，respawn 卡住，主人 20:14 授权传回主世界床边';

log('救援二阶段启动：等复活窗口，出现即 tp @s RDD0');
let lastTry = 0;
for (let i = 0; i < 240; i++) {
  const st = await mcp('get_self_status', { companion: 'RDD' });
  if (st && typeof st.hp === 'number' && st.position) {
    log('复活出现: ' + JSON.stringify({ hp: st.hp, pos: st.position, dim: st.dimension, bag: st.backpack_slots && st.backpack_slots.used }));
    if (Date.now() - lastTry > 62000) {
      lastTry = Date.now();
      const res = await mcp('rdd_admin_command', { companion: 'RDD', command: 'tp @s RDD0', stuck: STUCK, confirm: true });
      log('尝试 tp @s RDD0 → ' + JSON.stringify(res));
      await sleep(4000);
      const after = await mcp('get_self_status', { companion: 'RDD' });
      const moved = after && after.position && st.position && (Math.abs(after.position.x - st.position.x) > 2 || after.dimension !== st.dimension);
      log((moved ? 'SUCCESS' : 'FAILED_NO_MOVE') + ' 后: ' + JSON.stringify(after && { hp: after.hp, pos: after.position, dim: after.dimension }));
      if (moved && after.dimension === 'minecraft:overworld') { log('intervention:teleport_to_bed 生效，退出'); break; }
    }
  }
  await sleep(20000);
}
