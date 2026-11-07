'use strict';
/**
 * learner-gates.js —— 学习者（外部学习 AI）专属门禁判定（2026-11-07 主人定）。
 *
 * 主人原话：**学习者「必须定一个 30 分闹钟、必须检查游戏内产的学习单位看要不要改、
 * 必须看出发了检索的待复核的学习」。**
 *
 * 证据（2026-11-07 23:0x 现场核实过的真实文件）：
 *   L1 30 分闹钟  → ~/.dsh/storages/schedule.json 里 tables.tasks.* 有 kind=every 且 everySeconds<=1800
 *   L2 查学习单位 → <numen>/learner-review-state.json 的 last_review_at 在窗口内（游戏侧真写的复核时刻）
 *   L3 看待复核   → <numen>/learner-enqueued.jsonl 或 review-state 在窗口内被动过（见 note 的已知限度）
 *
 * 诚实限度：L2 只证明「游戏侧做过一次复核」，不证明复核结论对；L3 只证明「队列被动过」，
 * 不证明「看全了」。真正的结论质量靠知识库记录，不靠门禁 —— 这条写进 note，别当成强判据吹。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const WINDOW_MIN = 30;                 // 学习者一轮 = 30 分钟（主人 2026-11-07 定）
const ALARM_MAX_SECONDS = 1800;        // 闹钟上限：30 分钟

function stat(file) {
  try { const s = fs.statSync(file); return { mtimeMs: s.mtimeMs }; } catch { return null; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** L1：有没有一个 30 分钟（或更频繁）的重复闹钟。可按会话 id 过滤，缺省看全部。 */
function alarmState(scheduleFile, sessionId) {
  const j = readJson(scheduleFile);
  if (!j) return { known: false, reason: '读不到 schedule.json（没装 dsh-schedule 或换机器）' };
  const tasks = (j.tables && j.tables.tasks) || {};
  const rows = Object.entries(tasks).map(([id, row]) => ({ id, ...(row || {}) }));
  const mine = sessionId ? rows.filter((r) => r.sessionId === sessionId) : rows;
  if (!mine.length) return { known: true, ok: false, reason: '没有闹钟任务' + (sessionId ? '（会话 ' + sessionId + '）' : '') };
  const every = mine.filter((r) => {
    const rec = r.record || {};
    return rec.kind === 'every' && Number(rec.everySeconds) > 0 && Number(rec.everySeconds) <= ALARM_MAX_SECONDS;
  });
  if (every.length) {
    const r = every[every.length - 1].record;
    return { known: true, ok: true, reason: '有 ' + (Number(r.everySeconds) / 60) + ' 分钟闹钟：' + (r.title || r.id) };
  }
  const all = mine.map((r) => (r.record || {}).kind + '/' + ((r.record || {}).everySeconds ?? '-')).join(', ');
  return { known: true, ok: false, reason: '有闹钟但没有 ≤30 分钟的 every 任务（现有：' + all + '）' };
}

/** L2：游戏侧最近一次复核学习单位的时刻（learner-review-state.json 是游戏真写的）。 */
function reviewState(numenDir) {
  const file = path.join(numenDir, 'learner-review-state.json');
  const j = readJson(file);
  if (!j || !j.last_review_at) return { known: false, at: 0, reason: '读不到 learner-review-state.json' };
  const at = Date.parse(j.last_review_at);
  return {
    known: true,
    at: Number.isFinite(at) ? at : 0,
    verdicts: j.last_verdict_count,
    reason: 'last_review_at=' + j.last_review_at + '，结论 ' + j.last_verdict_count + ' 条',
  };
}

/** L3：检索发出的待复核队列有没有被巡检（文件被动过 = 有人消费/清理）。 */
function pendingQueue(numenDir) {
  const file = path.join(numenDir, 'learner-enqueued.jsonl');
  let lines = 0;
  try {
    lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
  } catch { return { known: false, reason: '读不到 learner-enqueued.jsonl' }; }
  const s = stat(file);
  return { known: true, pendingLines: lines, mtimeMs: s ? s.mtimeMs : 0 };
}

module.exports = { WINDOW_MIN, ALARM_MAX_SECONDS, alarmState, reviewState, pendingQueue, stat };
