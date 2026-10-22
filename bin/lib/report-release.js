'use strict'
/**
 * report-release.js —— 报告放行门禁（用户 2026-10-22 批准的两条补丁之一）
 *
 * 规则（用户原话）：「报告发出前，每个未了项都必须在报告里有状态；漏一个 = 红。」
 *
 * ── 为什么是门而不是纪律 ──────────────────────────────────────────────
 *   外部复审的诊断：`decisions.jsonl` 只是「止血记录层」—— 它记下了要主人拍板的事，
 *   但**没有任何东西拦住一份报告把这件事悄悄漏掉**。报告一发出，主人看到的是
 *   「一切正常」，于是问题从「等拍板」退化成「没人知道」。
 *   真正的修法是**门禁层**：报告在被放行之前，机器逐条核对未了项有没有交代。
 *
 * ── 「未了项」是谁（只认机器知道的，不靠自觉）────────────────────────
 *   A. 待主人拍板的未决项 —— `rdd存放\decisions.jsonl` 里 status=pending 的（D-N）
 *   B. 报告自己的「还不能用的 / 我改不动的」表 —— 每行的「要你做什么」不能空
 *      （空 = 这一行就是「没有状态」）
 *   C. 那张卡（existential）—— 报告必须交代它现在在哪一步
 *      因为用户 2026-10-22 定：「AI 的职责就缩成一句话：卡亮了没有？」
 *      一份不提卡的报告，等于没告诉主人该看什么。
 *
 * ── 「有状态」怎么判（可机判，不是靠嘴说）──────────────────────────
 *   一个未了项算「有状态」= 它出现在报告里**且**出现在一个带状态的位置：
 *     · 「给老板的三行」的 ②「今天哪件事必须老板知道」那一行里，或
 *     · 「还不能用的 / 我改不动的」表里（那一行天然有「要你做什么」= 状态）
 *   只出现在正文别处 = 没状态（正文可以复述，但不能当作交代）。
 *
 * ── 匹配方式（中文没有空格，别用分词）────────────────────────────────
 *   取「标题 ↔ 报告」的**最长公共子串**，≥4 个字符算命中；ASCII 词（如 V6、
 *   rdd_death_ledger）≥5 个字符按整词命中。这样「预算从影子改成真拦」能对上
 *   「预算还从影子改成真拦」，而「要不要」这种 3 字碎词不会误命中。
 *
 * 用法（作为库）：
 *   const { checkReportRelease } = require('./report-release')
 *   const r = checkReportRelease({ outDir, cardPath })
 *   if (!r.ok) console.error(r.why)
 *
 * 退出码约定由调用方决定（goal.js accept → exit 1；harness-gate Q17 → BLOCK）。
 */
const fs = require('fs')
const path = require('path')

// ── 路径：一律走 registry，拿不到再回落（不写死 D:\rdd）────────────────
function registryRoots () {
  try { return require('./registry.js').load().roots } catch { return null }
}
const FALLBACK_RDD_ROOT = path.resolve(__dirname, '..', '..', '..')

function defaultOutDir () {
  const r = registryRoots() || {}
  // ★ roots.docs 指向 `…\rdd-docs\rdd架构`；`rdd存放` 是它的兄弟目录，不是子目录。
  //   （写成 join(docs,'rdd存放') 会得到不存在的 `rdd架构\rdd存放` —— 面板已经踩过这次）
  if (r.docs) return path.join(path.dirname(r.docs), 'rdd存放')
  return path.join(FALLBACK_RDD_ROOT, 'docs', 'rdd-docs', 'rdd存放')
}
function defaultCardPath () {
  const r = registryRoots() || {}
  const base = r.docs || path.join(FALLBACK_RDD_ROOT, 'docs', 'rdd-docs', 'rdd架构')
  return path.join(base, '实机验证', '第一条VERIFIED经验进executor-验证卡.md')
}

// ── 报告定位（与 goal.js checkPlainSummary 同口径，含跨夜回退）────────
function pad2 (n) { return String(n).padStart(2, '0') }

function findReport (outDir, now) {
  if (!fs.existsSync(outDir)) return { err: '找不到 rdd存放\\ 目录：' + outDir }
  const d = now || new Date()
  const ymd = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
  const dash = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())

  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.md') && !f.startsWith('_'))
  const todays = files.filter((f) => f.includes(ymd) || f.includes(dash))
  if (todays.length) return { files: todays, dir: outDir, crossNight: false }

  // ★ 跨夜：0 点后今天还没有日报，但人可能还在干前一天晚上的活 —— 回退到最近一份带日期的。
  const dated = files
    .map((f) => ({ f, m: f.match(/(20\d{2}-?\d{2}-?\d{2})/) }))
    .filter((x) => x.m)
    .map((x) => ({ f: x.f, d: x.m[1].replace(/-/g, '') }))
    .sort((a, b) => b.d.localeCompare(a.d))
  if (!dated.length) return { err: '今天（' + dash + '）没有日报，也没有任何带日期的日报' }
  return { files: [dated[0].f], dir: outDir, crossNight: true, picked: dated[0] }
}

// ── 章节抽取 ────────────────────────────────────────────────────────
/** 取「给老板的三行」整节（标题后到下一个同级或更高级标题） */
function plainSection (text) {
  const head = text.match(/^#{1,4}\s*给老板的三行[^\n]*$/m)
  if (!head) return null
  const rest = text.slice(head.index + head[0].length)
  const next = rest.match(/^#{1,4}\s+\S/m)
  return { index: head.index, text: (next ? rest.slice(0, next.index) : rest).trim() }
}

/** 取「还不能用的 / 我改不动的」表（含 项|为什么|要你做什么 三列） */
function unresolvedTable (text) {
  const head = text.match(/^#{1,4}\s*[^\n]*(还不能用|改不动)[^\n]*$/m)
  if (!head) return null
  const rest = text.slice(head.index + head[0].length)
  const next = rest.match(/^#{1,4}\s+\S/m)
  const body = next ? rest.slice(0, next.index) : rest
  const rows = []
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    if (/^\|[\s:|-]+\|$/.test(t)) continue          // 分隔行 |---|---|
    const cells = t.split('|').slice(1, -1).map((c) => c.trim())
    if (!cells.length) continue
    if (/^(项|item)$/i.test(cells[0])) continue      // 表头
    rows.push({ raw: t, cells })
  }
  return { index: head.index, text: body, rows }
}

// ── 待拍板项（decisions.jsonl 事件重放）──────────────────────────────
function pendingDecisions (queueFile) {
  if (!fs.existsSync(queueFile)) return []
  let raw
  try { raw = fs.readFileSync(queueFile, 'utf8').replace(/^\uFEFF/, '') } catch { return [] }
  const map = new Map()
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || !e.id) continue
    const cur = map.get(e.id) || { id: e.id, status: 'pending' }
    if (e.ev === 'raised') {
      cur.title = e.title || ''
      cur.why = e.why || ''
      cur.raisedAt = e.at
      cur.risk = e.risk
    } else if (e.ev === 'resolved') { cur.status = 'resolved' } else if (e.ev === 'dismissed') { cur.status = 'dismissed' }
    map.set(e.id, cur)
  }
  return Array.from(map.values()).filter((x) => x.status === 'pending')
}

// ── 匹配：最长公共子串 ──────────────────────────────────────────────
/** 返回 {len, index}：title 与 text 的最长公共子串长度及它在 text 里的起点 */
function lcs (title, text) {
  const a = String(title || '')
  const b = String(text || '')
  if (!a.length || !b.length) return { len: 0, index: -1 }
  // 只保留「有信息量」的字符参与匹配：去掉标点与空白，避免靠标点凑长度
  const norm = (s) => s.replace(/[\s，。、；：？！,.;:?!（）()「」【】《》""''\-—–·|/\\]/g, '')
  const A = norm(a)
  const B = norm(b)
  if (!A.length || !B.length) return { len: 0, index: -1 }
  // 先算长度，再回到原文找位置（中文按字符算，够用）
  let best = 0
  let bestAEnd = 0
  let prev = new Array(B.length + 1).fill(0)
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array(B.length + 1).fill(0)
    for (let j = 1; j <= B.length; j++) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) { best = cur[j]; bestAEnd = i }
      }
    }
    prev = cur
  }
  if (!best) return { len: 0, index: -1 }
  const common = A.slice(bestAEnd - best, bestAEnd)
  return { len: best, index: b.indexOf(common), common }
}

/** ASCII 整词命中（V6 / rdd_death_ledger 这类），返回位置或 -1 */
function asciiHit (title, text) {
  const toks = String(title || '').match(/[A-Za-z][A-Za-z0-9_]{4,}/g) || []
  for (const t of toks) {
    const i = String(text).indexOf(t)
    if (i >= 0) return i
  }
  return -1
}

/** 判断某个未了项在报告里「有没有状态」，返回 {ok, where, why} */
function itemStatus (item, text, plain, table) {
  const titles = [item.title, item.why].filter(Boolean)
  let hitIndex = -1
  let hitWhere = ''
  let bestLen = 0

  for (const t of titles) {
    const r = lcs(t, text)
    if (r.len >= 4 && r.len > bestLen && r.index >= 0) {
      bestLen = r.len
      hitIndex = r.index
      hitWhere = '"' + r.common + '"'
    }
  }
  if (hitIndex < 0) {
    for (const t of titles) {
      const i = asciiHit(t, text)
      if (i >= 0) { hitIndex = i; hitWhere = '关键词'; break }
    }
  }
  if (hitIndex < 0) {
    return { ok: false, where: '', why: '报告里完全没提这件事（一个 4 字以上的片段都找不到）' }
  }

  // 命中位置必须落在「带状态的位置」里
  if (plain && plain.index >= 0 && plain.text) {
    const pStart = text.indexOf(plain.text)
    if (pStart >= 0 && hitIndex >= pStart && hitIndex < pStart + plain.text.length) {
      // 还要求落在 ② 那一行（「今天哪件事必须老板知道」）
      const l2 = plain.text.search(/②/)
      const l3 = plain.text.search(/③/)
      const s2 = l2 >= 0 ? l2 : 0
      const e2 = l3 > s2 ? l3 : plain.text.length
      const seg2 = plain.text.slice(s2, e2)
      const seg2Start = pStart + s2
      if (hitIndex >= seg2Start && hitIndex < seg2Start + seg2.length) {
        return { ok: true, where: '三行 ②（' + hitWhere + '）', why: '' }
      }
      return { ok: false, where: '三行 ①/③（' + hitWhere + '）', why: '提到了，但没放在 ②「今天哪件事必须老板知道」那一行 —— 主人只有 30 秒，看不到就等于没交代' }
    }
  }
  if (table && table.index >= 0) {
    const tStart = text.indexOf(table.text)
    if (tStart >= 0 && hitIndex >= tStart && hitIndex < tStart + table.text.length) {
      return { ok: true, where: '「还不能用的 / 我改不动的」表（' + hitWhere + '）', why: '' }
    }
  }
  return { ok: false, where: '正文别处（' + hitWhere + '）', why: '只在正文提到，不在「三行 ②」也不在「还不能用的」表里 —— 正文可以复述，但不能当作交代' }
}

// ── 卡（existential）状态 ───────────────────────────────────────────
/** 读卡的「> 状态：…」行；返回 {path, found, line, tokens, lit} */
function readCard (cardPath) {
  const p = cardPath || defaultCardPath()
  if (!fs.existsSync(p)) return { path: p, found: false, line: '', tokens: [], lit: false }
  let text = ''
  try { text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') } catch { return { path: p, found: false, line: '', tokens: [], lit: false } }
  const m = text.match(/^>\s*状态[:：]([^\n]*)$/m)
  const line = (m ? m[1] : '').trim()
  const lit = /✅|PASS|亮了|已通过/.test(line) && !/只差|还没|⬜|待/.test(line)
  const tokens = (line.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9_]{1,}/g) || [])
    .filter((t) => !/^\d+$/.test(t))
  return { path: p, found: true, line, tokens, lit }
}

/** 报告有没有交代卡的状态：卡自身状态词命中，或「卡 + 亮/红/还没」这类通用说法 */
function cardCovered (card, text, plain) {
  // 卡这个词本身在三行里是禁用词（§2.1 禁「卡」），所以只在正文/表里找
  const bodyText = plain && plain.text ? text.replace(plain.text, '') : text
  for (const t of card.tokens) {
    if (t.length >= 2 && bodyText.includes(t)) return { ok: true, where: '"' + t + '"' }
  }
  const generic = /(亮|红了|还没亮|未亮|通过了|过了|等你一句话|待主人|PASS|⬜|🟡|✅|❌)/.test(bodyText)
  const hasCard = /(卡|这一眼|那一眼|越玩越聪明|经验真的进了)/.test(bodyText)
  if (generic && hasCard) return { ok: true, where: '通用说法' }
  return { ok: false, where: '', why: '报告没交代那张卡现在在哪一步（亮没亮 / 还差什么）' }
}

// ── 主检查 ──────────────────────────────────────────────────────────
/**
 * @param {object} opt
 * @param {string} [opt.outDir]   rdd存放 目录
 * @param {string} [opt.cardPath] existential 卡的路径
 * @param {Date}   [opt.now]      测试用「今天」
 * @param {string} [opt.onlyFile] 指定文件（测试用，跳过定位）
 * @returns {{ok:boolean, why:string, file?:string, items:Array, card?:object}}
 */
function checkReportRelease (opt) {
  const o = opt || {}
  const outDir = o.outDir || defaultOutDir()

  let files
  let picked = null
  if (o.onlyFile) {
    files = [path.basename(o.onlyFile)]
    if (!fs.existsSync(o.onlyFile)) return { ok: false, why: '报告文件不存在：' + o.onlyFile, items: [] }
  } else {
    const f = findReport(outDir, o.now)
    // ★ 「今天还没写日报」和「日报漏了未了项」是两件事，必须分开：
    //   前者不该拦（一天可能写好几轮，报告在收工时才落）；后者才是「漏一个 = 红」。
    if (f.err) return { ok: false, noReport: true, why: f.err, items: [] }
    files = f.files
    picked = f.picked || null
  }

  const pending = pendingDecisions(path.join(outDir, 'decisions.jsonl'))
  const card = readCard(o.cardPath)
  const problems = []
  let items = []
  let usedFile = ''

  // 只要有一份日报通过就算放行（同 checkPlainSummary 的口径：多份当天文件时取能过的那份）
  for (const name of files) {
    const full = o.onlyFile || path.join(outDir, name)
    let text = ''
    try { text = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '') } catch { continue }
    const plain = plainSection(text)
    const table = unresolvedTable(text)
    const local = []

    // A. 待主人拍板的未决项
    for (const d of pending) {
      const st = itemStatus({ title: d.title || d.id, why: d.why }, text, plain, table)
      local.push({ kind: 'decision', id: d.id, title: d.title || '', ok: st.ok, where: st.where, why: st.why })
    }

    // B. 「还不能用的」表每行必须有「要你做什么」
    if (table && table.rows.length) {
      for (const row of table.rows) {
        const what = row.cells.length >= 3 ? row.cells[2] : ''
        const ok = !!what && !/^[-—–]+$/.test(what)
        local.push({
          kind: 'table-row',
          id: row.cells[0] || '(无项名)',
          title: row.cells[0] || '',
          ok,
          where: ok ? '表格第 3 列「要你做什么」' : '',
          why: ok ? '' : '这一行的「要你做什么」是空的 —— 那就是「没有状态」',
        })
      }
    }

    // C. 那张卡
    const cc = cardCovered(card, text, plain)
    local.push({
      kind: 'card',
      id: 'existential-card',
      title: card.found ? ('那张卡：' + (card.line || '(状态行读不到)')) : '(卡文件不存在)',
      ok: card.found ? cc.ok : false,
      where: cc.where,
      why: card.found ? (cc.why || '') : '找不到卡文件：' + card.path,
    })

    const bad = local.filter((x) => !x.ok)
    if (!bad.length) {
      return { ok: true, why: '', file: full, crossNight: !!picked, items: local, card }
    }
    if (!problems.length) { problems.push(...bad); usedFile = full; items = local }
  }

  if (!problems.length) {
    return { ok: false, noReport: true, why: '当天没有任何一份带日期的日报可查（rdd存放\\ 下没找到）', items: [] }
  }

  const L = []
  L.push('报告放行门禁：有 ' + problems.length + ' 个未了项在报告里没有状态（漏一个 = 红）')
  L.push('  报告：' + usedFile)
  for (const p of problems) {
    L.push('   [ 漏 ] ' + p.kind + ' · ' + p.id + (p.title ? ' · ' + p.title : ''))
    L.push('          ↳ ' + p.why)
  }
  L.push('')
  L.push('  ★ 怎么改：把这几个未了项写进报告的「给老板的三行」② 那一行，')
  L.push('     或者写进「还不能用的 / 我改不动的」表并填上「要你做什么」。')
  L.push('  ★ 为什么是硬门：报告一发出，主人看到的就是「一切正常」；')
  L.push('     漏掉的那一项从此变成「没人知道」，比「等他拍板」更糟。')
  return { ok: false, why: L.join('\n'), file: usedFile, items, card }
}

// ── 自测（`node report-release.js --selftest`）──────────────────────
// 为什么门禁也要自测：2026-10-04 的教训是「一条看起来在守的纪律，从没被执行过一次」。
// 门禁自己错了会错得很安静（Q7 的 frame=0 假 BLOCK 就是这样）。所以每条判据都要能被
// 一个反例打红、被一个正例放过 —— 两头都验，才叫自测。
//
// ★ 每个用例一个独立临时目录：第一版让 8 个用例共享一个 tmp，结果 decisions.jsonl 到
//   第 6 个用例才被创建，前几个用例的「待拍板项」根本不存在 → 门禁「正确地」放行了，
//   自测却报成门禁失效。**用例之间共享状态 = 自测在测别的东西**。
function selftest () {
  const checks = []
  const ck = (name, ok, note) => checks.push({ name, ok, note: note || '' })
  const os = require('os')

  /** 每个用例造一个干净的「rdd存放」，返回 {dir, cardPath, write, decisions} */
  function fixture (opts) {
    const o = opts || {}
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'))
    const cardPath = path.join(dir, '__card.md')
    fs.writeFileSync(cardPath, o.card === null
      ? ''
      : '# 那张卡\n> 状态：**🟡 V1–V5 已过，只差 V6（主人那句话）**（2026-10-22）\n', 'utf8')
    if (o.decisions && o.decisions.length) {
      fs.writeFileSync(path.join(dir, 'decisions.jsonl'),
        o.decisions.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8')
    }
    return {
      dir,
      cardPath,
      round: fs.rmSync.bind(fs, dir, { recursive: true, force: true }),
      write (name, text) {
        const p = path.join(dir, name)
        fs.writeFileSync(p, text, 'utf8')
        return p
      },
      run (name) {
        return checkReportRelease({ onlyFile: path.join(dir, name), outDir: dir, cardPath })
      },
    }
  }

  const RAISED = {
    ev: 'raised', id: 'D-9', at: '2026-10-22T00:00:00Z',
    title: '要不要现在把预算从影子改成真拦', why: '开闸后窗口用尽会静默停住，回滚成本高',
  }

  // ① 全交代 → 放行
  {
    const f = fixture({ decisions: [RAISED] })
    f.write('ok.md', [
      '# 报告',
      '## 给老板的三行',
      '① 没有，今天装的是内部设施',
      '② 有一件事要你拍板：预算还从影子改成真拦，等你点头',
      '③ 明天把那条经验接进执行请求',
      '## 还不能用的 / 我改不动的',
      '| 项 | 为什么 | 要你做什么 |',
      '|---|---|---|',
      '| 睡觉 | 白天睡不了 | 不用，等天黑 |',
      '## 别的',
      '她把 V1–V5 都过了，只差 V6。',
    ].join('\n'))
    const r = f.run('ok.md')
    ck('全交代 → 放行', r.ok, r.ok ? '' : r.why.split('\n').slice(0, 3).join(' / '))
    f.round()
  }

  // ② 待拍板项只在正文提到、没进 ② → 红（这是本门禁存在的主要理由）
  {
    const f = fixture({ decisions: [RAISED] })
    f.write('miss-plain.md', [
      '# 报告',
      '## 给老板的三行',
      '① 没有，今天装的是内部设施',
      '② 今天没什么要你知道的',
      '③ 明天继续',
      '## 别的',
      '顺便说一句，预算还从影子改成真拦这件事还在等。',
      '她把 V1–V5 都过了，只差 V6。',
    ].join('\n'))
    const r = f.run('miss-plain.md')
    const bad = r.items.find((x) => x.kind === 'decision' && !x.ok)
    ck('待拍板项只在正文 → 红', !r.ok && !!bad,
      !r.ok ? (bad ? '按预期拦下：' + bad.why.slice(0, 30) : '红的理由不是待拍板项') : '误放行')
    f.round()
  }

  // ②b 待拍板项在 ② → 放行
  {
    const f = fixture({ decisions: [RAISED] })
    f.write('plain-ok.md', [
      '# 报告',
      '## 给老板的三行',
      '① 没有，今天装的是内部设施',
      '② 预算还从影子改成真拦，等你点头',
      '③ 明天继续',
      '## 别的',
      'V1–V5 过了，差 V6。',
    ].join('\n'))
    const r = f.run('plain-ok.md')
    const d = r.items.find((x) => x.kind === 'decision')
    ck('待拍板项在 ② → 放行', r.ok && !!d && d.ok, r.ok ? (d ? d.where : '') : r.why.split('\n')[0])
    f.round()
  }

  // ③ 「还不能用的」表有一行「要你做什么」是空的 → 红
  {
    const f = fixture({ decisions: [RAISED] })
    f.write('empty-cell.md', [
      '# 报告',
      '## 给老板的三行',
      '① 没有，今天装的是内部设施',
      '② 预算还从影子改成真拦，等你点头',
      '③ 明天继续',
      '## 还不能用的 / 我改不动的',
      '| 项 | 为什么 | 要你做什么 |',
      '|---|---|---|',
      '| 睡觉 | 白天睡不了 |  |',
      '## 别的',
      'V1–V5 过了，差 V6。',
    ].join('\n'))
    const r = f.run('empty-cell.md')
    const row = r.items.find((x) => x.kind === 'table-row' && !x.ok)
    ck('表格空「要你做什么」→ 红', !r.ok && !!row, row ? '按预期拦下' : '没抓到空单元格')
    f.round()
  }

  // ④ 完全不提卡 → 红
  {
    const f = fixture({ decisions: [] })
    f.write('no-card.md', [
      '# 报告',
      '## 给老板的三行',
      '① 没有，今天装的是内部设施',
      '② 今天没什么要你知道的',
      '③ 明天继续',
      '## 别的',
      '今天天气不错。',
    ].join('\n'))
    const r = f.run('no-card.md')
    const bad = r.items.find((x) => x.kind === 'card' && !x.ok)
    ck('完全不提卡 → 红', !r.ok && !!bad, bad ? '按预期拦下' : '没抓到「没提卡」')
    f.round()
  }

  // ⑤ 没有待拍板项、表填满、卡交代了 → 放行（别把「没事」误判成红）
  {
    const f = fixture({ decisions: [] })
    f.write('clean.md', [
      '# 报告',
      '## 给老板的三行',
      '① 她会自己看天了',
      '② 没有要你拍板的事',
      '③ 明天接着看那张卡亮没亮',
      '## 还不能用的 / 我改不动的',
      '| 项 | 为什么 | 要你做什么 |',
      '|---|---|---|',
      '| 无 | — | 不用做什么 |',
      '## 别的',
      'V1–V5 都过了，就等你一句话。',
    ].join('\n'))
    const r = f.run('clean.md')
    ck('无事可报 → 放行（不误红）', r.ok, r.ok ? '' : r.why.split('\n').slice(0, 3).join(' / '))
    f.round()
  }

  // ⑥ 已 resolved 的待拍板项不再要求交代
  {
    const f = fixture({
      decisions: [
        RAISED,
        { ev: 'resolved', id: 'D-9', at: '2026-10-22T00:01:00Z', choice: 'A' },
        { ev: 'raised', id: 'D-10', at: '2026-10-22T00:02:00Z', title: '还没定的那件事', why: '真的还没定下来' },
      ],
    })
    const pend = pendingDecisions(path.join(f.dir, 'decisions.jsonl'))
    ck('只认 pending 的待拍板项', pend.length === 1 && pend[0].id === 'D-10',
      'pending=' + pend.map((x) => x.id).join(','))
    f.round()
  }

  // ⑦ 最长公共子串：4 字以上命中、3 字碎词不误命中
  {
    const a = lcs('要不要现在把预算从影子改成真拦', '预算还从影子改成真拦，等你点头')
    ck('中文片段能对上（≥4 字）', a.len >= 4, 'len=' + a.len + ' common=' + (a.common || ''))
    const b = lcs('要不要', '这件事要不要都行，随便')
    ck('3 字碎词不算命中（阈值 4）', b.len < 4, 'len=' + b.len)
  }

  // ⑧ 卡文件不存在时要红，不能静默放行
  {
    const f = fixture({ decisions: [], card: null })
    fs.rmSync(f.cardPath, { force: true })
    f.write('nocard.md', [
      '# 报告',
      '## 给老板的三行',
      '① 没事',
      '② 没事',
      '③ 没事',
      '## 别的',
      'V1–V5 通过了。',
    ].join('\n'))
    const r = f.run('nocard.md')
    const bad = r.items.find((x) => x.kind === 'card' && !x.ok)
    ck('卡文件不存在 → 红（不许静默放行）', !r.ok && !!bad, bad ? bad.why.slice(0, 40) : '没抓到')
    f.round()
  }

  const bad = checks.filter((c) => !c.ok)
  console.log('report-release selftest: ' + (checks.length - bad.length) + '/' + checks.length)
  for (const c of checks) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.name + (c.note ? '  —— ' + c.note : ''))
  return bad.length === 0 ? 0 : 1
}
module.exports = {
  checkReportRelease,
  selftest,
  // 导出内部件给自测/复用
  findReport,
  plainSection,
  unresolvedTable,
  pendingDecisions,
  readCard,
  lcs,
  defaultOutDir,
  defaultCardPath,
}

// ── CLI（`node report-release.js` 直接检查当前报告；--selftest 自测）──
if (require.main === module) {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) process.exit(selftest())
  const fileArg = argv.indexOf('--file')
  const r = checkReportRelease({
    onlyFile: fileArg >= 0 ? argv[fileArg + 1] : undefined,
  })
  if (r.ok) {
    console.log('✔ 报告放行门禁：通过')
    console.log('  报告：' + r.file)
    for (const it of r.items) console.log('  ✔ ' + it.kind + ' · ' + it.id + '  ' + it.where)
    process.exit(0)
  }
  console.error('✘ 报告放行门禁：未通过')
  console.error(r.why)
  process.exit(1)
}
