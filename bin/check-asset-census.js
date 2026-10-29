#!/usr/bin/env node
'use strict';
/*
 * check-asset-census.js —— 资产普查（76 号 §2 的补充检查）
 *
 * 用户 2026-10-21 定：
 *   「全景文档就是现成的应跟踪清单，以后每个 tag 对一遍『清单上有 vs git 里有』，
 *    差距为零才许打。这次 26 项的发现应该变成例行检查，而不是靠哪次清扫顺手动好运。」
 *
 * 为什么需要它（这条债所有既有门禁都抓不住）：
 *   门禁原来盯的全是「改动过的文件」，没人盯「从来没被跟踪的文件」。
 *   26 项文档资产 + 44 个 harness 文件就是这么攒了几周 ——
 *   治理层自己的器官（红线回退索引、七类格式规范、memory.jsonl）一直在裸奔。
 *   迁移指南本身没入库更是一句黑色幽默：真盘坏了，连「怎么迁移」都查不到。
 *
 * 判定：清单上每一项都必须被 git 跟踪（ls-files 非空）。不检查内容，只检查「在不在库里」。
 *
 * ★ 2026-10-22 加固（原来只判「目录非空」，是假阴性）：
 *   原实现对目录型条目只问「ls-files 非空吗」—— 一个目录里 12 个文件已跟踪、
 *   另 1 个文件裸奔，它照样判 OK。这正是用户点名的三个「零机检位置」
 *   （红线回退 > 模块架构 > 项目历史）看起来干净、实际没人盯的原因。
 *   现在改成**逐文件比对**：磁盘上递归枚举的每一个文件都必须在 ls-files 里，
 *   少一个就报裸奔（并把文件名列出来）。目录型条目额外报 tracked/裸奔计数。
 *
 * ★ 路径来源：原来硬编码 `D:\rdd`，换机/换目录就静默指空。
 *   现在走 registry.json（registryLib.load()），跟其他 harness 脚本一致。
 *
 * 用法：
 *   node check-asset-census.js            # 查默认清单
 *   node check-asset-census.js --json
 *   node check-asset-census.js --selftest
 *
 * 退出码：0 全跟踪 / 2 有裸奔资产 / 3 环境错
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const registryLib = require('./lib/registry.js');

const REG = registryLib.load();
const GIT = 'C:\\Users\\admin\\AppData\\Local\\Programs\\MinGit\\cmd\\git.exe';
const DOCS = path.resolve(REG.roots.docs, '..');
const HARNESS = REG.roots.harness;

// 应跟踪清单（与 全景文档 §六 一致）
const CENSUS = [
  { repo: DOCS, p: 'rdd架构/_memory/memory.jsonl', why: 'MCP 记忆库：跨会话唯一经验载体（414 实体）' },
  { repo: DOCS, p: 'rdd架构/_格式规范.md', why: 'rdd架构 根格式规范' },
  { repo: DOCS, p: 'rdd架构/代码解释/', why: '跨模块代码↔意图绑定' },
  { repo: DOCS, p: 'rdd架构/模块架构/', why: '每模块七节 + §8 绑定' },
  { repo: DOCS, p: 'rdd架构/红线回退/', why: '红线 tag → 回退点索引（治理层器官）' },
  { repo: DOCS, p: 'rdd架构/项目历史/', why: '大事记（时间/为什么/代价）' },
  { repo: DOCS, p: 'rdd架构/杂项记录/', why: '债账 #NNN' },
  { repo: DOCS, p: 'rdd架构/运维/', why: '起停/端口/备份/救火' },
  { repo: DOCS, p: 'rdd架构/实机验证/', why: '验证卡（判据/证据/结果）' },
  { repo: DOCS, p: 'rdd架构/自编译统一版/_格式规范.md', why: '编号文档规范' },
  { repo: DOCS, p: 'rdd存放/_格式规范.md', why: '给老板看的东西的写法' },
  { repo: HARNESS, p: 'bin/', why: 'harness 脚本（门禁/审计/goal）' },
  { repo: HARNESS, p: 'multimodel/', why: '多模型协同模块' },
  { repo: HARNESS, p: 'registry.json', why: '工具注册表（机器真源）' },
  { repo: HARNESS, p: 'standards.md', why: '编程规范（机器真源）' },
];

const EXIT_OK = 0, EXIT_BAD = 2, EXIT_USAGE = 3;

/**
 * ★ 2026-10-29（A0 批次）：显式豁免 —— 「清单说必须入库」与「.gitignore 明确不入库」打架时，
 *   不许任何一边静默生效。豁免必须带理由，而且**每次输出都打印**（不是藏起来）。
 *   为什么不做成「自动跟随 .gitignore」：那等于让 .gitignore 一句话就能让治理资产零机检，
 *   正是这份普查存在的理由（见文件头 26 项 / 44 文件）。
 */
const EXEMPT = [
  {
    repo: 'HARNESS', p: 'bin/run-curve.ps1',
    why: '.gitignore:19-21 明确「本机启动脚本，默认 --Goal 指向会话 .tmp，换机就跑不了 → 不入库」；'
      + '与 bin/ 全跟踪冲突。豁免而非隐藏：每次普查都打印这一条。',
  },
];

// ★ git ls-files 默认把非 ASCII 路径转义成八进制（"rdd\346\250..."），
//   跟磁盘上的真实路径比不上 —— 这是个假阳性陷阱（实测踩过）。
//   必须 -c core.quotepath=false 拿真实路径。
function lsFiles(repo, p) {
  const g = spawnSync(GIT, ['-C', repo, '-c', 'core.quotepath=false', 'ls-files', '--', p],
    { encoding: 'utf8', timeout: 30000 });
  if (g.status !== 0) return null;
  return (g.stdout || '').split(/\r?\n/).filter(Boolean).map((s) => s.replace(/\\/g, '/'));
}

// 磁盘上递归枚举文件（相对 repo，正斜杠）。跳过 .git 目录。
function walkDisk(repo, rel) {
  const out = [];
  const abs = path.join(repo, rel);
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const childRel = (rel + '/' + e.name).replace(/^\/+/, '');
    if (e.isDirectory()) {
      const sub = walkDisk(repo, childRel);
      if (sub === null) return null;
      out.push(...sub);
    } else {
      out.push(childRel);
    }
  }
  return out;
}

function run() {
  const results = [];
  for (const c of CENSUS) {
    const isDir = /\/$/.test(c.p);
    if (!fs.existsSync(path.join(c.repo, c.p.replace(/\/$/, '')))) {
      results.push({ ...c, status: 'MISSING', count: 0, bare: [], detail: '磁盘上不存在' });
      continue;
    }
    const files = lsFiles(c.repo, c.p);
    if (files === null) { results.push({ ...c, status: 'GIT_ERR', count: 0, bare: [], detail: 'git 不可用' }); continue }

    if (!isDir) {
      // 单文件：ls-files 命中即算在库
      if (files.length === 0) results.push({ ...c, status: 'UNTRACKED', count: 0, bare: [c.p], detail: '磁盘有、git 没有（裸奔）' });
      else results.push({ ...c, status: 'OK', count: files.length, bare: [], detail: `${files.length} 个文件已跟踪` });
      continue;
    }

    // ★ 目录型：逐文件比对 —— 磁盘上每个文件都必须在 ls-files 里。
    //   原来的「非空即过」是假阴性：一个目录里 12 个已跟踪 + 1 个裸奔照样判 OK。
    const disk = walkDisk(c.repo, c.p.replace(/\/$/, ''));
    if (disk === null) { results.push({ ...c, status: 'MISSING', count: 0, bare: [], detail: '磁盘上不存在' }); continue }
    const trackedSet = new Set(files);
    const bareAll = disk.filter((f) => !trackedSet.has(f)).sort();
    // 显式豁免（带理由，逐次打印），其余裸奔一律照报
    const exemptHits = bareAll.filter((f) => EXEMPT.some((e) => e.p === f
      && (e.repo === 'HARNESS' ? c.repo === HARNESS : c.repo === DOCS)));
    const bare = bareAll.filter((f) => !exemptHits.includes(f));
    // git 里跟踪了但磁盘上已经没了 —— 反向缺口，报出来（但不判裸奔）
    const diskSet = new Set(disk);
    const missing = files.filter((f) => !diskSet.has(f)).sort();
    const detail = `${disk.length} 个文件在盘上，${files.length} 个已跟踪` +
      (missing.length ? `；${missing.length} 个已跟踪但盘上没了` : '') +
      (bare.length ? `；★ ${bare.length} 个裸奔` : '') +
      (exemptHits.length ? `；豁免 ${exemptHits.length} 项（显式，见输出）` : '');
    results.push({
      ...c, status: bare.length ? 'UNTRACKED' : 'OK', count: files.length,
      bare, exempt: exemptHits, missing, detail,
    });
  }
  return results;
}

function selftest() {
  // 用真实仓库验证：清单里必须至少有一条 OK，且结构完整
  const r = run();
  const checks = [
    ['清单非空', r.length === CENSUS.length],
    ['每条都有 status', r.every((x) => ['OK', 'MISSING', 'UNTRACKED', 'GIT_ERR'].includes(x.status))],
    ['memory.jsonl 已跟踪', r.some((x) => x.p.includes('memory.jsonl') && x.status === 'OK')],
    ['模块架构 已跟踪', r.some((x) => x.p.includes('模块架构') && x.status === 'OK')],
  ];
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✔' : '✘'} ${name}`);
    if (ok) pass++;
  }
  // ★ 2026-10-22：负向自检 —— 「工具跑起来了」不等于「它抓得住东西」。
  //   造一个临时真 git 仓：提交一个文件，再放一个未跟踪文件进去，
  //   逐文件比对必须报出这个裸奔文件（旧的「目录非空即过」实现会判 OK）。
  //   没有这一条，这把尺子的刻度没人校过 —— 正是「selftest 绿 ≠ 实跑绿」的典型。
  const neg = negSelfTest();
  console.log(`  ${neg.ok ? '✔' : '✘'} 负向自检：目录里放 1 个未跟踪文件必须被抓出来`);
  if (!neg.ok) console.log(`      ↳ ${neg.detail}`);
  if (neg.ok) pass++;
  const total = checks.length + 1;
  console.log(`\n  selftest: ${pass}/${total}`);
  return pass === total ? EXIT_OK : EXIT_BAD;
}
function negSelfTest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-neg-'));
  const git = (args) => spawnSync(GIT, ['-C', tmp, '-c', 'core.quotepath=false', ...args],
    { encoding: 'utf8', timeout: 30000 });
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'selftest@local']);
    git(['config', 'user.name', 'selftest']);
    fs.mkdirSync(path.join(tmp, 'dir'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dir', 'a.md'), '# a\n', 'utf8');
    git(['add', 'dir/a.md']);
    git(['commit', '-q', '-m', 'seed']);
    fs.writeFileSync(path.join(tmp, 'dir', 'b.md'), '# b bare\n', 'utf8');
    // 直接复用本脚本的逐文件比对逻辑
    const tracked = lsFiles(tmp, 'dir');
    const disk = walkDisk(tmp, 'dir');
    const bare = disk.filter((f) => !new Set(tracked).has(f));
    if (bare.length !== 1 || bare[0] !== 'dir/b.md') {
      return { ok: false, detail: `期望抓到 dir/b.md，实际 bare=[${bare.join(',')}] tracked=[${tracked.join(',')}] disk=[${disk.join(',')}]` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录留着也不碍事 */ }
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node check-asset-census.js [--json] [--selftest]');
    return EXIT_OK;
  }
  if (argv.includes('--selftest')) return selftest();

  const r = run();
  const bad = r.filter((x) => x.status !== 'OK');

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ok: bad.length === 0, items: r, badCount: bad.length }, null, 2));
  } else {
    console.log(`资产普查：${r.length} 项\n`);
    for (const x of r) {
      const mark = x.status === 'OK' ? '✔' : '✘';
      console.log(`  ${mark} ${x.p.padEnd(42)} ${x.detail}`);
      if (x.status !== 'OK') console.log(`      ↳ ${x.why}`);
      // ★ 逐文件裸奔：把具体文件名列出来 —— 只说「有裸奔」没人知道该 git add 什么
      for (const b of (x.bare || [])) console.log(`      ✘ 裸奔: ${b}`);
      for (const e of (x.exempt || [])) {
        const info = EXEMPT.find((z) => z.p === e);
        console.log(`      ⊘ 显式豁免: ${e}` + (info ? ` —— ${info.why}` : ''));
      }
      for (const m of (x.missing || [])) console.log(`      ⚠ 已跟踪但盘上没了: ${m}`);
    }
    console.log('');
    if (bad.length === 0) console.log('VERDICT: 全部已跟踪，可以打 tag');
    else console.log(`VERDICT: ${bad.length} 项裸奔 —— 这些是治理层的器官，不许在库外`);
  }
  return bad.length === 0 ? EXIT_OK : EXIT_BAD;
}

process.exit(main());
