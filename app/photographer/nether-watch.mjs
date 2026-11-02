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

let lastDim = null;
let lastPortalAt = 0;
log('开始守维度（每 5 秒）');
for (;;) {
  const st = await mcp('get_self_status', { companion: 'RDD' });
  const dim = st && st.dimension;
  if (dim && dim !== lastDim) {
    log('维度变化 ' + lastDim + ' → ' + dim);
    if (lastDim && dim === 'minecraft:the_nether') {
      const r = await ps('/cam tp');
      log('/cam tp → ' + r.trim().slice(0, 120));
      await new Promise((res) => setTimeout(res, 3000));
      await cam('/rec', { on: true, fps: 6 });
      await new Promise((res) => setTimeout(res, 20000));
      await cam('/rec', { on: false });
      await new Promise((res) => setTimeout(res, 2500));
      const take = fs.readdirSync(SHOTS).filter((n) => n.startsWith('numencam_')).sort().pop();
      log('入界后录制完成：' + take);
    }
    lastDim = dim;
  }
  await new Promise((res) => setTimeout(res, 5000));
}
