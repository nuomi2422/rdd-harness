'use strict';
/**
 * taskchain-observe.js —— 任务链快照读端（2026-11-09，044-B2，只读）
 * 只回答"在所读到的样本里"可判的事实：多少快照、几条链/几个会话、版本区间与**缺口**、
 * 时间乱序、旧回执计数、epoch 集合、字段缺失。
 * 纪律：任何计数都只代表**本次读取范围**；0 不等于"机制没被触发过"。
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
      const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
      rows.push({
        file, line: i + 1, ts: Number.isFinite(ts) ? ts : null, session: ev.session || null,
        chain: c.chainInstanceId || null, goal: c.goalId || null,
        ver: Number.isFinite(c.stateVersion) ? c.stateVersion : null,
        stale: Number.isFinite(c.staleResultsIgnored) ? c.staleResultsIgnored : null,
        epoch: Number.isFinite(c.ownerEpoch) ? c.ownerEpoch : null,
        settled: c.settledStages && typeof c.settledStages === "object" ? Object.keys(c.settledStages).length : null,
        prim: c.currentPrimaryId || null, sub: c.currentSubtaskId || null,
      });
    }
  }
  if (!rows.length) return { status: "UNKNOWN", reason: "no-taskchain-snapshots", snapshots: 0, rows: [] };
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const chains = uniq(rows.map((r) => r.chain));
  const goals = uniq(rows.map((r) => r.goal));
  const sessions = uniq(rows.map((r) => r.session));
  const epochs = uniq(rows.map((r) => (r.epoch === null ? null : String(r.epoch)))).map(Number);
  const vers = rows.map((r) => r.ver).filter((v) => v !== null);
  let verRegressions = 0, verGaps = 0;
  for (let i = 1; i < vers.length; i += 1) {
    if (vers[i] < vers[i - 1]) verRegressions += 1;
    else if (vers[i] > vers[i - 1] + 1) verGaps += (vers[i] - vers[i - 1] - 1);
  }
  let tsRegressions = 0;
  const ts = rows.map((r) => r.ts).filter((t) => t !== null);
  for (let i = 1; i < ts.length; i += 1) if (ts[i] < ts[i - 1]) tsRegressions += 1;
  const staleTotal = rows.reduce((a, r) => a + (r.stale || 0), 0);
  const missing = { ver: rows.filter((r) => r.ver === null).length, chain: rows.filter((r) => !r.chain).length, stale: rows.filter((r) => r.stale === null).length };
  const last = rows[rows.length - 1];
  const window = ts.length ? { from: new Date(Math.min(...ts)).toISOString(), to: new Date(Math.max(...ts)).toISOString(), spanSec: Math.round((Math.max(...ts) - Math.min(...ts)) / 1000) } : null;
  return {
    status: (missing.ver || missing.chain) ? 'PARTIAL' : 'PRESENT',
    scope: 'only-observed-samples',
    snapshots: rows.length, chains: chains.length, goals: goals.length, sessions: sessions.length,
    verMin: vers.length ? Math.min(...vers) : null, verMax: vers.length ? Math.max(...vers) : null,
    verRegressions, verGaps, tsRegressions, staleResultsIgnored: staleTotal,
    staleZeroNote: staleTotal === 0 ? "本样本计数为 0；计数器生命周期/重置/范围未核，不能推断机制未触发" : null,
    epochs, settledCount: last.settled, currentPrimary: last.prim, currentSubtask: last.sub,
    missingFields: missing, window, rows,
  };
}

module.exports = { build };