/**
 * server.js —— RDD Harness 面板（RDD Harness Panel）
 *
 *   node app\server.js [8891]     →  http://127.0.0.1:8891/
 *
 * 一个进程、零依赖、一个单页。把散在七个地方的「真源」收进一屏：
 *   registry.json / standards.md / stage.md / 能力清单 / 工具分类索引   （工程纪律 + 工具）
 *   .stager 下每个任务的 state.json + docs/manifest.json            （AI 进度 + 文档）
 *   .stager 下每个任务的 decisions.json                              （决策收件箱）
 *   opencode-plugin/model-budget.json + .state/model-usage.json       （模型额度 + 实时用量）
 *   8776 / 8765 / 8899 / 8080                                        （端口活没活）
 *
 * ── 设计取舍（都是被坑出来的，不是偏好）────────────────────────────
 * 1) **零依赖**：整个工作区里所有常驻服务都是 node 内置模块 http/fs/net/child_process。
 *    面板要是引入 express/vue 之类，就得先 npm install、还得管 node_modules ——
 *    而这东西的唯一用途是「双击打开看一眼」，**多一个依赖就多一个它自己坏了的可能**。
 * 2) **默认只读**：只有白名单里的文件能写，而且必须走 POST /api/save。
 *    harness 的东西（规范 / 注册表 / 策略）都是「真源」，被面板随手改坏比没有面板更糟。
 * 3) **写前给 diff、要求显式 save**：不是怕你改，是怕「以为改了其实没存」——
 *    那是本项目踩过 6 次的那一类（回执 ok 但东西没落）。
 * 4) **端口自报**：面板自己占的端口也列进健康表，免得「打不开」时分不清是它没起还是别的东西挡了。
 *
 * ── 一个必须知道的坑 ──────────────────────────────────────────────
 *   PowerShell 5.1 读 UTF-8 无 BOM 会乱码，所以 verify JSON 一律用 node，
 *   读文件一律显式 'utf8'，写 .ps1/.bat 一律 UTF-8 **BOM**（.bat 另见 PANEL.bat 头注释）。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const url = require('url');
const { spawn } = require('child_process');

const PORT = parseInt(process.argv[2], 10) || 8891;
const APP = __dirname;
const HARNESS = path.resolve(APP, '..');
const PAGE = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const REG_FILE = path.join(HARNESS, 'registry.json');

// stage 的 decide.js 是 CJS，直接 require 复用（★ 不要在这里重写一遍决策逻辑）
let DECIDE = null;
function decide() {
  if (DECIDE) return DECIDE;
  const p = path.join(HARNESS, '..', 'restart developing doer', 'stager', 'bin', 'decide.js');
  try { DECIDE = require(p); }
  catch (e) {
    try { DECIDE = require('E:\\restart developing doer\\stager\\bin\\decide.js'); }
    catch (e2) { DECIDE = { __err: e2.message }; }
  }
  return DECIDE;
}

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return d; } }
function readText(p, d) { try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { return d; } }
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }

/** tmp 名带 pid —— 面板可能和 stager CLI 同时在写同一个文件。 */
function writeAtomic(p, text) {
  const tmp = p + '.panel-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, p); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) { } throw e; }
}

const REG = readJson(REG_FILE, null);
if (!REG) {
  process.stderr.write('★ 读不到 registry.json，面板只能显示「坏了」：' + REG_FILE + '\n');
}
const R = (REG && REG.roots) || {};
const H = R.harness || HARNESS;
const WS = R.workspace || path.resolve(HARNESS, '..');

// ───────────────────────────────────────────── 可读 / 可写的文件白名单
// key = 前端用的 id。value 尽量是「相对某个 root」，这样搬家不用改这里。
const DOCS = [
  { id: 'standards', name: '编程规范（真源）', file: 'standards.md', from: 'harness', editable: true, why: '8 域 40 条带 id 的唯一真源，改它等于改纪律' },
  { id: 'registry', name: '工具注册表（真源 JSON）', file: 'registry.json', from: 'harness', editable: true, why: '机器真源；改完必须过 selftest' },
  { id: 'stage', name: 'stage 流细则', file: 'stage.md', from: 'harness', editable: false, why: '四阶段 / 必读 / 机器门' },
  { id: 'capability', name: '进游戏前必读 · 游戏内能力清单', file: '进游戏前必读-游戏内能力清单.md', from: 'harness', editable: false, why: 'preflight P13 就是它' },
  { id: 'toolIndex', name: '工具分类索引', file: '工具分类索引-20261005.md', from: 'harness', editable: true, why: '回答「我该用哪条」；改 registry 要同步改它' },
  { id: 'decidePolicy', name: '决策策略（什么才配问你）', file: 'stager/core/decide-policy.json', from: 'workspace', editable: true, why: '改它就改了「什么能问用户」' },
  { id: 'budget', name: '模型额度（每小时上限）', file: 'opencode-plugin/model-budget.json', from: 'workspace', editable: true, why: '降级链与额度上限，改它不用动代码' },
  { id: 'agents', name: '工程纪律（外层 AGENTS.md）', file: 'AGENTS.md', from: 'workspace', editable: true, why: '⚠ 全局卡是从这里同步出去的，改完要跑 check-global' },
];

function docPath(d) {
  const base = d.from === 'harness' ? H : WS;
  return path.join(base, d.file);
}

// ───────────────────────────────────────────── 端口健康
const PORTS = [
  { port: 8776, name: '监测台', url: 'http://127.0.0.1:8776/', why: '游戏里发生了什么的只读观测' },
  { port: 8765, name: 'Numen MCP', url: '', why: '游戏内 AI 的工具通道（test=8766 已停用）' },
  { port: 8899, name: 'stage 看板 / 决策收件箱', url: 'http://127.0.0.1:8899/', why: '桌宠网页版' },
  { port: 8080, name: 'OpenClaw 键鼠', url: '', why: '必须先于游戏起' },
  { port: 8891, name: '★ Harness 面板（就是本进程）', url: 'http://127.0.0.1:8891/', why: '你现在看的这个' },
];

function portAlive(port, timeout) {
  return new Promise((res) => {
    const s = new net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch (e) { } res(v); };
    s.setTimeout(timeout || 400);
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}

// ───────────────────────────────────────────── harness 体检（轻量，只读）
function toolResolve(p) {
  if (path.isAbsolute(p)) return p;
  const bare = p.replace(/^(?:rdd)?harness[\\/]/, '');
  const cands = [path.join(WS, p), path.join(H, bare), path.join(R.live || '', p.replace(/^live[\\/]/, ''))];
  return cands.find((c) => exists(c)) || cands[0];
}

function harnessHealth() {
  const out = { ok: false, tools: 0, notes: [] };
  if (!REG) { out.notes.push({ lv: 'bad', t: 'registry.json 读不到 —— 面板只能显示「坏了」' }); return out; }

  const tools = REG.tools || [];
  out.tools = tools.length;
  const ids = tools.map((x) => x.id);
  out.idUnique = new Set(ids).size === ids.length;
  const paths = tools.filter((x) => !x.inGameCommand).map((x) => x.path);
  const dupPath = [...new Set(paths.filter((p, i) => paths.indexOf(p) !== i))];
  out.dupPath = dupPath;
  let missing = [];
  for (const t of tools) {
    if (t.inGameCommand) continue;
    if (!exists(toolResolve(t.path))) missing.push(t.id + ' → ' + t.path);
  }
  out.pathMissing = missing;
  out.skipped = tools.filter((x) => x.inGameCommand).length;

  const std = readText(path.join(H, 'standards.md'), '');
  out.standardClauses = (std.match(/^###\s+S-[A-Z]+-\d+/gm) || []).length;
  out.standardBytes = Buffer.byteLength(std, 'utf8');

  const locks = (REG.timeLocks && REG.timeLocks.locks) || [];
  const today = new Date().toISOString().slice(0, 10);
  out.locks = locks.length;
  out.locksOpen = locks.filter((x) => x.status === 'open').length;
  out.locksOverdue = locks.filter((x) => x.status === 'open' && x.reviewBy && x.reviewBy < today)
    .map((x) => x.id + '（reviewBy ' + x.reviewBy + ' 已过期 → preflight P9 会 BLOCK）');

  out.gates = {
    preflight: ((REG.gates || {}).preflight || {}).checks?.length || 0,
    postflight: ((REG.gates || {}).postflight || {}).checks?.length || 0,
  };
  out.bugs = ((REG.bugs || {}).list || []).length;
  out.docNo = (REG.docNumbers || {}).maxDocNo;

  // 判定：只把「会真的害人」的列成问题，措辞里带上后果
  if (!out.idUnique) out.notes.push({ lv: 'bad', t: '注册表里有重复 id —— 门禁与文档都按 id 引用，会互相盖' });
  if (dupPath.length) out.notes.push({ lv: 'warn', t: '两条工具指向同一个文件：' + dupPath.join(' / ') + ' —— 重复登记，不是两个工具' });
  if (missing.length) out.notes.push({ lv: 'bad', t: missing.length + ' 条工具路径不存在（空头支票）：' + missing.slice(0, 3).join('；') + (missing.length > 3 ? ' …' : '') });
  out.locksOverdue.forEach((x) => out.notes.push({ lv: 'bad', t: '时间锁到期未复核：' + x }));
  if (!out.notes.some((n) => n.lv === 'bad')) {
    out.notes.push({ lv: 'ok', t: '路径全落地、id 唯一、时间锁没到期' });
    out.ok = true;
  }
  return out;
}

// ───────────────────────────────────────────── stage：AI 进度
const STAGER = path.join(WS, 'stager');
const RUNTIME = path.join(STAGER, '.stager');

function stageState() {
  const id = readJson(path.join(RUNTIME, 'active.json'), null);
  if (!id) return { active: null, tasks: [] };
  const dir = path.join(RUNTIME, 'tasks', id);
  const st = readJson(path.join(dir, 'state.json'), null);
  const man = readJson(path.join(dir, 'docs', 'manifest.json'), { docs: [] });
  let decisions = { items: [] };
  try { decisions = readJson(path.join(dir, 'decisions.json'), { items: [] }); } catch (e) { }
  const defs = (readJson(path.join(STAGER, 'core', 'stages.json'), { stages: [] }).stages || []);
  const list = defs.map((s, i) => Object.assign({}, s, { _i: i }));
  const s = list.find((x) => x.id === (st && st.stage)) || {};
  const docs = man.docs || [];
  const need = [], have = [];
  (s.gate?.docs || []).forEach((k) => {
    (docs.some((d) => d.kind === k && d.stage === st?.stage && d.round === st?.round) ? have : need).push('doc:' + k);
  });
  const marks = (st?.marks || {})[(st?.round + ':' + st?.stage)] || [];
  (s.gate?.cmds || []).forEach((c) => (marks.indexOf(c) >= 0 ? have : need).push('cmd:' + c));

  const all = [];
  try {
    all = fs.readdirSync(path.join(RUNTIME, 'tasks')).map((n) => readJson(path.join(RUNTIME, 'tasks', n, 'state.json'), null)).filter(Boolean);
  } catch (e) { }
  all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return {
    active: {
      id, stage: st, stageDef: s, docs, need, have, marks,
      decisions: decisions.items || [],
      progressPath: path.join(dir, 'progress.md'),
      progress: readText(path.join(dir, 'progress.md'), '').slice(0, 40000),
      dir,
      stageCount: list.length,
      stageList: list.map((x) => ({ id: x.id, name: x.name, icon: x.icon, next: x.next })),
    },
    tasks: all.map((t) => ({
      id: t.id, title: t.title, status: t.status, stage: t.stage, round: t.round,
      maxRounds: t.maxRounds, actor: t.actor, updatedAt: t.updatedAt, wrap: t.wrap,
    })),
  };
}

// ───────────────────────────────────────────── 模型额度
function budgetView() {
  const dir = path.join(WS, 'opencode-plugin');
  const cfg = readJson(path.join(dir, 'model-budget.json'), null);
  const usage = readJson(path.join(dir, '.state', 'model-usage.json'), { hours: {} });
  if (!cfg) return { ok: false, why: '读不到 opencode-plugin/model-budget.json' };
  const d = new Date();
  const hk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`;
  const rows = (cfg.tiers || []).map((t) => {
    const lim = (cfg.hourly || {})[t.id] || null;
    const u = ((usage.hours || {})[hk] || {})[t.id] || { ms: 0, calls: 0, chars: 0, errors: 0 };
    const over = lim && ((lim.maxMinutesPerHour != null && u.ms / 60000 >= lim.maxMinutesPerHour) ||
      (lim.maxCallsPerHour != null && u.calls >= lim.maxCallsPerHour));
    return {
      id: t.id, label: t.label, model: t.model,
      matchModels: t.matchModels || null,
      limit: lim, used: u, over: !!over,
      state: !lim ? '未配置（等于禁用）' : lim.enabled === false ? '已关' : over ? '本小时超限' : '可用',
    };
  });
  return { ok: true, hourKey: hk, order: cfg.escalateOrder || [], rows, timeoutMs: cfg.defaultTimeoutMs };
}

// ───────────────────────────────────────────── 路由
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve(null); } });
  });
}
/** 只允许打开 roots 之内（或 harness 自己）的东西 —— 面板会 spawn 进程，不能当任意执行口。 */
function safeOpen(p) {
  if (!p) return { ok: false, why: '没给路径' };
  const abs = path.resolve(p);
  const bases = [WS, H, R.docs, R.docsUnified, R.docsOut, R.numen, R.scripts, R.live, R.stageDocs, path.join(R.docs || '', 'rdd存放')].filter(Boolean);
  const inside = bases.some((b) => abs === b || abs.startsWith(path.resolve(b) + path.sep));
  if (!inside) return { ok: false, why: '不在已登记的任何根目录内，出于安全不打开：' + abs };
  if (!exists(abs)) return { ok: false, why: '路径不存在：' + abs };
  return { ok: true, abs };
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url);
  const p = u.pathname;

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(PAGE);
  }

  if (p === '/api/overview') {
    const D = decide();
    const stage = stageState();
    let decisions = { ok: false, why: D.__err ? 'decide.js 加载失败：' + D.__err : null, pending: [], resolved: [], policy: { ok: false } };
    if (!D.__err) {
      try {
        const aid = stage.active ? stage.active.id : null;
        if (aid) {
          const box = D.load(aid);
          decisions = {
            ok: true, activeId: aid,
            pending: box.items.filter((x) => x.status === 'pending'),
            resolved: box.items.filter((x) => x.status !== 'pending').slice(-10),
            policy: policyBrief(D),
          };
        } else decisions = { ok: true, activeId: null, pending: [], resolved: [], policy: policyBrief(D) };
      } catch (e) { decisions.why = '读决策队列失败：' + e.message; }
    }
    return Promise.all(PORTS.map((x) => portAlive(x.port).then((a) => Object.assign({}, x, { alive: a }))))
      .then((ports) => send(res, 200, {
        ok: true,
        now: new Date().toISOString(),
        harness: harnessHealth(),
        stage: stage,
        decisions: decisions,
        budget: budgetView(),
        ports: ports,
        roots: rootRows(),
        docs: DOCS.map((d) => ({ id: d.id, name: d.name, editable: d.editable, why: d.why, path: docPath(d), exists: exists(docPath(d)) })),
        harnessDir: H, workspaceDir: WS,
      }));
  }

  if (p === '/api/tools') {
    if (!REG) return send(res, 500, { ok: false, why: 'registry.json 读不到' });
    const tools = (REG.tools || []).map((t) => {
      const abs = t.inGameCommand ? null : toolResolve(t.path);
      return {
        id: t.id, name: t.name, path: t.path, abs: abs, side: t.side,
        needsGame: !!t.needsGame, usage: t.usage || null, note: t.note || null,
        inGameCommand: !!t.inGameCommand,
        alive: t.inGameCommand ? null : exists(abs),
      };
    });
    return send(res, 200, { ok: true, tools, groups: Object.keys(tools.reduce((a, t) => { const k = t.id.split('.')[0]; a[k] = 1; return a; }, {})).sort() });
  }

  // 读白名单里的文件
  if (p.startsWith('/api/doc/')) {
    const id = decodeURIComponent(p.slice(9));
    const d = DOCS.find((x) => x.id === id);
    if (!d) return send(res, 404, { ok: false, why: '没有这个文件（只认白名单里的）：' + id });
    const fp = docPath(d);
    if (!exists(fp)) return send(res, 404, { ok: false, why: '文件不存在：' + fp });
    return send(res, 200, { ok: true, id, name: d.name, path: fp, editable: d.editable, why: d.why, content: readText(fp, '') });
  }

  if (p.startsWith('/api/raw')) {
    const fp = decodeURIComponent((u.query || ''));
    const chk = safeOpen(fp);
    if (!chk.ok) return send(res, 400, chk);
    const dir = path.dirname(chk.abs);
    let files = [];
    try { files = fs.readdirSync(dir).filter((n) => !/^\./.test(n)); } catch (e) { }
    return send(res, 200, {
      ok: true, dir: chk.abs,
      listing: files.map((n) => { const fp2 = path.join(dir, n); let sz = 0; try { sz = fs.statSync(fp2).size; } catch (e) { } return { name: n, dir: fs.statSyncSync(fp2).isDirectory(), size: sz }; }),
      content: readText(chk.abs, ''),
    });
  }

  if (p === '/api/open' && req.method === 'POST') {
    return readBody(req).then((b) => {
      if (!b) return send(res, 400, { ok: false, why: '请求体不对' });
      const chk = safeOpen(b.path);
      if (!chk.ok) return send(res, 400, chk);
      try {
        // start 是 cmd 的内建命令，必须经 shell；用 spawn 显式 shell:false 反而跑不了
        const s = spawn('cmd', ['/c', 'start', '""', chk.abs], { detached: true, stdio: 'ignore' });
        s.unref();
        return send(res, 200, { ok: true, opened: chk.abs });
      } catch (e) { return send(res, 500, { ok: false, why: '拉起失败：' + e.message }); }
    });
  }

  if (p === '/api/save' && req.method === 'POST') {
    return readBody(req).then((b) => {
      if (!b) return send(res, 400, { ok: false, why: '请求体不对' });
      const d = DOCS.find((x) => x.id === b.id);
      if (!d) return send(res, 404, { ok: false, why: '不在可写白名单里：' + b.id });
      if (!d.editable) return send(res, 403, { ok: false, why: d.name + ' 在面板里是只读的' });
      const fp = docPath(d);
      const before = readText(fp, '');
      if (typeof b.content !== 'string') return send(res, 400, { ok: false, why: '没给 content' });
      if (b.content === before) return send(res, 200, { ok: true, changed: false, path: fp, msg: '内容没变，没写盘' });
      if (b.content.trim() === '') return send(res, 400, { ok: false, why: '内容是空的 —— 拒绝写（怕把真源清空）' });
      // JSON 类文件先验：写坏了整个 harness 都读不了
      if (/\.json$/.test(fp)) {
        try { JSON.parse(b.content); }
        catch (e) { return send(res, 400, { ok: false, why: 'JSON 语法错，拒绝写入：' + e.message + '　（写坏了整个 harness 都读不了）' }); }
      }
      try {
        writeAtomic(fp, b.content);
        const after = readText(fp, '');
        const same = after === b.content;
        const bak = fp + '.panel-bak';
        try { fs.writeFileSync(bak, before, 'utf8'); } catch (e) { }
        return send(res, 200, {
          ok: true, changed: true, verified: same, path: fp, backup: bak,
          bytesBefore: Buffer.byteLength(before, 'utf8'), bytesAfter: Buffer.byteLength(after, 'utf8'),
          msg: same ? '已写入并回读校验一致（原内容备份到 ' + path.basename(bak) + '）' : '⚠ 写下去了但回读不一致，请立刻看磁盘',
        });
      } catch (e) { return send(res, 500, { ok: false, why: '写入失败：' + e.message }); }
    });
  }

  if (p === '/api/gate' && req.method === 'POST') {
    return readBody(req).then((b) => {
      const phase = (b && b.phase) === 'postflight' ? 'postflight' : 'preflight';
      const r = spawn(process.execPath, [path.join(H, 'bin', 'harness-gate.js'), phase, '--since', String((b && b.since) || new Date().toISOString().slice(0, 10))],
        { cwd: H, encoding: 'utf8', windowsHide: true });
      let out = '';
      r.stdout.on('data', (c) => out += c);
      r.stderr.on('data', (c) => out += c);
      r.on('close', (code) => send(res, 200, { ok: true, phase, exit: code, output: out.slice(0, 60000) }));
    });
  }

  if (p === '/api/selftest') {
    const r = spawn(process.execPath, [path.join(H, 'bin', 'harness-gate.js'), 'selftest'], { cwd: H, encoding: 'utf8', windowsHide: true });
    let out = '';
    r.stdout.on('data', (c) => out += c);
    r.stderr.on('data', (c) => out += c);
    return r.on('close', (code) => send(res, 200, { ok: true, exit: code, output: out.slice(0, 60000) }));
  }

  if (p === '/api/decisions') {
    const D = decide();
    if (D.__err) return send(res, 500, { ok: false, why: D.__err });
    const id = readJson(path.join(RUNTIME, 'active.json'), null);
    if (!id) return send(res, 409, { ok: false, why: '没有进行中的 stage 任务' });
    try {
      const box = D.load(id);
      return send(res, 200, {
        ok: true, activeId: id, policy: policyBrief(D),
        pending: box.items.filter((x) => x.status === 'pending'),
        resolved: box.items.filter((x) => x.status !== 'pending').slice(-20),
      });
    } catch (e) { return send(res, 500, { ok: false, why: e.message }); }
  }

  if (p === '/api/decide' && req.method === 'POST') {
    const D = decide();
    if (D.__err) return send(res, 500, { ok: false, why: D.__err });
    return readBody(req).then((b) => {
      if (!b || !b.id) return send(res, 400, { ok: false, why: '要 { id, choice, note }' });
      const id = readJson(path.join(RUNTIME, 'active.json'), null);
      if (!id) return send(res, 409, { ok: false, why: '没有进行中的 stage 任务' });
      const r = b.action === 'dismiss'
        ? D.dismiss(id, b.id, b.note || '', 'user')
        : D.resolve(id, b.id, b.choice, b.note || '', 'user');
      if (!r.ok) return send(res, 409, r);
      const sp = path.join(RUNTIME, 'tasks', id, 'state.json');
      const stt = readJson(sp, null);
      if (stt) { stt.docRev = (stt.docRev || 0) + 1; writeAtomic(sp, JSON.stringify(stt, null, 2)); }
      return send(res, 200, { ok: true, docPath: r.docPath || null, file: r.file || null, item: r.item });
    });
  }

  if (p === '/api/repo') {
    const r = spawn(process.execPath, [path.join(STAGER, 'bin', 'repo-status.js')], { cwd: STAGER, encoding: 'utf8', windowsHide: true });
    let out = '';
    r.stdout.on('data', (c) => out += c);
    r.stderr.on('data', (c) => out += c);
    return r.on('close', () => send(res, 200, { ok: true, output: out.slice(0, 60000) }));
  }

  res.writeHead(404); res.end('no');
});

function policyBrief(D) {
  try {
    const p = D.loadPolicy();
    return {
      ok: true,
      risks: Object.keys(p.risks || {}).map((k) => ({ id: k, label: p.risks[k].label, means: p.risks[k].means })),
      never: (p.neverEscalate && p.neverEscalate.patterns || []).map((x) => x.what),
      before: p.requireBeforeAsking || [],
    };
  } catch (e) { return { ok: false, why: e.message }; }
}

function rootRows() {
  const names = {
    harness: 'harness（本面板的家）', workspace: '工作区根（外层仓库）', numen: 'Numen 源码真源',
    scripts: '自编译脚本真源', docs: '设计+规范+叙事真源', docsUnified: '自编译统一版（编号文档）',
    docsOut: '★ 用户唯一收件箱', live: 'live 游戏实例', stageDocs: 'stage 过程文档',
  };
  return Object.keys(R).map((k) => ({ key: k, label: names[k] || k, path: R[k], exists: exists(R[k]) }));
}

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('RDD Harness 面板：http://127.0.0.1:' + PORT + '/\n');
  process.stdout.write('Ctrl+C 停。\n');
});