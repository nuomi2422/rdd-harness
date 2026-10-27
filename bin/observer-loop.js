#!/usr/bin/env node
'use strict';
/**
 * observer-loop.js —— 让 Observer 同伴按固定节拍把「它眼里的世界」写进 monitor/observer.jsonl
 *
 * 为什么存在（2026-10-28 用户下单）：
 *   mineflayer 连不了 NeoForge 实例（FML 握手门，见 tools/mineflayer/README.md），
 *   但 Numen 的 create_companion 能造一个服务端玩家实体（Observer，creative），
 *   它看得见 RDD 周围的地形/实体/矿物。本脚本把这份「第二视角」按统一信封落盘，
 *   监测台（8776）与离线分析就能像读其它 monitor 流一样读它。
 *
 * 信封与 MonitoringJournal 对齐（schema_version / event_id / timestamp / source /
 *   category / type / data），坏行=0：每行都是 JSON.stringify 出来的对象。
 *
 * 用法：
 *   node observer-loop.js                 # 默认 30s 一拍，写 monitor/observer.jsonl
 *   node observer-loop.js --interval 15 --once
 *   node observer-loop.js --companion Observer --watch RDD
 *
 * 边界（先说死）：
 *   - 只读 + 只写自己的 jsonl；不发任何身体指令、不改世界（红线同 learner_feedback）。
 *   - 任何一拍失败都不退出循环（观测崩了不该让第二视角消失），错误进 data.error。
 *   - 文件超过 MAX_BYTES 就轮转一份 .1 备份，保证总量有界。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RDD = 'D:/rdd';
const GAME = path.join(RDD, 'mc', 'The Best of Twilight Forest');
const MONITOR = path.join(GAME, 'config', 'numen', 'monitor');
const OUT = path.join(MONITOR, 'observer.jsonl');
const MCP = path.join(RDD, 'workspace', 'rdd-selfcompile', 'scripts', 'mcp-call.js');
const MAX_BYTES = 32 * 1024 * 1024;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
function flag(name) { return process.argv.includes('--' + name); }

const COMPANION = arg('companion', 'Observer');
const WATCH = arg('watch', 'RDD');
const INTERVAL = Math.max(5, parseInt(arg('interval', '30'), 10));
const ONCE = flag('once');
const RADIUS = parseInt(arg('radius', '16'), 10);

let SEQ = 0;

/** 调一次 MCP 工具，返回解析后的 JSON（失败返回 { error }）。 */
function mcp(tool, companion, argsObj) {
  const argv = [MCP, tool, companion];
  let tmp = null;
  if (argsObj) {
    tmp = path.join(require('os').tmpdir(), 'observer-loop-' + process.pid + '-' + (SEQ++) + '.json');
    fs.writeFileSync(tmp, JSON.stringify(argsObj), 'utf8');
    argv.push('@' + tmp);
  }
  try {
    const out = execFileSync(process.execPath, argv, { encoding: 'utf8', timeout: 30000 });
    const txt = String(out).trim();
    // 有的工具直接返回 JSON，有的外面包了提示语 —— 取第一个 { 到最后一个 }
    const a = txt.indexOf('{');
    const b = txt.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(txt.slice(a, b + 1));
    return { raw: txt };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e).slice(0, 300) };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
}

function nowIso() { return new Date().toISOString(); }

function append(type, data) {
  const env = {
    schema_version: 1,
    event_id: 'observer-' + Date.now() + '-' + (SEQ++),
    timestamp: nowIso(),
    source: 'numen',
    category: 'observer',
    type,
    data,
  };
  try {
    fs.mkdirSync(MONITOR, { recursive: true });
    if (fs.existsSync(OUT) && fs.statSync(OUT).size >= MAX_BYTES) {
      fs.renameSync(OUT, OUT + '.1');
    }
    fs.appendFileSync(OUT, JSON.stringify(env) + '\n', 'utf8');
  } catch (e) {
    console.error('[observer-loop] write failed: ' + e.message);
  }
}

function tick() {
  const self = mcp('get_self_status', COMPANION, null);
  const where = mcp('rdd_whereami', COMPANION, null);
  const ents = mcp('scan_nearby_entities', COMPANION, { type_filter: 'all', radius: RADIUS });

  const watch = mcp('rdd_whereami', WATCH, null);
  const watchStatus = mcp('get_self_status', WATCH, null);

  const dist = (() => {
    try {
      const a = where.data, b = watch.data;
      if (!a || !b) return null;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100;
    } catch { return null; }
  })();

  const data = {
    companion: COMPANION,
    watching: WATCH,
    distance_to_watched: dist,
    self: self.data || self.error || null,
    watched: {
      position: watch.data || watch.error || null,
      game_mode: watchStatus.game_mode,
      hp: watchStatus.hp,
      hunger: watchStatus.hunger,
      equipment: watchStatus.equipment,
      backpack_used: watchStatus.backpack_slots && watchStatus.backpack_slots.used,
      target: watchStatus.target,
    },
    nearby: (ents.entities || []).slice(0, 12).map((e) => ({
      id: e.id, type: e.type, category: e.category,
      pos: e.position, distance: Math.round(e.distance * 100) / 100, hp: e.hp,
    })),
    nearby_count: ents.total_found === undefined ? null : ents.total_found,
    radius: RADIUS,
    error: self.error || where.error || ents.error || null,
  };

  append('observer_tick', data);

  const selfPos = (self.data && self.data.position) || {};
  const watchPos = (watch.data) || {};
  console.log(
    '[' + nowIso() + '] ' + COMPANION +
    ' @(' + (selfPos.x ?? '?') + ',' + (selfPos.y ?? '?') + ',' + (selfPos.z ?? '?') + ')' +
    ' mode=' + ((self.data && self.data.game_mode) || '?') +
    ' | ' + WATCH + ' @(' + (watchPos.x ?? '?') + ',' + (watchPos.y ?? '?') + ',' + (watchPos.z ?? '?') + ')' +
    ' hp=' + (data.watched.hp ?? '?') +
    ' dist=' + (dist ?? '?') +
    ' nearby=' + data.nearby_count
  );
}

(function main() {
  append('observer_loop_start', {
    companion: COMPANION, watching: WATCH, interval_s: INTERVAL, radius: RADIUS, pid: process.pid,
  });
  console.log('[observer-loop] start: ' + COMPANION + ' watching ' + WATCH + ' every ' + INTERVAL + 's -> ' + OUT);

  tick();
  if (ONCE) { append('observer_loop_stop', { reason: '--once' }); return; }

  setInterval(() => {
    try { tick(); } catch (e) { append('observer_tick_error', { error: String(e.message).slice(0, 300) }); }
  }, INTERVAL * 1000);

  process.on('SIGINT', () => { append('observer_loop_stop', { reason: 'SIGINT' }); process.exit(0); });
})();
