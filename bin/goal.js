#!/usr/bin/env node
'use strict'
/**
 * goal.js —— 架构目标锁（goal-lock）
 *
 * 用户诉求（2026-10-07 原话要义）：
 *   「架构文档写完了就放到 stage 里，AI 依据架构文档的边界一起写；
 *     写到一半自己停了就强制把它开动，架构没完成之前不让它停；
 *     写完了提醒它看边界是不是真的完成，给出证据；
 *     硬性要求：不许写文档冒充完成 —— 我这里完成了，证据是什么？实际是什么？
 *     究竟能不能达成最终验收？没完成就一直跑。」
 *
 * 三条设计决定（每条都对着一个踩过的坑）：
 *
 * 1) **证据 = 跑出来的输出，不是打出来的字。**
 *    prove 不接收「我认为它成了」，它自己 spawnSync 跑命令、存 stdout/exit code/时间戳；
 *    accept 再把每条判据【重新跑一遍】。写进文档的自述在这里没有位置 ——
 *    这是对「回执 success:true ≠ 东西真存在」「声明≠接线」的正面回应。
 *
 * 2) **验收是机器复跑，不是人点头。**
 *    所有条目 accept 全过才把 status 置 accepted；有一条不过就 exit 1 并把
 *    「期望什么 / 实际什么」逐条打出来。goal.status 不是 accepted，
 *    opencode 那边的 goal-drive 插件就一直催 —— 这就是「没完成不许停」。
 *
 * 3) **状态文件是唯一真相，插件只读它。**
 *    stager/.stager/goal.json —— 和 active.json / decisions.json / heartbeat.json 同目录。
 *    没开 stage 也能用（用户明确说「虽然不走 stage 但可以逼他完成架构」）。
 *
 * 退出码：0 = 过 / 1 = 没过（有条目未验收） / 2 = 用法或状态错（不是债）
 *
 * 用法：
 *   node goal.js init --title "<任务名>" --arch "<架构文档路径>"
 *   node goal.js add "<验收条目>" [--id A1] [--how "<完成长什么样>"] [--cmd "<判据命令>"] [--expect "<正则>"]
 *   node goal.js status [--json]
 *   node goal.js prove <id> --cmd "<命令>" [--expect "<正则>"] [--file <证据文件>] --note "<实际是什么>"
 *   node goal.js accept
 *   node goal.js pause --reason "<为什么停>"     /  goal.js resume
 *   node goal.js drive                            （打印本该催跑的文案；正常由插件注入）
 *   node goal.js clear --yes
 *   全部命令支持 --state <路径> / 环境变量 RDD_GOAL_STATE（探针用）
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const DEFAULT_STATE = 'E:/restart developing doer/stager/.stager/goal.json'
const EVIDENCE_TTL_H = 72          // 手工证据（--file）超过 72 小时算过期
const OUT_MAX = 4000               // 单条证据存多少字符（够判读，不撑爆状态文件）

// ── 参数 ────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t.startsWith('--')) {
      const k = t.slice(2)
      const nxt = argv[i + 1]
      if (nxt !== undefined && !nxt.startsWith('--')) { a[k] = nxt; i++ }
      else a[k] = true
    } else a._.push(t)
  }
  return a
}
const argv = parseArgs(process.argv.slice(2))
const CMD = argv._[0] || ''
const STATE_FILE = argv.state || process.env.RDD_GOAL_STATE || DEFAULT_STATE

// ── 状态读写 ────────────────────────────────────────────
function readGoal(fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''))
    if (raw && typeof raw === 'object') return raw
  } catch { /* 交给 fallback */ }
  return fallback
}

function writeGoal(g) {
  g.updatedAt = new Date().toISOString()
  g.rev = (g.rev || 0) + 1
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  // 原子写：插件（opencode 进程）可能同时在读，半截 JSON 会让它静默退回「没有目标锁」
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(g, null, 1), 'utf8')
  fs.renameSync(tmp, STATE_FILE)
  return g
}

// ── 状态文件互斥锁（2026-10-07 真机踩出来的）─────────────
//
// 症状：两条 prove 并行跑，第二条回执 exit=0「证据已收」，但状态里它的 evidence=0 ——
//       读-改-写并发，后写的把先写的整份状态覆盖掉，**证据静默丢失**。
// 这正是「回执成功 ≠ 东西存在」的形态，而且丢了还不报错。
// 判据落在 mkdir（NTFS 上原子）上：拿不到就轮询，超过 10s 的锁视为死锁接管。
const LOCK_DIR = STATE_FILE + '.lock'
let lockHeld = false
let sleepFn = null
function sleepSync(ms) {
  if (!sleepFn) sleepFn = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sleepFn, 0, 0, ms)
}
function releaseLock() {
  if (!lockHeld) return
  lockHeld = false
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }) } catch { /* 已经没了 */ }
}
function acquireLock() {
  const t0 = Date.now()
  for (;;) {
    try { fs.mkdirSync(LOCK_DIR); lockHeld = true; return } catch { /* 被占了，往下判 */ }
    let stale = false
    try { stale = Date.now() - fs.statSync(LOCK_DIR).mtimeMs > 10000 } catch { continue }
    if (stale) { try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }) } catch { /* 抢不过就下轮再试 */ }; continue }
    if (Date.now() - t0 > 5000) {
      die(2, '状态文件被别的 goal 进程占着超过 5s（' + LOCK_DIR + '）—— 别并行跑两条 goal 命令；确认没有残留就删这个目录')
    }
    sleepSync(120)
  }
}
/** 改状态的命令一律包在锁里；die() 走 process.exit，finally 不会跑，所以它自己负责还锁 */
function withLock(fn) {
  acquireLock()
  try { return fn() } finally { releaseLock() }
}

function die(code, msg) {
  releaseLock()   // process.exit 不走 finally：不还锁就给下一条命令留个 5~10s 的死锁
  process.stderr.write('✘ ' + msg + '\n')
  process.exit(code)
}
/** 正常/非正常的提前退出也得还锁 —— cmdStatus/cmdAccept 里都是直接 process.exit */
function bye(code) {
  releaseLock()
  process.exit(code)
}
function needGoal() {
  const g = readGoal(null)
  if (!g) die(2, '没有目标锁。先：node goal.js init --title "<任务>" --arch "<架构文档路径>"')
  return g
}
function findItem(g, id) {
  const it = g.items.find((x) => x.id === id)
  if (!it) {
    const ids = g.items.map((x) => x.id).join(' ')
    die(2, '没有这个条目 ' + id + '。现有：' + (ids || '(一条都没有，先 goal.js add)'))
  }
  return it
}

// ── 跑命令（证据的唯一来源）────────────────────────────
function runCmd(cmd, expect) {
  const t0 = new Date().toISOString()
  const r = spawnSync(String(cmd), {
    shell: true, encoding: 'utf8', timeout: 120000, windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  const out = ((r.stdout || '') + (r.stderr || '')).slice(0, OUT_MAX)
  const code = r.status === null || r.status === undefined ? -1 : r.status
  // ★ 零输出不是「没信息」。findstr / grep 找不到匹配时一条都不打 ——
  //   只回一句 exit=1，对看的人来说就是静默失败（这工作区踩过的反面模式）。
  //   所以零输出要显式说出来：它本身就是线索。
  const noOutput = out.trim() === ''
  const zeroNote = noOutput ? '（命令零输出 —— 空输出本身就是线索：判据要找的东西多半没找到）' : ''
  if (expect) {
    let re = null
    try { re = new RegExp(expect) } catch (e) {
      return { t0, out, code, ok: false, why: '正则本身不合法：' + e.message }
    }
    const matched = re.test(out)
    return {
      t0, out, code, ok: code === 0 && matched,
      why: matched ? '' : (code !== 0 ? 'exit=' + code + zeroNote : '输出不匹配 /' + expect + '/' + zeroNote),
    }
  }
  return { t0, out, code, ok: code === 0, why: code === 0 ? '' : 'exit=' + code + zeroNote }
}

// ── 验收判定（accept 与 status 共用，单一真相）─────────
//
// ★ 一票必须两票：**既要有 prove 留下的证据，又要判据现跑能过。**
//   2026-10-07 探针实测出来的洞：原来只看「判据命令跑不跑得过」，
//   于是【从来没 prove 过的条目】也能算「过」—— 「必须给证据」那条硬性要求直接变成摆设。
//   现在两票缺一不可：
//     · 证据 = prove 时实跑留下的（带 note「实际是什么」）—— 说明有人真的走过这一步；
//     · 判据 = accept 时【重新跑】—— 保证现在还成立，不吃老本。
function judgeItem(it) {
  const ev = (it.evidence || []).filter((e) => e && e.ok)
  if (!ev.length) {
    return {
      ok: false,
      why: it.cmd
        ? '还没 prove（没有有效证据）。跑：goal.js prove ' + it.id + ' --cmd "' + it.cmd + '" --note "<实际是什么>"'
        : '还没有证据文件。跑：goal.js prove ' + it.id + ' --file <证据文件> --note "<实际是什么>"',
    }
  }
  if (!it.cmd) {
    // 手工条目：看证据文件，且没过期
    const last = ev.filter((e) => e.file).pop()
    if (!last) return { ok: false, why: '证据不是 --file 形式（手工条目只认文件证据）' }
    const f = last.file
    try {
      const st = fs.statSync(f)
      if (st.size <= 0) return { ok: false, why: '证据文件是空的：' + f }
      const ageH = (Date.now() - st.mtimeMs) / 3600000
      if (ageH > EVIDENCE_TTL_H) return { ok: false, why: '证据文件已过期 ' + ageH.toFixed(1) + 'h（>' + EVIDENCE_TTL_H + 'h）：' + f }
    } catch (e) {
      return { ok: false, why: '证据文件不存在：' + f }
    }
    return { ok: true, why: '' }
  }
  // 机器条目：accept 必须【重新跑】，不许吃老本
  const r = runCmd(it.cmd, it.expect || null)
  return { ok: r.ok, why: r.ok ? '' : (r.why + (r.out ? '｜实际输出：' + r.out.slice(0, 300).replace(/\s+/g, ' ') : '')) }
}

function pendingItems(g) {
  return g.items.filter((it) => !judgeItem(it).ok)
}

// ── 子命令 ──────────────────────────────────────────────
// ── 从 stage 里认领冻结的 arch（不用手敲路径）──────────
//
// 用户诉求：「架构文档写完了就把它放到 stage 里面」—— stager put --kind arch 已经存了，
// 这里直接把它捡起来当目标锁的边界，少一次手敲路径（手敲 = 抄错 = 锁错边界）。
function findArchFromStage(stagerRoot) {
  const STAGER_ROOT = stagerRoot || 'E:/restart developing doer/stager'
  let activeId = null
  try { activeId = JSON.parse(fs.readFileSync(path.join(STAGER_ROOT, '.stager/active.json'), 'utf8')) } catch { /* 没有活动任务 */ }
  if (typeof activeId === 'string') activeId = activeId.replace(/^"|"$/g, '')
  if (!activeId) return { err: '没有活动 stage（active.json 为空）—— 要么先 stager start，要么直接 --arch <路径>' }
  const base = path.join(STAGER_ROOT, '.stager/tasks', activeId, 'docs')
  let man = null
  try { man = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')) } catch {
    return { err: '活动 stage 没有 manifest.json（还没 put 过文档）—— 先 stager put --kind arch，或直接 --arch <路径>' }
  }
  const archs = (man.docs || []).filter((d) => d.kind === 'arch')
  if (!archs.length) return { err: '活动 stage 里没有 kind=arch 的文档 —— 先 stager put --kind arch，或直接 --arch <路径>' }
  archs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  const last = archs[0]
  // 冻结副本（file）优先，原件（from）兜底
  for (const cand of [last.file && path.join(base, last.file), last.from]) {
    if (cand && fs.existsSync(cand)) return { path: cand, title: last.title, id: last.id, round: last.round, stage: last.stage }
  }
  return { err: 'arch 记录在册但文件都不在了：' + JSON.stringify({ file: last.file, from: last.from }) }
}

function cmdInit() {
  let arch = argv.arch
  let from = null
  if (argv['from-stage']) {
    const r = findArchFromStage(argv['stager-root'])   // --stager-root 是测试钩子（也便于工作区搬家）
    if (r.err) die(2, r.err)
    arch = r.path; from = r
  }
  if (readGoal(null)) die(2, '已经有一把目标锁了（' + STATE_FILE + '）。先 goal.js clear --yes 再 init。')
  const title = argv.title
  if (!title || !arch) die(2, '缺 --title 或 --arch（也可以 --from-stage 自动认领 stage 里冻结的 arch）')
  if (!fs.existsSync(arch)) die(2, '架构文档不存在：' + arch)
  const g = {
    version: 1,
    title: String(title),
    arch: path.resolve(String(arch)),
    frozenAt: new Date().toISOString(),
    fromStage: from,
    status: 'active',
    pauseReason: '',
    createdAt: new Date().toISOString(),
    rev: 0,
    sessions: [],
    // ★ 自动催跑/断流续跑/压缩注入**一次只盯一个窗口**（2026-10-07 用户定的语义）：
    //   sessions = 认过这把锁的窗口（都拿到过边界注入）；activeSession = 其中最近有动静的那个。
    //   只认 sessions 不认 activeSession 的话，每个开过的窗口空闲时都会被催 —— 「反倒停不下来」。
    activeSession: null,
    nudges: { count: 0, lastAt: null, max: parseInt(argv.max || '80', 10), cooldownSec: parseInt(argv.cooldown || '120', 10) },
    stream: { count: 0, lastAt: null, max: 6 },
    items: [],
  }
  writeGoal(g)
  console.log('✔ 目标锁已上：' + g.title)
  console.log('  架构边界：' + g.arch)
  console.log('  下一步：goal.js add "<验收条目>" --cmd "<能判定它真成了的命令>"')
  console.log('  ★ 没有可判定条目 = 这把锁没意义（accept 会拒）。')
}

function cmdAdd() {
  const g = needGoal()
  const title = argv._[1]
  if (!title) die(2, '缺条目标题。用法：goal.js add "<验收条目>" --cmd "…"')
  const idx = g.items.length + 1
  const id = argv.id || ('A' + idx)
  if (g.items.some((x) => x.id === id)) die(2, '条目 id 重复：' + id)
  const item = {
    id: String(id),
    title: String(title),
    how: String(argv.how || ''),
    cmd: String(argv.cmd || ''),
    expect: String(argv.expect || ''),
    status: 'pending',
    createdAt: new Date().toISOString(),
    evidence: [],
    lastFail: null,
  }
  g.items.push(item)
  writeGoal(g)
  console.log('✔ 加了条目 ' + item.id + '：' + item.title)
  if (!item.cmd) {
    console.log('  ⚠ 没给 --cmd —— 这是手工条目，验收时只认 --file 证据（72h 内、非空）。')
    console.log('    能写成命令的尽量写成命令：证据跑出来比说出来可靠。')
  } else {
    console.log('  判据：' + item.cmd + (item.expect ? '  期望输出匹配 /' + item.expect + '/' : ''))
    const r = runCmd(item.cmd, item.expect || null)
    console.log('  试跑：' + (r.ok ? '✔ 过（' + r.code + '）' : '✘ 现在还不通过 —— ' + r.why))
    if (!r.ok && r.out) console.log('         ' + r.out.slice(0, 200).replace(/\s+/g, ' '))
  }
}

function cmdStatus() {
  const g = readGoal(null)
  if (!g) { console.log('（没有目标锁）'); bye(2) }
  const rows = g.items.map((it) => {
    const j = judgeItem(it)
    const last = (it.evidence || [])[it.evidence.length - 1]
    return { id: it.id, title: it.title, ok: j.ok, why: j.why, at: last ? last.at : '' }
  })
  const bad = rows.filter((r) => !r.ok)
  const out = {
    title: g.title, arch: g.arch, status: g.status, pauseReason: g.pauseReason || '',
    items: g.items.length, ok: rows.length - bad.length, bad: bad.length,
    nudges: g.nudges, stream: g.stream, rev: g.rev,
    bound: (g.sessions || []).length, activeSession: g.activeSession || null,
    pending: bad.map((r) => ({ id: r.id, title: r.title, why: r.why })),
  }
  if (argv.json) { console.log(JSON.stringify(out, null, 1)) }
  else {
    console.log('目标锁：' + g.title + '　状态=' + g.status + (g.status === 'paused' ? '（' + g.pauseReason + '）' : ''))
    console.log('架构边界：' + g.arch)
    console.log('')
    for (const r of rows) {
      console.log('  ' + (r.ok ? '[OK]' : '[  ]') + ' ' + r.id + '  ' + r.title + (r.at ? '   证据 ' + r.at : ''))
      if (!r.ok && r.why) console.log('        ↳ ' + r.why)
    }
    console.log('')
    console.log('验收：' + (rows.length - bad.length) + '/' + rows.length + ' 过' +
      (bad.length ? '　★ 还差 ' + bad.length + ' 条 —— goal.status != accepted，goal-drive 会继续催' : '　→ 跑 goal.js accept 做最终验收'))
    console.log('催跑：' + (g.nudges.count || 0) + '/' + (g.nudges.max || 80) + ' 次' +
      (g.nudges.lastAt ? '（上次 ' + g.nudges.lastAt + '）' : ''))
    console.log('盯的窗口：' + (g.activeSession || '（还没有窗口拿到边界注入 → 现在谁都不会被催/续）') +
      '　认过锁的窗口 ' + (g.sessions || []).length + ' 个，只盯最近有动静的那个')
  }
  bye(bad.length || g.status !== 'accepted' ? 1 : 0)
}

function cmdProve() {
  const g = needGoal()
  const id = argv._[1]
  if (!id) die(2, '缺条目 id。用法：goal.js prove A1 --cmd "<命令>" --note "<实际是什么>"')
  const it = findItem(g, id)
  const note = String(argv.note || '').trim()
  if (!note) die(2, '--note 不许空 —— 硬性要求：说清「实际是什么」，不是「我认为完成了」。' +
    '\n   例：--note "A1 装备栏读取：实际读到 36 格、第 5 格是铁镐（非预期为空）"')

  const ev = { at: new Date().toISOString(), note, cmd: '', out: '', code: null, file: '', ok: false }

  if (argv.cmd) {
    const provided = String(argv.cmd).trim()

    // ★ 判据口径不许悄悄换 —— 「换个更容易的命令」是最省事的一种作弊。
    //   add 时定死的判据要改，必须显式 --rejudge，并且旧判据留痕（judgeHistory）。
    if (it.cmd && it.cmd.trim() !== provided) {
      if (!argv.rejudge) {
        die(2, '判据口径对不上：\n' +
          '   本条目 add 时定的判据：' + it.cmd + '\n' +
          '   你这次给的命令：      ' + provided + '\n' +
          '   → 换判据要显式加 --rejudge（旧判据会写进 judgeHistory 留痕，别偷着换标准）。')
      }
      it.judgeHistory = it.judgeHistory || []
      it.judgeHistory.push({ at: new Date().toISOString(), old: it.cmd, new: provided, note })
      it.cmd = provided
      if (argv.expect) it.expect = String(argv.expect)
      console.log('⚠ 判据已改（--rejudge）：' + it.judgeHistory[it.judgeHistory.length - 1].old + '  →  ' + it.cmd)
    }
    if (!it.cmd) {
      // add 时没给 --cmd（手工条目）→ 用这条实跑命令当机器判据（升级成机器可验）
      it.cmd = provided
      if (argv.expect) it.expect = String(argv.expect)
      console.log('↑ 本条从手工条目升级为机器判据：' + it.cmd)
    }

    const r = runCmd(provided, argv.expect ? String(argv.expect) : (it.expect || null))
    ev.cmd = provided; ev.out = r.out; ev.code = r.code; ev.ok = r.ok
    it.evidence = it.evidence || []; it.evidence.push(ev)
    if (!r.ok) {
      it.status = 'pending'
      it.lastFail = { at: ev.at, why: r.why }
      writeGoal(g)
      die(1, '证据没收（判据没过）：' + r.why +
        (r.out ? '\n   实际输出：' + r.out.slice(0, 500).replace(/\s+/g, ' ') : '') +
        '\n   → 没过就是没完成，别改口径、别换个容易的命令重试。')
    }
    it.status = 'proved'
    it.lastFail = null
    writeGoal(g)
    console.log('✔ ' + it.id + ' 证据已收（实跑通过）')
    console.log('   命令：' + ev.cmd)
    console.log('   exit=' + ev.code + '　输出：' + (ev.out.slice(0, 300).replace(/\s+/g, ' ') || '(空)'))
    console.log('   实际：' + note)
    console.log('   ★ accept 时会把这条命令【重新跑一遍】，证据不吃老本。')
  } else if (argv.file) {
    const f = path.resolve(String(argv.file))
    if (!fs.existsSync(f)) die(2, '证据文件不存在：' + f)
    const st = fs.statSync(f)
    if (st.size <= 0) die(2, '证据文件是空的：' + f)
    ev.file = f; ev.ok = true
    it.evidence = it.evidence || []; it.evidence.push(ev)
    it.status = 'proved'
    it.lastFail = null
    writeGoal(g)
    console.log('✔ ' + it.id + ' 证据已收：' + f + '（' + st.size + ' 字节，' + st.mtime.toISOString() + '）')
    console.log('   实际：' + note)
    console.log('   ★ 手工证据 ' + EVIDENCE_TTL_H + ' 小时后过期，accept 会核。')
  } else {
    die(2, '要么 --cmd "<实跑的命令>"，要么 --file <证据文件>。光说不算证据。')
  }
}

function cmdAccept() {
  const g = needGoal()
  if (g.status === 'paused') die(2, '目标锁处于 paused（' + g.pauseReason + '）。先 goal.js resume。')
  if (!g.items.length) die(2, '一条验收条目都没有 —— 空验收不算验收。先 goal.js add。')

  const fails = []
  for (const it of g.items) {
    const j = judgeItem(it)
    if (j.ok) { it.status = 'proved'; it.lastFail = null }
    else { it.status = 'pending'; it.lastFail = { at: new Date().toISOString(), why: j.why }; fails.push({ id: it.id, title: it.title, why: j.why }) }
  }

  if (fails.length) {
    g.status = 'active'   // 验收没过就还是没完成 —— 留着 active，goal-drive 继续催
    writeGoal(g)
    process.stderr.write('✘ 最终验收未通过：' + fails.length + '/' + g.items.length + ' 条不过\n')
    for (const f of fails) {
      process.stderr.write('   [  ] ' + f.id + ' ' + f.title + '\n        ↳ ' + f.why + '\n')
    }
    process.stderr.write('→ 有一条不过就不是完成。goal-drive 会继续催，直到全过。\n')
    bye(1)
  }

  g.status = 'accepted'
  g.acceptedAt = new Date().toISOString()
  writeGoal(g)
  console.log('✔✔ 最终验收通过：' + g.items.length + '/' + g.items.length + ' 条（每条都是刚复跑出来的结果）')
  console.log('   目标：' + g.title)
  console.log('   架构：' + g.arch)
  console.log('   验收于：' + g.acceptedAt)
  console.log('   ★ goal.status=accepted —— goal-drive 从现在起不再催跑。')
  bye(0)
}

function cmdPause() {
  const g = needGoal()
  const reason = String(argv.reason || '').trim()
  if (!reason) die(2, 'pause 必须带 --reason —— 「停」也要留痕，否则和「忘了」分不开。')
  g.status = 'paused'; g.pauseReason = reason
  writeGoal(g)
  console.log('✔ 已暂停催跑：' + reason)
  console.log('   （状态锁还在，resume 之后接着逼；accept 期间会被拒）')
}
function cmdResume() {
  const g = needGoal()
  if (g.status === 'accepted') { console.log('已经验收通过了，没有可恢复的。'); return }
  g.status = 'active'; g.pauseReason = ''
  g.nudges.lastAt = null   // 恢复后立刻允许催一次
  writeGoal(g)
  console.log('✔ 恢复催跑。goal.status=active')
}
function cmdClear() {
  if (!argv.yes) die(2, 'clear 会删掉整把目标锁（含全部证据历史）。确认请加 --yes。')
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE)
  console.log('✔ 目标锁已清除：' + STATE_FILE)
}

// ── 催跑文案（插件也用它 —— 单一真相）─────────────────
// ★ pendList 可以由调用方传入：插件在事件钩子里【不能】逐条实跑判据命令
//   （每条最多 120s，会把事件循环挂住）。插件用 item.status 做快速估算，
//   最终权威始终是 accept 的复跑 —— 两边都只读同一份 goal.json。
function buildNudge(g, pendList) {
  const pend = pendList || g.items.map((it) => ({ it, j: judgeItem(it) })).filter((x) => !x.j.ok)
  const L = []
  L.push('[GOAL-DRIVE 架构目标锁 · 系统自动催跑，不是用户新指令]')
  L.push('')
  L.push('架构还没验收完（' + (g.items.length - pend.length) + '/' + g.items.length + ' 过），按边界继续做，别停。')
  L.push('· 目标：' + g.title)
  L.push('· 边界（冻结的架构文档）：' + g.arch)
  if (pend.length) {
    L.push('')
    L.push('未验收：')
    for (const x of pend) {
      L.push('  [' + x.it.id + '] ' + x.it.title)
      if (x.it.how) L.push('        完成长什么样：' + x.it.how)
      if (x.j.why) L.push('        还差：' + x.j.why.slice(0, 200))
    }
  } else {
    L.push('')
    L.push('★ 所有条目都 proved 了 —— 但没跑 accept 就不算完成。立刻跑最终验收。')
  }
  L.push('')
  L.push('硬性规矩（对每一条）：')
  L.push('1. 不许用「写了文档 / 我认为完成了」冒充完成。每完成一条，跑：')
  L.push('     node "E:\\新建文件夹\\rddharness\\bin\\goal.js" prove ' + (pend[0] ? pend[0].it.id : 'A1') +
    ' --cmd "<能判定它真成了的命令>" --note "<实际是什么>"')
  L.push('   证据是【跑出来的输出】，accept 时还会重新跑一遍 —— 手打的字不算。')
  L.push('2. 每条收尾自问三连，答不上来就是没完成：')
  L.push('     我这里完成了？证据是什么？实际是什么？它能撑起最终验收吗？')
  L.push('3. 全部 prove 过之后跑最终验收：')
  L.push('     node "E:\\新建文件夹\\rddharness\\bin\\goal.js" accept')
  L.push('   accept 逐条复跑判据，有一条不过就是没完成 —— 继续干。')
  L.push('4. 真卡住 / 在等用户拍板 → 停下来留痕，别硬编：')
  L.push('     node "E:\\新建文件夹\\rddharness\\bin\\goal.js" pause --reason "<卡在哪>"')
  L.push('   （pause 了我就不催；resume 之后接着逼。）')
  L.push('')
  L.push('（第 ' + ((g.nudges && g.nudges.count) || 0) + ' 次催跑' +
    ((g.nudges && g.nudges.max) ? '，上限 ' + g.nudges.max + ' 次' : '') +
    '；accept 全过我就不催了。）')
  return L.join('\n')
}

function cmdDrive() {
  const g = needGoal()
  if (g.status !== 'active') { console.log('（状态 ' + g.status + '，不催）'); return }
  const pend = pendingItems(g)
  if (!pend.length) { console.log('（全部条目都过了 —— 跑 goal.js accept 做最终验收）'); return }
  console.log(buildNudge(g))
}

// ── 导出（给 goal-drive 插件 import，单一真相）─────────
module.exports = { DEFAULT_STATE, readGoal, writeGoal, judgeItem, pendingItems, buildNudge, runCmd, findArchFromStage, withLock }

// ── CLI 入口 ────────────────────────────────────────────
if (require.main === module) {
  const map = {
    init: cmdInit, add: cmdAdd, status: cmdStatus, prove: cmdProve,
    accept: cmdAccept, pause: cmdPause, resume: cmdResume, drive: cmdDrive, clear: cmdClear,
  }
  // ★ 只有「改状态」的命令才上锁；status / drive 是只读的，不跟自己抢
  const MUTATING = new Set(['init', 'add', 'prove', 'accept', 'pause', 'resume', 'clear'])
  const fn = map[CMD]
  if (!fn) {
    process.stderr.write([
      '用法：node goal.js <命令>',
      '  init   --title "<任务>" --arch "<架构文档路径>"      上目标锁',
      '         --title "<任务>" --from-stage                 自动认领 stage 里冻结的 arch',
      '  add    "<验收条目>" [--id A1] [--how "<完成长什么样>"] [--cmd "<判据命令>"] [--expect "<正则>"]',
      '  status [--json]                                     看还差什么（有未过条目 exit=1）',
      '  prove  <id> --cmd "<命令>" --note "<实际是什么>"      证据：实跑命令并存输出',
      '         <id> --file <证据文件> --note "<实际是什么>"    手工证据（72h 内有效）',
      '         ★ 命令必须和 add 时的判据一致；换判据要 --rejudge（旧判据留痕）',
      '  accept                                            ★最终验收：逐条复跑，全过才 exit=0',
      '  pause --reason "<卡在哪>"  /  resume',
      '  drive                                             打印催跑文案（正常由插件注入）',
      '  clear --yes',
      '',
      '退出码：0=过  1=没过（有条目未验收）  2=用法/状态错',
      '状态文件：' + STATE_FILE,
    ].join('\n'))
    process.exit(2)
  }
  try { MUTATING.has(CMD) ? withLock(fn) : fn() } catch (e) {
    process.stderr.write('✘ 异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : String(e)) + '\n')
    process.exit(2)
  }
}
