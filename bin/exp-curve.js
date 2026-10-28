#!/usr/bin/env node
'use strict';
/**
 * exp-curve.js —— 学习曲线法的读数器（2026-10-27）
 *
 * 为什么有它：
 *   刻舟式 A/B（切 publication、数二值行为）在两个极端上都证伪了。
 *   改用「同一个长任务连跑 N 轮，看曲线有没有掉头向下」：
 *   不教任何东西，只记录每轮的用时/死亡/里程碑/空转。
 *
 * 用法：
 *   node exp-curve.js <runDir> [<runDir> ...] [--json]
 *   node exp-curve.js --self-test
 *
 * 每轮输出：用时(秒) / 死亡数 / 死亡原因 / 里程碑（第一把石镐、第一块铁、第一颗钻石）/ 调用数 / 失败调用数
 * 判据留给调用者：后 5 轮平均用时或死亡率是否显著低于前 5 轮。
 */
const fs = require('fs');
const path = require('path');

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function analyze(runDir) {
  const name = path.basename(runDir.replace(/[\\/]+$/, ''));
  const tools = readJsonl(path.join(runDir, 'evidence', 'tools.jsonl'));
  const results = tools.filter((t) => t.type === 'tool_result');
  const t0 = results.length ? Date.parse(results[0].timestamp) : null;
  const tEnd = results.length ? Date.parse(results[results.length - 1].timestamp) : null;

  const msgs = results.map((r) => {
    const d = r.data || {};
    let m = '';
    try { m = String(JSON.parse(d.result || '{}').message || ''); } catch { m = String(d.result || ''); }
    return { at: Date.parse(r.timestamp), tool: d.tool, msg: m, raw: String(d.result || '') };
  });

  const firstAt = (pred) => {
    const hit = msgs.find(pred);
    return hit ? hit.at : null;
  };
  const rel = (at) => (at && t0) ? Math.round((at - t0) / 1000) : null;

  const milestones = {
    stone_pickaxe: rel(firstAt((m) => /crafted.*stone_pickaxe/i.test(m.msg))),
    iron_ore: rel(firstAt((m) => /iron_ore/i.test(m.raw))),
    iron_ingot: rel(firstAt((m) => /crafted.*iron_ingot|smelted.*iron/i.test(m.msg))),
    diamond: rel(firstAt((m) => /"(minecraft:)?diamond"/.test(m.raw) || /diamond(?!_)/i.test(m.msg) && !/diamond_pickaxe/i.test(m.msg))),
  };

  const failed = msgs.filter((m) => /"success":false/.test(m.raw) || /FAILED|failed/i.test(m.msg)).length;
  // 空转：轮询（task_status）与“闲等”回执 —— 这是效率的直接读数，比 failed 更贴题
  const polls = msgs.filter((m) => m.tool === 'task_status').length;
  const idleish = msgs.filter((m) => /身体空闲|没有进行中|没有挂着的表|no active task/i.test(m.msg)).length;

  // 死亡：从 instrumentation（监控目录）按时间窗过滤
  const deaths = [];
  const inst = path.join(process.env.RDD_NUMEN_DIR || 'D:\\rdd\\mc\\The Best of Twilight Forest\\config\\numen', 'monitor', 'instrumentation.jsonl');
  if (t0 && fs.existsSync(inst)) {
    for (const o of readJsonl(inst)) {
      if (o.type !== 'death') continue;
      const at = Date.parse(o.timestamp);
      if (at >= t0 && at <= (tEnd || at)) {
        const d = o.data || {};
        deaths.push({ at: at, cause: d.deathCauseId, by: d.deathAttacker });
      }
    }
  }

  // 窗口与“早放弃”区分：stimulus 时刻 & watch 结束时刻（events.log）
  let windowS = null, activeS = null;
  const evLog = path.join(runDir, 'events.log');
  if (fs.existsSync(evLog)) {
    const txt = fs.readFileSync(evLog, 'utf8');
    const mStim = txt.match(/\[stimulus\][^\n]*/);
    const mWatch = txt.match(/\[watch\][^\n]*/);
    if (mStim) {
      const ts = (txt.slice(0, mStim.index).match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s*$/) || [])[1];
      if (ts) {
        const tStim = Date.parse(ts);
        if (mWatch) {
          const wts = (txt.slice(0, mWatch.index).match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s*$/) || [])[1];
          if (wts) windowS = Math.round((Date.parse(wts) - tStim) / 1000);
        }
        if (t0 && tEnd) activeS = Math.round((tEnd - tStim) / 1000);
      }
    }
  }

  return {
    run: name,
    seconds: (t0 && tEnd) ? Math.round((tEnd - t0) / 1000) : null,
    active_s: activeS,
    window_s: windowS,
    deaths: deaths.length,
    death_reasons: deaths.map((d) => (d.cause || '?') + (d.by ? ':' + d.by : '')),
    tool_calls: results.length,
    failed_calls: failed,
    polls: polls,
    idle_checks: idleish,
    milestones,
  };
}

function selfTest() {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curve-'));
  const d = path.join(root, 'r1');
  fs.mkdirSync(path.join(d, 'evidence'), { recursive: true });
  const mk = (sec, tool, msg, raw) => JSON.stringify({
    type: 'tool_result',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString(),
    data: { tool, result: JSON.stringify({ success: true, message: msg }) },
  });
  fs.writeFileSync(path.join(d, 'evidence', 'tools.jsonl'), [
    mk(0, 'get_world_info', 'ok'),
    mk(60, 'craft', 'crafted 1x stone_pickaxe'),
    mk(120, 'mine', 'mined diamond_ore'),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'evidence', 'events.jsonl'), '');
  const r = analyze(d);
  const ok = r.seconds === 120 && r.milestones.stone_pickaxe === 60 && r.deaths === 0;
  console.log(JSON.stringify({ selfTest: ok ? 'PASS' : 'FAIL', result: r }));
  return ok ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const dirs = argv.filter((a) => !a.startsWith('--'));
  if (!dirs.length) { console.error('usage: node exp-curve.js <runDir> [...] [--json] | --self-test'); process.exit(3); }
  const rows = dirs.map((d) => analyze(path.resolve(d)));
  if (argv.includes('--summary')) {
    const pick = (r) => (r.milestones.stone_pickaxe === null ? null : r.milestones.stone_pickaxe);
    const mean = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const half = (arr) => { const n = Math.floor(arr.length / 2); return [arr.slice(0, n), arr.slice(n)]; };
    const [firstA, secondA] = half(rows);
    const first5 = rows.slice(0, 5), last5 = rows.slice(-5);
    const block = (name, rs) => ({
      n: rs.length,
      deaths: rs.filter((r) => r.deaths > 0).length,
      pickaxe_mean: mean(rs.map(pick)),
      polls_mean: mean(rs.map((r) => r.polls)),
      diamond: rs.filter((r) => r.milestones.diamond !== null).length,
      iron: rs.filter((r) => r.milestones.iron_ore !== null).length,
    });
    console.log(JSON.stringify({
      all: block('all', rows),
      first5: block('first5', first5),
      last5: block('last5', last5),
      phaseA: block('A', firstA),
      phaseB: block('B', secondA),
    }, null, 1));
    return;
  }
  if (argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); return 0; }
  const pad = (s, n) => String(s === null || s === undefined ? '-' : s).padEnd(n);
  console.log(pad('#', 3) + pad('run', 42) + pad('秒', 6) + pad('死', 4) + pad('调用', 6) + pad('失败', 6) + pad('轮询', 6) + pad('空等', 6) + '里程碑(石镐/铁/钻石)');
  rows.forEach((r, i) => {
    const m = r.milestones;
    console.log(pad(i + 1, 3) + pad(r.run, 42) + pad(r.seconds, 6) + pad(r.deaths, 4) + pad(r.tool_calls, 6) + pad(r.failed_calls, 6) + pad(r.polls, 6) + pad(r.idle_checks, 6)
      + [m.stone_pickaxe, m.iron_ore, m.diamond].map((x) => (x === null ? '-' : x + 's')).join(' / '));
    if (r.death_reasons.length) console.log('    死亡: ' + r.death_reasons.join(', '));
  });
  return 0;
}

process.exit(main() || 0);
