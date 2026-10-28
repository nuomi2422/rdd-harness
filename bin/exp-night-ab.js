#!/usr/bin/env node
'use strict';
/**
 * exp-night-ab.js —— 夜间规避经验 A/B 的判读（二值 + 首次动作时间）
 *
 * 为什么有「时间」这一列：
 *   2026-10-27 八轮实机：二值判据「有没有做规避动作」在送达 2/3 vs 未送达 2/5 —— 分不开，
 *   因为**她本来就会**夜里回村睡、自己围盒子（基线率约 40%）。改测「多快做」：
 *   首次规避动作出现在第几秒（拿不到就记 600 = 窗口内没做）。连续量比二值量省样本。
 *
 * 用法：
 *   node exp-night-ab.js <runDir> [...] [--json]
 *   node exp-night-ab.js --self-test
 *
 * 规避动作 = 睡成（sleep 回执含 sleeping）｜木板围盒（build 的 walls/box，体积 ≥ 6）｜插火把。
 * 时间基准 t0 = evidence 里最早一条记录的时间戳。
 */
const fs = require('fs');
const path = require('path');

function readJsonLines(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function lastRequest(runDir) {
  const rows = readJsonLines(path.join(runDir, 'evidence', 'context.jsonl')).filter((o) => o.type === 'llm_request');
  return rows.length ? rows[rows.length - 1] : null;
}

/** build 调用按「每次调用」分组（ops 顺序 = 调用顺序）。 */
function buildCalls(runDir) {
  const req = lastRequest(runDir);
  if (!req) return [];
  const msgs = (req.data && req.data.request && req.data.request.messages) || [];
  const calls = [];
  for (const m of msgs) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const fn = tc.function || tc;
      if (fn.name !== 'build') continue;
      try { calls.push(JSON.parse(fn.arguments || '{}').ops || []); } catch { calls.push([]); }
    }
  }
  return calls;
}

function boxVolume(op) {
  if (op.x1 === undefined || op.x2 === undefined) return 0;
  const dx = Math.abs(op.x2 - op.x1) + 1;
  const dy = Math.abs((op.y2 ?? op.y1) - op.y1) + 1;
  const dz = Math.abs(op.z2 - op.z1) + 1;
  return dx * dy * dz;
}

function toolResults(runDir) {
  return readJsonLines(path.join(runDir, 'evidence', 'tools.jsonl'))
    .filter((t) => t.type === 'tool_result')
    .map((t) => ({ at: Date.parse(t.timestamp), tool: (t.data || {}).tool, raw: (t.data || {}).result }));
}

function msgOf(raw) {
  try { return String(JSON.parse(raw || '{}').message || ''); } catch { return String(raw || ''); }
}

function analyze(runDir) {
  const out = { run: path.basename(runDir.replace(/[\\/]+$/, '')) };
  const calls = buildCalls(runDir);
  const results = toolResults(runDir);
  const buildTimes = results.filter((r) => r.tool === 'build').map((r) => r.at);
  const sleepOkTimes = results.filter((r) => r.tool === 'sleep' && /sleeping|respawn point is now bound/i.test(msgOf(r.raw))).map((r) => r.at);

  let shelter = false, shelterOps = [], torch = false, shelterAt = null, torchAt = null;
  calls.forEach((ops, i) => {
    for (const op of ops) {
      const t = buildTimes[i] ?? null;
      if (/planks$/.test(op.block_id || '') && ['walls', 'box'].includes(op.op) && boxVolume(op) >= 6) {
        shelter = true;
        shelterOps.push(op.op + '@' + [op.x1, op.y1, op.z1].join(','));
        if (t && shelterAt === null) shelterAt = t;
      }
      if (/torch/.test(op.block_id || '')) {
        torch = true;
        if (t && torchAt === null) torchAt = t;
      }
    }
  });

  const sleep = sleepOkTimes.length > 0;
  const sleepAt = sleep ? sleepOkTimes[0] : null;

  const allTimes = results.map((r) => r.at).concat(readJsonLines(path.join(runDir, 'evidence', 'context.jsonl')).map((o) => Date.parse(o.timestamp || '')).filter(Boolean));
  const t0 = allTimes.length ? Math.min.apply(null, allTimes) : null;
  const candidates = [shelterAt, sleepAt, torchAt].filter((x) => x);
  const firstAt = candidates.length ? Math.min.apply(null, candidates) : null;
  const firstAvoidSec = (t0 && firstAt) ? Math.max(0, Math.round((firstAt - t0) / 1000)) : null;

  const req = lastRequest(runDir);
  const body = req ? JSON.stringify(req.data.request.messages) : '';
  out.entries = (body.match(/<entry ref=/g) || []).length;
  out.nightEntryDelivered = body.includes('夜间露天无掩体');
  out.shelter = shelter;
  out.shelterOps = shelterOps;
  out.sleep = sleep;
  out.torch = torch;
  out.avoid = shelter || sleep || torch;
  out.firstAvoidSec = firstAvoidSec;   // null = 窗口内没有
  out.costSec = firstAvoidSec === null ? 600 : firstAvoidSec;
  out.deathsPartial = readJsonLines(path.join(runDir, 'evidence', 'events.jsonl')).filter((e) => JSON.stringify(e).includes('"death"')).length;
  return out;
}

function selfTest() {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'night-ab-'));
  const iso = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const mk = (name, { ops, sleepMsg, night }) => {
    const d = path.join(root, name);
    fs.mkdirSync(path.join(d, 'evidence'), { recursive: true });
    const msgs = [{ role: 'user', content: (night ? '<entry ref="exp:failure|夜间露天无掩体">x</entry>' : '') + ' <query>go</query>' }];
    if (ops.length) msgs.push({ role: 'assistant', tool_calls: [{ function: { name: 'build', arguments: JSON.stringify({ ops }) } }] });
    fs.writeFileSync(path.join(d, 'evidence', 'context.jsonl'),
      JSON.stringify({ type: 'llm_request', timestamp: iso(0), data: { request: { messages: msgs } } }) + '\n');
    const tools = [];
    if (ops.length) tools.push({ type: 'tool_result', timestamp: iso(30), data: { tool: 'build', result: '{}' } });
    if (sleepMsg) tools.push({ type: 'tool_result', timestamp: iso(90), data: { tool: 'sleep', result: JSON.stringify({ success: true, message: sleepMsg }) } });
    fs.writeFileSync(path.join(d, 'evidence', 'tools.jsonl'), tools.map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(d, 'evidence', 'events.jsonl'), '');
    return d;
  };
  const shelter = mk('a', { ops: [{ op: 'walls', block_id: 'minecraft:acacia_planks', x1: 1, y1: 64, z1: 1, x2: 3, y2: 65, z2: 3 }], night: true });
  const none = mk('b', { ops: [{ op: 'set', block_id: 'minecraft:dirt', x: 1, y: 64, z: 1 }], night: false });
  const sleep = mk('c', { ops: [], sleepMsg: 'you are in the bed at 1,64,1 and the server confirms you are sleeping', night: true });
  const r1 = analyze(shelter), r2 = analyze(none), r3 = analyze(sleep);
  const ok = r1.shelter && r1.firstAvoidSec === 30 && !r2.avoid && r2.firstAvoidSec === null
    && r3.sleep && r3.firstAvoidSec === 90 && r1.nightEntryDelivered && !r2.nightEntryDelivered;
  console.log(JSON.stringify({ selfTest: ok ? 'PASS' : 'FAIL', cases: [r1, r2, r3].map((r) => ({ run: r.run, avoid: r.avoid, firstAvoidSec: r.firstAvoidSec })) }));
  return ok ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());
  const dirs = argv.filter((a) => !a.startsWith('--'));
  if (!dirs.length) {
    console.error('usage: node exp-night-ab.js <runDir> [...] [--json] | --self-test');
    process.exit(3);
  }
  const rows = dirs.map((d) => analyze(path.resolve(d)));
  if (argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad('run', 44) + pad('夜间条目', 9) + pad('动作', 6) + pad('首次(秒)', 9) + '备注');
    for (const r of rows) {
      console.log(pad(r.run, 44) + pad(r.nightEntryDelivered ? 'YES' : '-', 9)
        + pad(r.avoid ? 'YES' : '-', 6)
        + pad(r.firstAvoidSec === null ? '—' : String(r.firstAvoidSec), 9)
        + (r.shelter ? 'shelter ' : '') + (r.sleep ? 'sleep ' : '') + (r.torch ? 'torch' : ''));
    }
    const delivered = rows.filter((r) => r.nightEntryDelivered);
    const notDelivered = rows.filter((r) => !r.nightEntryDelivered);
    const avg = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    console.log('');
    console.log('送达组：' + delivered.filter((r) => r.avoid).length + '/' + delivered.length
      + ' 有动作，平均首次 ' + avg(delivered.map((r) => r.costSec)) + ' 秒（没做按 600 计）');
    console.log('未送达组：' + notDelivered.filter((r) => r.avoid).length + '/' + notDelivered.length
      + ' 有动作，平均首次 ' + avg(notDelivered.map((r) => r.costSec)) + ' 秒');
  }
  process.exit(0);
}

main();
