#!/usr/bin/env node
'use strict';
/*
 * snapshot-world.js —— 存档快照 / 回滚（H10）
 *
 * 用户 2026-10-20 提出、2026-10-21 再次强调：
 *   「多个存档可以复制存档，然后不断的进行验证同一个场景」
 *   「验证会破坏环境 → 复制存档 → 同一环境反复重跑直到满意再采数据」
 *
 * 为什么需要它：现在每一轮实机验证都在**同一个世界**上跑，验证会留下痕迹
 * （挖的洞、丢的东西、改的配置、同伴的记忆）。想复现「同一个起点」只能靠运气。
 * 有了快照：打一份 → 跑坏了 → 回滚 → 再来一次，环境一模一样。
 *
 * ★ 快照什么（分三类，体积差 6 倍，不能一锅端）：
 *   1. saves\<世界>\       全量（31 MB 级）—— 方块/实体/玩家状态，这是本体
 *   2. config\numen\ 状态  全量，但**排除 monitor\**（6.7 MB 级）——
 *      companions/rdd-tasks/rdd-ledger/rdd-facts 等，是同伴记忆与任务链
 *   3. config\numen\monitor 只留最近（193 MB！）—— 是 jsonl 日志，回滚它没意义，
 *      但完全不留就没法对照「回滚前后」。所以只拷最近 N 分钟改过的文件。
 *
 * ★ 安全设计（这工具最容易毁数据，宁可拒）：
 *   - 默认 dry-run，--apply 才真写
 *   - **备份前必须游戏已停**（java 进程为 0）—— 运行中拷存档 = 拷到半截
 *   - **回滚前必须游戏已停** + 先自动打一份 pre-restore 快照（后悔药）
 *   - 回滚前删 session.lock（不删游戏认为世界被占用，拒绝进入）
 *   - 只认 saves\ 下已存在的世界名，不许拼任意路径
 *
 * 用法：
 *   node snapshot-world.js --list                       # 看现有快照
 *   node snapshot-world.js --name before-g4c            # 干跑：看会拷什么
 *   node snapshot-world.js --name before-g4c --apply    # 真打快照
 *   node snapshot-world.js --restore before-g4c         # 干跑回滚
 *   node snapshot-world.js --restore before-g4c --apply # 真回滚
 *   node snapshot-world.js --selftest
 *
 * 退出码：0 正常 / 1 被安全检查拒 / 2 用法错 / 3 环境错
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RDD = 'D:\\rdd';
const MC = path.join(RDD, 'mc', 'The Best of Twilight Forest');
const SAVES = path.join(MC, 'saves');
const NUMEN = path.join(MC, 'config', 'numen');
const SNAP_ROOT = path.join(RDD, 'workspace', 'rdd-selfcompile', 'snapshots', 'world');

// monitor 只留最近这么多分钟的文件（日志回滚无意义，但要能对照回滚前后）
const MONITOR_RECENT_MIN = 30;

// ★ 快照默认 TTL（小时）。用户 2026-10-21 定：
//   「这种备份出来的存档实际上可以删掉的，就是它到一定时间就会主动删掉，
//    就相当于是一个快照，快照的话应该是执行 AI 自己的事」
//   —— 所以它**不是永久资产**，是执行 AI 用完就该清的工作副本。
//   默认 48 小时：够跨一个夜班+一个白班；超过就该删（31 MB/份，攒着没意义）。
const DEFAULT_TTL_H = 48;
// pre-restore 后悔药也吃 TTL（它同样是一次性工作副本）

const EXIT_OK = 0, EXIT_REFUSED = 1, EXIT_USAGE = 2, EXIT_ENV = 3;

const HELP = `用法：
  node snapshot-world.js --status [--ttl <小时>]      # 还有几个、占多少、哪些该删
  node snapshot-world.js --prune [--ttl <小时>] [--apply]   # 删过期的
  node snapshot-world.js --name <标签> [--world live] [--note "..."] [--apply]
  node snapshot-world.js --restore <标签> [--apply]
  node snapshot-world.js --delete <标签> [--apply]
  node snapshot-world.js --list
  node snapshot-world.js --selftest

  默认干跑（只打印会做什么）。--apply 才真执行。

★ 快照是**执行 AI 自己的工作副本**，不是永久资产：
  默认 TTL ${DEFAULT_TTL_H} 小时，过期就该 --prune 删掉（每份 30 MB 级）。
  它存在是为了「同一环境反复重跑」，用完即弃。

快照位置：${SNAP_ROOT}\\<标签>\\
  saves/<世界>/          全量
  numen/                 全量，排除 monitor/
  numen-monitor-recent/  只留最近 ${MONITOR_RECENT_MIN} 分钟改过的

退出码：0 正常 / 1 被安全检查拒 / 2 用法错 / 3 环境错`;

function parseArgs(argv) {
  const o = { apply: false, selftest: false, help: false, list: false, status: false, prune: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') o.name = argv[++i];
    else if (a === '--world') o.world = argv[++i];
    else if (a === '--restore') o.restore = argv[++i];
    else if (a === '--delete') o.del = argv[++i];
    else if (a === '--ttl') o.ttl = argv[++i];
    else if (a === '--note') o.note = argv[++i];
    else if (a === '--apply') o.apply = true;
    else if (a === '--list') o.list = true;
    else if (a === '--status') o.status = true;
    else if (a === '--prune') o.prune = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

/* ── 游戏是否在跑 ── */
function gameRunning() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "if (Get-Process java,javaw -ErrorAction SilentlyContinue) { 'RUNNING' } else { 'IDLE' }"],
    { encoding: 'utf8', timeout: 20000 });
  return (r.stdout || '').includes('RUNNING');
}

function dirSize(p) {
  let total = 0, files = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; files++; } catch { /* skip */ } }
    }
  };
  walk(p);
  return { bytes: total, files };
}

function mb(b) { return (b / 1048576).toFixed(1) + ' MB'; }

/* ── 读所有快照的 meta ── */
function listSnapshots() {
  if (!fs.existsSync(SNAP_ROOT)) return [];
  const out = [];
  for (const e of fs.readdirSync(SNAP_ROOT, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(SNAP_ROOT, e.name);
    let m = null;
    try {
      // ★ 去 BOM 再 parse：PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，
      //   而 JSON.parse 不接受 BOM。不去掉的话会**静默回退到目录 mtime**，
      //   看起来「能读」其实读的是错的时间（实测踩到：TTL 判定全失效）。
      m = JSON.parse(fs.readFileSync(path.join(full, 'meta.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch { /* 老快照没 meta，回退目录 mtime */ }
    const sz = dirSize(full);
    const at = (m && m.at) || (fs.existsSync(full) ? fs.statSync(full).mtime.toISOString() : '');
    const ageH = at ? (Date.now() - Date.parse(at)) / 3600000 : 0;
    out.push({
      name: e.name, dir: full, at, ageH,
      world: (m && m.world) || 'live',
      note: (m && m.note) || '',
      bytes: sz.bytes, files: sz.files,
      isPreRestore: /^pre-restore-/.test(e.name),
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/* ── status：一眼看还有几个、占多少、哪些该删 ── */
function cmdStatus(o) {
  const ttl = Number(o.ttl) || DEFAULT_TTL_H;
  const snaps = listSnapshots();
  if (!snaps.length) {
    console.log('（没有任何快照）');
    console.log('');
    console.log('需要「同一环境反复重跑」时再打：');
    console.log(`  node ${path.basename(__filename)} --name before-<批次> --apply`);
    return EXIT_OK;
  }
  const total = snaps.reduce((a, x) => a + x.bytes, 0);
  const expired = snaps.filter((x) => x.ageH > ttl);
  console.log(`快照 ${snaps.length} 份，共 ${mb(total)}　（TTL ${ttl} 小时，超了就该删）\n`);
  for (const s of snaps) {
    const stale = s.ageH > ttl;
    console.log(`  ${stale ? '🟡' : '  '} ${s.name}`);
    console.log(`       ${s.world} · ${s.at.replace('T', ' ').slice(0, 19)} · ${s.ageH.toFixed(1)} 小时前 · ${mb(s.bytes)}`);
    if (s.note) console.log(`       ${s.note}`);
  }
  console.log('');
  if (expired.length) {
    console.log(`⚠ ${expired.length} 份超过 TTL，可以删（释放 ${mb(expired.reduce((a, x) => a + x.bytes, 0))}）：`);
    console.log(`  node ${path.basename(__filename)} --prune --apply`);
  } else {
    console.log('✔ 都在 TTL 内');
  }
  return EXIT_OK;
}

/* ── prune：按 TTL 删过期快照 ── */
function cmdPrune(o) {
  const ttl = Number(o.ttl) || DEFAULT_TTL_H;
  const snaps = listSnapshots();
  const expired = snaps.filter((x) => x.ageH > ttl);
  if (!expired.length) {
    console.log(`✔ 没有超过 ${ttl} 小时的快照（共 ${snaps.length} 份），不用删`);
    return EXIT_OK;
  }
  const freed = expired.reduce((a, x) => a + x.bytes, 0);
  console.log(`将删 ${expired.length} 份超过 ${ttl} 小时的快照${o.apply ? '' : '（干跑，加 --apply 才真删）'}：`);
  for (const s of expired) {
    console.log(`  - ${s.name}  ${s.ageH.toFixed(1)} 小时前  ${mb(s.bytes)}`);
  }
  console.log(`  释放 ${mb(freed)}`);
  if (!o.apply) { console.log('\n干跑结束。加 --apply 执行。'); return EXIT_OK; }
  let ok = 0;
  for (const s of expired) {
    try { fs.rmSync(s.dir, { recursive: true, force: true }); ok++; } catch (e) { console.error(`  ✘ ${s.name}: ${e.message}`); }
  }
  console.log(`\n✔ 已删 ${ok}/${expired.length} 份，释放 ${mb(freed)}`);
  return ok === expired.length ? EXIT_OK : EXIT_ENV;
}

/* ── 列快照 ── */
function cmdList() {
  if (!fs.existsSync(SNAP_ROOT)) { console.log('（还没有任何快照）'); return EXIT_OK; }
  const ents = fs.readdirSync(SNAP_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (!ents.length) { console.log('（还没有任何快照）'); return EXIT_OK; }
  console.log('现有快照：\n');
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(SNAP_ROOT, e.name);
    const meta = path.join(full, 'meta.json');
    let m = null;
    try { m = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { /* 没 meta 也列 */ }
    const sz = dirSize(full);
    console.log('  ' + e.name);
    if (m) console.log(`     ${m.world} · ${m.at.replace('T', ' ').slice(0, 19)} · ${m.note || ''}`);
    console.log(`     ${mb(sz.bytes)} / ${sz.files} 文件`);
    console.log('');
  }
  return EXIT_OK;
}

/* ── 复制（带排除 + 时间过滤） ── */
function copyTree(src, dst, opts) {
  opts = opts || {};
  let copied = 0, bytes = 0;
  const walk = (s, d) => {
    let ents = [];
    try { ents = fs.readdirSync(s, { withFileTypes: true }); } catch { return }
    for (const e of ents) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (opts.excludeDir && opts.excludeDir(e.name, sp)) continue;
      if (e.isDirectory()) { walk(sp, dp); continue; }
      if (opts.onlyRecentMs) {
        let st; try { st = fs.statSync(sp); } catch { continue }
        if (Date.now() - st.mtimeMs > opts.onlyRecentMs) continue;
      }
      if (!opts.apply) { copied++; continue; }   // 干跑只计数
      fs.mkdirSync(d, { recursive: true });
      try { fs.copyFileSync(sp, dp); copied++; bytes += fs.statSync(sp).size; } catch { /* skip */ }
    }
  };
  walk(src, dst);
  return { copied, bytes };
}

/* ── 打快照 ── */
function cmdSnapshot(o) {
  if (!o.name) { console.error('[usage] 缺 --name'); return EXIT_USAGE; }
  const world = o.world || 'live';
  const worldDir = path.join(SAVES, world);
  if (!fs.existsSync(worldDir)) {
    console.error(`[env] 世界不存在：${worldDir}`);
    console.error('  现有世界：' + (fs.existsSync(SAVES) ? fs.readdirSync(SAVES).filter((x) => fs.statSync(path.join(SAVES, x)).isDirectory()).join(' / ') : '（saves 目录都没有）'));
    return EXIT_ENV;
  }

  const dst = path.join(SNAP_ROOT, o.name);
  console.log(`快照：${o.name}${o.apply ? '' : '（干跑，加 --apply 才真做）'}`);
  console.log(`  世界：${world}`);
  console.log(`  目标：${dst}`);
  console.log('');

  // 安全检查：游戏必须在停
  if (gameRunning()) {
    console.error('✘ 被安全检查拒：游戏正在运行。');
    console.error('  运行中拷存档 = 拷到半截（区块文件可能正被写）。先关游戏再打快照。');
    return EXIT_REFUSED;
  }
  console.log('✔ 安全检查通过（游戏未运行）');

  if (fs.existsSync(dst) && o.apply) {
    console.error(`✘ 快照已存在：${dst}`);
    console.error('  换个 --name，或先 --delete 旧的（不许静默覆盖）。');
    return EXIT_REFUSED;
  }

  console.log('');
  console.log('会拷什么：');
  const w = dirSize(worldDir);
  console.log(`  1. saves/${world}/              ${mb(w.bytes)} / ${w.files} 文件（全量）`);
  const numenAll = dirSize(NUMEN);
  const monAll = dirSize(path.join(NUMEN, 'monitor'));
  console.log(`  2. config/numen/（排除 monitor） ${mb(numenAll.bytes - monAll.bytes)} / 约 ${numenAll.files - monAll.files} 文件`);
  console.log(`  3. config/numen/monitor/        只留最近 ${MONITOR_RECENT_MIN} 分钟改过的（全量 ${mb(monAll.bytes)} 太大，日志回滚无意义）`);

  if (!o.apply) {
    console.log('');
    console.log('干跑结束。加 --apply 执行。');
    return EXIT_OK;
  }

  // 真拷
  const t0 = Date.now();
  fs.mkdirSync(dst, { recursive: true });
  const r1 = copyTree(worldDir, path.join(dst, 'saves', world), { apply: true });
  console.log(`  ✔ saves/${world}/  ${r1.copied} 文件 ${mb(r1.bytes)}`);

  const r2 = copyTree(NUMEN, path.join(dst, 'numen'), {
    apply: true,
    excludeDir: (name) => name === 'monitor',
  });
  console.log(`  ✔ config/numen/  ${r2.copied} 文件 ${mb(r2.bytes)}`);

  const r3 = copyTree(path.join(NUMEN, 'monitor'), path.join(dst, 'numen-monitor-recent'), {
    apply: true,
    onlyRecentMs: MONITOR_RECENT_MIN * 60000,
  });
  console.log(`  ✔ monitor 最近 ${MONITOR_RECENT_MIN} 分钟  ${r3.copied} 文件`);

  const meta = {
    name: o.name, world, at: new Date().toISOString(),
    note: o.note || '',
    monitorRecentMin: MONITOR_RECENT_MIN,
    counts: { worldFiles: r1.copied, numenFiles: r2.copied, monitorFiles: r3.copied },
    bytes: r1.bytes + r2.bytes,
    tookMs: Date.now() - t0,
    createdBy: 'snapshot-world.js',
  };
  fs.writeFileSync(path.join(dst, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  console.log('');
  console.log(`✔✔ 快照完成：${o.name}（${mb(meta.bytes)}，${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  console.log(`   回滚：node snapshot-world.js --restore ${o.name} --apply`);
  return EXIT_OK;
}

/* ── 回滚 ── */
function cmdRestore(o) {
  const name = o.restore;
  const src = path.join(SNAP_ROOT, name);
  if (!fs.existsSync(src)) {
    console.error(`[env] 快照不存在：${src}`);
    console.error('  现有：' + (fs.existsSync(SNAP_ROOT) ? fs.readdirSync(SNAP_ROOT).join(' / ') : '（无）'));
    return EXIT_ENV;
  }
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { /* 老快照没 meta */ }
  const world = (meta && meta.world) || 'live';

  console.log(`回滚：${name}${o.apply ? '' : '（干跑，加 --apply 才真做）'}`);
  console.log(`  世界：${world}`);
  console.log(`  快照时间：${meta ? meta.at.replace('T', ' ').slice(0, 19) : '（无 meta）'}`);
  console.log('');

  if (gameRunning()) {
    console.error('✘ 被安全检查拒：游戏正在运行。先关游戏 —— 回滚要覆盖 saves 和 config，跑着改必坏。');
    return EXIT_REFUSED;
  }
  console.log('✔ 安全检查通过（游戏未运行）');

  const worldDir = path.join(SAVES, world);
  const numenDir = NUMEN;
  console.log('');
  console.log('会做什么：');
  console.log(`  1. 先打一份 pre-restore 快照（后悔药，名字带时间戳）`);
  console.log(`  2. 删 ${worldDir}`);
  console.log(`  3. 拷回 saves/${world}/`);
  console.log(`  4. 删 config/numen/ 下**除 monitor 外**的状态目录，拷回快照里的`);
  console.log(`  5. 删 ${path.join(worldDir, 'session.lock')}（不删游戏会认为世界被占用，拒绝进入）`);
  console.log(`  6. 保留当前 monitor/（日志不回滚，只对照）`);

  if (!o.apply) { console.log(''); console.log('干跑结束。加 --apply 执行。'); return EXIT_OK; }

  // 1. 后悔药
  const preName = 'pre-restore-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const preDst = path.join(SNAP_ROOT, preName);
  console.log(`  → 打后悔药快照：${preName}`);
  fs.mkdirSync(preDst, { recursive: true });
  copyTree(worldDir, path.join(preDst, 'saves', world), { apply: true });
  copyTree(numenDir, path.join(preDst, 'numen'), { apply: true, excludeDir: (n) => n === 'monitor' });
  fs.writeFileSync(path.join(preDst, 'meta.json'), JSON.stringify({
    name: preName, world, at: new Date().toISOString(),
    note: `回滚到 ${name} 之前自动打的那一份`, createdBy: 'snapshot-world.js(restore)',
  }, null, 2), 'utf8');

  // 2-3. 世界
  try { fs.rmSync(worldDir, { recursive: true, force: true }); } catch (e) {
    console.error(`  ✘ 删世界失败：${e.message}`); return EXIT_ENV;
  }
  copyTree(path.join(src, 'saves', world), worldDir, { apply: true });
  console.log(`  ✔ 世界已恢复`);

  // 4. config/numen 状态目录（保留 monitor）
  let ents = [];
  try { ents = fs.readdirSync(numenDir, { withFileTypes: true }); } catch { /* ignore */ }
  for (const e of ents) {
    if (e.name === 'monitor') continue;
    const p = path.join(numenDir, e.name);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  copyTree(path.join(src, 'numen'), numenDir, { apply: true });
  console.log(`  ✔ config/numen 状态已恢复（monitor 保留）`);

  // 5. session.lock
  const lock = path.join(worldDir, 'session.lock');
  if (fs.existsSync(lock)) { try { fs.unlinkSync(lock); console.log('  ✔ 已删 session.lock'); } catch (e) { console.error('  ⚠ 删 session.lock 失败：' + e.message); } }

  console.log('');
  console.log(`✔✔ 回滚完成：${name}`);
  console.log(`   后悔药：${preName}`);
  console.log('   下一步：node bin/harness-gate.js preflight --since <今天> 确认环境可用');
  return EXIT_OK;
}

function cmdDelete(o) {
  const dst = path.join(SNAP_ROOT, o.del);
  if (!fs.existsSync(dst)) { console.error(`[env] 不存在：${dst}`); return EXIT_ENV; }
  if (!o.apply) { console.log(`干跑：会删 ${dst}（加 --apply）`); return EXIT_OK; }
  fs.rmSync(dst, { recursive: true, force: true });
  console.log(`✔ 已删 ${o.del}`);
  return EXIT_OK;
}

/* ── selftest ── */
function selftest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapw-'));
  const checks = [];

  // 造源树
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'A');
  fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'B');
  fs.writeFileSync(path.join(src, 'monitor.jsonl'), 'M');

  // 干跑不写盘
  const dry = copyTree(src, path.join(tmp, 'dry'), { apply: false });
  checks.push(['干跑只计数不落盘', dry.copied === 3 && !fs.existsSync(path.join(tmp, 'dry'))]);

  // 真拷
  const real = copyTree(src, path.join(tmp, 'real'), { apply: true });
  checks.push(['真拷 3 个文件', real.copied === 3 && fs.existsSync(path.join(tmp, 'real', 'sub', 'b.txt'))]);

  // 排除目录
  const exc = copyTree(src, path.join(tmp, 'exc'), { apply: true, excludeDir: (n) => n === 'monitor.jsonl' });
  checks.push(['排除生效', exc.copied === 2 && !fs.existsSync(path.join(tmp, 'exc', 'monitor.jsonl'))]);

  // 时间过滤：把 a.txt 设成 2 小时前
  const old = path.join(src, 'old.txt');
  fs.writeFileSync(old, 'O');
  const t = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, t, t);
  const rec = copyTree(src, path.join(tmp, 'rec'), { apply: true, onlyRecentMs: 30 * 60000 });
  checks.push(['只留最近生效', !fs.existsSync(path.join(tmp, 'rec', 'old.txt')) && fs.existsSync(path.join(tmp, 'rec', 'a.txt'))]);

  // dirSize
  const ds = dirSize(src);
  checks.push(['dirSize 数得对', ds.files === 4]);

  let pass = 0;
  for (const [n, ok] of checks) { console.log(`  ${ok ? '✔' : '✘'} ${n}`); if (ok) pass++; }
  console.log(`\n  selftest: ${pass}/${checks.length}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return pass === checks.length ? EXIT_OK : EXIT_REFUSED;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return EXIT_OK; }
  if (o.selftest) return selftest();
  if (o.status) return cmdStatus(o);
  if (o.prune) return cmdPrune(o);
  if (o.list) return cmdList();
  if (o.restore) return cmdRestore(o);
  if (o.del) return cmdDelete(o);
  if (o.name) return cmdSnapshot(o);
  console.log(HELP);
  return EXIT_USAGE;
}

process.exit(main());
