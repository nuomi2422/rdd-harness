'use strict';
/**
 * planner-entry.js —— 「这一轮的任务链，是不是走规划者建起来的？」
 *
 * ## 为什么要有它（2026-10-29 主人指示）
 *
 * 主人原话：
 *   「我们的任务链的触发是要有一个特殊的工具，不是说你给AI说句话，他就能用规划者的
 *     这个东西好像写出来了，但是AI都忘记用了，干活的AI忘记用了，直接在门禁上面，
 *     或者说哪个地方打一个显眼的标记啊」
 *   「找到了正确的入口：rdd_supervisor_submit —— 它直通 Stage-A 规划者。
 *     我上一个用错了（rdd_submit 只建单目标）。反正你记得让AI用这个」
 *
 * A supervisor_input is an intake event, not proof of a bound chain. Both
 * the planner and the direct-entry tool can emit a task_bound snapshot.
 * Only a goal_staged snapshot carrying the producer's exact chain identity
 * proves that chain was planned. An exact task_bound with explicit rdd_submit
 * origin proves a bypass; legacy sources that omit the join fields are UNKNOWN.
 * The scanner is read-only; UNKNOWN never instructs replacing a live chain.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TAIL_BYTES = 8 << 20; // 8MB：够覆盖一整轮（实测 rdd.jsonl 每 5s 一条，一天几十 MB）

/** monitor 目录：优先环境变量，其次 registry roots.live，最后退回硬编码（只做兜底） */
function monitorDir() {
  if (process.env.NUMEN_MONITOR_DIR) return process.env.NUMEN_MONITOR_DIR;
  try {
    const roots = require('./registry.js').load().roots;
    if (roots && roots.live) return path.join(roots.live, 'config', 'numen', 'monitor');
  } catch {
    /* registry 读不到就走兜底 —— 这不该让门禁崩 */
  }
  return 'D:\\rdd\\mc\\The Best of Twilight Forest\\config\\numen\\monitor';
}

/** 尾读一个 jsonl，返回解析成功的事件对象数组（坏行跳过，不抛） */
function tailEvents(file, maxBytes) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { events: [], size: 0, missing: true };
  }
  const len = Math.min(maxBytes || DEFAULT_TAIL_BYTES, st.size);
  // truncated：窗口没覆盖整个文件 —— 起点之前是否有规划证据，本轮无法判定。
  const truncated = len < st.size;
  const from = st.size - len;
  if (len <= 0) return { events: [], size: st.size, missing: false, truncated, from };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  let aligned = false; // 窗口是否正好落在行首
  try {
    fs.readSync(fd, buf, 0, len, from);
    if (from > 0) {
      const prev = Buffer.alloc(1);
      fs.readSync(fd, prev, 0, 1, from - 1);
      aligned = prev[0] === 0x0a; // 前一字节是换行 = 起点本身是完整行
    }
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  // 只有起点落在行中间时，第一行才是半截；落在行首就必须保留它。
  if (truncated && !aligned) lines.shift();
  const events = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      /* 坏行跳过：日志轮转/半截写入都会产生，不该让门禁崩 */
    }
  }
  return { events, size: st.size, missing: false, truncated, from };
}

/**
 * 扫本轮（since 之后）的任务链入口。
 *
 * @param {Date} since   本轮起点（门禁的 --since）
 * @param {object} [opts] { dir, maxBytes }
 * @returns {{
 *   ok: boolean,          // 有没有走规划者的证据
 *   verdict: string,      // PLANNED | BYPASSED | NO_CHAIN | NO_DATA | UNKNOWN
 *   coverage: object,     // { truncated, from, size }：证据窗口是否覆盖整个文件
 *   planned: Array,       // 走规划者的提交 [{at, source, objective}]
 *   bypassed: Array,      // 绕过的绑定   [{at, description}]
 *   file: string,
 *   note: string
 * }}
 */
function scan(since, opts) {
  const o = opts || {};
  const dir = o.dir || monitorDir();
  const file = path.join(dir, 'rdd.jsonl');
  const sinceMs = (since instanceof Date ? since : new Date(since)).getTime();

  const { events, missing, truncated, from, size } = tailEvents(file, o.maxBytes);
  const coverage = { truncated: !!truncated, from: from || 0, size: size || 0 };
  if (missing) {
    return { ok: false, verdict: 'NO_DATA', planned: [], bypassed: [], file, coverage, note: 'rdd.jsonl 不存在：' + file };
  }

  const planned = [];
  const bypassed = [];
  const scoped = new Map();
  let ambiguous = false, intakeOnly = false;
  const validId = v => typeof v === 'string' && v.trim() && !/^unknown$/i.test(v.trim());
  const result = (verdict, note) => ({ ok: verdict === 'PLANNED', verdict, planned, bypassed, file, coverage, note });
  for (const ev of events) {
    const t = Date.parse(ev?.timestamp);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    const d = ev.data || {};
    if (ev.type === 'supervisor_input' || ev.type === 'goal_staged') {
      // These summaries do not identify a bound chain; never use them as a join.
      intakeOnly = true;
      continue;
    }
    if (ev.type !== 'taskchain_snapshot' || !['task_bound', 'goal_staged'].includes(d.reason)) continue;
    const parts = [ev.session, ev.world_id, ev.server_session, d.companionId, d.taskId];
    if (ev.stamp_conflict || !parts.every(validId) || !Number.isSafeInteger(ev.world_epoch) || ev.world_epoch < 1) {
      ambiguous = true;
      continue;
    }
    const key = JSON.stringify([...parts, ev.world_epoch]);
    const chain = scoped.get(key) || {};
    const entry = { at: ev.timestamp, taskId: d.taskId, companionId: d.companionId };
    if (d.reason === 'goal_staged') chain.planned = {...entry, source: 'goal_staged snapshot'};
    else if (d.source === 'rdd_submit') chain.direct = {...entry, description: String(d.taskChain?.description || '').slice(0, 120)};
    scoped.set(key, chain);
  }
  for (const chain of scoped.values()) {
    if (chain.planned) planned.push(chain.planned);
    if (chain.direct) bypassed.push(chain.direct);
  }
  if (scoped.size === 1 && !ambiguous && planned.length === 1 && !bypassed.length) {
    return result('PLANNED', '同世界、服务器、同伴和任务链的 Stage-A 快照：' + planned[0].taskId);
  }
  if (scoped.size === 1 && !ambiguous && !coverage.truncated && bypassed.length === 1 && !planned.length) {
    return result('BYPASSED', '同一任务链的快照明确标记直接入口 rdd_submit：' + bypassed[0].taskId);
  }
  if (intakeOnly || ambiguous || scoped.size || coverage.truncated) {
    return result('UNKNOWN', '任务链来源无法唯一核对：可能缺少同一世界/服务器/任务身份，存在多条链，或只读到了日志尾部；不据此重派。');
  }
  return result('NO_CHAIN', '本窗口没有见到建链事件；不代表原链不存在。');
}

/** 给人看的一行摘要（门禁、监测台、日报都用同一句话，别各写各的） */
function summaryLine(r) {
  const tag = { PLANNED: '✔ 规划者', BYPASSED: '✘ 绕过规划者', NO_CHAIN: '- 无链', NO_DATA: '? 无数据', UNKNOWN: '? 证据不全' }[r.verdict] || r.verdict;
  return tag + '：' + r.note;
}

module.exports = { scan, summaryLine, monitorDir, tailEvents };
