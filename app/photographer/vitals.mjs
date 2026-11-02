#!/usr/bin/env node
/**
 * vitals.mjs —— 高频生命体征观测（10 秒一次），补 patrol 45 秒粒度看不到的东西：
 * 掉血、换手、位移突变、死亡/重生。
 * 只读：get_self_status + get_world_info，不碰 get_events（消费式收件箱）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const OUT = path.join(SHOTS, '_photographer', 'vitals.jsonl');
const CFG = path.join(process.env.RDD_LIVE || 'D:\\rdd\\mc\\The Best of Twilight Forest', 'config', 'numen', 'mcp_server.json');
const every = Number(process.argv.find((a) => a.startsWith('--every='))?.split('=')[1] || 10);

let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, '')); } catch { console.error('[vitals] 没有 mcp_server.json'); process.exit(2); }

function post(body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: cfg.host || '127.0.0.1', port: cfg.port, path: '/mcp', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length, accept: 'application/json, text/event-stream',
        ...(cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}) },
      timeout: 4000,
    }, (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload); req.end();
  });
}

// owner 就是机位玩家 RDDDev；把它坐标一起记下，任何观察者效应都能事后审计
const camState = () => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: 8767, path: '/state', method: 'GET', timeout: 4000 },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
  req.end();
});

async function call(tool, args) {
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitals', version: '1' } } });
  const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args || {} } });
  const txt = ((r && r.result && r.result.content) || []).map((c) => c.text).filter(Boolean).join('\n');
  try { return JSON.parse(txt); } catch { return null; }
}

let prev = null;
let stillRun = 0;
const tick = async () => {
  const st = await call('get_self_status', { companion: 'RDD' });
  if (!st || st.name === undefined) { console.log('[vitals] 拿不到状态'); return; }
  const rec = {
    ts: new Date().toISOString(),
    hp: Math.round(st.hp * 100) / 100, hunger: st.hunger,
    pos: [Math.round(st.position.x), Math.round(st.position.y), Math.round(st.position.z)],
    dim: st.dimension, main: (st.equipment && st.equipment.mainhand && st.equipment.mainhand.item) || null,
    bag: st.backpack_slots && st.backpack_slots.used,
  };
  const cs = await camState();
  if (cs && cs.body) {
    rec.owner = [Math.round(cs.body.x), Math.round(cs.body.y), Math.round(cs.body.z)];
    // 机位是跟着同伴走的，每步都在动；只有「一步跨了 >32 格」才算我主动搬了 owner
    if (prev && prev.owner) {
      const d = Math.hypot(rec.owner[0] - prev.owner[0], rec.owner[1] - prev.owner[1], rec.owner[2] - prev.owner[2]);
      if (d > 32) rec.ownerJump = Math.round(d);
    }
  }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n', 'utf8');
  if (prev) {
    const dHp = rec.hp - prev.hp;
    const moved = Math.hypot(rec.pos[0] - prev.pos[0], rec.pos[1] - prev.pos[1], rec.pos[2] - prev.pos[2]);
    if (dHp <= -2) console.log('[vitals] ⚠ 掉血 ' + dHp.toFixed(1) + ' → ' + rec.hp + '  @' + rec.ts);
    if (rec.hp <= 0 || (prev.hp > 0 && rec.pos[1] > prev.pos[1] + 20 && moved > 50)) console.log('[vitals] ⚠ 可能死亡/重生  @' + rec.ts);
    if (rec.main !== prev.main) {
      console.log('[vitals] 换手 ' + prev.main + ' → ' + rec.main + '  @' + rec.ts);
      // 主手从「有东西」变空 = 可能工具损坏（木镐挖 34 格圆石就没了），这类隐性成本不该只靠日志
      if (prev.main && !rec.main) console.log('[vitals] ⚠ 主手清空（可能工具损坏）之前的 ' + prev.main + '  @' + rec.ts);
    }
    if (rec.dim !== prev.dim) console.log('[vitals] 换维度 ' + prev.dim + ' → ' + rec.dim + '  @' + rec.ts);
    // 饥饿警戒：背包空 + 饥饿低 = 接下来必然掉血，提前报，不用等人死
    if (rec.hunger <= 8 && (rec.bag || 0) === 0) console.log('[vitals] ⚠ 饥饿警戒 hunger=' + rec.hunger + ' 背包空  @' + rec.ts);
    // 原地不动超过 5 分钟（按位置去重计数）
    if (rec.pos.join(',') === prev.pos.join(',')) { stillRun = (stillRun || 0) + 1; } else { stillRun = 0; }
    if (stillRun === 10) console.log('[vitals] 位置 5 分钟未变 ' + rec.pos.join(',') + '  @' + rec.ts);
  }
  prev = rec;
};

console.log('[vitals] 每 ' + every + ' 秒一次，写 ' + OUT);
for (;;) { await tick(); await new Promise((r) => setTimeout(r, every * 1000)); }
