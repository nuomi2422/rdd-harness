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
 * ## 两个工具的本质区别（代码事实，不是猜测）
 *
 * | 工具 | 代码路径 | 有没有 Stage-A | 留下的事件 |
 * |---|---|---|---|
 * | `rdd_supervisor_submit` | `RddPlugin.submitSupervisorGoal` → `beginPlanning` → `RddStagePlanner.planStages` | ✅ 是规划者 | `supervisor_input{source=rdd_supervisor_submit}` + `goal_staged{stages:N}` |
 * | `rdd_submit` | `RddPlugin.bind(goal)` → `startCurrentWithCounts` | ❌ 直接绑一条硬编码子任务，**完全绕过规划者** | 只有 `taskchain_snapshot{reason=task_bound}` |
 *
 * 证据来源：
 *   - `plugins/rdd/.../RddPlugin.java` L401-432（beginPlanning 里 publish supervisor_input）
 *   - `plugins/rdd/.../RddSubmitTool.java` L164-176（直接 RddPlugin.bind + startCurrent）
 *   - `plugins/rdd/.../RddPlugin.java` L817-863（bind 只 publishTaskSnapshot('task_bound')）
 *
 * 所以判据是**机器可读的**：本轮 rdd.jsonl 里有没有
 * `type=supervisor_input` 且 `data.source=rdd_supervisor_submit` 的事件。
 * 没有 = 这一轮的链不是规划者建的 = 主人说的「AI 忘记用了」。
 *
 * ## 边界（刻意不做的）
 *
 * - **只读**：只读 monitor/rdd.jsonl，不写、不派工、不改世界。
 * - **不判定「该不该建链」**：没有链的时候是 SKIP，不是 BLOCK。
 *   一条从没建过链的轮次不该被这条门禁钉死（同 P10/P10c 的教训）。
 * - **不冒充合规**：`/goal`（source=goal_sink）也算走了规划者 —— 它和
 *   rdd_supervisor_submit 是**同一段 beginPlanning 代码**。这条只抓「用了 rdd_submit
 *   这种绕路工具」，不抓「用了 /goal 而不是工具」。两者语义都是「进了规划者」。
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
  if (len <= 0) return { events: [], size: st.size, missing: false };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, st.size - len);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  // 尾读的第一行大概率是半截，丢掉（除非正好从头读的）
  if (len < st.size) lines.shift();
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
  return { events, size: st.size, missing: false };
}

/**
 * 扫本轮（since 之后）的任务链入口。
 *
 * @param {Date} since   本轮起点（门禁的 --since）
 * @param {object} [opts] { dir, maxBytes }
 * @returns {{
 *   ok: boolean,          // 有没有走规划者的证据
 *   verdict: string,      // PLANNED | BYPASSED | NO_CHAIN | NO_DATA
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

  const { events, missing } = tailEvents(file, o.maxBytes);
  if (missing) {
    return { ok: false, verdict: 'NO_DATA', planned: [], bypassed: [], file, note: 'rdd.jsonl 不存在：' + file };
  }

  const planned = [];
  const bypassed = [];
  let staged = null;

  for (const ev of events) {
    const t = Date.parse(ev.timestamp);
    if (!Number.isFinite(t) || t < sinceMs) continue;
    const d = ev.data || {};

    if (ev.type === 'supervisor_input') {
      // ★ 这是规划者的门：beginPlanning() 里 publish，两个真路（/goal 与
      //   rdd_supervisor_submit）都经过它。rdd_submit 不经过。
      planned.push({ at: ev.timestamp, source: d.source || '?', objective: String(d.objective || '').slice(0, 120) });
    } else if (ev.type === 'goal_staged') {
      staged = { at: ev.timestamp, stages: d.stages };
    } else if (ev.type === 'taskchain_snapshot' && d.reason === 'task_bound') {
      // bind() 直绑 —— rdd_submit 走这条，没经过规划者
      const desc = d.taskChain && d.taskChain.description ? String(d.taskChain.description).slice(0, 120) : '';
      bypassed.push({ at: ev.timestamp, description: desc });
    }
  }

  if (planned.length) {
    return {
      ok: true,
      verdict: 'PLANNED',
      planned,
      bypassed,
      staged,
      file,
      note: planned.map((p) => p.source).join(' + ') +
        (staged ? `（Stage-A 分出 ${staged.stages} 级）` : ''),
    };
  }
  if (bypassed.length) {
    return {
      ok: false,
      verdict: 'BYPASSED',
      planned,
      bypassed,
      staged,
      file,
      note: `本轮建了 ${bypassed.length} 条链，但没有一条经过规划者 —— ` +
        '看起来用了 rdd_submit（只绑单目标，绕过 Stage-A）。',
    };
  }
  return { ok: false, verdict: 'NO_CHAIN', planned, bypassed, staged, file, note: '本轮没建过任务链（不拦）' };
}

/** 给人看的一行摘要（门禁、监测台、日报都用同一句话，别各写各的） */
function summaryLine(r) {
  const tag = { PLANNED: '✔ 规划者', BYPASSED: '✘ 绕过规划者', NO_CHAIN: '- 无链', NO_DATA: '? 无数据' }[r.verdict] || r.verdict;
  return tag + '：' + r.note;
}

module.exports = { scan, summaryLine, monitorDir, tailEvents };
