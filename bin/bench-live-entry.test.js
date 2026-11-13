'use strict';
/**
 * 2026-11-13 A1：bench brief/live 的「现场」投影必须分清
 *   ① 监视进程（bench-watch）活着 ② 源流是否新鲜 ③ 源身份是否成立。
 * 旧版只凭 status.json 的 pid 存活印「状态: LIVE」，游戏 02:27:28Z 已 STOPPED、
 * 02:30 brief 仍报 LIVE pid=3476（那是 watcher）。这里全部走真 CLI 反例，不测孤立 helper。
 *
 * 红→绿：这几个用例在旧实现上会拿到 LIVE 或丢身份，改后必须 STALE/UNKNOWN/不冒窗口身份。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BENCH = path.join(__dirname, 'bench.js');
const WATCH = path.join(__dirname, 'bench-watch.js');
const NOW = Date.now();
const SEC = 1000;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-live-entry-'));
  const live = path.join(dir, 'live');
  fs.mkdirSync(live, { recursive: true });
  const wb = path.join(dir, 'workbench.json');
  fs.writeFileSync(wb, JSON.stringify({ schema: 1, updated_at: '', probes: [], tips: [], signals: [], verdicts: [], queue: [], masters: [] }));
  fs.writeFileSync(path.join(dir, 'CHECKPOINT.md'), '# CHECKPOINT\n\n> 写入时间：2026-11-13 10:00\n\n- **主线目标**：测试目标\n- **下一步**：测试下一步\n');
  return { dir, live, wb };
}

function run(sb, args, liveDir) {
  const r = spawnSync(process.execPath, [BENCH].concat(args), {
    encoding: 'utf8',
    windowsHide: true,
    env: Object.assign({}, process.env, {
      BENCH_FILE: sb.wb,
      BENCH_USAGE_FILE: path.join(sb.dir, 'usage.jsonl'),
      BENCH_VERIFICATION_HISTORY: path.join(sb.dir, 'verification-history.jsonl'),
      RDD_CHECKPOINT: path.join(sb.dir, 'CHECKPOINT.md'),
      BENCH_LIVE_DIR: liveDir || sb.live,
      DSH_SESSION_ID: '',
    }),
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function briefJson(sb, liveDir) {
  const r = run(sb, ['brief', '--json', '--session', 't'], liveDir);
  const i = r.out.indexOf('{');
  assert.ok(i >= 0, 'brief --json 没有 JSON：' + r.out.slice(0, 300));
  return { r, json: JSON.parse(r.out.slice(i)) };
}

const IDENTITY = (at) => ({ file: 'tools.jsonl', at, session: 'sess-1', server_session: 'srv-1', world_id: 'live-abc', world_epoch: 1, event_id: 'tools-e1' });

function writeLive(sb, over) {
  const base = {
    schema: 1,
    pid: process.pid, // 本测试进程 = 真实存活
    started_at: NOW - 3600 * SEC,
    last_tick_at: new Date(NOW - 5 * SEC).toISOString(),
    ticks: 7,
    monitor: 'C:\\tmp\\monitor',
    counters: {},
    files: {
      'rdd.jsonl': { size: 10, lastEventAt: NOW - 5 * SEC, missing: false },
      'tools.jsonl': { size: 10, lastEventAt: NOW - 6 * SEC, missing: false },
      'context.jsonl': { size: 10, lastEventAt: NOW - 7 * SEC, missing: false },
      'ai.jsonl': { size: 10, lastEventAt: NOW - 8 * SEC, missing: false },
      'observer.jsonl': { size: 10, lastEventAt: NOW - 999 * SEC, missing: false },
    },
    identity: IDENTITY(new Date(NOW - 6 * SEC).toISOString()),
  };
  const st = Object.assign(base, over || {});
  fs.writeFileSync(path.join(sb.live, 'status.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(sb.live, 'snapshot.md'), '# 实验台 live · snapshot\n\n## 当前任务链\ngoal_id=goal-1  status=ACTIVE  stateVersion=3  链数据年龄=5s 前\n主目标 9/12  ·  当前小步 4\n');
  return st;
}

function writeControl(sb, bridgeWindow) {
  const ctl = { schema: 1, enabled: true, views: ['snapshot'], interval_s: 15, updated_at: new Date(NOW).toISOString() };
  if (bridgeWindow) ctl.bridgeWindow = bridgeWindow;
  fs.writeFileSync(path.join(sb.live, 'watch.json'), JSON.stringify(ctl, null, 2));
}

function binding(worldId, serverSession, windowKey) {
  return { windowKey: windowKey || 'w-1', worldId, serverSession, companion: 'c-1', run: 'run-1', targetSession: 'sess-1', since: '2026-11-13T02:00:00+08:00', logFile: 'C:\\tmp\\latest.log', encoding: 'utf-8', timezone: '+08:00' };
}

test('watcher 新 tick + 旧的最后事件：必须 STALE，不许被 tick 刷新成 LIVE', () => {
  const sb = sandbox();
  writeControl(sb);
  writeLive(sb, {
    last_tick_at: new Date(NOW - 3 * SEC).toISOString(),
    ticks: 9999,
    files: {
      'rdd.jsonl': { size: 10, lastEventAt: NOW - 19 * 60 * SEC, missing: false },
      'tools.jsonl': { size: 10, lastEventAt: NOW - 20 * 60 * SEC, missing: false },
      'context.jsonl': { size: 10, lastEventAt: NOW - 21 * 60 * SEC, missing: false },
      'ai.jsonl': { size: 10, lastEventAt: NOW - 22 * 60 * SEC, missing: false },
      'observer.jsonl': { size: 10, lastEventAt: NOW - 999 * SEC, missing: false },
    },
    identity: IDENTITY(new Date(NOW - 20 * 60 * SEC).toISOString()),
  });
  const { json } = briefJson(sb);
  const live = json.entry.live;
  assert.equal(live.known, true);
  assert.equal(live.alive, true);
  assert.equal(live.state, 'STALE', JSON.stringify(live.state_reason));
  assert.match(live.state_reason, /源流最新事件/);
  const t = run(sb, ['brief']);
  assert.match(t.out, /现场状态: STALE/);
  assert.ok(!/现场状态: LIVE/.test(t.out), 'watcher 活着+事件旧，brief 不许印 LIVE');
});

test('缺核心源（context.jsonl missing）哪怕其余流新，也只能 UNKNOWN', () => {
  const sb = sandbox();
  writeControl(sb);
  writeLive(sb, {
    files: {
      'rdd.jsonl': { size: 10, lastEventAt: NOW - 3 * SEC, missing: false },
      'tools.jsonl': { size: 10, lastEventAt: NOW - 4 * SEC, missing: false },
      'context.jsonl': { size: 0, lastEventAt: null, missing: true, gapReason: 'unavailable' },
      'ai.jsonl': { size: 10, lastEventAt: NOW - 5 * SEC, missing: false },
      'observer.jsonl': { size: 10, lastEventAt: NOW - 999 * SEC, missing: false },
    },
  });
  const { json } = briefJson(sb);
  const live = json.entry.live;
  assert.equal(live.state, 'UNKNOWN', live.state_reason);
  assert.deepEqual(live.stream.missingCore, ['context.jsonl']);
  assert.match(live.state_reason, /源缺失/);
});

test('bind-window 的 world/server 与源事件不一致：不认窗口身份，也不能 LIVE', () => {
  const sb = sandbox();
  writeControl(sb, binding('live-OTHER', 'srv-OTHER', 'w-old'));
  writeLive(sb, { bridge: { status: 'WAITING', windowKey: 'w-old' } });
  const { json } = briefJson(sb);
  const live = json.entry.live;
  assert.equal(live.state, 'UNKNOWN', live.state_reason);
  assert.equal(live.identity.status, 'UNKNOWN');
  assert.equal(live.scope.window_key, null, '冲突时不许把窗口身份借给这份源');
  assert.match(live.identity.reason, /不一致/);
});

test('最后事件时间在未来：当坏样本 UNKNOWN，不能算新', () => {
  const sb = sandbox();
  writeControl(sb);
  const st = writeLive(sb);
  st.files['rdd.jsonl'].lastEventAt = NOW + 10 * 60 * SEC;
  fs.writeFileSync(path.join(sb.live, 'status.json'), JSON.stringify(st, null, 2));
  const { json } = briefJson(sb);
  const live = json.entry.live;
  assert.equal(live.state, 'UNKNOWN', live.state_reason);
  assert.equal(live.stream.future, 1);
  assert.match(live.state_reason, /未来/);
});

test('新 tick + 旧 windowKey 残留 + 缺源：三项都不能把它洗成 LIVE', () => {
  const sb = sandbox();
  writeControl(sb, binding('live-abc', 'srv-1', 'w-old'));
  writeLive(sb, {
    last_tick_at: new Date(NOW - 2 * SEC).toISOString(),
    files: {
      'rdd.jsonl': { size: 10, lastEventAt: NOW - 3 * SEC, missing: false },
      'tools.jsonl': { size: 0, lastEventAt: null, missing: true },
      'context.jsonl': { size: 10, lastEventAt: NOW - 4 * SEC, missing: false },
      'ai.jsonl': { size: 10, lastEventAt: NOW - 5 * SEC, missing: false },
      'observer.jsonl': { size: 10, lastEventAt: NOW - 999 * SEC, missing: false },
    },
  });
  const { json } = briefJson(sb);
  const live = json.entry.live;
  assert.notEqual(live.state, 'LIVE', JSON.stringify(live));
  assert.match(live.state_reason, /源缺失/);
});

test('正例：源新 + 身份全 + bind-window 对上才 LIVE，且任务链仍能展开', () => {
  const sb = sandbox();
  writeControl(sb, binding('live-abc', 'srv-1', 'w-1'));
  writeLive(sb);
  const { json } = briefJson(sb);
  const live = json.entry.live;
  assert.equal(live.state, 'LIVE', live.state_reason);
  assert.equal(live.identity.status, 'BOUND');
  assert.equal(live.scope.window_key, 'w-1');
  assert.equal(live.stream.age_s != null && live.stream.age_s <= 60, true);
  const t = run(sb, ['brief']);
  assert.match(t.out, /现场状态: LIVE/);
  assert.match(t.out, /任务链（live\/snapshot\.md 快照/);
  assert.match(t.out, /goal_id=goal-1/);
  assert.match(t.out, /身份: \[BOUND\]/);
});

test('无 bind-window：身份只到 SOURCE，不冒充窗口归属', () => {
  const sb = sandbox();
  writeControl(sb);
  writeLive(sb);
  const { json } = briefJson(sb);
  const live = json.entry.live;
  assert.equal(live.identity.status, 'SOURCE');
  assert.equal(live.scope.window_key, null);
  assert.match(live.identity.reason, /没有 bind-window/);
  assert.equal(live.state, 'LIVE', live.state_reason);
});

test('live status 真 CLI：监视进程/源流/身份分开写，旧流现场不叫 LIVE', () => {
  const sb = sandbox();
  writeControl(sb);
  writeLive(sb, {
    files: {
      'rdd.jsonl': { size: 10, lastEventAt: NOW - 19 * 60 * SEC, missing: false },
      'tools.jsonl': { size: 10, lastEventAt: NOW - 20 * 60 * SEC, missing: false },
      'context.jsonl': { size: 10, lastEventAt: NOW - 21 * 60 * SEC, missing: false },
      'ai.jsonl': { size: 10, lastEventAt: NOW - 22 * 60 * SEC, missing: false },
      'observer.jsonl': { size: 10, lastEventAt: NOW - 999 * SEC, missing: false },
    },
    identity: IDENTITY(new Date(NOW - 20 * 60 * SEC).toISOString()),
  });
  const r = run(sb, ['live', 'status']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /监视进程: pid=\d+ 运行中/);
  assert.match(r.out, /源流: STALE/);
  assert.match(r.out, /现场状态=STALE/);
  assert.match(r.out, /身份: /);
});

test('生产端：bench-watch --once 从源事件抄复合身份进 status.json，缺字段就不抄', () => {
  const sb = sandbox();
  const mon = path.join(sb.dir, 'monitor');
  fs.mkdirSync(mon, { recursive: true });
  const ev = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(mon, 'tools.jsonl'), ev({ timestamp: '2026-11-13T02:25:52.240Z', type: 'tool_result', session: 'sess-9', server_session: 'srv-9', world_id: 'live-xyz', world_epoch: 1, event_id: 'e-1', data: { tool: 'x' } }) + '\n');
  fs.writeFileSync(path.join(mon, 'rdd.jsonl'), ev({ timestamp: '2026-11-13T02:26:50.482Z', type: 'situation_event', session: 'sess-9', event_id: 'e-2', data: {} }) + '\n');
  const out = path.join(sb.dir, 'live2');
  const r = spawnSync(process.execPath, [WATCH, '--once', '--monitor', mon, '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  const st = JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8'));
  assert.ok(st.identity, 'status.json 应带 identity');
  assert.equal(st.identity.world_id, 'live-xyz');
  assert.equal(st.identity.server_session, 'srv-9');
  assert.equal(st.identity.session, 'sess-9');
  assert.equal(st.identity.file, 'tools.jsonl');

  // 只有 rdd.jsonl（无 server_session/world_id）时不许造身份。
  const mon2 = path.join(sb.dir, 'monitor2');
  fs.mkdirSync(mon2, { recursive: true });
  fs.writeFileSync(path.join(mon2, 'rdd.jsonl'), ev({ timestamp: '2026-11-13T02:26:50.482Z', type: 'situation_event', session: 'sess-9', event_id: 'e-2', data: {} }) + '\n');
  const out2 = path.join(sb.dir, 'live3');
  const r2 = spawnSync(process.execPath, [WATCH, '--once', '--monitor', mon2, '--out', out2], { encoding: 'utf8', windowsHide: true });
  assert.equal(r2.status, 0, (r2.stdout || '') + (r2.stderr || ''));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out2, 'status.json'), 'utf8')).identity, null);
});

test('生产端轮转：旧代 identity 必须随文件代际失效，不能把上一 scope 当当前', () => {
  const W = require('./bench-watch');
  const L = require('./lib/bench-live');
  const sb = sandbox();
  const mon = path.join(sb.dir, 'monitor');
  const out = path.join(sb.dir, 'liveRot');
  fs.mkdirSync(mon, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const tools = path.join(mon, 'tools.jsonl');
  const state = L.newState({ monitor: mon, started_at: Date.now() });
  const opt = { monitor: mon, out, views: ['snapshot'], interval_s: 15, now: Date.now() };
  const publish = () => {
    const st = W.statusOf(state, { running: true, views: ['snapshot'], interval_s: 15 });
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(st, null, 2));
    return st;
  };
  const ev = (o) => JSON.stringify(o) + '\n';

  // 第 1 代：带身份 A
  fs.writeFileSync(tools, ev({ timestamp: '2026-11-13T02:20:00.000Z', type: 'tool_result', session: 'sess-A', server_session: 'srv-A', world_id: 'live-A', world_epoch: 1, event_id: 'e-A', data: {} }));
  W.collectOnce(state, opt);
  assert.equal(publish().identity.world_id, 'live-A');

  // 轮转到第 2 代：事件缺身份且时间更早 —— 旧代 A 不许继续占位
  const nf2 = tools + '.new2';
  fs.writeFileSync(nf2, ev({ timestamp: '2026-11-13T02:10:00.000Z', type: 'tool_result', session: 'sess-B', event_id: 'e-B', data: {} }));
  fs.renameSync(nf2, tools);
  W.collectOnce(state, opt);
  assert.equal(publish().identity, null, '轮转后新代无身份，旧代 identity 必须失效');

  // 再轮转到第 3 代：带身份 B（比旧代还早）—— 必须是 B，不是 A
  const nf3 = tools + '.new3';
  fs.writeFileSync(nf3, ev({ timestamp: '2026-11-13T02:05:00.000Z', type: 'tool_result', session: 'sess-C', server_session: 'srv-C', world_id: 'live-C', world_epoch: 2, event_id: 'e-C', data: {} }));
  fs.renameSync(nf3, tools);
  W.collectOnce(state, opt);
  const st3 = publish();
  assert.equal(st3.identity.world_id, 'live-C');
  assert.equal(st3.identity.session, 'sess-C');
});

// ── 2026-11-13 A1 补：多流身份冲突（顶层「最新一条」不能洗干净混 scope） ──────
function mixedScope(sb, opts) {
  const W = require('./bench-watch');
  const L = require('./lib/bench-live');
  const o = Object.assign({ ctxServer: 'srv-A', ctxWorld: 'live-A', rddSession: 'sess-A', ctxSession: 'sess-A' }, opts || {});
  const mon = path.join(sb.dir, 'monitorMix');
  const out = path.join(sb.dir, 'liveMix');
  fs.mkdirSync(mon, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const at = (s) => new Date(Date.now() - s * SEC).toISOString();
  const w = (f, rows) => fs.writeFileSync(path.join(mon, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // rdd 只带 session（部分身份）：producer 必须把它记进 files[*].identity，消费端才知道它说了什么
  w('rdd.jsonl', [{ timestamp: at(2), type: 'situation_event', session: o.rddSession, event_id: 'e-r1', data: {} }]);
  // tools：完整身份 A，且是最新的一条完整事件 → 顶层 status.identity 会取它
  w('tools.jsonl', [{ timestamp: at(5), type: 'tool_result', session: 'sess-A', server_session: 'srv-A', world_id: 'live-A', world_epoch: 1, event_id: 'e-t1', data: {} }]);
  // context：另一条 source，也新鲜
  w('context.jsonl', [{ timestamp: at(10), type: 'llm_usage', session: o.ctxSession, server_session: o.ctxServer, world_id: o.ctxWorld, world_epoch: 1, event_id: 'e-c1', data: {} }]);
  const state = L.newState({ monitor: mon, started_at: Date.now() });
  W.collectOnce(state, { monitor: mon, out, views: ['snapshot'], interval_s: 15, now: Date.now() });
  const st = W.statusOf(state, { running: true, pid: process.pid, enabled: true, last_tick_at: new Date().toISOString(), ticks: 1 });
  fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(st, null, 2));
  fs.writeFileSync(path.join(out, 'watch.json'), JSON.stringify({ schema: 1, enabled: true, views: ['snapshot'], interval_s: 15, bridgeWindow: binding('live-A', 'srv-A', 'w-A') }, null, 2));
  fs.writeFileSync(path.join(out, 'snapshot.md'), '# 实验台 live · snapshot\n\n## 当前任务链\ngoal_id=goal-1  status=ACTIVE\n');
  return { out, st };
}

test('混合 scope：两条新鲜流分别带 world/server A、B（顶层最新=A 且 bind=A）也不许 LIVE', () => {
  const sb = sandbox();
  const { out } = mixedScope(sb, { ctxServer: 'srv-B', ctxWorld: 'live-B' });
  const { json } = briefJson(sb, out);
  const live = json.entry.live;
  assert.notEqual(live.state, 'LIVE', '两条新鲜流的 world/server 冲突，不能被顶层最新摘要洗成 LIVE：' + JSON.stringify(live.state_reason));
  assert.equal(live.state, 'UNKNOWN');
  assert.match(live.state_reason, /多个|不同|不一致|冲突/);
  const t = run(sb, ['brief'], out);
  assert.ok(!/现场状态: LIVE/.test(t.out), '真 CLI 不许印 LIVE');
  assert.match(t.out, /现场状态: UNKNOWN/);
});

test('混合 scope（部分身份）：rdd 只有 session=B，tools/context 完整=A，同样新鲜也必须 UNKNOWN', () => {
  const sb = sandbox();
  const { out, st } = mixedScope(sb, { rddSession: 'sess-B' });
  // 先证 producer 真的把 rdd 的部分身份投出来了，否则这条反例测的是假的
  assert.equal(st.files['rdd.jsonl'].identity && st.files['rdd.jsonl'].identity.session, 'sess-B', 'producer 必须保留 rdd 的单 session 身份');
  assert.equal(st.files['rdd.jsonl'].identity.server_session, null);
  assert.equal(st.identity.session, 'sess-A', '顶层只取完整条目');
  const { json } = briefJson(sb, out);
  const live = json.entry.live;
  assert.equal(live.state, 'UNKNOWN', live.state_reason);
  assert.match(live.state_reason, /不同 session/);
  const t = run(sb, ['brief'], out);
  assert.ok(!/现场状态: LIVE/.test(t.out));
  assert.match(t.out, /现场状态: UNKNOWN/);
});

test('对照：同样多流、rdd 部分身份也是 A（一致），仍应 LIVE', () => {
  const sb = sandbox();
  const { out } = mixedScope(sb, { rddSession: 'sess-A' });
  const { json } = briefJson(sb, out);
  const live = json.entry.live;
  assert.equal(live.state, 'LIVE', live.state_reason);
  assert.equal(live.identity.status, 'BOUND');
});

test('producer：只有部分身份（rdd 单 session）时顶层 identity 为 null，但每流身份仍在', () => {
  const W = require('./bench-watch');
  const L = require('./lib/bench-live');
  const sb = sandbox();
  const mon = path.join(sb.dir, 'monitorPartial');
  const out = path.join(sb.dir, 'livePartial');
  fs.mkdirSync(mon, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(mon, 'rdd.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'situation_event', session: 'sess-only', event_id: 'e-r', data: {} }) + '\n');
  const state = L.newState({ monitor: mon, started_at: Date.now() });
  W.collectOnce(state, { monitor: mon, out, views: ['snapshot'], interval_s: 15, now: Date.now() });
  const st = W.statusOf(state, { running: true });
  assert.equal(st.identity, null, '不完整身份不许升成顶层 scope');
  assert.equal(st.files['rdd.jsonl'].identity.session, 'sess-only');
  assert.equal(st.files['rdd.jsonl'].identity.server_session, null);
  assert.equal(st.files['rdd.jsonl'].identity.world_id, null);
});
