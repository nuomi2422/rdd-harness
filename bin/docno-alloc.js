#!/usr/bin/env node
'use strict';
/*
 * docno-alloc.js —— 编号文档的【集中取号处】（S-DOC-02 的执行器）
 *
 * ★ 为什么要有它（2026-10-22 审计实测的根因，不是猜测）：
 *   编号撞了 8 个（44/45/48/52/53/54/65/66）。查下来机制是这样漏的：
 *     - 现行规矩只有一句「接最大号往后排」（standards.md S-DOC-02），
 *       说的是**读目录**取最大号；
 *     - 但那要求**每个写入方自己去扫目录**。本工作区**并行会话常态**，
 *       两个会话同时扫到同一个最大号 → 同时建档 → 撞号。
 *       registry 自己的 legacyNotes 第 1 条写的就是这个：
 *       「65/66 是并行会话互相撞的（为避开 64 改成 66，又撞上对方建的 66-…）」。
 *     - registry.docNumbers.nextDocNo 是**缓存值**（现在还停在 75，实际最大号已 76），
 *       且自述「★ 别信这个缓存值，现场重扫」—— 也就是说**没有任何单一真源**。
 *     - 台账 docs-freshness.json 里**没有预留字段**（实测：file/role/ttlDays/
 *       lastVerified/verifiedBy/scope/evidence/found），所以连「谁占了哪个号」都没地方记。
 *
 *   ⇒ 撞号不是「谁不小心」，是**没有分配机制**：每个写入方都在自己猜号。
 *   ⇒ 改名只能平掉这次的 8 个，下周再来 8 个。**要修的是分配机制。**
 *
 * ★ 本工具就是那个机制：
 *   1. 号源唯一：`docs-freshness.json` 的 `allocations` 台账（append 语义，永不删行）。
 *   2. 取号 = max(目录里实际存在的号, 台账里已分配的号) + 1。
 *      —— 目录实测兜住「手写的、没走工具的」历史文件；
 *      —— 台账兜住「号已分配但文件还没落盘」的并发窗口。
 *   3. **占号即落盘**：取号那一刻就把号写进台账（哪怕文件还没建），
 *      下一个并行会话就取不到同一个号。这是防撞的关键 —— 先占后建。
 *   4. **删号不回收**（S-DOC-02 铁律：目录内唯一、不复用）。
 *
 * ★ 为什么取号必须走这一个入口（别绕过）：
 *   绕过 = 自己扫目录 = 回到并发撞号的原点。门禁 P10d 会查「本轮新建的编号文档
 *   是不是都在台账 allocations 里」—— 绕过取号的文件会被门禁认出来。
 *
 * 用法：
 *   node docno-alloc.js next                 # 取一个号（占用并落台账）
 *   node docno-alloc.js next --title "标题"   # 取号并把标题一并记进台账
 *   node docno-alloc.js next --dry-run       # 只看会拿到几号，不占号
 *   node docno-alloc.js status               # 看已分配号 / 目录实占 / 冲突
 *   node docno-alloc.js check                # 查：有没有目录里有、但台账没分配过的号
 *   node docno-alloc.js selftest
 *
 * 退出码：0 正常 / 1 有冲突（check/status 发现撞号） / 2 用法错 / 3 环境错
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const registryLib = require('./lib/registry.js');

// ★ 2026-10-30：`check` 从 2026-10-22 建起就是坏的 —— 它用 `spawnSync` 与 `GIT` 却两个都没定义，
//   一跑就 `ReferenceError: spawnSync is not defined`。也就是说「谁绕过取号处」这条判据
//   **从来没被执行过一次**（同 bug-10 那一族：纪律看起来在守，其实从没执行过）。
//   本机 git 不在 PATH（MinGit 装在 %LOCALAPPDATA%\Programs\MinGit），所以这里按已知安装位找。
function resolveGit() {
  if (process.env.RDD_GIT && fs.existsSync(process.env.RDD_GIT)) return process.env.RDD_GIT;
  const probes = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'MinGit', 'cmd', 'git.exe'),
    path.join(process.env.ProgramFiles || '', 'Git', 'cmd', 'git.exe'),
  ];
  for (const p of probes) if (p && fs.existsSync(p)) return p;
  return 'git';
}
const GIT = resolveGit();

const EXIT_OK = 0, EXIT_CONFLICT = 1, EXIT_USAGE = 2, EXIT_ENV = 3;

const HELP = `用法：
  node docno-alloc.js next [--title "标题"] [--dry-run]   取一个号（默认就占号）
  node docno-alloc.js status                              看分配台账 / 目录实占 / 冲突
  node docno-alloc.js check                               查「目录里有但没分配过」的号
  node docno-alloc.js selftest
`;

// ── 台账读写 ───────────────────────────────────────────────────────────────
function readLedger(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try { return JSON.parse(raw); } catch { return null; }
}

function writeLedger(file, ledger) {
  // ⚠ 与 harness 其他脚本一致：写 JSON 用 UTF-8 **不带 BOM**（带 BOM 会让 JSON.parse 炸）
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2), 'utf8');
}

/** 台账里已分配过的号（分配过的号永不回收） */
function allocatedNos(ledger) {
  const s = new Set();
  for (const a of (ledger.allocations || [])) {
    const n = Number(a.no);
    if (Number.isFinite(n)) s.add(n);
  }
  return s;
}

/** 目录里实际存在的号（兜住手写文件 / 历史文件） */
function dirNos(dir, pattern) {
  const byNo = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return byNo; }
  const re = new RegExp(pattern);
  for (const n of names) {
    if (!/\.md$/.test(n) || n.startsWith('_') || n === 'README.md') continue;
    const m = n.match(re);
    if (!m) continue;
    const no = m[1];
    if (!byNo.has(no)) byNo.set(no, []);
    byNo.get(no).push(n);
  }
  return byNo;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
function loadCtx() {
  const REG = registryLib.load();
  const dir = REG.docNumbers.root;
  const ledgerFile = REG.docNumbers.ledger;
  // ★ 2026-10-30：号数放宽到 2–3 位。旧默认 ^(\d{2})- 会把 100 号以上全当成「没有编号」，
  //   于是那些文件既不参与撞号检测，也进不了「谁占了哪个号」的统计 —— 取号就会撞。
  const pattern = REG.docNumbers.pattern || '^(\\d{2,3})-';
  if (!dir || !ledgerFile) return { err: 'registry.docNumbers 缺 root/ledger' };
  if (!fs.existsSync(dir)) return { err: '编号目录不存在：' + dir };
  const ledger = readLedger(ledgerFile);
  if (!ledger) return { err: '台账读不了或不是合法 JSON：' + ledgerFile };
  return { REG, dir, ledgerFile, ledger, pattern };
}

function computeNext(ctx) {
  const byNo = dirNos(ctx.dir, ctx.pattern);
  const alloc = allocatedNos(ctx.ledger);
  const dirMax = byNo.size ? Math.max(...[...byNo.keys()].map(Number)) : 0;
  const allocMax = alloc.size ? Math.max(...alloc) : 0;
  // ★ 两个源取大者再 +1：目录兜住手写文件，台账兜住「已占号未落盘」的并发窗口
  const next = Math.max(dirMax, allocMax) + 1;
  return { byNo, alloc, dirMax, allocMax, next };
}

/** 撞号检测：目录里同一个号有多个文件 */
function conflicts(ctx, byNo) {
  const out = [];
  for (const [no, arr] of byNo) {
    if (arr.length > 1) out.push({ no: Number(no), files: arr });
  }
  return out.sort((a, b) => a.no - b.no);
}

function cmdNext(argv) {
  const ctx = loadCtx();
  if (ctx.err) { console.error('环境错：' + ctx.err); return EXIT_ENV; }
  const dry = argv.includes('--dry-run');
  const ti = argv.indexOf('--title');
  const title = ti >= 0 && argv[ti + 1] ? argv[ti + 1] : '';

  const c = computeNext(ctx);
  if (dry) {
    console.log(`下一个号 = ${c.next}（目录实占最大 ${c.dirMax} / 台账已分配最大 ${c.allocMax}）—— dry-run，未占号`);
    return EXIT_OK;
  }

  // ★ 先占后建：号落台账的那一刻，这个号就归本次调用了
  if (!Array.isArray(ctx.ledger.allocations)) ctx.ledger.allocations = [];
  ctx.ledger.allocations.push({
    no: c.next,
    title,
    at: new Date().toISOString(),
    by: process.env.DSH_SESSION_ID || 'unknown',
  });
  ctx.ledger.allocator = {
    tool: 'bin/docno-alloc.js',
    rule: 'max(目录实占号, 台账已分配号) + 1；先占后建；删号不回收',
  };
  // ★ updated 保持台账原约定（YYYY-MM-DD 日期串），不要写成 ISO 时间戳 ——
  //   这个字段全仓多处按字符串比对，写法一变就成了「文档滞后现实」的又一次实例。
  ctx.ledger.updated = new Date().toISOString().slice(0, 10);
  try {
    writeLedger(ctx.ledgerFile, ctx.ledger);
  } catch (e) {
    console.error('环境错：台账写不进去：' + (e && e.message));
    return EXIT_ENV;
  }
  console.log(`已分配编号 = ${c.next}${title ? '（' + title + '）' : ''}`);
  console.log(`  台账：${ctx.ledgerFile}`);
  console.log(`  文件名请用：${String(c.next).padStart(2, '0')}-<中文名>[-YYYYMMDD].md`);
  console.log(`  ★ 落盘后还要登记三处：registry.docNumbers.registerIn 里的三份索引`);
  return EXIT_OK;
}

function cmdStatus(argv) {
  const ctx = loadCtx();
  if (ctx.err) { console.error('环境错：' + ctx.err); return EXIT_ENV; }
  const c = computeNext(ctx);
  const cf = conflicts(ctx, c.byNo);
  const json = argv.includes('--json');

  const allocList = (ctx.ledger.allocations || []).slice().sort((a, b) => Number(a.no) - Number(b.no));
  if (json) {
    console.log(JSON.stringify({
      next: c.next, dirMax: c.dirMax, allocMax: c.allocMax,
      allocated: allocList, conflicts: cf,
    }, null, 2));
    return cf.length ? EXIT_CONFLICT : EXIT_OK;
  }
  console.log('编号取号状态\n');
  console.log(`  目录实占号数 = ${c.byNo.size}（最大 ${c.dirMax}）`);
  console.log(`  台账已分配号 = ${c.alloc.size}（最大 ${c.allocMax}）`);
  console.log(`  下一个号     = ${c.next}`);
  console.log(`  目录撞号     = ${cf.length}`);
  for (const x of cf) console.log(`    ✘ ${x.no}: ${x.files.join(' + ')}`);
  console.log('\n  已分配台账（最近的 10 条）:');
  for (const a of allocList.slice(-10)) {
    console.log(`    ${String(a.no).padStart(2, '0')}  ${a.at}  ${a.title || ''}`);
  }
  return cf.length ? EXIT_CONFLICT : EXIT_OK;
}

function cmdCheck() {
  const ctx = loadCtx();
  if (ctx.err) { console.error('环境错：' + ctx.err); return EXIT_ENV; }
  const c = computeNext(ctx);
  const cf = conflicts(ctx, c.byNo);
  // 目录里有、但台账从没分配过的号 —— 这些是「绕过取号处」或历史文件
  const unallocated = [];
  for (const [no, arr] of c.byNo) {
    if (!c.alloc.has(Number(no))) unallocated.push({ no: Number(no), files: arr });
  }
  unallocated.sort((a, b) => a.no - b.no);

  // ★ 2026-10-22：把「历史文件」和「本轮绕过取号处」分开，否则一条命令刷 75 行。
  //   台账 allocations 是 2026-10-22 才有的字段（先占后建），
  //   在那之前建的文件全都没有分配记录 —— 那是**预期**，不是违规。
  //   真正的违规是：取号处已经存在之后，还有文件在盘上出现却没走过取号。
  //   判据用「台账 updated 之后的 git 改动」—— 取号处上线后动过的号才算数。
  //   （不按 mtime：mtime 会被 git checkout / 解压覆盖，不能证明「新建」。）
  let sinceIso = null;
  try {
    const firstAlloc = (ctx.ledger.allocations || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
    if (firstAlloc && firstAlloc.at) sinceIso = String(firstAlloc.at).slice(0, 10);
  } catch { /* 没分配记录就全算历史 */ }
  const recentFiles = new Set();
  if (sinceIso) {
    const r = spawnSync(GIT, ['-C', ctx.dir, 'log', '--name-only', '--format=',
      `--since=${sinceIso} 00:00`, '--', '.'], { encoding: 'utf8', timeout: 30000 });
    if (r.status === 0) {
      for (const l of (r.stdout || '').split(/\r?\n/)) {
        const f = l.trim();
        if (f && /\.md$/.test(f)) recentFiles.add(f);
      }
    }
  }
  const isRecent = (files) => files.some((f) => recentFiles.has(f));
  const recentUnalloc = unallocated.filter((x) => isRecent(x.files));
  const legacyUnalloc = unallocated.filter((x) => !isRecent(x.files));

  // ★ 2026-10-22：撞号也分「已登记为债的旧撞号」和「新撞号」。
  //   依据与 check-doc-freshness 同源：台账 knownDuplicateNumbers 里的是旧债，
  //   降级不拦（否则一次旧债把门禁永久钉死，门禁一旦被长期忽略就等于没有）。
  //   不在名单里的撞号 = 新撞号，必须 BLOCK。
  const KNOWN_DUP = new Set((ctx.ledger.knownDuplicateNumbers || []).map((x) => Number(x)));
  const newConflicts = cf.filter((x) => !KNOWN_DUP.has(Number(x.no)));
  const knownConflicts = cf.filter((x) => KNOWN_DUP.has(Number(x.no)));

  console.log('编号一致性检查\n');
  console.log(`  取号处上线日     = ${sinceIso || '（无分配记录）'}`);
  console.log(`  新撞号（未登记）  = ${newConflicts.length}   ← 这些要处理`);
  for (const x of newConflicts) console.log(`    ✘ ${x.no}: ${x.files.join(' + ')}`);
  console.log(`  旧撞号（已登记为债）= ${knownConflicts.length}   ← 降 WARN，不拦`);
  for (const x of knownConflicts) console.log(`    · ${x.no}: ${x.files.join(' + ')}`);
  console.log(`  取号后新增却没走过取号处 = ${recentUnalloc.length}   ← 这些是违规`);
  for (const x of recentUnalloc) console.log(`    ✘ ${String(x.no).padStart(2, '0')}  ${x.files.join(' + ')}`);
  console.log(`  历史文件（取号处之前建的） = ${legacyUnalloc.length}   ← 预期，不算违规`);
  for (const x of legacyUnalloc.slice(0, 5)) console.log(`    · ${String(x.no).padStart(2, '0')}  ${x.files.join(' + ')}`);
  if (legacyUnalloc.length > 5) console.log(`    · …还有 ${legacyUnalloc.length - 5} 个`);

  if (newConflicts.length === 0 && recentUnalloc.length === 0) {
    console.log('\nVERDICT: 编号一致 —— 本轮新增的号都从取号处来');
    if (knownConflicts.length) {
      console.log(`  （${knownConflicts.length} 个旧撞号已登记为债，在台账 knownDuplicateNumbers 里，降 WARN 不拦）`);
    }
    if (legacyUnalloc.length) {
      console.log(`  （另有 ${legacyUnalloc.length} 个历史文件无分配记录，属取号处上线前的既有状态）`);
    }
    return EXIT_OK;
  }
  console.log('\nVERDICT: 有问题要处理。');
  if (newConflicts.length) {
    console.log('  新撞号 → 改文件名并同步引用；若确认是旧债，登记进台账 knownDuplicateNumbers 并说明理由。');
  }
  if (recentUnalloc.length) {
    console.log('  取号后新增却没走过取号处 → 下次先跑 `node bin/docno-alloc.js next`，先占号再建文件。');
  }
  return EXIT_CONFLICT;
}

function selftest() {
  const checks = [];
  const ctx = loadCtx();
  checks.push(['registry 可加载且有 docNumbers', !ctx.err, ctx.err || '']);
  if (!ctx.err) {
    const c = computeNext(ctx);
    checks.push(['next > 目录最大号', c.next > c.dirMax, `next=${c.next} dirMax=${c.dirMax}`]);
    checks.push(['next > 台账最大号', c.next > c.allocMax, `next=${c.next} allocMax=${c.allocMax}`]);
    checks.push(['台账可写回（allocations 是数组）', Array.isArray(ctx.ledger.allocations) || ctx.ledger.allocations === undefined, '']);
    checks.push(['编号目录存在', fs.existsSync(ctx.dir), ctx.dir]);
  }
  let pass = 0;
  for (const [name, ok, note] of checks) {
    console.log(`  ${ok ? '✔' : '✘'} ${name}${note ? '  —— ' + note : ''}`);
    if (ok) pass++;
  }
  console.log(`\n  selftest: ${pass}/${checks.length}`);
  return pass === checks.length ? EXIT_OK : EXIT_ENV;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return EXIT_OK; }
  if (cmd === 'next') return cmdNext(argv);
  if (cmd === 'status') return cmdStatus(argv);
  if (cmd === 'check') return cmdCheck();
  if (cmd === 'selftest') return selftest();
  console.error('未知命令：' + cmd);
  console.error(HELP);
  return EXIT_USAGE;
}

process.exit(main());
