'use strict';
/**
 * taskchain-observe.js —— 任务链快照读端（2026-11-09，044-B2，只读）
 * 只回答可判的事实：多少快照、几条链、版本区间是否单调、旧回执被忽略次数、当前 settle 条目数。
 * 不解释原因、不判断"对不对"；无数据 UNKNOWN，字段缺失 PARTIAL。
 */
function build(linesByFile) {
  const rows = [];
  for (const file of Object.keys(linesByFile || {})) {
    const lines = String(linesByFile[file] || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const s = lines[i].trim();
      if (!s) continue;
      let ev; try { ev = JSON.parse(s); } catch { continue; }
      if (String(ev.type || '') !== 'taskchain_snapshot') continue;
      const c = (ev.data && ev.data.taskChain) || {};
      rows.push({ file, line: i + 1, chain: c.chainInstanceId || null, goal: c.goalId || null, ver: Number.isFinite(c.stateVersion) ? c.stateVersion : null, stale: Number.isFinite(c.staleResultsIgnored) ? c.staleResultsIgnored : null, epoch: Number.isFinite(c.ownerEpoch) ? c.ownerEpoch : null, settled: c.settledStages && typeof c.settledStages === 'object' ? Object.keys(c.settledStages).length : null, prim: c.currentPrimaryId || null, sub: c.currentSubtaskId || null });
    }
  }
  if (!rows.length) return { status: "UNKNOWN", reason: "no-taskchain-snapshots", rows: [] };
  const chains = [...new Set(rows.map((r) => r.chain).filter(Boolean))];
  const goals = [...new Set(rows.map((r) => r.goal).filter(Boolean))];
  const vers = rows.map((r) => r.ver).filter((v) => v !== null);
  const staleTotal = rows.reduce((a, r) => a + (r.stale || 0), 0);
  let verRegressions = 0;
  for (let i = 1; i < vers.length; i += 1) if (vers[i] < vers[i - 1]) verRegressions += 1;
  const missing = rows.filter((r) => r.ver === null || r.chain === null).length;
  const epochs = [...new Set(rows.map((r) => r.epoch).filter((e) => e !== null))];
  const last = rows[rows.length - 1];
  return { status: missing ? 'PARTIAL' : 'PRESENT', snapshots: rows.length, chains: chains.length, goals: goals.length, verMin: vers.length ? Math.min(...vers) : null, verMax: vers.length ? Math.max(...vers) : null, verRegressions, staleResultsIgnored: staleTotal, epochs, settledCount: last.settled, currentPrimary: last.prim, currentSubtask: last.sub, missingFields: missing, rows };
}

module.exports = { build };