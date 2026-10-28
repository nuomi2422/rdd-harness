#!/usr/bin/env node
'use strict';
/**
 * exp-craft-ab.js —— craft 经验 A/B 的机械裁决（可重复、不认口头结论）
 *
 * 为什么存在：
 *   V-20261026-13 的两对 A/B 是拿临时 python 片段数出来的，换个会话就复现不了。
 *   这份脚本把「判据 ④」写成代码：同一母版、可比 control_key、按 tools.jsonl 的
 *   craft 结果序列判 treatment 是否真的更少 3x3 空转 / 是否先做工作台。
 *
 * 用法：
 *   node exp-craft-ab.js <baseRunDir> <treatRunDir> [--json]
 *   node exp-craft-ab.js --self-test
 *
 * 判据（与 V-20261026-13 冻结判据一致，不许在这里放宽）：
 *   ① 母版可比：两轮 envelope.master.manifest.sha256 相同
 *   ② 环境可比：两轮 world.before.stable_key 相同（time_bucket 不算）
 *   ③ 变量真生效：treatment 的 llm_request 里出现 craft 经验的 ref 次数 > 0；
 *      且 baseline 里 0 次（否则“变量没进/没退”都给不出结论）
 *   ④ 行为：treatment 的 3x3 失败次数 < baseline，或 treatment 在第一次 3x3 尝试之前
 *      就 craft 了 crafting_table（baseline 没有）
 *   ⑤ 自然调用：两轮 craft 的 tool_call_id 都是 call_ 前缀（mcp- 是外部调用，不算行为）
 *   全过 → PASS；③④ 任一不成立 → INCONCLUSIVE；①②⑤ 不成立 → INVALID（实验本身不成立）
 *
 * 退出码：0 PASS / 1 INCONCLUSIVE / 2 INVALID / 3 用法或读盘错误
 */
const fs = require('fs');
const path = require('path');

const REF_HINT = 'craft 3x3';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readLines(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
}

function loadArm(dir) {
  const ev = path.join(dir, 'evidence');
  const envPath = path.join(dir, 'envelope.json');
  if (!fs.existsSync(envPath)) throw new Error('no envelope.json: ' + dir);
  const env = readJson(envPath);
  const arm = {
    dir,
    runId: env.runId,
    watchSeconds: (env.timings || {}).watchSeconds || null,
    stopReason: (env.watch || {}).stopReason || null,
    masterSha: ((env.master || {}).manifest || {}).sha256 || null,
    stableKeyBefore: (((env.world || {}).before) || {}).stable_key || null,
    controlKeyBefore: (((env.world || {}).before) || {}).control_key || null,
    crafts: [],
    llmRequests: 0,
    refHits: 0,
  };

  for (const line of readLines(path.join(ev, 'tools.jsonl'))) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const d = o.data || {};
    if (o.type !== 'tool_result' || d.tool !== 'craft') continue;
    let r = {};
    try { r = JSON.parse(d.result || '{}'); } catch { /* 原文兜底 */ }
    const msg = String(r.message || d.result || '');
    arm.crafts.push({
      at: o.timestamp,
      ok: r.success === true,
      msg,
      callId: d.tool_call_id || '',
      // 「3x3 相关动作」= 失败在 3x3 配方上，或成功时用的是工作台（2x2 会写 Used your own 2x2 grid）
      is3x3Fail: /3x3 recipe/.test(msg) && r.success !== true,
      craftedTable: r.success === true && /crafted \d+x crafting_table/.test(msg),
      usedTable: r.success === true && /Used the (crafting table at|already-open grid)/.test(msg),
    });
  }

  for (const line of readLines(path.join(ev, 'context.jsonl'))) {
    if (!line.includes('"type":"llm_request"')) continue;
    arm.llmRequests++;
    if (line.includes(REF_HINT)) arm.refHits++;
  }
  return arm;
}

function summarize(arm) {
  const c = arm.crafts;
  const fails3 = c.filter(x => x.is3x3Fail);
  const tables = c.filter(x => x.craftedTable);
  // 第一次「碰 3x3」：失败在 3x3 上，或成功时用了工作台 —— 两者都说明她在动 3x3 配方
  const firstAttempt = c.find(x => x.is3x3Fail || x.usedTable) || null;
  const firstTable = tables[0] || null;
  const tableBeforeFirstAttempt = !!(firstTable && (!firstAttempt
      || Date.parse(firstTable.at) <= Date.parse(firstAttempt.at)));
  const naturalOnly = c.every(x => x.callId.startsWith('call_'));
  return {
    craftCalls: c.length,
    fails3x3: fails3.length,
    failTimes: fails3.map(x => x.at),
    tablesCrafted: tables.length,
    firstTableAt: firstTable ? firstTable.at : null,
    first3x3At: firstAttempt ? firstAttempt.at : null,
    tableBeforeFirst3x3: tableBeforeFirstAttempt,
    naturalOnly,
    sequence: c.map(x => ({
      at: x.at,
      ok: x.ok,
      what: x.craftedTable ? 'craft_table' : (x.is3x3Fail ? '3x3-fail' : (x.usedTable ? '3x3-ok' : 'craft')),
      usedTable: x.usedTable,
      msg: x.msg.slice(0, 120),
    })),
    llmRequests: arm.llmRequests,
    refHits: arm.refHits,
  };
}

function judge(base, treat) {
  const b = summarize(base), t = summarize(treat);
  const reasons = [];
  let verdict = 'PASS';

  const masterOk = base.masterSha && base.masterSha === treat.masterSha;
  if (!masterOk) { verdict = 'INVALID'; reasons.push('母版 manifest 不同: ' + base.masterSha + ' vs ' + treat.masterSha); }

  const envOk = base.stableKeyBefore && base.stableKeyBefore === treat.stableKeyBefore;
  if (!envOk) { verdict = 'INVALID'; reasons.push('stable_key 不同（环境不可比）'); }

  const varOk = b.refHits === 0 && t.refHits > 0;
  if (!varOk) {
    if (verdict === 'PASS') verdict = 'INCONCLUSIVE';
    reasons.push('变量不可确认: baseline ref=' + b.refHits + '/' + b.llmRequests
        + ', treatment ref=' + t.refHits + '/' + t.llmRequests + '（要求 baseline=0 且 treatment>0）');
  }

  const behaviorOk = t.fails3x3 < b.fails3x3
      || (t.tableBeforeFirst3x3 && !b.tableBeforeFirst3x3);
  if (!behaviorOk) {
    if (verdict === 'PASS') verdict = 'INCONCLUSIVE';
    reasons.push('行为无差异: 3x3 失败 baseline=' + b.fails3x3 + ' / treatment=' + t.fails3x3
        + '；先做工作台 baseline=' + b.tableBeforeFirst3x3 + ' / treatment=' + t.tableBeforeFirst3x3);
  }

  const naturalOk = b.naturalOnly && t.naturalOnly;
  if (!naturalOk) { verdict = 'INVALID'; reasons.push('存在非自然 craft 调用（mcp- 前缀）'); }

  if (verdict === 'PASS' && reasons.length === 0) {
    reasons.push('treatment 3x3 失败更少，或先做工作台 —— 与冻结判据一致');
  }
  return { verdict, reasons, baseline: b, treatment: t };
}

function selfTest() {
  // 用临时目录造假证据，验证三条判定：PASS / INCONCLUSIVE / INVALID
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-ab-'));
  const mk = (name, { master, stable, refs, crafts }) => {
    const d = path.join(root, name);
    fs.mkdirSync(path.join(d, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(d, 'envelope.json'), JSON.stringify({
      runId: name,
      timings: { watchSeconds: 600 },
      watch: { stopReason: 'wall 600s' },
      master: { manifest: { sha256: master } },
      world: { before: { stable_key: stable, control_key: stable } },
    }));
    fs.writeFileSync(path.join(d, 'evidence', 'tools.jsonl'), crafts.map(c => JSON.stringify({
      type: 'tool_result', timestamp: c.at,
      data: { tool: 'craft', result: JSON.stringify({ success: c.ok, message: c.msg }), tool_call_id: 'call_x' },
    })).join('\n') + '\n');
    const reqs = [];
    for (let i = 0; i < 10; i++) reqs.push(JSON.stringify({ type: 'llm_request', body: i < refs ? 'xx exp:failure|craft 3x3 …' : 'plain' }));
    fs.writeFileSync(path.join(d, 'evidence', 'context.jsonl'), reqs.join('\n') + '\n');
    return d;
  };
  const fail3 = { at: '2026-01-01T00:00:01Z', ok: false, msg: 'x is a 3x3 recipe — none within 16 blocks' };
  const table = { at: '2026-01-01T00:00:02Z', ok: true, msg: 'crafted 1x crafting_table — used 4x planks' };

  const a = mk('a', { master: 'M1', stable: 'S1', refs: 0, crafts: [fail3, table] });
  const b = mk('b', { master: 'M1', stable: 'S1', refs: 10, crafts: [table] });
  const r1 = judge(loadArm(a), loadArm(b));
  const c = mk('c', { master: 'M1', stable: 'S1', refs: 10, crafts: [fail3, table] });
  const r2 = judge(loadArm(a), loadArm(c));
  const d2 = mk('d', { master: 'M2', stable: 'S1', refs: 10, crafts: [table] });
  const r3 = judge(loadArm(a), loadArm(d2));

  const ok = r1.verdict === 'PASS' && r2.verdict === 'INCONCLUSIVE' && r3.verdict === 'INVALID';
  console.log(JSON.stringify({ selfTest: ok ? 'PASS' : 'FAIL', cases: [r1.verdict, r2.verdict, r3.verdict] }));
  return ok ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());
  const json = argv.includes('--json');
  const dirs = argv.filter(a => !a.startsWith('--'));
  if (dirs.length !== 2) {
    console.error('usage: node exp-craft-ab.js <baseRunDir> <treatRunDir> [--json] | --self-test');
    process.exit(3);
  }
  let base, treat;
  try {
    base = loadArm(path.resolve(dirs[0]));
    treat = loadArm(path.resolve(dirs[1]));
  } catch (e) {
    console.error('read error: ' + e.message);
    process.exit(3);
  }
  const r = judge(base, treat);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('=== craft A/B 机械裁决 ===');
    console.log('baseline : ' + base.runId + '   (watch ' + base.watchSeconds + 's, ' + base.stopReason + ')');
    console.log('treatment: ' + treat.runId + '   (watch ' + treat.watchSeconds + 's, ' + treat.stopReason + ')');
    console.log('母版 sha  : ' + String(base.masterSha).slice(0, 16) + ' / ' + String(treat.masterSha).slice(0, 16));
    console.log('stable_key: ' + (base.stableKeyBefore === treat.stableKeyBefore ? '相同' : '不同'));
    console.log('craft ref : ' + r.baseline.refHits + '/' + r.baseline.llmRequests + '  vs  '
        + r.treatment.refHits + '/' + r.treatment.llmRequests);
    console.log('3x3 失败  : ' + r.baseline.fails3x3 + '  vs  ' + r.treatment.fails3x3);
    console.log('先做工作台: ' + r.baseline.tableBeforeFirst3x3 + '  vs  ' + r.treatment.tableBeforeFirst3x3);
    console.log('craft 序列(baseline) : ' + r.baseline.sequence.map(s => (s.ok ? '' : '!') + s.what).join(' → '));
    console.log('craft 序列(treatment): ' + r.treatment.sequence.map(s => (s.ok ? '' : '!') + s.what).join(' → '));
    console.log('裁决      : ' + r.verdict);
    for (const why of r.reasons) console.log('  - ' + why);
  }
  process.exit(r.verdict === 'PASS' ? 0 : r.verdict === 'INCONCLUSIVE' ? 1 : 2);
}

main();
