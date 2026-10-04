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

const HARNESS = path.resolve(__dirname, '..');
const REGISTRY = path.join(HARNESS, 'registry.json');

// ── 小工具 ───────────────────────────────────────────────────────────────
const J = (p) => path.join(...p.split('/').map((s) => s.replace(/\\/g, path.sep)));
const R = (rel) => path.join(J(REG.roots.workspace), rel);
const P = (p) => path.join(p);

function loadRegistry() {
  const raw = fs.readFileSync(REGISTRY, 'utf8').replace(/^﻿/, '');
  REG = JSON.parse(raw);
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

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 << 20 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
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
    record('P11', '规则没打架', BLOCK, 'artifact', bad.length ? BLOCK : PASS,
      bad.length
        ? `check-align exit=${align.status} / check-global exit=${glb.status} —— 规则文件之间有冲突或指针失效，先修那个再动游戏`
        : `check-align 0 · check-global 0（外层 AGENTS.md / rddharness\\stage.md / 全局指针卡 三层分工一致）`);
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
    const bare = p.replace(/^harness[\\/]/, '');   // 注册表里的 harness/ 前缀是相对于 harness 根的
    const cands = [
      path.join(REG.roots.workspace, p),
      path.join(REG.roots.harness, bare),
      path.join(REG.roots.live, p.replace(/^live[\\/]/, '')),
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