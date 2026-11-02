#!/usr/bin/env node
/**
 * nether-watch.mjs —— 维度切换守门员。
 *
 * 问题：伙伴进下界后，客户端（主世界）就看不见它了，跟拍会断。
 * 做法：每 5 秒读一次它的维度；一旦变成下界，立刻 /cam tp 把机位带过去，再录 20 秒。
 * 这条是「拍不到跨维度」的唯一解法，先跑起来再看效果。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const CFG = path.join(process.env.RDD_LIVE || 'D:\\rdd\\mc\\The Best of Twilight Forest', 'config', 'numen', 'mcp_server.json');
const API = 'http://127.0.0.1:8767';
const LOG = path.join(SHOTS, '_photographer', 'nether-watch.log');
const SEND = 'D:\\rdd\\harness\\rdd-harness\\bin\\send-mc-command.ps1';
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, ''));
const log = (m) => { const s = new Date().toISOString() + ' ' + m; console.log('[nether] ' + m); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const post = (body) => new Promise((resolve) => {
  const p = Buffer.from(JSON.stringify(body), 'utf8');
  const req = http.request({ host: cfg.host || '127.0.0.1', port: cfg.port, path: '/mcp', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': p.length, accept: 'application/json, text/event-stream',
      ...(cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}) }, timeout: 4000 },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
  req.write(p); req.end();
});
const mcp = async (tool, args) => {
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'nw', version: '1' } } });
  const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args || {} } });
  const t = ((r && r.result && r.result.content) || []).map((c) => c.text).filter(Boolean).join('\n');
  try { return JSON.parse(t); } catch { return null; }
};
const cam = (endpoint, body) => new Promise((resolve) => {
  const u = new URL(API + endpoint);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: body === undefined ? 'GET' : 'POST',
    headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}, timeout: 5000 },
    (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
  if (payload) req.write(payload);
  req.end();
});
const ps = (script) => new Promise((resolve) => execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SEND, '-Text', script], { timeout: 30000 }, (e, so, se) => resolve((so || '') + (se || ''))));
// 机位位移必须可复原：owner 就是机位玩家，移动它会干扰 respawn（2026-11-02 事故）
const GUARD = 'D:\\rdd\\worktrees\\photographer\\app\\photographer\\cam-guard.mjs';
const guard = (act) => new Promise((resolve) => execFile('node', [GUARD, act], { timeout: 30000 }, (e, so, se) => resolve(((so || '') + (se || '')).trim())));

let lastDim = null;
let lastPortalAt = 0;
log('开始守维度（每 5 秒）');
for (;;) {
  const st = await mcp('get_self_status', { companion: 'RDD' });
  const dim = st && st.dimension;
  if (dim && dim !== lastDim) {
    log('维度变化 ' + lastDim + ' → ' + dim);
    if (lastDim && dim === 'minecraft:the_nether') {
      // ★ 2026-11-02 事故后改策略：不再自动把 owner 送进下界。
      // 证据：14:34:24 我 /cam tp 把 RDDDev 送进下界拍入界 → 14:34:56 同伴死亡后就近复活在下界 (61,37,34)。
      // 跟拍会改变复活点，这是对实验的实质干扰。默认只「看」，不「搬」。
      const allowTp = process.argv.includes('--allow-tp');
      if (!allowTp) {
        log('检测到入下界，但按策略不搬 owner（要拍下界需显式 --allow-tp）');
        lastDim = dim;
        await new Promise((res) => setTimeout(res, 5000));
        continue;
      }
      const saved = await guard('save');
      log('拍前记录 owner 位置: ' + saved.slice(0, 80));
      const r = await ps('/cam tp');
      log('/cam tp → ' + r.trim().slice(0, 120));
      await new Promise((res) => setTimeout(res, 3000));
      await cam('/rec', { on: true, fps: 6 });
      await new Promise((res) => setTimeout(res, 60000));
      await cam('/rec', { on: false });
      await new Promise((res) => setTimeout(res, 2500));
      const take = fs.readdirSync(SHOTS).filter((n) => n.startsWith('numencam_')).sort().pop();
      log('入界后录制完成：' + take);
      const back = await guard('restore');
      log('拍完复原 owner: ' + back.slice(0, 80));
    }
    lastDim = dim;
  }
  // 目标走出视野就追：等维度事件太被动，长距离 goto 掉岩浆那 20 秒就是这么丢的
  const st2 = await cam('/state');
  if (st2 && st2.inWorld && st2.targetVisible === false && Date.now() - lastPortalAt > 30000) {
    lastPortalAt = Date.now();
    const r = await ps('/cam tp');
    log('目标不可见 → /cam tp ' + r.trim().slice(0, 80));
  }
  await new Promise((res) => setTimeout(res, 5000));
}
