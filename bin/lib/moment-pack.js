'use strict';
/**
 * moment-pack.js —— 按时刻的证据包（2026-11-09，044-A1 读端，只读）
 * 给一个时间点，把四条流里 ±窗口 内的事件按时间排出来，每条带 文件:行号。
 * 只输出类型/工具名等元信息，不外带正文、参数、结果内容。
 * 边界：只按 timestamp/at 过滤，不推因果；无数据 → UNKNOWN。
 */
function pack(linesByFile, atIso, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return { status: 'UNKNOWN', reason: 'bad-time', rows: [] };
  const span = Number.isFinite(o.spanSec) ? o.spanSec : 30;
  const lo = at - span * 1000;
  const hi = at + span * 1000;
  const rows = [];
  for (const file of Object.keys(linesByFile || {})) {
    const text = linesByFile[file];
    const lines = String(text || "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const s = lines[i].trim();
      if (!s) continue;
      let ev; try { ev = JSON.parse(s); } catch { continue; }
      const raw = ev.timestamp || ev.at || (ev.data && (ev.data.timestamp || ev.data.at));
      const t = raw ? Date.parse(raw) : NaN;
      if (!Number.isFinite(t) || t < lo || t > hi) continue;
      const d = ev.data || {};
      rows.push({ t, file, line: i + 1, type: String(ev.type || '?'), tool: d.tool || null, companion: d.companion_id || d.companionId || null });
    }
  }
  rows.sort((a, b) => a.t - b.t || a.file.localeCompare(b.file) || a.line - b.line);
  const byType = {};
  for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
  return { status: rows.length ? 'PRESENT' : 'UNKNOWN', reason: rows.length ? null : 'no-events-in-window', at: atIso, spanSec: span, total: rows.length, byType, rows };
}

function render(res, limit) {
  const max = Number.isFinite(limit) ? limit : 40;
  const out = [];
  out.push('[时刻证据包] ' + (res.at || '?') + ' ±' + (res.spanSec || '?') + 's  事件=' + (res.total === undefined ? 0 : res.total) + (res.status === 'UNKNOWN' ? '（' + res.reason + '）' : ''));
  if (res.byType) out.push('类型: ' + Object.keys(res.byType).map(k => k + '=' + res.byType[k]).join(' '));
  for (const r of (res.rows || []).slice(0, max)) {
    out.push('  ' + new Date(r.t).toISOString().slice(11, 23) + ' ' + r.type + (r.tool ? '[' + r.tool + ']' : '') + '  (' + r.file + ':' + r.line + ')');
  }
  if ((res.rows || []).length > max) out.push('  … 另有 ' + (res.rows.length - max) + ' 条未列');
  return out.join('\n');
}

module.exports = { pack, render };
