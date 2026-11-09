'use strict';
/**
 * identity-real-entry.test.js —— 用**真实 monitor 流**做身份负例（2026-11-09）
 *
 * 目的：证明"在现有真实数据上，身份独立归属判不出来"，而不是只在夹具上断言。
 * 没有真实文件时**跳过**（skip），不伪造数据。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const G = require('./identity-claim-guard');
const AL = require('./action-ledger');

const DIR = process.env.RDD_MONITOR || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
const has = fs.existsSync(path.join(DIR, 'tools.jsonl'));

test('真实流：现有字段不足以证明独立归属 → UNKNOWN', { skip: has ? false : '无真实 monitor 文件' }, () => {
  const txt = fs.readFileSync(path.join(DIR, 'tools.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-2000).join('\n');
  // 伪造一个"看起来独立"的 resolver：直接拿信封字段拼 claim（这正是最容易被写成自证的做法）
  const selfResolver = (ev) => {
    const d = ev.data || {};
    return {
      worldId: ev.world_id || d.world_id,
      serverSession: ev.server_session || d.session_id,
      companion: d.companion_id,
      evidence: 'tools.jsonl', // 指向自己所在的流
      callId: d.tool_call_id,
    };
  };
  // 守门后：没有事件绑定、没有可信来源验证器 → 一律 UNKNOWN
  const guarded = (ev) => {
    const claim = selfResolver(ev);
    const r = G.verifyIndependent(claim, () => ({ ...claim }), {});
    return r.independent ? claim : null;
  };
  const lg = AL.build(txt, '', { resolveIdentity: guarded });
  const known = lg.summary.coverage && lg.summary.coverage.identityKnown;
  const [k, n] = String(known || '0/0').split('/').map(Number);
  assert.equal(k, 0, '真实数据上不得出现"已证身份"（现有字段不足以证明独立）');
  assert.ok(n >= 1, '应当确实读到了真实事件');
});
test('真实流：信封自洽但证据指向别的流/别的同伴 → 仍不得独立', { skip: has ? false : '无真实 monitor 文件' }, () => {
  const read = (n) => {
    const p = path.join(DIR, n);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).slice(-500)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  const tools = read('tools.jsonl');
  const events = read('events.jsonl');
  const t = tools.find((e) => e.data && e.data.companion_id);
  const other = events.find((e) => e.data && e.data.companion_id && e.data.companion_id !== t.data.companion_id);
  if (!t || !other) return; // 数据不足则跳过断言（不伪造）
  const claim = {
    worldId: t.world_id || '', serverSession: t.server_session || t.data.session_id || '',
    companion: t.data.companion_id, evidence: 'events.jsonl#0', callId: t.data.tool_call_id,
  };
  // resolver 返回"别的流、别的同伴"的记录，字段看起来都合理
  const resolve = () => ({
    eventKey: 'ev-x', provenance: 'events.jsonl',
    worldId: claim.worldId, serverSession: claim.serverSession, companion: other.data.companion_id,
  });
  const r = G.verifyIndependent(claim, resolve, { eventKey: 'ev-y', trustedSources: ['events.jsonl'] });
  assert.equal(r.independent, false, '指向别的同伴/别的流不得判独立');
});
test('真实流：证据卡与总判定（只读）——观测窗口可见，总判定不得 PRESENT', { skip: has ? false : '无真实 monitor 文件' }, () => {
  const { buildCard } = require('../evidence-card');
  const V = require('./evidence-verdict');
  const card = buildCard(DIR);
  assert.ok(card.observedWindow, '必须带观测窗口');
  assert.equal(card.observedWindow.scope, 'observed-bytes-only');
  const v = V.buildVerdict(card, null);
  assert.notEqual(v.verdict, 'PRESENT', '真实数据当前不可能给 PRESENT');
  assert.ok(v.reasons.length > 0, '必须说明卡在哪');
});
