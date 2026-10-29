#!/usr/bin/env node
'use strict';
/**
 * ai-surface.js —— 核对外部编码 AI 实际请求暴露面（2026-10-29 施工单第 1 阶段）
 *
 * 为什么存在：
 *   registry.json 有 98 项，但那是「目录」。外部 AI 每一轮真正收到几个工具定义，
 *   要从会话请求头里数，不能拿 registry 数字冒充。这个脚本只做取证，不参与业务流程。
 *
 * 三个面（互不冒充）：
 *   1. DSH 实际请求面：解压会话 .jsonl.zstd，取第一条 request/header 的 tools[]。
 *   2. Harness 目录面：registry.json 的 tools[] 数量。
 *   3. Numen 游戏内面：源码里 registerTool(...) 调用点，**运行时暴露数一律 unverified**
 *      （游戏没起 / 不同插件组合会变；不要用源码数冒充每轮提示里的工具数）。
 *
 * 用法：
 *   node bin/ai-surface.js --json                          # 自动找当前 workspace 最新会话
 *   node bin/ai-surface.js --dsh-session <session.v4.jsonl.zstd>
 *   node bin/ai-surface.js --numen D:\rdd\workspace\minecraft-numen
 *
 * 边界：只读；不写任何账本；找不到就写 unknown/unverified，不填 0。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HARNESS = path.resolve(__dirname, '..');
const RDD = 'D:\\rdd';
const DSH_SESSIONS = process.env.DSH_SESSIONS || path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'sessions');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

/** DSH 会话是「一条记录一帧 zstd」；按魔数切帧，逐帧解压。 */
function decodeSession(file) {
  const buf = fs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  const lines = [];
  let failed = 0;
  for (let k = 0; k < starts.length; k++) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
    try {
      for (const l of zlib.zstdDecompressSync(slice).toString('utf8').split(/\r?\n/)) if (l.trim()) lines.push(l);
    } catch { failed++; }
  }
  return { lines, frames: starts.length, failed };
}

function newestSession() {
  if (!fs.existsSync(DSH_SESSIONS)) return null;
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl.zstd')) files.push({ p, m: fs.statSync(p).mtimeMs });
    }
  };
  walk(DSH_SESSIONS);
  files.sort((a, b) => b.m - a.m);
  return files.length ? files[0].p : null;
}

function dshSurface(file) {
  const out = { file, count: null, tools: [], provider: null, model: null, session: null, frames: null, decodeFailures: null, note: null };
  if (!file || !fs.existsSync(file)) { out.note = 'unknown：没找到 DSH 会话文件'; return out; }
  const { lines, frames, failed } = decodeSession(file);
  out.frames = frames;
  out.decodeFailures = failed;
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type === 'session' && o.id) out.session = o.id;
    if (o.type === 'request/header' && o.data && o.data.header) {
      const h = o.data.header;
      out.provider = (h.config || {}).provider || null;
      out.model = (h.config || {}).model || null;
      out.tools = (h.tools || []).map((t) => t.name);
      out.count = out.tools.length;
      break;
    }
  }
  if (out.count == null) out.note = 'unknown：会话里没有 request/header（可能还没发过请求）';
  return out;
}

function registrySurface() {
  const file = path.join(HARNESS, 'registry.json');
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, count: (r.tools || []).length, note: '目录数量；不等于每轮请求里的工具定义数' };
  } catch (e) {
    return { file, count: null, note: 'unknown：' + e.message };
  }
}

function numenSurface(dir) {
  const root = dir || path.join(RDD, 'workspace', 'minecraft-numen');
  const out = { root, registerToolCalls: null, uniqueToolClasses: [], plugins: [], runtime: 'unverified', note: '源码调用点数；运行时实际暴露数依赖启用的插件与同伴状态，拿不到就写 unverified' };
  if (!fs.existsSync(root)) { out.note = 'unknown：目录不存在 ' + root; return out; }
  const classes = new Set();
  const plugins = new Set();
  let calls = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.java')) {
        const text = fs.readFileSync(p, 'utf8');
        const re = /registerTool\(\s*new\s+(\w+)/g;
        let m;
        while ((m = re.exec(text))) { classes.add(m[1]); calls++; }
        if (calls) {
          const rel = path.relative(root, p);
          const pl = rel.split(path.sep).find((x, i, arr) => arr[i - 1] === 'plugins');
          if (pl) plugins.add(pl);
        }
      }
    }
  };
  walk(root);
  out.registerToolCalls = calls;
  out.uniqueToolClasses = [...classes].sort();
  out.plugins = [...plugins].sort();
  return out;
}

function main() {
  const dshFile = arg('dsh-session') || newestSession();
  const dsh = dshSurface(dshFile);
  const registry = registrySurface();
  const numen = numenSurface(arg('numen'));
  const report = {
    generated_at: new Date().toISOString(),
    boundary: '三个面分别取证，互不冒充；拿不到写 unknown/unverified。',
    dsh,
    registry,
    numen,
    intersection: {
      dsh_vs_registry: dsh.tools.filter((t) => {
        try { return JSON.parse(fs.readFileSync(path.join(HARNESS, 'registry.json'), 'utf8')).tools.some((x) => x.id === t); } catch { return false; }
      }),
      note: 'DSH 工具名与 registry id 是两套命名（ask_user_question vs bench），交集通常为空——空交集不代表谁错了，只说明两张表不是一个命名空间',
    },
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('# 外部编码 AI 工具面取证');
    console.log('DSH 实际请求面: ' + (dsh.count == null ? 'unknown' : dsh.count + ' 项') + '  provider=' + (dsh.provider || '?') + '/' + (dsh.model || '?') + '  session=' + (dsh.session || '?'));
    if (dsh.tools.length) console.log('  ' + dsh.tools.join(', '));
    console.log('Harness 目录面: ' + (registry.count == null ? 'unknown' : registry.count + ' 项') + '（registry.json，目录不是每轮定义）');
    console.log('Numen 源码面: registerTool 调用 ' + (numen.registerToolCalls == null ? 'unknown' : numen.registerToolCalls + ' 处 / ' + numen.uniqueToolClasses.length + ' 个类 / 插件 ' + numen.plugins.join(',')) + '；运行时=' + numen.runtime);
    for (const w of [dsh.note, registry.note, numen.note]) if (w) console.log('  · ' + w);
  }
}

main();
