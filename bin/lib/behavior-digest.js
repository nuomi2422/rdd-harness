'use strict';
/**
 * behavior-digest.js —— 行为轨迹摘要（2026-11-09，只读；047-B 的实现）
 *
 * 目的：把"说（ai）/做（tools）/果（events、rdd）"压成一段 ≤1200 字的摘要，
 * 并**必须带异常摘要**（重复失败 / 连续只读 / 原地打转 / 死亡链）——那才是找盲点的部分。
 *
 * 约束：
 *   - 每条都带来源指针（文件 + 行号），可回查原始行；
 *   - 没有数据的部分写 UNKNOWN，不编；
 *   - 不改任何流，只读。
 */
const LIMIT = 1200;

function parseLines(text, file) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const s = lines[i].trim();
    if (!s) continue;
    try { rows.push({ o: JSON.parse(s), file, line: i + 1 }); } catch { /* 坏行由上层计 */ }
  }
  return rows;
}

function tsOf(r) {
  const v = r.o.timestamp || r.o.at || (r.o.data && (r.o.data.timestamp || r.o.data.at));
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

function within(rows, sinceMs, untilMs) {
  return rows.filter((r) => {
    const t = tsOf(r);
    if (t === null) return true; // 缺时间保留（不静默丢）
    return t >= sinceMs && t <= untilMs;
  });
}

function buildDigest(input) {
  // sinceMs=0 是合法边界（从头），不能用 || 取默认值，否则会被当成缺省。
  const sinceRaw = Number(input && input.sinceMs);
  const untilRaw = Number(input && input.untilMs);
  const sinceMs = Number.isFinite(sinceRaw) ? sinceRaw : Date.now() - 30 * 60_000;
  const untilMs = Number.isFinite(untilRaw) ? untilRaw : Date.now();
  const ai = within(parseLines(input && input.ai, 'ai.jsonl'), sinceMs, untilMs);
  const tools = within(parseLines(input && input.tools, 'tools.jsonl'), sinceMs, untilMs);
  const events = within(parseLines(input && input.events, 'events.jsonl'), sinceMs, untilMs);
  const rdd = within(parseLines(input && input.rdd, 'rdd.jsonl'), sinceMs, untilMs);

  const said = ai.filter((r) => /assistant|think|reason/i.test(String(r.o.type || ''))).slice(-5);
  const did = tools.filter((r) => String(r.o.type) === 'tool_call').slice(-5);
  const done = tools.filter((r) => String(r.o.type) === 'tool_result').slice(-5);

  const anomalies = [];
  // 重复失败：同一 tool 连续失败 ≥3
  const fails = tools.filter((r) => {
    const d = r.o.data || {};
    const ok = d.success ?? (d.result && d.result.success);
    return ok === false;
  });
  const byTool = new Map();
  for (const f of fails) {
    const t = String((f.o.data || {}).tool || '?');
    byTool.set(t, (byTool.get(t) || 0) + 1);
  }
  for (const [t, n] of byTool) if (n >= 3) anomalies.push('重复失败 ' + t + '×' + n + '（' + fails[0].file + ':' + fails[0].line + '）');
  // 连续只读：最近 5 次调用都是 get/inspect/list
  const last5 = did.slice(-5);
  if (last5.length === 5 && last5.every((r) => /get|inspect|list|query|read/i.test(String((r.o.data || {}).tool || '')))) {
    anomalies.push('连续只读 5 次（' + last5[0].file + ':' + last5[0].line + '）');
  }
  // 死亡链
  const deaths = events.filter((r) => /death/i.test(String(r.o.type || '')));
  if (deaths.length) anomalies.push('死亡事件 ' + deaths.length + ' 次（' + deaths[0].file + ':' + deaths[0].line + '）');
  // 原地打转：rdd 中连续 ≥3 条同一 phase/state
  const sameChain = [];
  for (let i = 1; i < rdd.length; i += 1) {
    const a = rdd[i - 1].o.data || {};
    const b = rdd[i].o.data || {};
    if (a.phase && a.phase === b.phase && a.state === b.state) sameChain.push(rdd[i]);
    else sameChain.length = 0;
    if (sameChain.length >= 2) { anomalies.push('原地打转 phase=' + b.phase + '（' + rdd[i].file + ':' + rdd[i].line + '）'); break; }
  }

  // 2026-11-09：**脱敏**——只输出"类型/工具名/长度/成败"等元信息 + 文件:行号，
  // 绝不输出正文、参数、命令、结果内容（那些可能含任务正文或凭据）。
  const fmt = (r, text) => '  - ' + text + '（' + r.file + ':' + r.line + '）';
  const len = (v) => (typeof v === 'string' ? v.length : 0);
  const parts = [];
  parts.push('[行为摘要 ' + new Date(sinceMs).toISOString().slice(11, 16) + '~' + new Date(untilMs).toISOString().slice(11, 16) + ']');
  parts.push('说 ' + said.length + ' 条 / 做 ' + did.length + ' 条 / 果 ' + done.length + ' 条 / 事件 ' + events.length + ' 条');
  if (said.length) parts.push('说：\n' + said.map((r) => fmt(r, 'assistant 文本 ' + len((r.o.data || {}).text) + ' 字（内容不外带）')).join('\n'));
  if (did.length) parts.push('做：\n' + did.map((r) => fmt(r, String((r.o.data || {}).tool || '?'))).join('\n'));
  if (done.length) parts.push('果：\n' + done.map((r) => {
    const d = r.o.data || {};
    const ok = d.success ?? (d.result && d.result.success);
    return fmt(r, '结果 ' + (ok === undefined ? 'UNKNOWN' : ok ? 'ok' : 'fail') + (Number.isFinite(d.duration_ms) ? ' ' + d.duration_ms + 'ms' : ''));
  }).join('\n'));
  parts.push(anomalies.length ? '异常：\n' + anomalies.map((a) => '  - ' + a).join('\n') : '异常：UNKNOWN（窗口内没检出已知模式，不代表没有问题）');

  let text = parts.join('\n');
  let truncated = false;
  if (text.length > LIMIT) { text = text.slice(0, LIMIT - 20) + '\n…（已截断）'; truncated = true; }
  return {
    text,
    truncated,
    counts: { said: said.length, did: did.length, done: done.length, events: events.length, anomalies: anomalies.length },
    anomalies,
  };
}

module.exports = { buildDigest, LIMIT };