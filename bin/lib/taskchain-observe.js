'use strict';
/**
 * taskchain-observe.js —— 任务链快照读端（2026-11-09，044-B2，只读）
 * 只回答"在所读到的样本里"可判的事实：多少快照、几条链/几个会话、版本区间与**缺口**、
 * 时间乱序、旧回执计数、epoch 集合、字段缺失。
 * 纪律：任何计数都只代表**本次读取范围**；0 不等于"机制没被触发过"。
 */
function build(linesByFile, opts) {
  const rows = [];
  const gaps = [];
  let malformedLines = 0;
  let order = 0;
  let expansionFailures = 0, expansionExhausted = 0, lastExpansionFailure = null;
  // 所有 rdd 行的时间戳（用于判断"缺口期间还有没有别的活动"）
  const anyRddTs = [];
  for (const file of Object.keys(linesByFile || {})) {
    const lines = String(linesByFile[file] || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const s = lines[i].trim();
      if (!s) continue;
      let ev; try { ev = JSON.parse(s); } catch {
        malformedLines += 1;
        gaps.push({ code: 'MALFORMED_LINE', file, line: i + 1 });
        continue;
      }
      const anyTs = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
      if (Number.isFinite(anyTs)) anyRddTs.push(anyTs);
      if (ev.type === 'expansion_failed') {
        expansionFailures += 1;
        lastExpansionFailure = { file, line: i + 1, timestamp: ev.timestamp || null, primary: ev.data && ev.data.primary || null, reason: ev.data && ev.data.reason || null };
      }
      if (ev.type === 'expansion_exhausted') expansionExhausted += 1;
      if (String(ev.type || '') !== 'taskchain_snapshot') continue;
      const c = (ev.data && ev.data.taskChain) || {};
      const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
      rows.push({
        file, line: i + 1, order: order++, ts: Number.isFinite(ts) ? ts : null, session: ev.session || null,
        chain: c.chainInstanceId || null, goal: c.goalId || null,
        ver: Number.isFinite(c.stateVersion) ? c.stateVersion : null,
        stale: Number.isFinite(c.staleResultsIgnored) ? c.staleResultsIgnored : null,
        epoch: Number.isFinite(c.ownerEpoch) ? c.ownerEpoch : null,
        settled: c.settledStages && typeof c.settledStages === "object" ? Object.keys(c.settledStages).length : null,
        settledKeys: c.settledStages && typeof c.settledStages === 'object' ? Object.keys(c.settledStages) : null,
        prim: c.currentPrimaryId || null, sub: c.currentSubtaskId || null,
      });
    }
  }
  if (!rows.length) return { status: "UNKNOWN", reason: "no-taskchain-snapshots", snapshots: 0, rows: [], malformedLines, gaps, expansionFailures, expansionExhausted, lastExpansionFailure };
  const physicalRows = [...rows];
  const orderedRows = rows.some((r) => r.ts !== null) ? [...rows].sort((a, b) => {
    if (a.ts === null && b.ts === null) return a.order - b.order;
    if (a.ts === null) return 1;
    if (b.ts === null) return -1;
    return a.ts - b.ts || a.order - b.order;
  }) : rows;
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const chains = uniq(rows.map((r) => r.chain));
  const goals = uniq(rows.map((r) => r.goal));
  const sessions = uniq(rows.map((r) => r.session));
  const epochs = uniq(rows.map((r) => (r.epoch === null ? null : String(r.epoch)))).map(Number);
  // 2026-11-10：版本必须**按链**比较——不同链各自编号，混在一起算回退/缺口没有意义。
  const byChain = new Map();
  for (const r of orderedRows) {
    const key = r.chain || '(no-chain)';
    if (!byChain.has(key)) byChain.set(key, []);
    byChain.get(key).push(r);
  }
  const versionRows = (list) => list.some((r) => r.ts !== null) ? list.filter((r) => r.ts !== null) : list;
  const vers = orderedRows.map((r) => r.ver).filter((v) => v !== null);
  let verRegressions = 0, verGaps = 0;
  for (const list of byChain.values()) {
    const vs = versionRows(list).map((r) => r.ver).filter((v) => v !== null);
    for (let i = 1; i < vs.length; i += 1) {
      if (vs[i] < vs[i - 1]) verRegressions += 1;
      else if (vs[i] > vs[i - 1] + 1) verGaps += (vs[i] - vs[i - 1] - 1);
    }
  }
  // 版本跳跃分两类：同一瞬间多次状态变更（快照节流，不算丢失） vs 间隔很久（可疑）。
  let fastGaps = 0, slowGaps = 0;
  for (const list of byChain.values()) {
    const vr = versionRows(list);
    for (let i = 1; i < vr.length; i += 1) {
      const a = vr[i - 1], b = vr[i];
      if (a.ver === null || b.ver === null) continue;
      if (b.ver <= a.ver + 1) continue;
      const dt = (a.ts !== null && b.ts !== null) ? (b.ts - a.ts) : null;
      if (dt !== null && dt <= 1000) fastGaps += 1; else slowGaps += 1;
    }
  }
  // slow 缺口期间是否还有别的 rdd 行：有 ⇒ 更像快照节流；没有 ⇒ 真空白（可疑）
  let slowGapActive = 0, slowGapBlank = 0;
  for (const list of byChain.values()) {
    const vr = versionRows(list);
    for (let i = 1; i < vr.length; i += 1) {
      const a = vr[i - 1], b = vr[i];
      if (a.ver === null || b.ver === null) continue;
      if (b.ver <= a.ver + 1) continue;
      if (a.ts === null || b.ts === null || (b.ts - a.ts) <= 1000) continue;
      const others = anyRddTs.filter((t) => t > a.ts && t < b.ts).length;
      if (others > 0) slowGapActive += 1; else slowGapBlank += 1;
    }
  }
  let tsRegressions = 0;
  const physicalTs = physicalRows.map((r) => r.ts).filter((t) => t !== null);
  for (let i = 1; i < physicalTs.length; i += 1) if (physicalTs[i] < physicalTs[i - 1]) tsRegressions += 1;
  const staleTotal = rows.reduce((a, r) => a + (r.stale || 0), 0);
  const missing = { ver: rows.filter((r) => r.ver === null).length, chain: rows.filter((r) => !r.chain).length, stale: rows.filter((r) => r.stale === null).length, timestamp: rows.filter((r) => r.ts === null).length };
  const last = orderedRows.filter((r) => r.ts !== null).pop() || physicalRows[physicalRows.length - 1];
  const currentBasis = last.ts !== null ? 'latest_timestamp' : 'physical_order_no_timestamp';
  const ts = rows.map((r) => r.ts).filter((t) => t !== null);
  const window = ts.length ? { from: new Date(Math.min(...ts)).toISOString(), to: new Date(Math.max(...ts)).toISOString(), spanSec: Math.round((Math.max(...ts) - Math.min(...ts)) / 1000) } : null;
  return {
    status: (missing.ver || missing.chain || malformedLines) ? 'PARTIAL' : 'PRESENT',
    scope: 'only-observed-samples',
    snapshots: rows.length, chains: chains.length, goals: goals.length, sessions: sessions.length,
    verMin: vers.length ? Math.min(...vers) : null, verMax: vers.length ? Math.max(...vers) : null,
    verRegressions, verGaps, fastGaps, slowGaps, slowGapActive, slowGapBlank, tsRegressions, staleResultsIgnored: staleTotal,
    chainsDetail: [...byChain.entries()].map(([id, list]) => {
      const values = list.map((r) => r.ver).filter((v) => v !== null);
      return { chain: id, snapshots: list.length, verMin: values.length ? Math.min(...values) : null, verMax: values.length ? Math.max(...values) : null };
    }),
    staleZeroNote: staleTotal === 0 ? "本样本计数为 0；计数器生命周期/重置/范围未核，不能推断机制未触发" : null,
    verGapsNote: verGaps ? "版本跳跃 fast=" + fastGaps + " slow=" + slowGaps + "；slow 中有其它 rdd 行=" + slowGapActive + "（更像节流）、空白=" + slowGapBlank + "（真空白才可疑）" : null,
    epochs, settledCount: last.settled, currentPrimary: last.prim, currentSubtask: last.sub, currentBasis,
    // B2 口径：当前主项目标若已出现在 settledStages 里 ⇒ "历史完成"与"当前主支"冲突，需要人看。
    currentPrimarySettled: !!(last.settledKeys && last.prim && last.settledKeys.includes(last.prim)),
    settledKeysCount: last.settledKeys ? last.settledKeys.length : null,
    missingFields: missing, malformedLines, gaps, window, rows: orderedRows,
    expansionFailures, expansionExhausted, lastExpansionFailure,
  };
}

module.exports = { build };