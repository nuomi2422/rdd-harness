/**
 * Existing dsh-bench-bridge, maintained only in the RDD harness (2026-11-12).
 * Explicit host binding -> existing evidence package -> official plugin-source followup.
 * Disabled by default; no session enumeration, monitor scanner, child process or human source.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SOURCE, sha256, readBounded, validateBinding, deliveryKey, bindingKey, loadPackage, renderSummary } from './core.js'

export const name = 'dsh-bench-bridge'
export const inject = ['agents', 'tools']

export function apply(ctx, config = {}, runtime = {}) {
  const enabled = config.enabled === true
  const io = runtime.fs || fs
  const now = runtime.now || Date.now
  const stateFile = config.stateFile || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bench-bridge-delivery.json')
  let state, loaded = false, busy = false, disposed = false, timer = null, unregister = null
  let status = { state: enabled ? 'WAITING' : 'DISABLED' }
  const report = (state, reason) => {
    status = { state, ...(reason ? { reason } : {}) }
    try { ctx.logger?.info?.('[bench-bridge] ' + JSON.stringify(status)) } catch {}
    return status
  }
  function persist(next) {
    const file = stateFile + '.tmp-' + process.pid + '-' + sha256(String(now()) + Math.random()).slice(0, 12)
    try {
      io.mkdirSync(path.dirname(stateFile), { recursive: true })
      io.writeFileSync(file, JSON.stringify(next), { encoding: 'utf8', flag: 'wx' })
      io.renameSync(file, stateFile)
      state = next
    } catch (e) {
      try { io.unlinkSync(file) } catch {}
      throw new Error('state-write-failed:' + e.message)
    }
  }
  function loadState() {
    if (loaded) return
    try {
      const parsed = JSON.parse(readBounded(stateFile, 32768, io))
      if (parsed.version !== 2 || !Array.isArray(parsed.delivered) || parsed.delivered.length > 32
          || !Number.isFinite(parsed.retiredBefore)) throw new Error('state-invalid')
      state = parsed
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      state = { version: 2, delivered: [], pending: null, retiredBefore: 0 }
    }
    loaded = true
  }
  async function tick(retry = false) {
    if (!enabled || disposed) return report(disposed ? 'DISPOSED' : 'DISABLED')
    if (busy) return { state: 'BUSY' }
    busy = true
    try {
      if (typeof config.targetSession !== 'string' || !config.targetSession.trim()) return report('UNKNOWN', 'explicit-target-required')
      const targetId = config.targetSession
      const raw = config.bindingFile ? JSON.parse(readBounded(config.bindingFile, 16384, io)) : config.binding
      if (raw?.targetSession !== undefined && raw.targetSession !== targetId) return report('UNKNOWN', 'host-target-conflict')
      const b = validateBinding(raw, now())
      const key = deliveryKey(targetId, b)
      const binding = bindingKey(targetId, b)
      loadState()
      const previous = state.delivered.find(entry => entry.key === key)
      if (previous) return previous.binding === binding ? report('DELIVERED', 'already-recorded')
        : report('UNKNOWN', 'window-binding-conflict')
      if (Date.parse(b.cutoff) <= state.retiredBefore) return report('UNKNOWN', 'outside-retained-markers')
      if (state.pending) {
        if (state.pending.key !== key) return report('UNKNOWN', 'one-pending-window')
        if (state.pending.binding !== binding) return report('UNKNOWN', 'window-binding-conflict')
        if (state.pending.status !== 'rejected') return report('UNKNOWN', 'delivery-outcome-unknown-no-retry')
        if (!retry) return report('PENDING', 'explicit-retry-required')
      }
      const pack = loadPackage(b, io, Math.min(2 * 1024 * 1024, Math.max(1024, config.maxPackageBytes || 1024 * 1024)))
      const summary = renderSummary(b, pack, config.maxChars)
      const target = ctx.agents.get(targetId)
      if (!target || target.id !== targetId || target.session?.header?.origin === 'subagent'
          || typeof target.followup !== 'function' || (config.targetWorkspace && target.session?.header?.cwd !== config.targetWorkspace)) {
        persist({ ...state, pending: { key, binding, status: 'rejected', target: targetId, reason: 'target-unavailable' } })
        return report('PENDING', 'target-unavailable')
      }
      const createUserMessage = runtime.createUserMessage || (await import('@deepseek-ai/dsh-llm')).createUserMessage
      const message = createUserMessage({ content: [{ type: 'text', text: summary.text }], source: SOURCE })
      if (disposed) return report('DISPOSED')
      // Intent is not a delivered marker. A restart with an in-flight intent reports UNKNOWN.
      persist({ ...state, pending: { key, binding, status: 'sending', target: targetId, packageSha256: b.packageSha256 } })
      try {
        const accepted = await target.followup(message)
        if (accepted === false || accepted?.accepted === false) throw new Error('queue-rejected')
      } catch (e) {
        persist({ ...state, pending: { key, binding, status: 'rejected', target: targetId, reason: String(e.message).slice(0, 160) } })
        return report('PENDING', 'queue-rejected')
      }
      const delivered = state.delivered.concat({ key, binding, target: targetId, cutoff: b.cutoff, packageSha256: b.packageSha256 })
      let retiredBefore = state.retiredBefore
      while (delivered.length > 32) retiredBefore = Math.max(retiredBefore, Date.parse(delivered.shift().cutoff))
      try { persist({ ...state, delivered, retiredBefore, pending: null }) }
      catch (e) {
        state = { ...state, pending: { key, binding, status: 'unknown', target: targetId } }
        return report('UNKNOWN', 'accepted-but-state-unrecorded')
      }
      return report('DELIVERED', 'queue-accepted-and-recorded')
    } catch (e) { return report('UNKNOWN', String(e.message).slice(0, 200)) }
    finally { busy = false }
  }
  async function registerTool() {
    const defineTool = await (runtime.defineTool || import('@deepseek-ai/dsh-tools').then(module => module.defineTool))
    if (disposed) return
    unregister = ctx.tools.register(defineTool({
      name: 'bench_bridge_delivery',
      description: '读取既有摘要桥状态，或向宿主固定父会话投递/显式重试固定窗口；不接收路径、目标或正文。DELIVERED 仅代表队列接受且本地留记，不代表父已读或采用。',
      parameters: { action: { type: 'string', required: true, enum: ['status', 'deliver', 'retry'], description: 'status 不读文件；deliver 消费配置绑定；retry 仅重试明确拒绝的待发项' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { state: { type: 'string' }, reason: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: args => args.action === 'status',
      async execute(args, exec) {
        if (!config.targetSession || exec.agent?.id !== config.targetSession
            || exec.agent?.session?.header?.origin === 'subagent') throw new Error('fixed-parent-caller-required')
        // Reject extra fields even when called outside defineTool validation.
        if (!args || Object.keys(args).some(k => k !== 'action')
            || !['status', 'deliver', 'retry'].includes(args.action)) throw new Error('invalid-delivery-action')
        if (disposed) return { state: 'DISPOSED' }
        return args.action === 'status' ? { ...status } : tick(args.action === 'retry')
      },
    }))
  }
  function dispose() {
    disposed = true
    if (timer !== null) clearInterval(timer)
    timer = null
    if (typeof unregister === 'function') unregister()
    unregister = null
  }
  function startTimer() {
    if (disposed) return
    timer = setInterval(() => tick(), Math.min(60000, Math.max(1000, config.pollMs || 15000)))
    timer.unref?.()
  }
  let ready = Promise.resolve()
  if (enabled) {
    ctx.effect(() => dispose)
    // Real host injects tools; legacy isolated tick consumers retain their controller.
    if (ctx.tools) ready = registerTool().then(startTimer, e => report('UNKNOWN', 'tool-registration-failed:' + String(e.message).slice(0, 120)))
    else startTimer()
  }
  return { ready, tick, retryPending: () => tick(true), dispose, status: () => ({ ...status }) }
}
