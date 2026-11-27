'use strict';
// 跨流关联的可判性：真实数据上目前**没有共同键**，必须显式记录为 UNKNOWN，而不是靠猜。
// 若未来生产加了共同键（例如 event_seq 同时写进各流），本测试会失败并提醒更新口径。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');

const DIR = process.env.RDD_MONITOR || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
const has = fs.existsSync(path.join(DIR, 'tools.jsonl'));

const rows = (n) => {
  const p = path.join(DIR, n);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).slice(-500)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

test('真实流：tools 与 events 目前没有共同键（显式 UNKNOWN，不硬拼）', { skip: has ? false : '无真实文件' }, () => {
  const t = rows('tools.jsonl');
  const e = rows('events.jsonl');
  const ids = new Set(t.map((r) => r && r.data && r.data.tool_call_id).filter(Boolean));
  const shared = e.filter((r) => r && r.data && r.data.tool_call_id && ids.has(r.data.tool_call_id)).length;
  // 现状：events 不带 tool_call_id；若将来带上并能匹配，这里应改为断言可关联
  assert.equal(shared, 0, 'events 里出现可匹配的 tool_call_id 时，需要更新跨流关联口径');
});

test('真实流：rdd.jsonl 运行级 session 已存在，可按 session 对齐但不冒充世界效果', { skip: has ? false : '无真实文件' }, () => {
  const r = rows('rdd.jsonl');
  const c = rows('context.jsonl');
  if (!r.length) return;
  const rddSessions = new Set(r.map((x) => x.session).filter((x) => typeof x === 'string' && x));
  const contextSessions = new Set(c.map((x) => x.session).filter((x) => typeof x === 'string' && x));
  const shared = [...rddSessions].filter((x) => contextSessions.has(x));
  assert.ok(rddSessions.size > 0, 'rdd.jsonl 应保留运行级 session');
  assert.ok(shared.length > 0, 'rdd 与 context 至少有一个可对齐 session；相同 session 仍不证明世界效果');
});
