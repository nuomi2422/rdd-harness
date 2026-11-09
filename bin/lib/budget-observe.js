'use strict';
/**
 * budget-observe.js —— 预算可观测性（2026-11-09，044 读端，只读）
 * 从 context.jsonl / 其它流里统计：budget_gate(trimmed)、budget_settle、llm_usage(totalTokens)、llm_request(promptTokens)。
 * 坏值（非数值/负数）不算 0，单列 invalid；一条预算相关事件都没有 → UNKNOWN。
 */
function num(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }

function build(linesByFile) {
  const out = { gateEvents: 0, trimmedEvents: 0, trimmedTotal: 0, settleEvents: 0, usageEvents: 0, tokensTotal: 0, requestEvents: 0, promptTokensTotal: 0, invalid: 0, pointers: [],
    byMode: {}, byProvider: {}, ratios: [], limitTokens: [], turns: [], trimmedGreaterThanInput: 0 }; 
  for (const file of Object.keys(linesByFile || {})) {
    const lines = String(linesByFile[file] || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const s = lines[i].trim();
      if (!s) continue;
      let ev; try { ev = JSON.parse(s); } catch { continue; }
      const t = String(ev.type || "");
      const d = ev.data || {};
      if (t === "budget_gate") {
        out.gateEvents += 1;
        // 字段缺失 ≠ 坏值：缺失只说明这条没带预算信息，不当 0 也不记 invalid。
        if (d.trimmed !== undefined) {
          const tr = num(d.trimmed);
          if (tr === null) out.invalid += 1;
          else if (tr > 0) {
            out.trimmedEvents += 1; out.trimmedTotal += tr;
            const mode = String(d.mode || 'unknown');
            const prov = String(d.provider || 'unknown');
            out.byMode[mode] = (out.byMode[mode] || 0) + 1;
            out.byProvider[prov] = (out.byProvider[prov] || 0) + 1;
            const ratio = num(d.ratio);
            if (ratio !== null) out.ratios.push(ratio);
            // 记录 trimmed>gateInput 的次数：按源码这是常态（本地估算偏高），保留计数便于发现口径变化
            const gi = num(d.gateInput);
            if (gi !== null && tr > gi) out.trimmedGreaterThanInput = (out.trimmedGreaterThanInput || 0) + 1;
            const lim = num(d.limitTokens);
            if (lim !== null) out.limitTokens.push(lim);
            if (typeof d.turn === 'number') out.turns.push(d.turn);
          }
        }
        out.pointers.push(file + ":" + (i + 1));
      } else if (t === "budget_settle") {
        out.settleEvents += 1;
      } else if (t === "llm_usage") {
        out.usageEvents += 1;
        if (d.totalTokens !== undefined) {
          const v = num(d.totalTokens);
          if (v === null) out.invalid += 1; else out.tokensTotal += v;
        }
      } else if (t === "llm_request") {
        out.requestEvents += 1;
        if (d.promptTokens !== undefined) {
          const v = num(d.promptTokens);
          if (v === null) out.invalid += 1; else out.promptTokensTotal += v;
        }
      }
    }
  }
  // 汇总：裁剪比例与上限的分布（只做描述，不推因果）
  const stat = (arr) => (arr.length ? { n: arr.length, min: Math.min(...arr), max: Math.max(...arr), avg: Number((arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(3)) } : null);
  out.ratioStat = stat(out.ratios);
  // 语义（2026-11-09 读 EntityAgentLoop 源码确认）：
  //   trimmed = 本轮**原始本地估算 token**（estimateRequestTokens）
  //   gateInput = 用上一次校准比例换算后的入闸 token（calibration.gate）
  //   ratio = lastMeasured / lastTrimmed（校准比例，实测/估算）
  // ⇒ trimmed > gateInput 属**设计使然**（本地估算系统性偏高），不是异常；也不是"已裁剪量"。
  out.limitStat = stat(out.limitTokens);
  const modes = Object.keys(out.byMode);
  out.shadowOnly = modes.length > 0 && modes.every((m) => m === 'shadow');
  out.trimmedIsEstimate = out.shadowOnly;
  const any = out.gateEvents + out.settleEvents + out.usageEvents + out.requestEvents;
  const status = any === 0 ? "UNKNOWN" : (out.invalid ? "PARTIAL" : "PRESENT");
  return { status, ...out, reasons: any === 0 ? ["no-budget-events"] : (out.invalid ? ["invalid-values"] : []) };
}

module.exports = { build };