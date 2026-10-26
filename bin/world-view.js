#!/usr/bin/env node
'use strict';
/**
 * world-view.js —— 环境工作台 v0（84 号）
 *
 * 一次采集（world_probe snapshot）、一份文件（md + json）、所有 AI 只读这一份。
 * 纯渲染器：给定 snapshot JSON 就能出固定 md，离线可测（--render / --self-test）。
 * 失败不伪造：采集失败写 status=FAILED，缺探针写 missing[]，不把缺项写成 0。
 *
 * 用法：
 *   node world-view.js --run <runId> --phase before --out <runDir>\env [--companion RDD]
 *   node world-view.js --render <snapshot.json> --phase before --run r1   # 离线渲染已有快照
 *   node world-view.js --self-test
 *
 * 退出码：0 成功（含 coverage=PARTIAL）/ 1 FAILED（采集或解析失败）/ 2 用法错
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MCP_CALL = 'D:/rdd/workspace/rdd-selfcompile/scripts/mcp-call.js';
const VERSION = 'world-view/0.1';

function fail(...a) { console.error(...a); process.exit(1); }
function usage() { console.error('usage: world-view.js --run <id> --phase <p> --out <dir> [--companion <name>] | --render <file> --run <id> --phase <p> | --self-test'); process.exit(2); }

/** 解析 world_probe snapshot 的原始回执，抽实验关心的字段；不二次解释。 */
function pick(d) {
  const c = d.control || {};
  const self = d.self || {};
  return {
    world_id: d.world_id || null,
    dimension: d.dimension || null,
    at: d.at || null,
    complete: d.complete === true,
    errors: Array.isArray(d.errors) ? d.errors : [],
    difficulty: c.difficulty, hardcore: c.hardcore,
    day: c.day, time_of_day: c.time_of_day, time_bucket: c.time_bucket,
    is_day: c.is_day, weather: c.weather, raining: c.raining,
    control_key: d.control_key || null,
    stable_key: d.stable_key || null,
    players: (c.players || []).map(p => p.name + ':' + p.mode + (p.sleeping ? ':sleeping' : '') + (p.spectator ? ':spectator' : '')),
    self: {
      name: self.name, mode: self.mode, hp: self.hp, max_hp: self.max_hp,
      pos: [self.x, self.y, self.z], sleeping: self.sleeping === true,
      deaths: self.deaths, food: self.food,
    },
    distances: { sim: c.simulation_distance, view: c.view_distance },
  };
}

/** md 七行（84 号 2.3）：只写事实，不写推断。 */
function renderMd(v, meta) {
  const s = v.self || {};
  const lines = [];
  lines.push('# world-view · ' + meta.run_id + ' · ' + meta.phase);
  lines.push('captured_at=' + meta.captured_at + '  world_id=' + v.world_id + '  coverage=' + (v.complete ? 'COMPLETE' : 'PARTIAL') + (v.errors.length ? '  missing=' + v.errors.join(',') : ''));
  lines.push('difficulty=' + v.difficulty + '  hardcore=' + v.hardcore + '  day=' + v.day + '  time_of_day=' + v.time_of_day + ' (bucket=' + v.time_bucket + ', is_day=' + v.is_day + ')  weather=' + v.weather);
  const pos = (s.pos || []).map(x => (x == null ? '?' : Math.round(x))).join(',');
  lines.push('player=' + (s.name || '?') + ' pos=(' + pos + ') hp=' + s.hp + '/' + s.max_hp + '  gamemode=' + s.mode + '  sleeping=' + s.sleeping);
  lines.push('players=[' + v.players.join('; ') + ']');
  lines.push('dist=sim/' + v.distances.sim + ' view/' + v.distances.view);
  lines.push('control_key=' + v.control_key);
  lines.push('source=' + meta.source + '  view_id=' + meta.view_id);
  return lines.join('\n') + '\n';
}

function build(snapshotRaw, runId, phase) {
  let parsed = null;
  try { parsed = JSON.parse(snapshotRaw); } catch { return null; }
  const d = parsed && parsed.data ? parsed.data : null;
  if (!d) return null;
  const capturedAt = d.at || new Date().toISOString();
  const viewId = runId + '-' + phase + '-' + String(capturedAt).replace(/[:.]/g, '-');
  const v = pick(d);
  const meta = { run_id: runId, phase, captured_at: capturedAt, view_id: viewId, source: VERSION };
  return {
    json: { schema: 1, view_id: viewId, run_id: runId, phase, captured_at: capturedAt, source: VERSION, coverage: v.complete ? 'COMPLETE' : 'PARTIAL', missing: v.errors.map(e => String(e).split(':')[0]), errors: v.errors, view: v, control_key: v.control_key, stable_key: v.stable_key },
    md: renderMd(v, meta),
  };
}

function collect(companion) {
  const r = spawnSync(process.execPath, [MCP_CALL, 'world_probe', companion || 'RDD', '{"action":"snapshot"}'], { encoding: 'utf8', timeout: 45000 });
  return (r.stdout || '').trim() + ((r.stderr || '').trim() ? '\n' + (r.stderr || '').trim() : '');
}

function writeOut(outDir, runId, phase, product) {
  fs.mkdirSync(outDir, { recursive: true });
  const jp = path.join(outDir, 'world-view-' + phase + '.json');
  const mp = path.join(outDir, 'world-view-' + phase + '.md');
  fs.writeFileSync(jp, JSON.stringify(product.json, null, 2));
  fs.writeFileSync(mp, product.md);
  console.log('wrote ' + jp);
  console.log('wrote ' + mp);
  console.log(product.md);
}

function selfTest() {
  // ① 离线渲染：固定 snapshot → 固定 md（84 号判据 5）
  const snap = JSON.stringify({ success: true, data: {
    world_id: 'exp-x-1', dimension: 'minecraft:overworld', at: '2026-10-26T12:00:00.000Z',
    complete: true, errors: [],
    control: { difficulty: 'easy', hardcore: false, day: 0, time_of_day: 13850, time_bucket: 13, is_day: false,
      weather: 'clear', raining: false, simulation_distance: 5, view_distance: 2,
      players: [{ name: 'RDD', mode: 'survival', sleeping: false, spectator: false }, { name: 'OBS', mode: 'creative', sleeping: false, spectator: true }] },
    self: { name: 'RDD', mode: 'survival', hp: 18, max_hp: 20, x: 157.5, y: 63, z: 688.5, sleeping: false, deaths: 3, food: 20 },
    control_key: 'v1|difficulty=easy', stable_key: 's1|difficulty=easy',
  } });
  const p1 = build(snap, 'r-test', 'before');
  if (!p1) return fail('self-test: build failed');
  const md1 = p1.md;
  const expect = ['coverage=COMPLETE', 'difficulty=easy', 'is_day=false', 'sleeping=false', 'view_id=r-test-before-2026-10-26T12-00-00-000Z'];
  for (const e of expect) if (!md1.includes(e)) return fail('self-test: md missing ' + e);
  // ② PARTIAL：errors 非空 → coverage=PARTIAL，missing 点名（判据 3）
  const snap2 = JSON.stringify({ success: true, data: { world_id: 'live', dimension: 'x', at: '2026-10-26T12:00:01.000Z', complete: false, errors: ['entities:CHUNK_UNLOADED'], control: { players: [] }, self: {}, control_key: null, stable_key: null } });
  const p2 = build(snap2, 'r-test2', 'after');
  if (!p2 || p2.json.coverage !== 'PARTIAL' || !p2.json.missing.includes('entities')) return fail('self-test: PARTIAL not marked');
  // ③ 坏 JSON → FAILED 不伪造
  if (build('not json', 'r', 'before') !== null) return fail('self-test: bad json must be null');
  // ④ exp 副本 world_id 检查（判据 4 的数据面）
  if (p1.json.view.world_id !== 'exp-x-1') return fail('self-test: world_id wrong');
  console.log(JSON.stringify({ selfTest: 'PASS', mdLines: md1.split('\n').length, cases: 4 }));
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const runId = arg('--run'), phase = arg('--phase'), render = arg('--render'), outDir = arg('--out'), companion = arg('--companion');
  if (!runId || !phase || !['before', 'after', 'death', 'review'].includes(phase)) usage();
  if (render) {
    const raw = fs.readFileSync(render, 'utf8');
    const p = build(raw, runId, phase);
    if (!p) return fail('FAILED: cannot parse ' + render);
    if (outDir) writeOut(outDir, runId, phase, p);
    else console.log(p.md);
    return 0;
  }
  if (!outDir) usage();
  const raw = collect(companion);
  const p = build(raw, runId, phase);
  if (!p) {
    // 失败也落盘：FAILED 文件 + 原始回执（85 号坑：失败不静默）
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'world-view-' + phase + '.FAILED.json'), JSON.stringify({ schema: 1, status: 'FAILED', phase, run_id: runId, captured_at: new Date().toISOString(), raw: raw.slice(0, 4000) }, null, 2));
    return fail('FAILED: world_probe snapshot failed');
  }
  writeOut(outDir, runId, phase, p);
  process.exit(0);
}
main();
