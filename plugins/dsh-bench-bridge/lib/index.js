/**
 * dsh-bench-bridge —— 关窗后把实验台摘要投给编码 AI（A 方案，2026-11-08）
 *
 * 背景：bench live 每 15 秒产 strand/chat/context，但没有任何通道送到编码 AI 上下文；
 *   B 方案（bench-digest + Q21）已落，靠人/门禁强制去跑。A 方案是自动投递：
 *   检测到「All dimensions are saved」→ 跑 bench-digest → 把摘要作为系统提醒投给指定会话。
 *
 * 默认 enabled:false。打开方式：profile 的 cordis.patch.yml 里把 bench-bridge 的 enabled 改 true，
 *   或改 ~/.dsh/bench-bridge.json 的 { enabled: true, targetSession: 'session-xxx' }。
 *
 * 为什么默认关：这会往 AI 上下文里塞东西，属于行为改变；主人点头再开。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const RDD = process.env.RDD_ROOT || 'D:/rdd'
const HARNESS = path.join(RDD, 'harness', 'rdd-harness')
const LOG = path.join(RDD, 'mc', 'The Best of Twilight Forest', 'logs', 'latest.log')
const AUDIT = path.join(RDD, '.harness', 'audit', 'bench-digest-inject.jsonl')
const STATE_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bench-bridge.json')

const DEFAULTS = { enabled: false, targetSession: '', sinceMin: 360, pollMs: 15000, maxChars: 1500 }

export const name = 'dsh-bench-bridge'
export const inject = ['sessionController']

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
function audit(o) { try { fs.mkdirSync(path.dirname(AUDIT), { recursive: true }); fs.appendFileSync(AUDIT, JSON.stringify(o) + '\n', 'utf8') } catch {} }

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const state = readJson(STATE_FILE, {})
  const merged = { ...cfg, ...(state || {}) }
  let lastSeen = 0
  let timer = null

  function log(m) { try { ctx.logger?.info?.('[bench-bridge] ' + m) } catch {} }

  function pickTarget() {
    if (merged.targetSession) return merged.targetSession
    try {
      const list = ctx.agents?.list?.() ?? []
      const top = list.filter((a) => a?.session?.header?.origin !== 'subagent')
      return top[0]?.id || ''
    } catch { return '' }
  }

  function latestLaunchMs() {
    try {
      const st = fs.statSync(LOG)
      const fd = fs.openSync(LOG, 'r')
      const start = Math.max(0, st.size - 512 * 1024)
      const buf = Buffer.alloc(st.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      fs.closeSync(fd)
      const txt = buf.toString('utf8')
      // ★ 主人 2026-11-08：观测要「进游戏时」送，不是关窗后 —— 进游戏时 AI 会一直尝试更新，正好盯着实验台找 bug。
      const idx = txt.lastIndexOf('ModLauncher running')
      if (idx < 0) return 0
      const line = txt.slice(txt.lastIndexOf('\n', idx) + 1, idx)
      const m = line.match(/(\d{2})月(\d{4}) (\d{2}:\d{2}:\d{2})/)
      if (!m) return 0
      return new Date(`${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[1]}T${m[3]}`).valueOf()
    } catch { return 0 }
  }

  function digest() {
    const out = execFileSync(process.execPath, [path.join(HARNESS, 'bin', 'bench-digest.js'), '--since', merged.sinceMin + 'm'], { encoding: 'utf8', timeout: 30000 })
    return out.length > merged.maxChars ? out.slice(0, merged.maxChars) + '\n…（已截断）' : out
  }

  async function tick() {
    if (!merged.enabled) return
    const saveAt = latestSaveMs()
    if (!saveAt || saveAt <= lastSeen) return
    lastSeen = saveAt
    const target = pickTarget()
    if (!target) return log('没有可投递的会话')
    let text = ''
    try { text = digest() } catch (e) { audit({ at: new Date().toISOString(), ok: false, error: String(e?.message ?? e) }); return log('digest 失败: ' + e?.message) }
    const body = ['<system-reminder>', '这是 dsh-bench-bridge 自动投递（不是用户输入）：检测到游戏正在启动，下面是实验台摘要（进游戏前先看一眼异常段）。', '按 Q21 要求：先看「异常」段——重复失败 / 连续只读 / 高频同工具 / 死亡，再决定下一轮改哪个变量。', '', text, '</system-reminder>'].join('\n')
    try {
      await ctx.sessionController.prompt({ requestId: 'bench-bridge-' + target + '-' + saveAt, sessionId: target, mode: 'queue', content: [{ type: 'text', text: body }] })
      audit({ at: new Date().toISOString(), ok: true, target, saveAt, chars: text.length })
      log('已投递摘要给 ' + target + '（' + text.length + ' 字）')
    } catch (e) {
      audit({ at: new Date().toISOString(), ok: false, target, error: String(e?.message ?? e) })
      log('投递失败: ' + e?.message)
    }
  }

  timer = setInterval(() => { void tick() }, merged.pollMs)
  timer.unref?.()
  ctx.effect(() => () => { clearInterval(timer) })
  log('armed（enabled=' + merged.enabled + '，target=' + (merged.targetSession || 'auto') + '）')
}
