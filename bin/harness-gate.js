#!/usr/bin/env node
/* harness-gate.js — RDD harness 两段门禁执行器
 *
 *   node harness-gate.js preflight  --since 2026-10-04   进游戏【之前】
 *   node harness-gate.js postflight --since 2026-10-04   出游戏【之后】
 *   node harness-gate.js selftest                       只跑内置检查（不碰外部工具）
 *   node harness-gate.js registry                       打印注册表摘要
 *
 * 设计原则（照抄 loop-gate.js 的那条）：
 *   每项判据只认盘上的实物或可追溯的痕迹，不认「AI 说它做了」。
 *
 * 三类 kind：
 *   artifact 查实物 —— AI 编不出来（jar 内容、commit、测试 xml、mp4 帧数）
 *   trace    查痕迹 —— mtime + 内容签名，防「只靠改时间骗过」
 *   human    人工   —— 机器判不了，列出来让人打勾
 *
 * 退出码：0 全过 / 1 有 block / 3 环境错（注册表读不到）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const registryLib = require('./lib/registry.js');

const HARNESS = path.resolve(__dirname, '..');
const REGISTRY = path.join(HARNESS, 'registry.json');

// ── 小工具 ───────────────────────────────────────────────────────────────
const J = (p) => path.join(...p.split('/').map((s) => s.replace(/\\/g, path.sep)));
const R = (rel) => path.join(J(REG.roots.workspace), rel);
const P = (p) => path.join(p);

function loadRegistry() {
  // ★ 路径解析统一走 bin/lib/registry.js：注册表现在全是相对 RDD 根的路径，
  //   绝对路径只作兼容。别在这里自己 path.join(REG.roots...) 拼死路径。
  REG = registryLib.load();
}
let REG = null;

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function mtime(p) { try { return fs.statSync(p).mtime; } catch { return null; } }
function listDir(p) { try { return fs.readdirSync(p); } catch { return []; } }

function today() {
  const a = process.argv;
  const i = a.indexOf('--since');
  if (i >= 0 && a[i + 1]) return new Date(a[i + 1] + 'T00:00:00');
  const d = new Date(); d.setHours(0, 0, 0, 0); return d;
}
function arg(name, dflt) {
  const a = process.argv; const i = a.indexOf(name);
  return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
}
function freshEnough(p, since) { const m = mtime(p); return !!m && m >= since; }

/** 内容签名：正文里出现 keyword 或 head 前 12 位（与 loop-gate.js 同一套，防「只改 mtime」） */
function hasSignature(text, keyword, head) {
  if (!text) return false;
  if (keyword && text.includes(keyword)) return true;
  if (head && head.length >= 7 && text.includes(head.slice(0, 12))) return true;
  return false;
}
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

/** 递归找文件（自己写，避开 glob 依赖），depth 默认 6 */
function walk(dir, depth, pred, out) {
  out = out || [];
  if (depth < 0 || !isDir(dir)) return out;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'build') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth - 1, pred, out);
    else if (e.isFile() && (!pred || pred(e.name, full))) out.push(full);
  }
  return out;
}

/**
 * 找到可用的 git 可执行文件。
 *
 * ★ 2026-10-19：本机 git 不在 PATH 上（MinGit 装在 %LOCALAPPDATA%\Programs\MinGit）。
 *   原来直接 spawnSync('git') → selftest 永远报「git 可用 ✘」，
 *   看起来像「仓库坏了」，其实是 PATH 的事（门禁自己的缺陷长得像债，同类第 9 例）。
 *   现在按 ①PATH ②已知安装位 ③RDD_GIT 环境变量 依次找；找不到返回原名（让报错照旧）。
 */
function resolveGit() {
  if (process.env.RDD_GIT && fs.existsSync(process.env.RDD_GIT)) return process.env.RDD_GIT;
  const probes = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'MinGit', 'cmd', 'git.exe'),
    path.join(process.env.ProgramFiles || '', 'Git', 'cmd', 'git.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Git', 'cmd', 'git.exe'),
  ];
  for (const p of probes) if (p && fs.existsSync(p)) return p;
  return 'git';
}
const GIT = resolveGit();

function git(cwd, args) {
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf8', maxBuffer: 32 << 20 });
  const out = (r.stdout || '') + (r.stderr || '');
  // spawn 本身失败（ENOENT）时 r.status 是 null —— 归一成非零码，别让它冒充成功
  return { code: r.status === null ? 127 : r.status, out };
}

/** 列 zip/jar 里的 entry 名（借 powershell 的 ZipFile，避免引依赖） */
function zipEntries(jar) {
  const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
    `$z=[System.IO.Compression.ZipFile]::OpenRead('${jar.replace(/'/g, "''")}');` +
    `$z.Entries|ForEach-Object{$_.FullName};$z.Dispose()`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// ── 结果收集 ─────────────────────────────────────────────────────────────
const results = [];
function record(id, name, level, kind, state, detail) {
  results.push({ id, name, level, kind, state, detail: detail || '' });
}
const BLOCK = 'BLOCK', WARN = 'WARN', PASS = 'PASS', SKIP = 'SKIP';
// ★ ASK = 「必须由人点头，机器判不了」。它【不进 BLOCK 计数】（否则一条永远无法自动
// 满足的项会把门禁永久钉死 —— 同 P10/P10c 的教训），但【永远打印在单独的段落里】，
// 所以「AI 读得到这句提示」这件事本身是被保证的。
// 用它而不是「记进 registry 就当有」：2026-10-04 首跑发现 P11/P12/P13 只写进了
// registry.json，preflight() 里根本没 record()，于是**门禁上一轮还没接上就没人提醒**
// —— 那正是 bug-10 那一族（纪律看起来在守，其实从没执行过）。
const ASK = 'ASK';

// ═══════════════════════════════════════════════════════════════════════════
// preflight —— 进游戏之前
// ═══════════════════════════════════════════════════════════════════════════
function preflight(ctx) {
  const { since, keyword, head } = ctx;
  const NUMEN = R('minecraft-numen');
  const SCRIPTS = R('rdd-selfcompile/scripts');
  const LIVE_MODS = P(REG.roots.live) + path.sep + 'mods';

  // P1 编译通道合规 —— phase-build.json 是 run-mutation 的产物，手写 gradle 不会产生它
  {
    const muts = R('rdd-selfcompile/mutations');
    const phases = walk(muts, 3, (n) => /^phase-build\.json$/.test(n));
    const recent = phases.filter((p) => freshEnough(p, since));
    if (!phases.length) record('P1', '编译通道合规', BLOCK, 'artifact', SKIP,
      'mutations 下没有任何 phase-build.json —— 本轮可能还没编译，或没走 run-mutation.ps1');
    else if (!recent.length) record('P1', '编译通道合规', BLOCK, 'artifact', WARN,
      `有 ${phases.length} 个历史 phase-build.json，但没有一个是本轮（--since ${since.toISOString().slice(0, 10)}）的`);
    else {
      const last = recent.sort((a, b) => mtime(b) - mtime(a))[0];
      const t = readText(last);
      const hasModule = /"module"|"moduleOverride"|"effectiveModule"/.test(t);
      record('P1', '编译通道合规', BLOCK, 'artifact', hasModule ? PASS : WARN,
        `本轮编译走的是 run-mutation：${path.relative(muts, last)}${hasModule ? '' : ' ⚠ 该 phase 里没读到 module 字段'}`);
    }
  }

  // P2 jar 不落后于源码
  {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'verify-tools/check-runtime-deployment.js')],
      { encoding: 'utf8', maxBuffer: 32 << 20 });
    const out = (r.stdout || '') + (r.stderr || '');
    const stale = /VERDICT=STALE/.test(out);
    const ahead = out.split(/\r?\n/).filter((l) => /领先|STALE/.test(l) && !/VERDICT/.test(l)).slice(0, 4);
    record('P2', 'jar 不落后于源码', BLOCK, 'artifact', (r.status === 2 || stale) ? BLOCK : PASS,
      `exit=${r.status}` + (ahead.length ? ' | ' + ahead.join(' ; ') : ' | 无源码领先项'));
  }

  // P3 jar 内容自检 —— 本轮构建的 jar 必须真在 live mods 里
  {
    const jars = listDir(LIVE_MODS).filter((n) => /\.jar$/i.test(n) && !/\.bak|\.off$/i.test(n));
    if (!jars.length) record('P3', 'jar 内容自检', BLOCK, 'artifact', BLOCK, `live mods 下没有启用的 jar：${LIVE_MODS}`);
    else {
      const freshJars = jars
        .map((n) => ({ n, p: path.join(LIVE_MODS, n) }))
        .filter((j) => freshEnough(j.p, since));
      if (!freshJars.length) record('P3', 'jar 内容自检', BLOCK, 'artifact', WARN,
        `mods 下 ${jars.length} 个 jar，但没有一个是本轮部署的（--since ${since.toISOString().slice(0, 10)}）`);
      else {
        // 抽查最新那个：能不能列出 entries
        const latest = freshJars.sort((a, b) => mtime(b.p) - mtime(a.p))[0];
        const ents = zipEntries(latest.p);
        const classes = ents ? ents.filter((e) => e.endsWith('.class')).length : -1;
        const toml = ents ? ents.some((e) => /META-INF\/neoforge\.mods\.toml$/.test(e)) : false;
        const mixinCfg = ents ? ents.filter((e) => /\.mixins\.json$/.test(e)) : [];
        const ok = classes > 0 && toml;
        record('P3', 'jar 内容自检', BLOCK, 'artifact', ok ? PASS : BLOCK,
          `${latest.n} → ${classes} 个 .class` + (toml ? ' + neoforge.mods.toml' : ' ⚠ 无 neoforge.mods.toml') +
          (mixinCfg.length ? ` + ${mixinCfg.join(',')}` : '') +
          (ents && !ents.some((e) => e.endsWith('.refmap.json')) ? '' : ''));
      }
    }
  }

  // P4 无重复 mixin 注入 —— 只查【本工作区自己的 jar】。
  // ★ 教训（2026-10-04 实跑踩到）：别扫整个 mods 目录。第三方 mod 自带一堆 mixin，
  //   而且它们的备份 jar（_backup_xxx.jar）也躺在同一个目录里 —— 扫全盘会得到
  //   27 条「重复注入」的纯噪音。P4 的本意只有一个：搬走自己的 mixin 后，
  //   旧宿主 jar 里那一份有没有跟着重建掉。
  {
    const OWN = /^(numen[-_]|numen_api)/i;
    const isBackup = (n) => /\.(bak|off|old|stager-bak)(\.jar)?$/i.test(n) || /^_backup/i.test(n) || /\.bak[-_.]/i.test(n);
    const jars = listDir(LIVE_MODS)
      .filter((n) => /\.jar$/i.test(n) && !isBackup(n) && OWN.test(n))
      .map((n) => path.join(LIVE_MODS, n));
    const owner = new Map();      // class 名 -> [jar]
    let scanned = 0;
    for (const j of jars) {
      const ents = zipEntries(j);
      if (!ents) continue;
      scanned++;
      for (const e of ents) {
        if (!e.endsWith('.class') || e.includes('$')) continue;
        if (!/\/(mixin|mixins)\//i.test(e) && !/Mixin[A-Z]|Accessor$/i.test(e)) continue;
        if (!owner.has(e)) owner.set(e, []);
        owner.get(e).push(path.basename(j));
      }
    }
    const dup = [...owner.entries()].filter(([, v]) => v.length > 1);
    record('P4', '无重复 mixin 注入', BLOCK, 'artifact', dup.length ? BLOCK : PASS,
      dup.length
        ? dup.map(([k, v]) => `${k} 同时在 ${v.join(' + ')}`).join(' ; ')
        : `扫了 ${scanned} 个自有 jar（${jars.map((j) => path.basename(j)).join(', ')}），` +
          `${owner.size} 个 mixin/accessor 类，无重名。★ 第三方 mod 不查（它们自带一堆 mixin + 备份 jar，会刷出纯噪音）`);
  }

  // P5 本轮有按模块 commit
  {
    const r = git(NUMEN, ['log', `--since=${since.toISOString().slice(0, 10)} 00:00`, '--oneline']);
    const lines = (r.out || '').split(/\r?\n/).filter((l) => /^[0-9a-f]{7,}\s/.test(l));
    const mine = keyword ? lines.filter((l) => l.includes(keyword)) : lines;
    record('P5', '本轮有按模块 commit', BLOCK, 'artifact', lines.length ? PASS : BLOCK,
      lines.length
        ? `本轮共 ${lines.length} 个 commit，其中命中「${keyword}」${mine.length} 个` +
          (mine.length ? ' → ' + mine.slice(0, 3).join(' | ')
                       : ` → 最新 3 个：${lines.slice(0, 3).join(' | ')}（★ 本工作区常有两个会话并行，确认命中的是你那个）`)
        : 'minecraft-numen 本轮 0 commit（★ 确认是精确 add 指定的文件，别用 -A）');
  }

  // P6 测试有结果且 0 失败
  {
    const xmls = walk(NUMEN, 6, (n) => /^TEST-.*\.xml$/.test(n));
    let tests = 0, bad = 0, recentXml = 0;
    for (const x of xmls) {
      const t = readText(x);
      const m = t.match(/<testsuite\b[^>]*>/);
      if (!m) continue;
      const tag = m[0];
      tests += +(tag.match(/tests="(\d+)"/) || [0, 0])[1];
      bad += +(tag.match(/failures="(\d+)"/) || [0, 0])[1];
      bad += +(tag.match(/errors="(\d+)"/) || [0, 0])[1];
      if (freshEnough(x, since)) recentXml++;
    }
    if (!xmls.length) record('P6', '测试有结果且 0 失败', BLOCK, 'artifact', SKIP,
      '没找到任何 TEST-*.xml（没跑过 gradle test？）');
    else if (!recentXml) record('P6', '测试有结果且 0 失败', BLOCK, 'artifact', BLOCK,
      `历史共 ${xmls.length} 份结果，但本轮 0 份 —— 改了执行层就必须跑`);
    else record('P6', '测试有结果且 0 失败', BLOCK, 'artifact', bad ? BLOCK : PASS,
      `本轮 ${recentXml} 份结果；累计 tests=${tests} failures+errors=${bad}`);
  }

  // P7 规范/索引已补
  {
    const touched = [];
    const probe = [
      P(REG.roots.harness) + path.sep + 'standards.md',
      P(REG.roots.docsUnified),
      path.join(REG.roots.stageDocs),
    ];
    // 记忆图谱写入留痕：memory MCP 不落盘，只能靠文档里写了实体名
    const stageTxt = walk(REG.roots.stageDocs, 4, (n) => /\.md$/.test(n))
      .filter((f) => freshEnough(f, since))
      .map((f) => readText(f)).join('\n');
    const mem = /memory_create_entities|memory_add_observations|memory_search_nodes/.test(stageTxt);
    for (const p of probe) if (isDir(p) || isFile(p)) { if (freshEnough(p, since)) touched.push(path.basename(p)); }
    const ok = touched.length > 0 || mem;
    record('P7', '规范/索引已补', BLOCK, 'trace', ok ? PASS : BLOCK,
      ok ? `本轮动过：${touched.join(', ') || '(无目录级改动)'}${mem ? ' + 文档里有记忆图谱调用留痕' : ''}`
         : '★ 本轮既没动 standards.md / docsUnified，也没在文档里留记忆图谱写入痕迹。坑不许只写在 AGENTS.md 里。');
  }

  // P8 不回退清单对照过
  {
    const p = path.join(REG.roots.docsUnified, '30-主要功能不回退清单.md');
    const r = git(REG.roots.docs, ['log', '-1', `--since=${since.toISOString().slice(0, 10)} 00:00`, '--format=%h %s', '--', path.relative(REG.roots.docs, p).replace(/\\/g, '/')]);
    const fresh = freshEnough(p, since) || /\b[0-9a-f]{7,}\s/.test(r.out);
    record('P8', '不回退清单对照过', BLOCK, 'trace', fresh ? PASS : WARN,
      fresh ? '30-主要功能不回退清单.md 本轮动过' : '本轮没动 30-主要功能不回退清单.md（命中要保的能力时会漏）');
  }

  // ── P11 / P12 / P13 ────────────────────────────────────────────────
  // ★ 2026-10-04 首跑事故：P11/P12/P13 只写进了 registry.json，preflight() 里
  //   **一次 record() 都没有** —— 所以「进游戏前提醒你过一遍游戏内能力清单」
  //   这条用户明确要求的门禁，上一轮根本没接上，跑出来 12 行里根本没有 P13。
  //   这跟 bug-10（纪律引用了一个不存在的命令）是同一族：
  //   **声明 ≠ 接线**。修法 = 真 record() + ASK 状态永远打印（见 ASK 常量注释）。
  {
    // P11 规则没打架 —— 真跑那两个自检脚本，别自己另写一套判断
    const chk = path.join(REG.roots.workspace, 'stager', 'bin');
    const align = spawnSync(process.execPath, [path.join(chk, 'check-align.js')], { encoding: 'utf8', maxBuffer: 8 << 20 });
    const glb = spawnSync(process.execPath, [path.join(chk, 'check-global.js')], { encoding: 'utf8', maxBuffer: 8 << 20 });
    const bad = [align, glb].filter((r) => r.status !== 0);
    // ★ 2026-10-19：退出码 3 = 环境错（例如全局指针卡还没装到 ~/.config/opencode/），
    //   按项目契约那是 SKIP 不是债 —— 报 BLOCK 会让「文件没装」长得像「规则打架」。
    const env = bad.filter((r) => r.status === 3);
    const real = bad.filter((r) => r.status !== 3);
    let p11state = PASS;
    let p11detail = `check-align 0 · check-global 0（外层 AGENTS.md / rddharness\\stage.md / 全局指针卡 三层分工一致）`;
    if (real.length) {
      p11state = BLOCK;
      p11detail = `check-align exit=${align.status} / check-global exit=${glb.status} —— 规则文件之间有冲突或指针失效，先修那个再动游戏`;
    } else if (env.length) {
      p11state = SKIP;
      p11detail = `check-global exit=3（环境错，不是债）：${env.map((r) => (r.stdout || '').split(/\r?\n/).find((l) => /SKIP|缺失/.test(l)) || '').filter(Boolean).join(' ').trim() || '全局指针卡缺失'} —— 装法见该脚本输出`;
    }
    record('P11', '规则没打架', BLOCK, 'artifact', p11state, p11detail);
  }
  {
    // P12 改接口先查消费者 —— 机器判不了「你到底改了哪个接口」，只能问
    const touched = git(REG.roots.workspace, ['log', '--since=' + since.toISOString().slice(0, 10) + ' 00:00',
      '--name-only', '--format=', '--', 'minecraft-numen']).out
      .split(/\r?\n/).filter((l) => /\.java$/i.test(l));
    const iface = touched.filter((f) => /\/(interface|api|bridge|registry)\w*\.(java|json)$/i.test(f)
      || /Bridge\.java$|Registry\.java$|NumenTool\.java$/.test(f));
    record('P12', '改接口先查消费者', 'ask', 'human', ASK,
      iface.length
        ? `本轮动到接口/门面类 ${iface.length} 个（${iface.slice(0, 3).join(', ')}${iface.length > 3 ? ' …' : ''}）—— ★ 确认已 grep 过全部消费者并补齐 switch 分支`
        : '本轮没动接口类（若动了，下面这行会列出来）—— 仍要自己确认新增枚举值/方法名没有漏改 switch');
  }
  {
    // P13 ★ 用户 2026-10-04 明确要的那一条：进游戏之前让 AI 过一遍游戏内能力清单
    const cl = path.join(REG.roots.harness, '进游戏前必读-游戏内能力清单.md');
    if (!isFile(cl)) {
      record('P13', '进游戏前过一遍游戏内能力清单', 'ask', 'human', BLOCK,
        `★ 清单文件不在：${cl} —— 这条门禁等于没有，先把清单补上`);
    } else {
      const items = (readText(cl).match(/^## [1-9]\d* ·/gm) || []).length;
      record('P13', '进游戏前过一遍游戏内能力清单', 'ask', 'human', ASK,
        `★ 动手起游戏之前，先打开读一遍：\n` +
        `       ${cl}\n` +
        `       它列了 ${items} 项游戏内能力（说话/建伙伴/让内脑停/视觉/拍摄/追踪/相机/飞行/看监测台）` +
        `各自的正确调用姿势和坑。\n` +
        `       ★ 别临场手写已有工具 —— 「游戏内截图能力=0」这类结论已经错了不止一次。`);
    }
  }

  {
    // ★ P14（2026-10-21 用户定）：脏工作区不许开新批次。
    //   为什么加：334 处脏项能攒几周没人发现，说明「干净」没有强制点。
    //   根因是各会话判断干净时**只看 diff，不看「磁盘上有但 git 不知道」的文件** ——
    //   26 项文档资产 + 44 个 harness 文件就是这么攒出来的（宪法和记忆从没进过版本控制）。
    //   ★ 所以「干净」的定义必须写死：clean = git status --porcelain 为空；
    //     **untracked 一律算脏**（不许只盯改动过的文件）。
    //   白名单：运行产物（report/ 的临时件、runs/、mutations/、.tmp/、*.log）
    //   它们本来就该在盘上而不该进库。
    const repos = [
      { name: 'docs', dir: REG.roots.docs },
      { name: 'harness', dir: REG.roots.harness },
      { name: 'numen', dir: path.join(REG.roots.workspace, 'minecraft-numen') },
    ];
    const IGNORE = /(^|\/)(runs|mutations|\.tmp|node_modules)\/|\.log$|report\/w-replies\//;
    const dirtyAll = [];
    for (const r of repos) {
      if (!fs.existsSync(r.dir)) continue;
      const g = require('child_process').spawnSync(
        'C:\\Users\\admin\\AppData\\Local\\Programs\\MinGit\\cmd\\git.exe',
        ['-C', r.dir, '-c', 'core.quotepath=false', 'status', '--porcelain'],
        { encoding: 'utf8', timeout: 30000 }
      );
      if (g.status !== 0) continue;
      const lines = (g.stdout || '').split(/\r?\n/).filter(Boolean).filter((l) => !IGNORE.test(l.slice(3)));
      if (lines.length) dirtyAll.push({ name: r.name, lines });
    }
    if (dirtyAll.length === 0) {
      record('P14', '工作区干净（含 untracked）', 'artifact', 'BLOCK', PASS,
        '三仓 git status --porcelain 均为空 —— 可以开新批次 / 打审计 tag');
    } else {
      const total = dirtyAll.reduce((a, x) => a + x.lines.length, 0);
      const brief = dirtyAll.map((d) => `${d.name} ${d.lines.length}`).join(' / ');
      const sample = dirtyAll[0].lines.slice(0, 3).map((l) => l.slice(0, 70)).join('\n       ');
      record('P14', '工作区干净（含 untracked）', 'artifact', 'BLOCK', BLOCK,
        `★ 脏工作区不许开新批次（${brief}，共 ${total} 处）。\n` +
        `       ★ 「干净」= git status --porcelain 为空；**untracked 也算脏**\n` +
        `         （26 项文档资产 + 44 个 harness 文件就是这样攒出来的：\n` +
        `          各会话只看 diff，不看「磁盘上有但 git 不知道」的文件）。\n` +
        `       先收口再开批次。示例：\n       ${sample}\n` +
        `       ★ 为什么：334 能攒出来 = 干净没有强制点。不收口，下轮 334 变 600，tag 门永远差一步。`);
    }

    // ★★ 2026-10-22：P14 追加「资产普查」子判据。
    //   为什么追加在 P14 里而不是另立一项（AGENTS.md §0.5「不许再加工具/新检查项」）：
    //   普查盯的是同一件事的另一面 —— 「在不在库里」，而不是「干不干净」。
    //   ★ 关键区别（实测证明，不是推断）：
    //     git status --porcelain **看不见被 .gitignore 吃掉的文件**。
    //     实测：造一个 .gitignore 掉的 secret.md → porcelain 输出为空，
    //     而 `ls-files --others --ignored` 能看见它。
    //   ⇒ 治理资产只要被某条 .gitignore 规则误伤，就永久处于「零机检」状态：
    //     门禁说干净、普查（只在打 tag 时跑）不说、文档里照常引用它。
    //   顺序（用户 2026-10-22 定）：红线回退 > 模块架构 > 项目历史。
    //   判据（用户定）：「文件存在 + 在资产普查清单里」就够，不查内容。
    {
      const census = path.join(__dirname, 'check-asset-census.js');
      if (!fs.existsSync(census)) {
        record('P14', '工作区干净（含 untracked）', 'artifact', 'BLOCK', BLOCK,
          '★ 资产普查脚本不存在（bin/check-asset-census.js）—— 不能当通过：治理资产可能裸奔且无人知道');
      } else {
        const cg = require('child_process').spawnSync(process.execPath, [census, '--json'],
          { encoding: 'utf8', timeout: 120000 });
        let parsed = null;
        try { parsed = JSON.parse(cg.stdout || '{}'); } catch { /* 降级 */ }
        if (!parsed || !Array.isArray(parsed.items)) {
          record('P14', '工作区干净（含 untracked）', 'artifact', 'BLOCK', BLOCK,
            '★ 资产普查跑不起来（输出无法解析）—— 不能当通过：被 .gitignore 吃掉的资产门禁看不见');
        } else if (parsed.badCount > 0) {
          // 优先级序：红线回退 > 模块架构 > 项目历史（用户 2026-10-22 定）
          const PRI = ['红线回退', '模块架构', '项目历史'];
          const items = parsed.items.filter((x) => x.status !== 'OK');
          items.sort((a, b) => {
            const ia = PRI.findIndex((k) => String(a.p).includes(k));
            const ib = PRI.findIndex((k) => String(b.p).includes(k));
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
          });
          const detail = items.map((x) => {
            const bare = (x.bare || []).slice(0, 3);
            return `${x.p}（${bare.length ? bare.join('、') : x.detail}）`;
          }).join('\n       ');
          record('P14', '工作区干净（含 untracked）', 'artifact', 'BLOCK', BLOCK,
            `★ 资产普查有 ${parsed.badCount} 项裸奔 —— 治理层的器官在库外。\n` +
            `       ★ 这些文件 git status --porcelain 看不见（被 .gitignore 吃掉），\n` +
            `         所以「工作区干净」不等于「资产在库里」。\n` +
            `       按优先级（红线回退 > 模块架构 > 项目历史）：\n       ${detail}\n` +
            `       处理：git add 对应路径，或修掉误伤它的 .gitignore 规则。`);
        } else {
          const n = parsed.items.length;
          record('P14', '工作区干净（含 untracked）', 'artifact', 'BLOCK', PASS,
            `三仓 git status --porcelain 均为空；资产普查 ${n} 项全部在库里（逐文件比对，含被 .gitignore 吃掉的那一类）`);
        }
      }
    }
  }

  {
    // ★ P15（2026-10-21 用户定）：进游戏前问一句「这次要不要先打存档快照」。
    //   为什么挂在大门上而不是 stage 里：用户原话「所有挂在的话，基本上就进游戏和退游戏
    //   那两个挂在大门，东西也更加确定性」—— stage 已经没人走了（tasks 目录空）。
    //   为什么重要：「验证会破坏环境」是这轮最大的隐性成本 ——
    //   同一场景想复现只能靠运气，因为每轮验证都在同一个世界上留痕。
    // ★ 2026-10-21 用户纠正定性：**快照是执行 AI 自己的工作副本，不是永久资产**。
    //   用户原话：「不一定自动打，应该是要干活的 AI 知道这个东西的存在，他要用的时候才用，
    //   而且还要主动的删掉，因为这种备份出来的存档实际上可以删掉的，就是他到一定时间
    //   就会主动删掉，就相当于是一个快照，快照的话应该是执行 AI 自己的事。」
    //   所以这里**不是「问用户要不要」，是「告诉 AI 这是你的工具 + 你要负责删」**。
    const snap = path.join(REG.roots.harness, 'bin', 'snapshot-world.js');
    if (!isFile(snap)) {
      record('P15', '存档快照（你的工具，用完自己删）', 'human', 'ask', WARN,
        `快照工具不在（${snap}）—— 想「同一环境反复重跑」就没手段了`);
    } else {
      let statusOut = '';
      try {
        const g = require('child_process').spawnSync(process.execPath, [snap, '--status'], { encoding: 'utf8', timeout: 30000 });
        statusOut = (g.stdout || '').trim();
      } catch { /* ignore */ }
      const none = /没有任何快照/.test(statusOut);
      const expired = /超过 TTL|🟡/.test(statusOut);
      record('P15', '存档快照（你的工具，用完自己删）', 'human', 'ask', ASK,
        `★ 这是**你的工具**，不是等用户批的事。自己判断要不要用：\n` +
        `       这次验证会不会**破坏环境**（挖/丢/改同伴状态）？会 → 打一份再进游戏：\n` +
        `         node "${snap}" --name before-<批次> --apply      （游戏必须已停）\n` +
        `       跑坏了回滚：--restore before-<批次> --apply\n` +
        `       ★ **用完自己删**：快照是工作副本不是资产（每份 30 MB 级），默认 TTL ${'48'} 小时。\n` +
        `         查：--status ｜ 删过期的：--prune --apply\n` +
        (none
          ? `       ⚠ 当前**一个快照都没有** —— 想复现「同一个起点」只能靠运气`
          : (expired
            ? `       🟡 **有过期快照没删** —— 跑 --prune --apply 清掉（别攒着占盘）`
            : `       ✔ 现有快照都在 TTL 内`)) +
        `\n       ★ 为什么：每轮验证都在同一个世界上留痕，不留快照就无法回到同一场景重跑。`);
    }
  }

  builtinChecks(ctx, 'preflight');
}

// ═══════════════════════════════════════════════════════════════════════════
// postflight —— 出游戏之后
// ═══════════════════════════════════════════════════════════════════════════
function postflight(ctx) {
  const { since, keyword, head } = ctx;
  const LIVE = P(REG.roots.live);

  // Q1 有标记
  {
    const active = path.join(R('stager/.stager/active.json'));
    const hasActive = isFile(active);
    let markerNote = '';
    if (hasActive) {
      const a = readText(active);
      const stage = (a.match(/"stage"\s*:\s*"([^"]+)"/) || [, '?'])[1];
      const round = (a.match(/"round"\s*:\s*(\d+)/) || [, '?'])[1];
      markerNote = `active: stage=${stage} round=${round}`;
    }
    record('Q1', '有标记', BLOCK, 'trace', hasActive ? PASS : WARN,
      hasActive ? markerNote + '（★ 还要确认 stager implement --note 已打）' : '没有 .stager/active.json —— 本轮没开 stage');
  }

  // Q2 evidence 已落 + Q3 总结已写 + Q5 记忆图谱已灌 —— 都在 stageDocs 下
  const stageFiles = walk(REG.roots.stageDocs, 4, (n) => /\.md$/.test(n)).filter((f) => freshEnough(f, since));
  const stageTxt = stageFiles.map((f) => readText(f)).join('\n');
  {
    const ev = stageFiles.filter((f) => /evidence|证据/i.test(f));
    const ok = ev.some((f) => hasSignature(readText(f), keyword, head) || ev.length > 0);
    record('Q2', 'evidence 已落盘', BLOCK, 'trace', ev.length ? (ok ? PASS : WARN) : SKIP,
      ev.length ? ev.map((f) => path.basename(f)).join(', ')
                : `本轮 stageDocs 下没有 evidence 文档（新鲜文档共 ${stageFiles.length} 份）`);
  }
  {
    const sum = stageFiles.filter((f) => /experience|经验|code|说明|review|summary|总结/i.test(f));
    record('Q3', '总结已写', BLOCK, 'trace', sum.length ? PASS : WARN,
      sum.length ? sum.map((f) => path.basename(f)).join(', ')
                 : '没找到 experience/code 文档（工程规范第 8 条四件：改了哪/为什么/怎么调的/入口出口）');
  }
  {
    const mem = /memory_create_entities|memory_add_observations/.test(stageTxt);
    record('Q5', '记忆图谱已灌', BLOCK, 'trace', mem ? PASS : WARN,
      mem ? '文档里有记忆写入调用留痕' : '★ 别只写文档不进图谱 —— 空库→查了没用→更不查。至少写明灌了哪几条实体');
  }

  // Q4 ★ 总结写到了正确位置（harness 里不许出现总结）
  {
    const h = P(REG.roots.harness);
    const bad = walk(h, 4, (n) => /\.md$/.test(n))
      .filter((f) => freshEnough(f, since))
      .filter((f) => !/(README|standards)\.md$/i.test(path.basename(f)))
      .filter((f) => /(总结|复盘|报告|经验|evidence|summary|retro)/i.test(path.basename(f)));
    record('Q4', '★ 总结写到了正确位置', BLOCK, 'artifact', bad.length ? BLOCK : PASS,
      bad.length ? `harness 下出现了总结类文件：${bad.map((f) => path.relative(h, f)).join(', ')} —— 总结该进 docsUnified 或 stageDocs`
                 : 'harness 下没有总结类文件（本 harness 只放注册表/门禁/规范/skill）');
  }

  // Q6 三个机器门的结果被记录（不自己跑 —— 跑是别处的职责，这里查「有没有记录」）
  {
    const has = /loop-gate|flow-gate|stager\s+check|VERDICT=/.test(stageTxt);
    const notDoneButExplained = /NOT_DONE[\s\S]{0,200}(预期内|没走 ?stage|未开 ?stage)/.test(stageTxt);
    record('Q6', '三个机器门都过', BLOCK, 'trace', has ? (notDoneButExplained || /VERDICT=LOOP_COMPLETE/.test(stageTxt) ? PASS : WARN) : WARN,
      has ? '本轮文档里记录了机器门结果'
           : '★ 没记录 loop-gate / flow-gate / stager check 的结果。没走 stage 时 NOT_DONE 是预期内的，但要显式写明，不能拿它判定没做完');
  }

  // Q7 ★ 产物真的落地
  {
    const dirs = listDir(path.join(LIVE, 'screenshots'))
      .filter((n) => /^numencam_/.test(n))
      .map((n) => path.join(LIVE, 'screenshots', n))
      .filter((d) => isDir(d) && freshEnough(d, since));
    if (!dirs.length) {
      record('Q7', '产物真的落地', BLOCK, 'artifact', SKIP, '本轮没有 numencam 录像目录（没用 /cam rec 就跳过）');
    } else {
      const d = dirs.sort((a, b) => mtime(b) - mtime(a))[0];
      const pngs = listDir(d).filter((n) => /\.png$/i.test(n));
      const mp4 = listDir(d).filter((n) => /\.mp4$/i.test(n));
      const flog = listDir(d).filter((n) => /ffmpeg/i.test(n)).map((n) => readText(path.join(d, n))).join('\n');
      // ffmpeg 的进度条会在同一行里反复刷新 frame=N（N 递增到总帧数），
      // 所以必须取【最后一次】出现，不能用 String.match（那拿的是第一次 = frame= 0）。
      // 2026-10-04 实测踩过：真值 frame=160，这个检查却读出 frame=0 报假 BLOCK。
      const allFrames = [...flog.matchAll(/frame=\s*(\d+)/g)].map((m) => +m[1]);
      const frames = allFrames.length ? Math.max(...allFrames) : null;
      const bad = !mp4.length || (frames !== null && frames !== pngs.length);
      record('Q7', '产物真的落地', BLOCK, 'artifact', bad ? BLOCK : PASS,
        `${path.basename(d)}: ${pngs.length} 张 png, mp4=${mp4.length ? (fs.statSync(path.join(d, mp4[0])).size + ' B') : '无'}` +
        (frames === null ? ' | ⚠ ffmpeg.log 里没读到 frame=' : ` | ffmpeg frame=${frames} ${frames === pngs.length ? '✔' : '✘ 与 png 张数不等'}`));
    }
  }

  // Q10 游戏已关
  {
    const n = spawnSync('powershell.exe',
      ['-NoProfile', '-Command', "@(Get-Process java -ErrorAction SilentlyContinue).Count"],
      { encoding: 'utf8' }).stdout.trim();
    record('Q10', '游戏已关', WARN, 'artifact', n === '0' ? PASS : WARN,
      n === '0' ? 'java 进程 0' : `★ java 进程还有 ${n} 个，别占内存（用 mc.stop 关，别用 mc-start.js --stop，它是哑弹）`);
  }

  // Q11 人工
  record('Q11', '提交精确、没卷别人', 'ask', 'human', ASK,
    '逐行确认 git status --short，每一行都是你改的。★ rdd-docs 尤其危险（副本同步一次动 147 个文件）');

  // Q12 ★ 用户 2026-10-04 明确要的：退游戏之后必须提示「写记录 + 写文档」。
  //   与 P13 同一族修复：原来也只写进了 registry，postflight 里没有 record()。
  {
    const okDocs = ['测试日志.md', '09-更新日志.md'];
    const moved = okDocs.filter((n) => freshEnough(path.join(REG.roots.docsUnified, n), since));
    // 只认「真·长期资产」：`NN-中文名.md`。日志/索引/台账虽然也是 NN- 开头，但不是资产，
    // 计进去会让「本轮已写 N 份」虚高，反而掩盖「其实一篇都没写」。
    const NOT_ASSET = /更新日志|按主题导航|时间线|README|docs-freshness/;
    const longterm = walk(REG.roots.docsUnified, 1, (n) => /^\d{2}-.*\.md$/.test(n) && !NOT_ASSET.test(n))
      .filter((f) => freshEnough(f, since));
    record('Q12', '写记录 + 写文档', 'ask', 'human', ASK,
      `关游戏之后顺序固定：关游戏 → 写记录 → 写文档 → 门禁。三件必须真动手的：\n` +
      `       ① 写记录：${okDocs.join(' / ')} 各加本轮条目${moved.length ? `（本轮已动：${moved.join(', ')}）` : '（本轮都还没动）'}，条目要带 keyword 或 HEAD 前 12 位作签名，否则机器判不出是你写的\n` +
      `       ② 写文档：长期资产进 ${REG.roots.docsUnified}\\NN-<中文名>.md` +
      `${longterm.length ? `（本轮已写 ${longterm.length} 份：${longterm.slice(0, 3).map((f) => path.basename(f)).join(', ')}${longterm.length > 3 ? ' …' : ''}）` : '（本轮还没写）'}，` +
      `编号接现有最大号往后排，并【同时登记 3 处】：README §二目录表 / 09-更新日志 / 50-按主题导航\n` +
      `       ③ 灌记忆图谱：memory_create_entities / memory_add_observations —— 别只写文档不进图谱\n` +
      `       ★ 机器侧的对应项是 Q2(evidence) / Q3(总结) / Q5(图谱) / Q9(编号三处)，它们绿了不等于你走过上面三步。`);
  }

  // ★ Q13（2026-10-19 新增）：本轮有没有写「实机验证卡」。
  //   用户明确要求：进游戏要留下「收集了什么数据 / 为什么 / 结果 / 验的什么 / 什么时候 / 以后怎么复现」。
  //   判据 = docs/rdd-docs/rdd架构/实机验证/YYYY-MM.md 本轮被改过，且里面有 V- 编号的卡。
  //   级别 WARN 不是 BLOCK：有的轮次确实不进游戏（纯文档/纯编译），那就不该被拦。
  {
    const dir = path.join(REG.roots.docs, '实机验证');
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}.md`;
    const file = path.join(dir, month);
    const exists = fs.existsSync(file);
    const fresh = exists && freshEnough(file, since);
    const text = exists ? fs.readFileSync(file, 'utf8') : '';
    // 卡标题允许 `##` 或 `###`（有人用 h2 当卡片级标题，别因为标题级别判成「0 张卡」）
    const cards = (text.match(/^#{2,3} V-\d{8}-\d{2}/gm) || []).length;
    const filled = (text.match(/\|\s*状态\s*\|\s*(?:✅|❌|🟡)/g) || []).length;
    if (!exists) {
      record('Q13', '实机验证卡', WARN, 'trace', WARN,
        `没有 实机验证/${month} —— 本轮若进过游戏，必须建卡（判据/数据/结果/原因/复现）`);
    } else if (!fresh) {
      record('Q13', '实机验证卡', WARN, 'trace', WARN,
        `本轮没动 实机验证/${month}（现有 ${cards} 张卡）。如果这轮进了游戏 = 漏写；没进游戏可忽略`);
    } else {
      record('Q13', '实机验证卡', WARN, 'trace', filled > 0 ? PASS : WARN,
        `实机验证/${month} 本轮已更新 · ${cards} 张卡 · 已回填结果 ${filled} 张` +
        (filled === 0 ? '（还是待验状态，退游戏后记得填结果/原因/复现）' : ''));
    }
  }

  // ★ Q14（2026-10-20 #087 新增）：验证卡里的「证据坐标」是否指得到东西。
  //   为什么：V-13 引用的原文只在归档 rdd-1792489290677.jsonl 里，主 rdd.jsonl 0 命中，
  //   复查时差点判成「汇报造假」。证据没有坐标 = 每次复查都靠记忆哪个文件。
  //   分两档：
  //     hard（BLOCK 级 → 记 WARN，因为本项不拦收工，但要让它在报告里显眼）
  //       坐标指不到文件 / 行号越界 / 那一行是空行 / 引文在整个文件里找不到
  //     warn（只是缺坐标）
  //       只写文件名没写行号 —— H3 要求补，但不至于拦
  //   级别定 WARN：与 Q13 同口径，避免「今天没验就过不了门」把门禁钉死。
  {
    const dir = path.join(REG.roots.docs, '实机验证');
    const checker = path.join(REG.roots.workspace, 'rdd-selfcompile', 'scripts', 'verify-tools', 'check-evidence-anchor.js');
    const monitor = path.join(REG.roots.mc || 'D:\\rdd\\mc', 'The Best of Twilight Forest', 'config', 'numen', 'monitor');
    if (!fs.existsSync(checker)) {
      record('Q14', '证据坐标', WARN, 'trace', WARN,
        `检查器不存在（${checker}）—— H3 未落地，证据无法对账`);
    } else if (!fs.existsSync(monitor)) {
      record('Q14', '证据坐标', WARN, 'trace', WARN,
        `监测目录不存在（${monitor}）—— 无法核对证据坐标（环境问题，不是债）`);
    } else {
      const r = require('child_process').spawnSync(
        process.execPath,
        [checker, '--cards', dir, '--monitor', monitor, '--json'],
        { encoding: 'utf8', timeout: 60000 }
      );
      let parsed = null;
      try { parsed = JSON.parse(r.stdout || '{}'); } catch { /* 交给下面的降级分支 */ }
      if (!parsed) {
        record('Q14', '证据坐标', WARN, 'trace', WARN,
          `检查器没给出可解析结果（exit=${r.status}）—— 不能当 PASS，也不能当 BLOCK（环境/脚本问题）`);
      } else {
        const hard = parsed.hard || [];
        const warn = parsed.warn || [];
        const brief = (arr) => arr.slice(0, 3).map((x) => `${x.md}:${x.mdLine || '-'} ${x.level}`).join(' · ');
        if (hard.length) {
          record('Q14', '证据坐标', WARN, 'trace', WARN,
            `有 ${hard.length} 条坐标指不到东西/引文不存在（必须修，否则证据是编的）：${brief(hard)}` +
            (hard.length > 3 ? ' …' : '') + `\n       → 详情：node ${checker}`);
        } else if (warn.length) {
          record('Q14', '证据坐标', WARN, 'trace', WARN,
            `坐标可解析，但有 ${warn.length} 处只写文件名没写行号（H3：补成 文件:行号）：${brief(warn)}` +
            (warn.length > 3 ? ' …' : ''));
        } else {
          record('Q14', '证据坐标', WARN, 'trace', PASS, '所有证据坐标都对得上，引文一致');
        }
      }
    }
  }

  // ★ Q15（2026-10-20 #091 自审新增）：债账有没有真的进「下一步（汇总）」表。
  //   为什么：H1 的试金石是「三值化不经提醒自己浮进下一步表」，实测连续为负 ——
  //   完成的批次还挂在 P0、本轮新债一条没进表。这件事靠「我记得」不成立，所以做成机检。
  //   级别定 WARN（不拦收工）：表没刷新是流程债，不是本次证据造假。
  {
    const checker = path.join(REG.roots.workspace, 'rdd-selfcompile', 'scripts', 'verify-tools', 'check-debt-rollup.js');
    if (!fs.existsSync(checker)) {
      record('Q15', '债账入表', WARN, 'trace', WARN,
        `检查器不存在（${checker}）—— H1 未落地，债账仍靠记忆`);
    } else {
      const r = require('child_process').spawnSync(process.execPath, [checker, '--json'],
        { encoding: 'utf8', timeout: 60000 });
      let parsed = null;
      try { parsed = JSON.parse(r.stdout || '{}'); } catch { /* 降级到下面 */ }
      if (!parsed) {
        record('Q15', '债账入表', WARN, 'trace', WARN,
          `检查器没给出可解析结果（exit=${r.status}）—— 不能当 PASS，也不能当 BLOCK`);
      } else {
        const warns = parsed.warn || [];
        if (warns.length === 0) {
          record('Q15', '债账入表', WARN, 'trace', PASS,
            `下一步表已刷新（行=${(parsed.info || {}).openRows}，H 段=${(parsed.info || {}).hasHSection ? '有' : '无'}）`);
        } else {
          record('Q15', '债账入表', WARN, 'trace', WARN,
            warns.map((w) => `${w.code}：${w.detail}`).join('\n       ') +
            `\n       → 详情：node ${checker}`);
        }
      }
    }
  }

  {
    // ★ Q16（2026-10-21 用户定）：退游戏后的「文档书写清单」。
    //   从 stage 的 close 阶段搬过来的 —— 用户原话：
    //   「原本的 stage 就可以差不多废弃和隐藏了，只是说要把我们想要挂在的东西给拉过来，
    //    就比如说那个文档书写，就是退游戏的时候可能要挂在，然后 AI 看到了它就会自己写」。
    //   为什么必须挂在这里：stage 的 tasks 目录是空的（没人走 stage），
    //   挂在 stage 的必读清单等于**从没被执行过**。
    //   级别 ASK：机器判不了「文档写得好不好」，但必须把清单摆在面前。
    record('Q16', '退游戏后的文档书写清单（从 stage 搬来）', 'human', 'ask', ASK,
      `★ 关游戏不是结束。按顺序做完这四件，再开下一轮：\n` +
      `       ① 回填验证卡（判据/数据/结果/**原因**/复现）→ rdd架构\\实机验证\\YYYY-MM.md\n` +
      `       ② 杂项记录加一行 #NNN（三态 + 下一步）→ rdd架构\\杂项记录\\YYYY-MM.md\n` +
      `       ③ 新坑写时间锁（智能性错误必填 guard）→ harness\\registry.json\n` +
      `       ④ 经验实体写进记忆库 → rdd架构\\_memory\\memory.jsonl（append-only，只追加不重写）\n` +
      `       ★ 还有两件容易漏：\n` +
      `         · **快照用完了吗？** 这轮打的存档快照如果不再需要，自己删掉：\n` +
      `             node "D:\\rdd\\harness\\rdd-harness\\bin\\snapshot-world.js" --prune --apply\n` +
      `           （快照是工作副本不是资产，每份 30 MB 级，别攒着占盘）\n` +
      `         · **决策队列里若有事等主人拍板，别自己定了**：\n` +
      `             node "D:\\rdd\\harness\\rdd-harness\\bin\\decide-inbox.js" list --pending`);
  }

  {
    // ★ Q17（2026-10-22 用户批准的补丁 A）：报告放行门禁 —— 未了项必须在报告里有状态。
    //   用户原话：「报告发出前，每个未了项都必须在报告里有状态；漏一个 = 红。」
    //
    //   为什么挂在 postflight 而不是只挂在 goal.js accept：
    //     goal.js accept 只在「有目标锁」时才跑；而日报每天都在写。
    //     只挂 accept = 大部分轮次这条门禁从没执行过 —— 正是 Q1 那天踩过的形态
    //     （「声明在 registry 里却从没被 record() 接线」）。
    //
    //   为什么「没日报」不拦：报告是收工时才落的，一天可能跑好几轮。
    //     没日报 → SKIP（不冒充通过，也不制造假红）；日报存在但漏项 → BLOCK。
    {
      const lib = path.join(__dirname, 'lib', 'report-release.js');
      let r = null;
      try {
        r = require(lib).checkReportRelease();
      } catch (e) {
        r = { ok: false, why: '报告放行门禁加载失败：' + (e && e.message ? e.message : String(e)) };
      }
      if (r.ok) {
        const brief = (r.items || []).map((x) => x.kind + '·' + x.id).join('、');
        record('Q17', '★ 报告放行门禁：未了项必须在报告里有状态', 'block', 'artifact', PASS,
          `报告已放行：${path.basename(r.file || '')}\n` +
          `       核对过的未了项（${(r.items || []).length}）：${brief || '（无）'}`);
      } else if (r.noReport) {
        record('Q17', '★ 报告放行门禁：未了项必须在报告里有状态', 'block', 'artifact', SKIP,
          `今天还没有日报，无法核对未了项（不拦）：${r.why}\n` +
          `       ★ 收工写日报时，记得：待拍板项 → 三行 ②；「还不能用的」表每行都要写「要你做什么」；\n` +
          `         并交代那张卡现在在哪一步（亮没亮）。`);
      } else {
        record('Q17', '★ 报告放行门禁：未了项必须在报告里有状态', 'block', 'artifact', BLOCK, r.why);
      }
    }
  }

  builtinChecks(ctx, 'postflight');
}

// ═══════════════════════════════════════════════════════════════════════════
// 内置检查（不依赖外部工具）：时间锁 + 文档编号
// ═══════════════════════════════════════════════════════════════════════════
function builtinChecks(ctx, phase) {
  const { since } = ctx;
  const sinceStr = since.toISOString().slice(0, 10);
  const now = new Date();

  // 时间锁
  const TL = REG.timeLocks || { locks: [] };
  const due = TL.locks.filter((l) => l.status === 'open' && l.reviewBy && new Date(l.reviewBy) < now);
  if (phase === 'preflight') {
    record('P9', '时间锁未到期', BLOCK, 'artifact', due.length ? BLOCK : PASS,
      due.length
        ? due.map((l) => `${l.id} 「${l.title}」复核日 ${l.reviewBy} 已过`).join(' ; ') + ' —— 要么复核，要么显式续期并写理由'
        : `${TL.locks.length} 条锁，${TL.locks.filter((l) => l.status === 'open').length} 条 open，均未到期`);
  } else {
    const ymd = new Date().toISOString().slice(0, 10);
    const hit = TL.locks.filter((l) => (l.detected === ymd || (l.reviewBy && l.reviewBy >= ymd)));
    const said = /无新的智能性错误|无新的智能性错误|没有新的智能性/.test(ctx.stageTxt || '');
    record('Q8', '★ 时间锁已更新', BLOCK, 'trace', (hit.length || said) ? PASS : BLOCK,
      hit.length ? `今天有锁命中：${hit.map((l) => l.id).join(', ')}`
                 : said ? '文档里写明「本轮无新的智能性错误」'
                        : '★ 本轮既没新增时间锁，也没写明「无新的智能性错误」。看起来做了/回执成功/静默通过但实际没生效 —— 那就是智能性错误，必须留一条带 guard 的锁');
  }

  // 文档编号
  // ★ 铁律（S-DOC-03）：**已知旧撞号一律 WARN，只有本轮新增的撞号才 BLOCK。**
  //   理由：一次旧债就把门禁永久钉死，门禁一旦被长期忽略就等于没有。
  //   65/66 这种「未登记台账的撞号」也是旧债 → WARN + 提示补登记，不 BLOCK。
  {
    const dir = REG.docNumbers.root;
    const legacy = new Set([...(REG.docNumbers.legacyDuplicateWarn || []), ...(REG.docNumbers.legacyDuplicateBlock || [])]
      .map(Number));
    const unregisteredDup = new Set((REG.docNumbers.legacyDuplicateBlock || []).map(Number));
    const byNo = new Map();
    const noHyphen = [];
    for (const n of listDir(dir)) {
      if (!/\.md$/.test(n) || n.startsWith('_') || n === 'README.md') continue;
      const m = n.match(REG.docNumbers.pattern);
      if (!m) {
        // 盲区：有数字但缺连字符 → 整个逃过编号检查
        const m2 = n.match(/^(\d{2})[^-\w]/);
        if (m2) noHyphen.push(`${n}（建议改名 ${m2[1]}-xxx.md，或去掉开头数字）`);
        continue;
      }
      const no = m[1];
      if (!byNo.has(no)) byNo.set(no, []);
      byNo.get(no).push(n);
    }
    const dupNew = [], dupOld = [];
    for (const [no, arr] of byNo) {
      if (arr.length < 2) continue;
      const tag = `${no}(${arr.join(' + ')})`;
      if (legacy.has(+no)) dupOld.push(tag + (unregisteredDup.has(+no) ? ' ← 未登记台账，顺手补一下' : ''));
      else dupNew.push(tag);
    }
    const maxNo = Math.max(...[...byNo.keys()].map((n) => +n));
    record('P10', '文档编号不新增撞号', BLOCK, 'artifact', dupNew.length ? BLOCK : PASS,
      `${byNo.size} 个编号，最大 ${maxNo}（registry.nextDocNo=${REG.docNumbers.nextDocNo}，★ 别信这个缓存值，现场重扫）` +
      (dupNew.length ? ' | ✘ 本轮新增撞号: ' + dupNew.join(' ; ') : ' | 无新增撞号') +
      (dupOld.length ? ' | 已知旧撞号(WARN): ' + dupOld.join(' ; ') : ''));

    if (noHyphen.length) {
      record('P10b', '文档编号格式', WARN, 'artifact', WARN,
        `${noHyphen.join(' ; ')} —— 缺连字符，整个逃过编号检查。这是【历史文件】，不拦，但下次动它时顺手改名。`);
    }

    // ★ P10d（2026-10-22）：**取号必须走集中分配处**，否则并行会话必然撞号。
    //   背景（实测根因，不是猜测）：编号撞了 8 个（44/45/48/52/53/54/65/66）。
    //   现行规矩只说「接最大号往后排」= 每个写入方自己扫目录 → 并行会话同时扫到同一号 → 撞。
    //   registry 的 legacyNotes 第 1 条自述就是这个：「65/66 是并行会话互相撞的」。
    //   而 registry.docNumbers.nextDocNo 是缓存（停在 75，实际最大 76）且自述「别信这个缓存值」，
    //   台账 docs-freshness.json 里也没有任何预留字段 —— 即【没有单一真源】。
    //   ⇒ 修法是给号源一个地方：bin/docno-alloc.js（先占后建，落台账 allocations）。
    //   本项只查「本轮新建的编号文档是不是从取号处来的」，不查内容质量。
    {
      const ledgerPath2 = REG.docNumbers.ledger;
      let allocNos = null;
      if (isFile(ledgerPath2)) {
        try {
          const led = JSON.parse(readText(ledgerPath2).replace(/^﻿/, ''));
          allocNos = new Set((led.allocations || []).map((a) => Number(a.no)).filter(Number.isFinite));
        } catch { allocNos = null; }
      }
      if (allocNos === null) {
        // 台账还没有 allocations 段 —— 说明还没启用集中取号（旧债，不拦）
        record('P10d', '编号走集中取号处', WARN, 'artifact', WARN,
          '台账还没有 allocations 段 —— 集中取号处（bin/docno-alloc.js）还没启用。' +
          '本轮新建编号文档仍可能撞号（并行会话各自扫目录）。这是【新机制未启用】，不拦。');
      } else {
        // ★ 只管【本轮动过】的编号文档：历史文件全部没走过取号处，不能一次性全红
        const freshNums = [...byNo.entries()]
          .filter(([, arr]) => arr.some((nm) => freshEnough(path.join(REG.roots.docsUnified, nm), since)))
          .map(([no]) => Number(no));
        const bypass = freshNums.filter((n) => !allocNos.has(n));
        // ★ 只卡「本轮新建」（号靠近当前最大号 = 刚建的）而不是所有本轮改过的历史文件
        record('P10d', '编号走集中取号处', WARN, 'artifact', bypass.length ? WARN : PASS,
          bypass.length
            ? `★ 本轮动过但没从取号处分配过的号：${bypass.join(' , ')} —— 新建编号文档请先跑 ` +
              `\`node D:\\rdd\\harness\\rdd-harness\\bin\\docno-alloc.js next\`（先占号再建文件），` +
              `否则并行会话会各扫各的目录、各拿同一个号。`
            : `本轮动过的编号 ${freshNums.join(' , ') || '无'} 均从取号处分配 ✔（台账 allocations ${allocNos.size} 条）`);
      }
    }

    // 未登记台账（UNREGISTERED）—— 债，但不是永久的，补登记就行 → WARN
    const ledgerPath = REG.docNumbers.ledger;
    if (isFile(ledgerPath)) {
      let ledger = null;
      try { ledger = JSON.parse(readText(ledgerPath).replace(/^﻿/, '')); } catch { /* 台账坏了不归本门禁管 */ }
      if (ledger && Array.isArray(ledger.docs)) {
        const known = new Set(ledger.docs.map((d) => d.file));
        const unreg = [...byNo.values()].flat().filter((n) => !known.has(n));
        record('P10c', '文档已登记台账', WARN, 'artifact', unreg.length ? WARN : PASS,
          unreg.length
            ? `${unreg.length} 份未登记 docs-freshness.json：${unreg.slice(0, 6).join(', ')}${unreg.length > 6 ? ' …' : ''} —— 补登记（node verify-tools/check-doc-freshness.js 会列全）`
            : `${byNo.size} 份编号文档全部在台账里`);
      }
    }

    // Q9 登记三处
    if (phase === 'postflight') {
      const targets = REG.docNumbers.registerIn.map((p) => ({
        raw: p,
        // ★ registry 的 registerIn 每项后面可能带给人看的补注（如 `README.md §二目录表`）。
        // 直接拿整串当路径用 isFile() 判 → 永远 false → bodies 全是空串 → Q9 永远报「没登记」。
        // 这就是 2026-10-04 首跑 Q9 BLOCK 的根因（和 P4/P10/Q9 之前那几个同类的「门禁自己的缺陷」）。
        // 修法：路径取第一个空格/§/（ 之前的部分，补注仍然保留在 raw 里只用于报错文案。
        file: p.split(/[ §（(]/)[0].trim(),
      }));
      const bodies = targets.map((t) => (isFile(t.file) ? readText(t.file) : ''));
      const unreadable = targets.filter((t) => !isFile(t.file)).map((t) => t.file);
      if (unreadable.length) missing.push(`★ 注册表里的登记目标读不到：${unreadable.join(' ; ')}（registry.docNumbers.registerIn 路径写错了，不是「没登记」）`);
      const freshNames = [...byNo.entries()]
        .filter(([no]) => String(no) === String(REG.docNumbers.nextDocNo) || +no >= maxNo - 2)
        .flatMap(([, arr]) => arr);
      const missing = [];
      for (const nm of freshNames) {
        targets.forEach((t, i) => {
          if (!bodies[i].includes(nm)) missing.push(`${path.basename(t.file)} 缺 ${nm}`);
        });
      }
      // ★ 只对【本轮动过】的文档 BLOCK。没动过的历史债不拦 —— 否则一次旧债就把门禁
      // 永久钉死，门禁一旦被长期忽略就等于没有（与 P10/P10c 同一原则）。
      // 2026-10-04 实测：67/68/69 是 10-03 别人建的、一直没登记三处，
      // 若一律 BLOCK 则本轮（跟编号无关）永远过不了。
      const mine = freshNames.filter((nm) => freshEnough(path.join(REG.roots.docsUnified, nm), since));
      const blocking = mine.filter((nm) => missing.some((s) => s.endsWith(nm)));
      const inherited = missing.length - blocking.length;
      const detail = missing.length ? missing.join(' ; ') : `最近几份（${freshNames.join(', ') || '无'}）在三处索引里都能找到`;
      record('Q9', '编号登记三处', BLOCK, 'artifact',
        blocking.length ? BLOCK : (missing.length ? WARN : PASS),
        blocking.length
          ? `★ 本轮新建的 ${blocking.join(', ')} 没登记三处 → 必须补（长期资产进 docsUnified 要同时登记 README §二目录表 / 09-更新日志 / 50-按主题导航）` +
            (inherited > 0 ? `｜另有 ${inherited} 条是历史债，本轮没动这些文档，不拦` : '')
          : (missing.length ? `${detail}｜★ 全部是历史债（本轮没动这些文档），不拦；顺手补了更好` : detail));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── selftest ──────────────────────────────────────────────────────────────
// 门禁自己也会错，而且错得很安静（时间锁 TL-2026-10-04-01 就是：Q7 用 String.match
// 取 ffmpeg 进度条的第一个 frame=0，真值是 160，报了假 BLOCK）。
// 所以门禁需要一个「体检自己」的入口：环境类问题一律 exit 3，不跟债混在一起。
function runSelftest() {
  const R = [];
  let bad = 0;
  const chk = (name, ok, note) => { R.push(`  ${ok ? '✔' : '✘'} ${name}${note ? '  —— ' + note : ''}`); if (!ok) bad++; };

  // 1. 注册表结构：门禁代码里读到的每个字段都必须存在（缺字段会在跑到那一项时才炸）

  // ★★★ 1a. 【声明 ≠ 接线】自检：registry 里每一条门禁项都必须在代码里被 record() 过。
  // 这是 2026-10-04 首跑事故的直接补丁：P11/P12/P13/Q12 当时只写进了 registry.json，
  // 代码里一次 record() 都没有 —— 于是「进游戏前提醒你过一遍游戏内能力清单」这条
  // 用户明确要求的门禁，跑出来 12 行里根本没有它，而且**没人发现**，因为
  // `registry` 模式只查 tools/时间锁/bugs 的完整性，从不查门禁项是否被接线。
  // 与 bug-10 同一族：一条看起来在守的纪律，从没被执行过一次。
  {
    // ⚠ gates.preflight 是 `{ $comment, when, checks: [...] }`，不是数组本身。
    //   （与 REG.timeLocks / REG.routing / REG.bugs 同一个坑，我在这上面栽过两次。）
    const declared = [...REG.gates.preflight.checks, ...REG.gates.postflight.checks].map((c) => c.id);
    const src = readText(__filename);
    const wired = declared.filter((id) => src.includes("record('" + id + "'"));
    const unwired = declared.filter((id) => !wired.includes(id));
    chk(`声明的门禁项都已接线（${wired.length}/${declared.length}）`, unwired.length === 0,
      unwired.length ? '★ registry 里声明了但代码从没 record() 过 —— 等于没有这一项：' + unwired.join(', ') : 'preflight + postflight 全部接上了');
  }
  const paths = [
    ['roots.workspace', REG.roots.workspace], ['roots.docs', REG.roots.docs],
    ['roots.docsUnified', REG.roots.docsUnified], ['roots.numen', REG.roots.numen],
    ['roots.scripts', REG.roots.scripts], ['roots.live', REG.roots.live],
    ['roots.stageDocs', REG.roots.stageDocs], ['roots.harness', REG.roots.harness],
  ];
  for (const [k, v] of paths) chk(`registry ${k}`, typeof v === 'string' && v.length > 0, v);
  {
    // ★ 2026-10-19：root 相对化自检。注册表里再出现 `D:\rdd\...` 就是搬家必炸的隐患。
    const absRoots = Object.entries(REG.rootsRaw).filter(([, v]) => path.isAbsolute(String(v))).map(([k]) => k);
    chk('registry roots 已相对化', absRoots.length === 0,
      absRoots.length ? '★ 这些还是绝对路径，换机器/换目录会静默指错：' + absRoots.join(', ')
                      : `RDD 根=${REG._meta.root}（${REG._meta.envApplied ? '来自 ' + REG._meta.envName : '由 rootAnchor ' + REG._meta.anchor + ' 推出'}）`);
    const dnAbs = ['root', 'ledger'].filter((k) => REG.docNumbersRaw && path.isAbsolute(String(REG.docNumbersRaw[k] || '')));
    chk('registry docNumbers 已相对化', dnAbs.length === 0, dnAbs.join(',') || 'OK');
  }
  chk('registry routing 铁律', Array.isArray(REG.routing.rule) && REG.routing.rule.length >= 4, `${((REG.routing || {}).rule || []).length} 条`);
  chk('registry tools', Array.isArray(REG.tools) && REG.tools.length > 0, `${(REG.tools || []).length} 个`);
  const tids = new Set((REG.tools || []).map((t) => t.id));
  chk('tools id 无重复', tids.size === (REG.tools || []).length, `${tids.size}/${(REG.tools || []).length}`);
  // 工具路径自检 —— ★ 这项专门抓「空头支票」（注册表里写了、文件却不存在）。
  //   2026-10-04 首跑抓到 7 条，其中 3 条是注册表把路径写成了 `.../xxx` 省略号
  //   （文件其实在），4 条是相对路径没解析（harness/ 与 live/ 前缀）。
  //   相对路径要按 roots 依次试；inGameCommand 的条目（游戏内指令，不是文件）跳过。
  const resolveTool = (p) => {
    if (path.isAbsolute(p)) return p;
    // ★ harness/ 与 rddharness/ 两个前缀都剥 —— 两个都出现在注册表里（cam.sendCommand 写 harness/，
    //   os.wallpaper* 写 rddharness/）。原来只剥 harness/，于是 rddharness/ 那两条被判「路径不存在」，
    //   而文件明明在 D:\rdd\harness\rdd-harness\ 下面。
    //   ★ 这是 bug-9/bug-10 同类的第 6 例：门禁自己的缺陷长得像「门禁在正确地报债」。
    //   判别标准（别再犯）：报「不存在」之前，先把三个候选路径都打出来看一遍。
    const bare = p.replace(/^(?:rdd)?harness[\\/]/, '');
    const cands = [
      path.join(REG.roots.workspace, p),
      path.join(REG.roots.harness, bare),
      path.join(REG.roots.live, p.replace(/^live[\\/]/, '')),
      // ★ 2026-10-19：补第 4 个候选 = RDD 根。`tools/` 是顶层目录（工具链、mcp-memory），
      //   既不在 workspace 也不在 harness 下面，前三个候选必然落空 → 又被误报成「空头支票」。
      //   同类第 7 例。判别标准不变：报「不存在」之前先把候选路径都打出来看一遍。
      path.join(REG._meta.root, p),
    ];
    return cands.find((c) => isFile(c)) || cands[0];
  };
  let checked = 0, skipped = 0;
  for (const t of REG.tools || []) {
    if (t.inGameCommand) { skipped++; continue; }
    checked++;
    if (!isFile(resolveTool(t.path))) chk(`tools[${t.id}] 路径存在`, false, t.path);
  }
  chk('tools 路径全部落地（无空头支票）', true, `查了 ${checked} 个 · 跳过 ${skipped} 个游戏内指令条目`);
  const badSide = (REG.tools || []).filter((t) => !['build', 'read', 'run', 'write', 'writeGame', 'writeMods'].includes(t.side));
  chk('tools side 取值合法', badSide.length === 0, badSide.map((t) => t.id).join(',') || 'OK');

  // 2. 时间锁：★ 必须每条都带 guard（「没有 guard 的锁等于没有锁，只是抱怨」）
  //    注意 timeLocks 是 { $comment, policy, locks:[…] }，不是数组 —— 2026-10-04 写错过一次
  for (const L of (REG.timeLocks.locks || [])) {
    chk(`锁 ${L.id} 带 guard`, typeof L.guard === 'string' && L.guard.length > 0, L.title);
    chk(`锁 ${L.id} 有 reviewBy`, !!L.reviewBy, String(L.reviewBy));
  }

  // 3. 文档编号台账文件在不在
  chk('docNumbers.ledger 存在', isFile(REG.docNumbers.ledger), REG.docNumbers.ledger);

  // 4. 工具函数自测
  const tmp = path.join(require('os').tmpdir(), `harness-selftest-${process.pid}.txt`);
  fs.writeFileSync(tmp, 'x'.repeat(100), 'utf8');
  chk('mtime() 读到刚写的文件', mtime(tmp) > 0);
  chk('walk() 能找到它', walk(path.dirname(tmp), 1, (n) => n.endsWith('.txt')).includes(tmp));
  chk('hasSignature() 对无签名返回 false', hasSignature('no keyword here', 'camera', 'a91f2710') === false);
  chk('hasSignature() 对含 keyword 返回 true', hasSignature('keyword camera here', 'camera', 'a91f2710') === true);
  chk('hasSignature() 对含 head 前 12 位返回 true', hasSignature('built at a91f27105538', 'zzz', 'a91f27105538cef5') === true);
  try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不算门禁错 */ }

  // 5. git 能用（preflight P5 依赖）
  const g = git(REG.roots.numen, ['rev-parse', '--short', 'HEAD']);
  chk('git 可用（numen 仓库）', g.code === 0, (g.out || '').trim() || g.err);

  // 6. ★ ffmpeg frame= 解析回归：ffmpeg 进度条会在一行里刷多个 frame=，
  //    必须取最大值而不是第一个（TL-2026-10-04-01 的 guard 就挂在这儿）
  const fake = 'frame=    0 fps=0.0 q=-1.0 size=N/A time=-\r\nframe=   32 fps=62 q=-1.0\r\nframe=  160 fps=62 q=-1.0 Lsize=769KiB\r\n';
  const seen = [...fake.matchAll(/frame=\s*(\d+)/g)].map((m) => +m[1]);
  chk('ffmpeg frame= 取最大值而非第一个', Math.max(...seen) === 160, `读到 ${JSON.stringify(seen)}`);

  console.log('══════════ RDD harness 门禁 · SELFTEST（体检门禁自身）═══════════');
  // ★ 2026-10-22：selftest 绿 ≠ 门禁绿，两个必须在输出里分清。
  //   用户原话：「体检和日报里每个『绿』必须注明是 selftest 绿还是 实跑绿。」
  //   实测踩过：把 selftest 的「5 个都绿」当成 verify-tools 全绿汇报，
  //   而实跑 check-doc-freshness 当时有 10 个 BLOCK。
  //   判别标准（别再犯）：selftest 证明的是「门禁代码本身没坏」，
  //   **不证明「工程没债」**。后者只有实跑 preflight/postflight 才知道。
  console.log('  ⚠ 这是【selftest 绿】= 门禁自身健康，不代表工程没债。');
  console.log('    要判「这一轮干得干不得」必须实跑 preflight / postflight。');
  console.log(`  规范源 ${REG.standards.source}`);
  console.log(`  时间锁 ${(REG.timeLocks.locks || []).length} 条 · 工具 ${(REG.tools || []).length} 个`);
  console.log('');
  R.forEach((l) => console.log(l));
  console.log('');
  console.log(`  FAIL=${bad}`);
  console.log(bad === 0
    ? '  VERDICT=SELFTEST_OK（门禁自身健康；环境问题请看 exit 3）'
    : '  VERDICT=SELFTEST_FAIL（门禁自己有 bug —— 这是环境错 exit 3，不是债）');
  return bad === 0 ? 0 : 3;
}

function printHeader(phase) {
  const g = phase === 'preflight' ? REG.gates.preflight : REG.gates.postflight;
  console.log('════════════════════════════════════════════════════════════');
  console.log(` RDD harness 门禁 · ${phase.toUpperCase()}   （${g.when}）`);
  console.log('════════════════════════════════════════════════════════════');
  console.log(` 注册表 ${REG.version} · 工具 ${REG.tools.length} · 规范源 ${path.basename(REG.standards.source)} · 时间锁 ${REG.timeLocks.locks.length}`);
  console.log('');
}

function printResults() {
  const ICON = { PASS: '✔', WARN: '!', BLOCK: '✘', SKIP: '-', ASK: '☞' };
  for (const r of results) {
    const tag = r.state;
    console.log(`${ICON[r.state]} ${r.id.padEnd(5)} ${r.name.padEnd(22)} [${r.kind}/${r.level}] ${tag}`);
    if (r.detail) console.log(`        ${r.detail}`);
  }
  console.log('');
}

function verdict() {
  const nb = results.filter((r) => r.state === BLOCK).length;
  const nw = results.filter((r) => r.state === WARN).length;
  const np = results.filter((r) => r.state === PASS).length;
  const ns = results.filter((r) => r.state === SKIP).length;
  const na = results.filter((r) => r.state === ASK).length;
  console.log('────────────────────────────────────────────────────────────');
  console.log(` PASS=${np}  WARN=${nw}  BLOCK=${nb}  SKIP=${ns}  ASK=${na}`);
  console.log(` VERDICT=${nb === 0 ? 'PASS' : 'BLOCKED'}`);
  if (nb) {
    console.log('');
    console.log(' ✘ BLOCK 项必须处理完才能进/出游戏：');
    for (const r of results.filter((x) => x.state === BLOCK)) console.log(`   · ${r.id} ${r.name}`);
  }
  // ★ ASK 段落：机器判不了、但**必须由人点头**的项。永远打印，不参与 BLOCK 计数。
  // 「永远打印」是这个状态存在的全部意义 —— 声明在 registry 里却没接上的检查，
  // 表现就是这一段空着，而空着没人看（2026-10-04 首跑的真实事故）。
  if (na) {
    console.log('');
    console.log(' ☞ 下面这些机器判不了，【必须你亲自过一遍并点头】，过了才动游戏：');
    for (const r of results.filter((x) => x.state === ASK)) {
      console.log(`   · ${r.id} ${r.name}`);
      if (r.detail) console.log(`       ${r.detail}`);
    }
  }
  if (nw) {
    console.log('');
    console.log(' ! WARN 项建议看一眼（不拦，但都是「继承红」）：');
    for (const r of results.filter((x) => x.state === WARN)) console.log(`   · ${r.id} ${r.name}`);
  }
  return nb === 0 ? 0 : 1;
}

function registrySummary() {
  console.log('══════════ RDD harness 注册表 ══════════');
  console.log(` 版本 ${REG.version} · 更新于 ${REG.updated}`);
  console.log(` 根：${REG.roots.harness}`);
  console.log('');
  const bySide = {};
  for (const t of REG.tools) bySide[t.side] = (bySide[t.side] || 0) + 1;
  console.log(` 工具 ${REG.tools.length} 个，按副作用：`);
  for (const k of Object.keys(bySide).sort()) console.log(`   ${String(bySide[k]).padStart(3)} × ${k}`);
  console.log('');
  console.log(' 门禁：');
  for (const p of ['preflight', 'postflight']) {
    const cs = REG.gates[p].checks;
    console.log(`   ${p.padEnd(11)} ${cs.length} 项（${cs.filter((c) => c.kind === 'artifact').length} 查实物 / ` +
      `${cs.filter((c) => c.kind === 'trace').length} 查痕迹 / ${cs.filter((c) => c.kind === 'human').length} 人工）`);
  }
  console.log('');
  console.log(` 时间锁 ${REG.timeLocks.locks.length} 条（open ${REG.timeLocks.locks.filter((l) => l.status === 'open').length}）`);
  console.log(` 历史 bug ${REG.bugs.list.length} 个`);
  console.log('');
  console.log(' 下一站：');
  console.log(`   规范（唯一真源）  ${REG.standards.source}`);
  console.log(`   规范（人读镜像）  ${REG.standards.mirror}`);
  console.log(`   详细索引  ${path.join(REG.roots.harness, '工具总索引-20261003', '70-工具总索引-编译·进游戏验证·相机·OpenClaw-20261003.md')}`);
  console.log('');
}

// ── main ─────────────────────────────────────────────────────────────────
function main() {
  loadRegistry();
  const mode = process.argv[2] || 'help';
  if (mode === 'registry') { registrySummary(); return 0; }
  if (mode === 'help' || mode === '--help') {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, '').replace(/^ \* ?/gm, ''));
    return 0;
  }
  if (mode !== 'preflight' && mode !== 'postflight' && mode !== 'selftest') {
    console.error('未知模式：' + mode + '（用 preflight / postflight / selftest / registry）');
    return 3;
  }
  if (mode === 'selftest') return runSelftest();
  const since = today();
  const ctx = {
    since,
    keyword: arg('--keyword', 'numencam'),
    head: arg('--head', ''),
    stageTxt: '',
  };

  // stageDocs 正文（postflight 的签名/记忆判据要用）
  ctx.stageTxt = walk(REG.roots.stageDocs, 4, (n) => /\.md$/.test(n))
    .filter((f) => freshEnough(f, since)).map((f) => readText(f)).join('\n');

  printHeader(mode);
  if (mode === 'preflight') preflight(ctx); else postflight(ctx);
  printResults();
  return verdict();
}

try { process.exit(main()); }
catch (e) {
  console.error('门禁自身崩了（这不是门禁结果，是 bug）：' + (e && e.stack || e));
  process.exit(3);
}