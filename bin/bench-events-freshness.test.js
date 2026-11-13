'use strict';
/**
 * 2026-11-13 A1：events.jsonl（终态流）要进现场视图，但它的新鲜度**不能**代表游戏在跑/世界后态。
 * 验收：
 *  - producer：collectOnce 必须把 events.jsonl 读进来（files/快照都有它）；坏 JSON 不崩、缺失显式。
 *  - consumer：events 新鲜但 tools/rdd/context 旧 → brief 不得 LIVE（逐流区分，任核心流旧即 STALE）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('./bench-watch');
const L = require('./lib/bench-live');
const BENCH = path.join(__dirname, 'bench.js');
const SEC = 1000;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-events-'));
  const mon = path.join(dir, 'monitor');
  const out = path.join(dir, 'live');
  fs.mkdirSync(mon, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  return { dir, mon, out };
}
function ev(ts, type, over) { return JSON.stringify(Object.assign({ timestamp: new Date(ts).toISOString(), type }, over || {})); }

test('producer 必读 events.jsonl：files 与快照都要有它（红：现在 FILES 没有 events）', () => {
  const f = fixture();
  const now = Date.now();
  fs.writeFileSync(path.join(f.mon, 'events.jsonl'), ev(now - 5 * SEC, 'task_finished', { session: 's1', server_session: 'srv1', world_id: 'w1', data: { id: 't1', message: 'done' } }) + '\n');
  fs.writeFileSync(path.join(f.mon, 'tools.jsonl'), ev(now - 2 * 60 * 60 * SEC, 'tool_result', { session: 's1', server_session: 'srv1', world_id: 'w1', data: { tool_call_id: 'c1' } }) + '\n');
  const state = L.newState({ monitor: f.mon, started_at: now - 3600 * SEC });
  W.collectOnce(state, { monitor: f.mon, out: f.out, views: ['snapshot'], interval_s: 15, now });
  assert.ok(state.files['events.jsonl'], 'producer 必须把 events.jsonl 纳入 FILES');
  assert.ok(state.files['events.jsonl'].lastEventAt, 'events 的 lastEventAt 必须被记录');
  const snap = fs.readFileSync(path.join(f.out, 'snapshot.md'), 'utf8');
  assert.match(snap, /^- events\.jsonl /m, '快照流段必须列出 events.jsonl');
});

test('events 坏 JSON 不崩，文件仍被追踪；缺失时显式报没读到', () => {
  const f = fixture();
  const now = Date.now();
  fs.writeFileSync(path.join(f.mon, 'events.jsonl'), 'not-json\n' + ev(now - 5 * SEC, 'task_finished', { session: 's1', data: { id: 't1' } }) + '\n');
  const state = L.newState({ monitor: f.mon, started_at: now - 3600 * SEC });
  W.collectOnce(state, { monitor: f.mon, out: f.out, views: ['snapshot'], interval_s: 15, now });
  assert.equal(state.files['events.jsonl'].malformed, 1, '坏行要计数，不许静默');
  const st = W.statusOf(state, { running: true });
  assert.ok(st.files['events.jsonl'], 'status 要带 events');
  // 缺失：另一个 monitor 只有 rdd/tools
  const f2 = fixture();
  fs.writeFileSync(path.join(f2.mon, 'rdd.jsonl'), ev(now - 5 * SEC, 'situation_event', { session: 's1', data: {} }) + '\n');
  const s2 = L.newState({ monitor: f2.mon, started_at: now - 3600 * SEC });
  W.collectOnce(s2, { monitor: f2.mon, out: f2.out, views: ['snapshot'], interval_s: 15, now });
  const snap2 = fs.readFileSync(path.join(f2.out, 'snapshot.md'), 'utf8');
  // 旧流缺省文案保持不变（“未观测到”），但 events 必须仍被追踪并显式缺失
  const missLine = snap2.split('\n').find((l) => l.startsWith('- events.jsonl'));
  assert.ok(missLine && /未观测到/.test(missLine), '缺失的 events 要显式出现：' + missLine);
  assert.equal(W.statusOf(s2, { running: true }).files['events.jsonl'].missing, true);
});

function liveFixture(f, over) {
  const now = Date.now();
  const base = {
    schema: 1, pid: process.pid, started_at: now - 3600 * SEC,
    last_tick_at: new Date(now - 3 * SEC).toISOString(), ticks: 5, enabled: true, monitor: 'm', counters: {},
    identity: { file: 'tools.jsonl', at: new Date(now - 5 * SEC).toISOString(), session: 's1', server_session: 'srv1', world_id: 'w1', world_epoch: 1, event_id: 'e1' },
    files: {
      'rdd.jsonl': { size: 1, lastEventAt: now - 2 * 60 * 60 * SEC, missing: false },
      'tools.jsonl': { size: 1, lastEventAt: now - 2 * 60 * 60 * SEC, missing: false },
      'context.jsonl': { size: 1, lastEventAt: now - 2 * 60 * 60 * SEC, missing: false },
      'events.jsonl': { size: 1, lastEventAt: now - 5 * SEC, missing: false },
    },
  };
  fs.writeFileSync(path.join(f.out, 'status.json'), JSON.stringify(Object.assign(base, over || {}), null, 2));
  fs.writeFileSync(path.join(f.out, 'watch.json'), JSON.stringify({ schema: 1, enabled: true, views: ['snapshot'], interval_s: 15, bridgeWindow: { windowKey: 'w', worldId: 'w1', serverSession: 'srv1', companion: 'c1', run: 's1', targetSession: 's1', since: '2026-11-13T04:00:00+08:00', logFile: 'C:\\tmp\\latest.log', encoding: 'utf-8', timezone: '+08:00' } }, null, 2));
  fs.writeFileSync(path.join(f.out, 'snapshot.md'), '# s\n');
}
function briefJson(f) {
  const wb = path.join(f.dir, 'wb.json');
  fs.writeFileSync(wb, JSON.stringify({ schema: 1, updated_at: '', probes: [], tips: [], signals: [], verdicts: [], queue: [], masters: [] }));
  const r = spawnSync(process.execPath, [BENCH, 'brief', '--json', '--session', 't'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: Object.assign({}, process.env, { BENCH_FILE: wb, BENCH_USAGE_FILE: path.join(f.dir, 'usage.jsonl'), RDD_CHECKPOINT: path.join(f.dir, 'cp.md'), BENCH_LIVE_DIR: f.out, DSH_SESSION_ID: '' }) });
  const i = r.stdout.indexOf('{');
  assert.ok(i >= 0, 'brief 无 JSON：' + r.stdout.slice(0, 200));
  return JSON.parse(r.stdout.slice(i));
}

test('events 新鲜但 tools/rdd/context 旧：brief 不得 LIVE（逐流区分）', () => {
  const f = fixture();
  liveFixture(f);
  const j = briefJson(f);
  const live = j.entry.live;
  assert.equal(live.state, 'STALE', 'events 新鲜不能代表现场在跑：' + JSON.stringify(live.state_reason));
  assert.match(live.state_reason, /tools|rdd|context|核心流/);
});
test('活跃源新旧不一（rdd 新、tools/context 旧）：PARTIAL，不是 LIVE 也不是 STALE', () => {
  const f = fixture();
  const now = Date.now();
  liveFixture(f);
  const st = JSON.parse(fs.readFileSync(path.join(f.out, 'status.json'), 'utf8'));
  st.files['rdd.jsonl'].lastEventAt = now - 3 * SEC;
  st.files['events.jsonl'].lastEventAt = now - 4 * SEC;
  fs.writeFileSync(path.join(f.out, 'status.json'), JSON.stringify(st, null, 2));
  const live = briefJson(f).entry.live;
  assert.equal(live.state, 'PARTIAL', live.state_reason);
  assert.match(live.state_reason, /新旧不一/);
});
test('活跃源都新但 events 缺失：PARTIAL（终态不可见），不许 LIVE', () => {
  const f = fixture();
  const now = Date.now();
  liveFixture(f);
  const st = JSON.parse(fs.readFileSync(path.join(f.out, 'status.json'), 'utf8'));
  for (const k of ['rdd.jsonl', 'tools.jsonl', 'context.jsonl']) st.files[k].lastEventAt = now - 5 * SEC;
  st.files['events.jsonl'] = { size: 0, lastEventAt: null, missing: true };
  fs.writeFileSync(path.join(f.out, 'status.json'), JSON.stringify(st, null, 2));
  const live = briefJson(f).entry.live;
  assert.equal(live.state, 'PARTIAL', live.state_reason);
  assert.match(live.state_reason, /events/);
});
