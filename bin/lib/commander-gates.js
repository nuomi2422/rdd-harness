'use strict';
/**
 * commander-gates.js —— 指挥官专属的「监督轮」门禁判定（2026-11-07 主人定）。
 *
 * 主人原话：**每两轮必须读架构 MCP、三轮内整理一遍文档、四轮内必须读施工文档和角色卡一遍；
 * 一轮 = 固定的 20 分钟；而且必须保证施工 AI 绑定 goal。**
 *
 * 这里只做判定，不打印、不记账 —— 接线在 harness-gate.js 的 roundGates()。
 *
 * 证据分两档（★ 这一栏必须诚实，因为「看起来做了」正是主人点名最多的盲点）：
 *   硬证据（盘上实物，AI 编不出来）：
 *     C2 文档整理  = 知识库里有 .md 的 mtime 落在窗口内
 *     C4 施工有 goal = ~/.dsh/goal-keeper.log 里该会话最后一条 goal 事件不是 complete/clear
 *   自报证据（需要 AI 每轮自己写一行，能造假 → 登记为已知缺口）：
 *     C1 架构 MCP  = rounds 文件里 archMcp 时间戳
 *     C3 读文档    = rounds 文件里 readDocs 时间戳
 *   为什么 C1/C3 只能自报：架构 MCP 是只读服务不记调用日志；DSH 的 read 工具调用不落盘
 *   （2026-11-07 22:50 实测：会话目录只有 239 字节的 session 头，没有事件流）。
 *   要升级成硬证据，得在 DSH 侧加一个工具调用记录插件 —— 已登记 knownGaps。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROUND_MIN = 20;                  // 一轮 = 20 分钟（主人 2026-11-07 定的固定值）
const WINDOW = { arch: 2, docs: 3, read: 4 };   // 分别卡 2 / 3 / 4 轮

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** C1：最近一次读架构 MCP 的时间（自报，来自 rounds 文件）。 */
function lastArch(roundsFile) {
  const rows = readJsonl(roundsFile).filter((r) => r && r.archMcp);
  if (!rows.length) return 0;
  const at = Date.parse(rows[rows.length - 1].at);
  return Number.isFinite(at) ? at : 0;
}

/** C3：最近一次同时读了「施工文档」和「角色卡」的时间（自报）。 */
function lastReadDocs(roundsFile) {
  const rows = readJsonl(roundsFile).filter((r) => r && Array.isArray(r.readDocs));
  for (let i = rows.length - 1; i >= 0; i--) {
    const list = rows[i].readDocs.join(' ');
    if (/施工文档/.test(list) && /角色/.test(list)) {
      const at = Date.parse(rows[i].at);
      return Number.isFinite(at) ? at : 0;
    }
  }
  return 0;
}

/** C2：知识库里最近被写过/改过的 .md（硬证据：文件系统 mtime，不是自述）。 */
function lastDocTidy(knowledgeDir) {
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/\.md$/i.test(entry.name)) continue;
      const t = mtimeOf(full);
      if (t > newest) newest = t;
    }
  };
  walk(knowledgeDir, 0);
  return newest;
}

/**
 * C4：施工 AI 是否绑着 goal。
 * 读 dsh-goal-keeper 的日志（它是真痕迹）：支持 -2x 会话、多轮转。
 * 最后一条事件是 complete / clear / no-goal → 没有 goal；armed / resume / rN → 绑着。
 */
function workerGoalState(logFile, workerSessionId) {
  const text = (() => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } })();
  if (!text) return { known: false, reason: '读不到 goal-keeper.log（换机器或没装 dsh-goal-keeper）' };
  const lines = text.split(/\r?\n/).filter((l) => l.includes('session-'));
  const mine = workerSessionId ? lines.filter((l) => l.includes(workerSessionId)) : lines;
  if (!mine.length) {
    return { known: false, reason: workerSessionId ? '日志里没有这个会话：' + workerSessionId : '日志里没有任何会话的 goal 事件' };
  }
  const last = mine[mine.length - 1];
  const dead = /goal complete|goal clear|no-goal/.test(last);
  const armed = /armed|resume|goal goal-|r\d/.test(last);
  const at = (last.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/) || [])[1];
  return { known: true, armed: armed && !dead, at: at ? Date.parse(at) : 0, line: last.slice(0, 160) };
}

function verdict(ageMs, windowRounds, label) {
  const limitMs = windowRounds * ROUND_MIN * 60_000;
  if (!ageMs) return { ok: false, detail: label + '：没有任何记录（窗口 ' + windowRounds + ' 轮 = ' + (limitMs / 60_000) + ' 分钟）' };
  const minutes = Math.round(ageMs / 60_000);
  const ok = ageMs <= limitMs;
  return {
    ok,
    detail: label + '：' + minutes + ' 分钟前（窗口 ' + windowRounds + ' 轮 = ' + (limitMs / 60_000) + ' 分钟）',
  };
}


/**
 * C5 用的硬证据：架构正文/图谱最近被改过的时刻。
 * 「写架构 MCP」在盘上的真实形态 = 034/035 或 架构意图 下的正文被更新（MCP 只读，不会替你写）。
 */
function lastArchTouch(archDir) {
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/\.(md|json)$/i.test(entry.name)) continue;
      const t = mtimeOf(full);
      if (t > newest) newest = t;
    }
  };
  walk(archDir, 0);
  return newest;
}

/** C5 的自报那半：rounds 文件里最近一次「过了架构现状」的时刻（archStatus）。 */
function lastArchStatus(roundsFile) {
  const rows = readJsonl(roundsFile).filter((r) => r && r.archStatus);
  if (!rows.length) return 0;
  const at = Date.parse(rows[rows.length - 1].at);
  return Number.isFinite(at) ? at : 0;
}

/**
 * C5（2026-11-07 深夜改版）：每次被激活都要做一次架构巡检，并把「查重结论 + 改没改」记进
 * 架构意图/036-架构巡检记录.jsonl。这里只读最新一条并做结构校验。
 * 为什么改成账本：主人要「每次激活都更新一小下」且「保留他怎么改过来的一路记录」——
 * 光看文件 mtime 只能证明动过，证明不了「先查重再修」。
 */
function lastArchScan(scanFile) {
  const rows = readJsonl(scanFile);
  if (!rows.length) return { known: false, reason: '没有任何巡检记录（' + scanFile + '）' };
  const row = rows[rows.length - 1];
  const at = Date.parse(row.at);
  return { known: true, at: Number.isFinite(at) ? at : 0, row };
}

/**
 * C6（2026-11-08 主人定）：一旦开了任务，20 分钟闹钟不许自己撤，除非主人明确叫停。
 * 只看「有没有一个 ≤20 分钟的重复闹钟」，不绑会话 —— 闹钟在哪台窗口上不重要，别让它空转才重要。
 */
function supervisionAlarm(scheduleFile, maxSeconds = 1200) {
  let j = null;
  try { j = JSON.parse(require('fs').readFileSync(scheduleFile, 'utf8')); } catch { return { known: false, reason: '读不到 schedule.json' }; }
  const tasks = (j.tables && j.tables.tasks) || {};
  const rows = Object.values(tasks).map((r) => r || {});
  const hit = rows.filter((r) => {
    const rec = r.record || {};
    return rec.kind === 'every' && Number(rec.everySeconds) > 0 && Number(rec.everySeconds) <= maxSeconds;
  });
  if (hit.length) {
    const rec = hit[hit.length - 1].record;
    return { known: true, ok: true, reason: '有 ' + (Number(rec.everySeconds) / 60) + ' 分钟闹钟：' + (rec.title || rec.id) };
  }
  return { known: true, ok: false, reason: '没有任何 ≤' + (maxSeconds / 60) + ' 分钟的重复闹钟（现有 ' + rows.length + ' 个任务）' };
}

/**
 * C7（2026-11-08 主人第三次投诉「干一半就收工」）：任务开着就必须有产出。
 * 判据不看你说了什么，只看盘上最近 20 分钟有没有新东西——日志/账本不算产出，代码、文档、记录才算。
 * 为什么这样判：主人说「电脑开着就是干活的」，而"我还在想"和"我已经收工"在盘上没有区别；
 * 用产出当证据是最不容易骗的近似（也会误伤纯思考轮，所以窗口给 20 分钟、只判 BLOCK 不判人）。
 */
function recentOutput(dirs, now, windowMs) {
  const skip = /(\.log$|\.jsonl$|node_modules|[\\/]runs[\\/]|[\\/]\.tmp[\\/]|[\\/]\.git[\\/]|__pycache__|\.zstd$|\.bak)/;
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (skip.test(full)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (now - st.mtimeMs <= windowMs) hits.push({ file: full, at: st.mtimeMs });
    }
  };
  for (const d of dirs) walk(d, 0);
  hits.sort((a, b) => b.at - a.at);
  return { count: hits.length, newest: hits[0] || null };
}

/**
 * 工具痕迹账本（2026-11-08 加）：架构 MCP 每次调用都写一行 .harness/audit/mcp-calls.jsonl。
 * 有了它，「我查过架构」「我读过角色卡」不再靠自报 —— 直接看账本。
 */
function lastMcpCall(ledgerFile, match) {
  const rows = readJsonl(ledgerFile).filter((r) => r && typeof r.tool === 'string' && match.test(r.tool));
  if (!rows.length) return { known: false, at: 0, tool: null };
  const last = rows[rows.length - 1];
  const at = Date.parse(last.at);
  return { known: true, at: Number.isFinite(at) ? at : 0, tool: last.tool, count: rows.length };
}

module.exports = { ROUND_MIN, WINDOW, lastMcpCall, supervisionAlarm, recentOutput, lastArchScan, lastArchTouch, lastArchStatus, lastArch, lastReadDocs, lastDocTidy, workerGoalState, verdict };
