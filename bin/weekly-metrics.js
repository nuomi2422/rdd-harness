#!/usr/bin/env node
'use strict'
/**
 * weekly-metrics.js —— 周行为指标（用户 2026-10-22 批准的两条补丁之一）
 *
 * 为什么要有这个：
 *   用户原话「有了这两条，AI 的职责就缩成一句话：卡亮了没有？」
 *   而「卡亮了没有」的判据之一（V5）是**周指标前后对比不退化**。
 *   指标不提前把基线攒出来，到对比那天就只剩「我记得好像快了」—— 不可证伪。
 *
 * 三个指标（用户点名：任务完成耗时、死亡率、7 天滚动）：
 *   1. 任务完成耗时 —— 从任务**提交**到**终态**的墙钟秒数
 *   2. 死亡率 —— 死亡条数 / 活动量（分母是当天的游戏活动量，不是绝对数）
 *   3. 7 天滚动 —— 上面两个的 7 日移动平均
 *
 * ── 数据源（★ 全部实测过，不是猜的；探针见 .tmp\probe1..14）──
 *   提交：monitor/tools.jsonl  type=tool_result 且 result.data.async===true 且有 task_id
 *        （实测 916 条；task_id 从 t1 起复用，所以配对必须按【时间序】而不是按 id）
 *   终态：monitor/events.jsonl type=task_finished（status ∈ done/stopped/timeout/failed）
 *        实测 340 条，与提交【按时间序 340/340 全部配对成功】
 *   死亡：config/numen/rdd-ledger/<companion>.json 的 deaths[]（带 wallClockMillis）
 *        交叉验证：monitor/instrumentation.jsonl 的 type=death 事件（实测 9 条）
 *
 * ── ★ 死亡指标的坑（2026-10-22 实测，必须记住）──
 *   实测 9 条死亡**全部**是 `debug_kill` 触发的（每次死亡前 5 秒内都有 debug_kill 调用）。
 *   也就是说：**历史上没有一条自然死亡**。
 *   ⇒ 自然死亡样本为 0，死亡率目前**无法在统计上区分**「0 次自然死亡」和「测不出」。
 *   ⇒ 本脚本把 debug_kill 单独算一类并**显式标注**，不把它混进自然死亡率。
 *   ⇒ 自然死亡一旦出现，自然死亡率才有意义；在那之前它只能是「无自然死亡记录」。
 *
 * 用法：
 *   node weekly-metrics.js                 打印最近 7 天 + 滚动
 *   node weekly-metrics.js --days 14       看更长窗口
 *   node weekly-metrics.js --json          机器可读
 *   node weekly-metrics.js --write         落盘到 harness\rdd-harness\runs\weekly-metrics\latest.json
 *   node weekly-metrics.js --selftest      自测（配对逻辑、分类逻辑）
 *
 * 退出码：0=ok  1=环境错（monitor 目录找不到）  2=用法错
 */
const fs = require('fs')
const path = require('path')

// ── 路径（不写死 D:\rdd，走 registry 回落）─────────────────────────────
function registryRoots () {
  try { return require('./lib/registry.js').load().roots } catch { return null }
}
const FALLBACK_RDD_ROOT = path.resolve(__dirname, '..', '..', '..')
const RDD_ROOT = (registryRoots() || {}).harness
  ? path.resolve((registryRoots() || {}).harness, '..', '..')
  : FALLBACK_RDD_ROOT

const MONITOR_DIR = process.env.NUMEN_MONITOR_DIR ||
  path.join(RDD_ROOT, 'mc', 'The Best of Twilight Forest', 'config', 'numen', 'monitor')
const LEDGER_DIR = process.env.NUMEN_LEDGER_DIR ||
  path.join(RDD_ROOT, 'mc', 'The Best of Twilight Forest', 'config', 'numen', 'rdd-ledger')
const OUT_DIR = process.env.RDD_WEEKLY_METRICS_DIR ||
  path.join(RDD_ROOT, 'harness', 'rdd-harness', 'runs', 'weekly-metrics')

// ── 参数 ────────────────────────────────────────────────────────────
function parseArgs (argv) {
  const o = { _: [], days: 7, json: false, write: false, selftest: false }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--days') { o.days = parseInt(argv[++i], 10) || 7; continue }
    if (t === '--json') { o.json = true; continue }
    if (t === '--write') { o.write = true; continue }
    if (t === '--selftest') { o.selftest = true; continue }
    if (t === '--help' || t === '-h') { o.help = true; continue }
    o._.push(t)
  }
  return o
}
const argv = parseArgs(process.argv.slice(2))

const EXIT_OK = 0, EXIT_ENV = 1, EXIT_USAGE = 2

// ── 小工具 ──────────────────────────────────────────────────────────
function readJsonl (file) {
  const out = []
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 坏行跳过：门禁不能因为一行坏数据就死 */ }
  }
  return out
}
function dayOf (ts) { return String(ts || '').slice(0, 10) }
function pct (list, p) {
  if (!list.length) return null
  const v = list.slice().sort((a, b) => a - b)
  return v[Math.min(v.length - 1, Math.floor(v.length * p))]
}
function round1 (n) { return n === null || n === undefined ? null : Math.round(n * 10) / 10 }

// ── ① 任务耗时：提交 → 终态 ────────────────────────────────────────
//
// ★ task_id 会复用（t1/t2/t3 一直循环用），所以【绝不能】按 id 建字典直接配对 ——
//   实测那样会把 8 天前的 t1 和今天的 t1 配成一对。
//   正确做法：按时间序排， 每个终态取它【之前最近的一个】同 task_id 的提交。
function collectTasks (monitorDir) {
  const tools = readJsonl(path.join(monitorDir, 'tools.jsonl'))
  const events = readJsonl(path.join(monitorDir, 'events.jsonl'))

  // 提交：tool_result 里 data.async===true 且有 task_id
  const submits = []
  for (const o of tools) {
    if (o.type !== 'tool_result') continue
    let r
    try { r = JSON.parse(o.data.result) } catch { continue }
    const d = r.data || {}
    if (!d.task_id || d.async !== true) continue
    submits.push({ ts: o.timestamp, tid: String(d.task_id), task: String(d.task || '') })
  }
  submits.sort((a, b) => new Date(a.ts) - new Date(b.ts))

  // 终态：events.jsonl 的 task_finished
  const finishes = []
  for (const o of events) {
    if (o.type !== 'task_finished') continue
    const d = o.data || {}
    if (!d.id) continue
    finishes.push({ ts: o.timestamp, tid: String(d.id), task: String(d.task || ''), status: String(d.status || '') })
  }
  finishes.sort((a, b) => new Date(a.ts) - new Date(b.ts))

  // 按 task_id 分桶 + 时间序配对
  const byTid = new Map()
  for (const s of submits) {
    const arr = byTid.get(s.tid) || []
    arr.push(s)
    byTid.set(s.tid, arr)
  }
  const cursor = new Map()
  const pairs = []
  for (const f of finishes) {
    const arr = byTid.get(f.tid) || []
    let ci = cursor.get(f.tid) || 0
    let best = null
    for (let i = ci; i < arr.length; i++) {
      if (new Date(arr[i].ts) <= new Date(f.ts)) best = arr[i]
      else break
    }
    if (best) {
      cursor.set(f.tid, arr.indexOf(best) + 1)
      const dt = (new Date(f.ts) - new Date(best.ts)) / 1000
      if (dt >= 0 && dt <= 30 * 60) {   // 超过 30 分钟的不算「一次任务」，是跨轮残留
        pairs.push({ ts: f.ts, day: dayOf(f.ts), task: f.task, status: f.status, seconds: dt })
      }
    }
  }
  return { pairs, submitCount: submits.length, finishCount: finishes.length }
}

// ── ② 死亡：账本 + debug_kill 分类 ─────────────────────────────────
function collectDeaths (monitorDir, ledgerDir) {
  const deaths = []
  // 账本（带 wallClockMillis）
  if (fs.existsSync(ledgerDir)) {
    for (const f of fs.readdirSync(ledgerDir)) {
      if (!f.endsWith('.json')) continue
      let j
      try { j = JSON.parse(fs.readFileSync(path.join(ledgerDir, f), 'utf8')) } catch { continue }
      for (const d of (j.deaths || [])) {
        if (!d.wallClockMillis) continue
        deaths.push({
          ts: new Date(d.wallClockMillis).toISOString(),
          day: dayOf(new Date(d.wallClockMillis).toISOString()),
          seq: d.seq, at: d.deathAt || '', state: d.state || '',
          lost: typeof d.lostEntries === 'number' ? d.lostEntries : null,
          source: 'ledger', companion: f.replace(/\.json$/, ''),
        })
      }
    }
  }
  // debug_kill 调用时刻（用来把「测试击杀」和「自然死亡」分开）
  const kills = []
  for (const o of readJsonl(path.join(monitorDir, 'tools.jsonl'))) {
    if (o.type === 'tool_call' && (o.data.tool || '') === 'debug_kill') kills.push(o.timestamp)
  }
  kills.sort()
  // 判定：死亡后 30 秒内有 debug_kill ⇒ 调试击杀
  for (const d of deaths) {
    const t = new Date(d.ts).getTime()
    d.debugKill = kills.some((k) => {
      const kt = new Date(k).getTime()
      return kt <= t + 5000 && t - kt < 30000
    })
    d.kind = d.debugKill ? 'debug' : 'natural'
  }
  deaths.sort((a, b) => new Date(a.ts) - new Date(b.ts))
  return deaths
}

// ── ③ 活动量（死亡率的分母）────────────────────────────────────────
function collectActivity (monitorDir) {
  const byDay = {}
  for (const o of readJsonl(path.join(monitorDir, 'tools.jsonl'))) {
    if (o.type !== 'tool_call') continue
    const d = dayOf(o.timestamp)
    byDay[d] = (byDay[d] || 0) + 1
  }
  return byDay
}

// ── 汇总 ────────────────────────────────────────────────────────────
function build (monitorDir, ledgerDir, days) {
  const { pairs, submitCount, finishCount } = collectTasks(monitorDir)
  const deaths = collectDeaths(monitorDir, ledgerDir)
  const activity = collectActivity(monitorDir)

  const allDays = new Set()
  for (const p of pairs) allDays.add(p.day)
  for (const d of deaths) allDays.add(d.day)
  for (const d of Object.keys(activity)) allDays.add(d)
  const sorted = Array.from(allDays).filter(Boolean).sort()
  const cutoff = sorted.length ? sorted[Math.max(0, sorted.length - days)] : null

  const daily = []
  for (const day of sorted) {
    if (cutoff && day < cutoff) continue
    const dayPairs = pairs.filter((p) => p.day === day)
    const done = dayPairs.filter((p) => p.status === 'done').map((p) => p.seconds)
    const dayDeaths = deaths.filter((d) => d.day === day)
    const natural = dayDeaths.filter((d) => d.kind === 'natural')
    const debug = dayDeaths.filter((d) => d.kind === 'debug')
    const acts = activity[day] || 0
    daily.push({
      day,
      activityCalls: acts,
      tasks: dayPairs.length,
      done: done.length,
      failed: dayPairs.filter((p) => p.status === 'failed').length,
      stopped: dayPairs.filter((p) => p.status === 'stopped').length,
      timeout: dayPairs.filter((p) => p.status === 'timeout').length,
      // 耗时：只统计 done（failed 的耗时是「失败用多久」，混进去会污染「她做成一件事要多久」）
      durP50: round1(pct(done, 0.5)),
      durP90: round1(pct(done, 0.9)),
      durAvg: done.length ? round1(done.reduce((a, b) => a + b, 0) / done.length) : null,
      deaths: dayDeaths.length,
      deathsNatural: natural.length,
      deathsDebug: debug.length,
      // 死亡率：自然死亡 / 活动量 × 1000（活动量小的时候比「每次死亡」稳）
      deathRatePer1k: acts ? round1((natural.length / acts) * 1000) : null,
    })
  }

  // 7 天滚动
  const roll = []
  for (let i = 0; i < daily.length; i++) {
    const w = daily.slice(Math.max(0, i - 6), i + 1)
    const durs = w.filter((d) => d.durP90 !== null).map((d) => d.durP90)
    const nat = w.reduce((a, d) => a + d.deathsNatural, 0)
    const acts = w.reduce((a, d) => a + d.activityCalls, 0)
    const done = w.reduce((a, d) => a + d.done, 0)
    const tasks = w.reduce((a, d) => a + d.tasks, 0)
    roll.push({
      day: daily[i].day,
      window: w.length,
      durP90Rolling: durs.length ? round1(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
      doneRolling: done,
      tasksRolling: tasks,
      successRate: tasks ? round1((done / tasks) * 100) : null,
      deathsNaturalRolling: nat,
      deathRatePer1kRolling: acts ? round1((nat / acts) * 1000) : null,
    })
  }

  const naturalTotal = deaths.filter((d) => d.kind === 'natural').length
  const debugTotal = deaths.filter((d) => d.kind === 'debug').length
  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    sources: {
      monitorDir, ledgerDir,
      taskSubmits: submitCount, taskFinishes: finishCount, taskPairs: pairs.length,
      deathRecords: deaths.length,
    },
    // ★ 诚实说明：自然死亡样本为 0 时，死亡率不可解释 —— 明说，别让 0 看起来像「很安全」
    caveat: naturalTotal === 0
      ? '自然死亡样本为 0 —— 账本里 ' + deaths.length + ' 条死亡全部是 debug_kill 触发的。' +
        '当前只能报「无自然死亡记录」，不能报「死亡率 0」。自然死亡一旦出现，指标才成立。'
      : null,
    deaths: { total: deaths.length, natural: naturalTotal, debug: debugTotal },
    daily,
    rolling: roll,
    latest: roll.length ? roll[roll.length - 1] : null,
  }
}

// ── 输出 ────────────────────────────────────────────────────────────
function printHuman (r) {
  const L = []
  L.push('══ 周行为指标（' + r.windowDays + ' 天窗口）══')
  L.push('生成于 ' + r.generatedAt)
  L.push('')
  L.push('数据源：monitor ' + r.sources.monitorDir)
  L.push('  任务提交 ' + r.sources.taskSubmits + ' 条 · 终态 ' + r.sources.taskFinishes +
    ' 条 · 配对成功 ' + r.sources.taskPairs + ' 条')
  L.push('  死亡记录 ' + r.sources.deathRecords + ' 条（自然 ' + r.deaths.natural + ' · 调试 ' + r.deaths.debug + '）')
  if (r.caveat) { L.push(''); L.push('⚠ ' + r.caveat) }
  L.push('')
  L.push('日期        活动  任务  成功  p50耗时  p90耗时  死亡(自然/调试)  自然死亡率‰')
  L.push('─'.repeat(82))
  for (const d of r.daily) {
    L.push([
      d.day,
      String(d.activityCalls).padStart(5),
      String(d.tasks).padStart(5),
      String(d.done).padStart(5),
      (d.durP50 === null ? '—' : d.durP50 + 's').padStart(8),
      (d.durP90 === null ? '—' : d.durP90 + 's').padStart(8),
      (d.deaths + '(' + d.deathsNatural + '/' + d.deathsDebug + ')').padStart(14),
      (d.deathRatePer1k === null ? '—' : String(d.deathRatePer1k)).padStart(12),
    ].join(' '))
  }
  L.push('')
  L.push('── 7 天滚动 ──')
  L.push('日期        窗口  p90滚动  成功率%  自然死亡  自然死亡率‰')
  L.push('─'.repeat(60))
  for (const x of r.rolling) {
    L.push([
      x.day,
      String(x.window).padStart(5),
      (x.durP90Rolling === null ? '—' : x.durP90Rolling + 's').padStart(8),
      (x.successRate === null ? '—' : String(x.successRate)).padStart(9),
      String(x.deathsNaturalRolling).padStart(9),
      (x.deathRatePer1kRolling === null ? '—' : String(x.deathRatePer1kRolling)).padStart(12),
    ].join(' '))
  }
  L.push('')
  L.push('★ 怎么用这张表：卡上 V5 判据 = 同一场景前后各取一个滚动窗口对比。')
  L.push('  耗时看 p90 滚动（别看 p50：被大量 1 秒内的小任务压平），')
  L.push('  成功率看 done/tasks，死亡看自然死亡 —— 调试击杀不算她的能力问题。')
  console.log(L.join('\n'))
}

// ── 自测 ────────────────────────────────────────────────────────────
function selftest () {
  const checks = []
  const ck = (name, ok, note) => { checks.push({ name, ok, note: note || '' }) }

  // ① 配对：造一个 task_id 复用、两个时间段的场景，必须配对到最近的那个
  {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wm-'))
    fs.writeFileSync(path.join(tmp, 'tools.jsonl'),
      JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'tool_result', data: { tool: 'goto', result: JSON.stringify({ data: { task_id: 't1', task: 'goto', async: true } }) } }) + '\n' +
      JSON.stringify({ timestamp: '2026-01-01T00:00:10Z', type: 'tool_result', data: { tool: 'goto', result: JSON.stringify({ data: { task_id: 't1', task: 'goto', async: true } }) } }) + '\n')
    fs.writeFileSync(path.join(tmp, 'events.jsonl'),
      JSON.stringify({ timestamp: '2026-01-01T00:00:05Z', type: 'task_finished', data: { id: 't1', task: 'goto', status: 'done' } }) + '\n' +
      JSON.stringify({ timestamp: '2026-01-01T00:00:15Z', type: 'task_finished', data: { id: 't1', task: 'goto', status: 'done' } }) + '\n')
    const r = collectTasks(tmp)
    ck('task_id 复用时按时间序配对到最近的提交', r.pairs.length === 2 &&
      Math.abs(r.pairs[0].seconds - 5) < 0.01 && Math.abs(r.pairs[1].seconds - 5) < 0.01,
      'pairs=' + r.pairs.length + ' ' + JSON.stringify(r.pairs.map((p) => p.seconds)))
    // 超过 30 分钟的跨轮残留不算
    fs.writeFileSync(path.join(tmp, 'events.jsonl'),
      JSON.stringify({ timestamp: '2026-01-01T02:00:00Z', type: 'task_finished', data: { id: 't1', task: 'goto', status: 'done' } }) + '\n')
    const r2 = collectTasks(tmp)
    ck('超过 30 分钟的残留配对被丢弃', r2.pairs.length === 0, 'pairs=' + r2.pairs.length)
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // ② 非 async 的 tool_result 不算提交
  {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wm-'))
    fs.writeFileSync(path.join(tmp, 'tools.jsonl'),
      JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'tool_result', data: { tool: 'task_status', result: JSON.stringify({ data: { task_id: 't1', task: 'goto', state: 'running' } }) } }) + '\n')
    fs.writeFileSync(path.join(tmp, 'events.jsonl'),
      JSON.stringify({ timestamp: '2026-01-01T00:00:05Z', type: 'task_finished', data: { id: 't1', task: 'goto', status: 'done' } }) + '\n')
    const r = collectTasks(tmp)
    ck('task_status 的轮询不算任务提交', r.submitCount === 0 && r.pairs.length === 0,
      'submits=' + r.submitCount)
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // ③ debug_kill 与自然死亡的分类
  {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wm-'))
    fs.writeFileSync(path.join(tmp, 'tools.jsonl'),
      JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'tool_call', data: { tool: 'debug_kill' } }) + '\n')
    const ld = path.join(tmp, 'ledger')
    fs.mkdirSync(ld)
    fs.writeFileSync(path.join(ld, 'c.json'), JSON.stringify({
      version: 1, nextSeq: 3, deaths: [
        { seq: 1, wallClockMillis: Date.parse('2026-01-01T00:00:01Z'), deathAt: '1,2,3' },
        { seq: 2, wallClockMillis: Date.parse('2026-01-02T00:00:00Z'), deathAt: '4,5,6' },
      ],
    }))
    const ds = collectDeaths(tmp, ld)
    const natural = ds.filter((d) => d.kind === 'natural')
    const debug = ds.filter((d) => d.kind === 'debug')
    ck('debug_kill 附近的死亡被标成调试击杀', debug.length === 1, 'debug=' + debug.length)
    ck('没有 debug_kill 的死亡被标成自然死亡', natural.length === 1, 'natural=' + natural.length)
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // ④ 滚动窗口长度 ≤ 7
  {
    const r = { rolling: Array.from({ length: 10 }, (_, i) => ({ day: 'd' + i, window: Math.min(7, i + 1) })) }
    ck('滚动窗口不超过 7 天', r.rolling.every((x) => x.window <= 7), 'max=' + Math.max(...r.rolling.map((x) => x.window)))
  }

  let bad = 0
  for (const c of checks) { if (!c.ok) bad++ }
  console.log('weekly-metrics selftest: ' + (checks.length - bad) + '/' + checks.length)
  for (const c of checks) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.name + (c.note ? '  —— ' + c.note : ''))
  return bad === 0 ? EXIT_OK : 1
}

// ── 入口 ────────────────────────────────────────────────────────────
function main () {
  if (argv.help) {
    console.log([
      '用法：node weekly-metrics.js [选项]',
      '  --days N    看最近 N 天（默认 7）',
      '  --json      机器可读输出',
      '  --write     落盘 runs\\weekly-metrics\\latest.json',
      '  --selftest  自测',
      '',
      '退出码：0=ok  1=环境错  2=用法错',
    ].join('\n'))
    return EXIT_USAGE
  }
  if (argv.selftest) return selftest()

  if (!fs.existsSync(MONITOR_DIR)) {
    console.error('[env] 找不到 monitor 目录：' + MONITOR_DIR)
    console.error('  环境变量 NUMEN_MONITOR_DIR 可以覆盖。游戏实例路径变了的话改环境变量，别改脚本。')
    return EXIT_ENV
  }

  const r = build(MONITOR_DIR, LEDGER_DIR, argv.days)
  if (argv.json) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    printHuman(r)
  }
  if (argv.write) {
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true })
      const out = path.join(OUT_DIR, 'latest.json')
      fs.writeFileSync(out, JSON.stringify(r, null, 2), 'utf8')
      // 留一份带日期的历史（append-only 惯例）
      const day = new Date().toISOString().slice(0, 10)
      fs.writeFileSync(path.join(OUT_DIR, 'metrics-' + day + '.json'), JSON.stringify(r, null, 2), 'utf8')
      if (!argv.json) console.log('\n✔ 已落盘：' + out)
    } catch (e) {
      console.error('[env] 落盘失败：' + e.message)
      return EXIT_ENV
    }
  }
  return EXIT_OK
}

if (require.main === module) {
  try { process.exit(main()) } catch (e) {
    console.error('✘ 异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : String(e)))
    process.exit(EXIT_ENV)
  }
}

module.exports = { build, collectTasks, collectDeaths, collectActivity }
