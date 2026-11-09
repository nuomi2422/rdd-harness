'use strict';
/**
 * evidence-card.js —— 一次运行的"证据卡"（2026-11-09）
 *
 * 用途：把分散在三个流里的证据合成一张可核对的卡，避免指挥官/主人逐文件翻：
 *   - 动作账本（tools.jsonl + events.jsonl）→ 调用/终态/身份覆盖
 *   - 最终请求（context.jsonl）→ why 是否真的进了请求（n/N）
 *   - 结算核验（rdd.jsonl）→ 有多少结算按最终目标核验过
 *
 * 口径：**没有数据一律 UNKNOWN，不写成"没问题"**；三个来源各自独立判定，不互相背书。
 *
 * 用法：
 *   node bin/evidence-card.js --dir "D:\rdd\mc\...\monitor" [--json]
 */
const fs = require('fs');
const path = require('path');
const AL = require('./lib/action-ledger');
const FR = require('./lib/final-request-evidence');
const SE = require('./lib/settle-evidence');

function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function buildCard(dir, opts = {}) {
  const d = dir || '';
  const tools = readIf(path.join(d, 'tools.jsonl'));
  const events = readIf(path.join(d, 'events.jsonl'));
  const context = readIf(path.join(d, 'context.jsonl'));
  const rdd = readIf(path.join(d, 'rdd.jsonl'));

  const card = { dir: d, sources: {}, actions: null, finalRequest: null, settle: null, reasons: [] };

  // 动作账本：没有 tools 流就 UNKNOWN
  if (tools === null) { card.reasons.push('tools.jsonl-missing'); card.actions = { status: 'UNKNOWN', reasons: ['tools.jsonl-missing'] }; }
  else {
    const lg = AL.build(tools, events || '', { minStreak: 3 });
    card.actions = {
      status: lg.summary.calls > 0 ? 'PRESENT' : 'UNKNOWN',
      calls: lg.summary.calls,
      states: lg.summary.states,
      identityKnown: lg.summary.coverage && lg.summary.coverage.identityKnown,
      acceptedOnly: lg.summary.acceptedOnly,
      duplicates: lg.summary.duplicates,
    };
  }

  // 最终请求：没有 context 流或没有事件 → UNKNOWN（不是"没有 why"）
  if (context === null) { card.reasons.push('context.jsonl-missing'); card.finalRequest = { status: 'UNKNOWN', reasons: ['context.jsonl-missing'] }; }
  else card.finalRequest = FR.build(context);

  // 结算核验
  if (rdd === null) { card.reasons.push('rdd.jsonl-missing'); card.settle = { status: 'UNKNOWN', reasons: ['rdd.jsonl-missing'] }; }
  else card.settle = SE.build(rdd);

  card.sources = {
    tools: tools === null ? 'missing' : 'present',
    events: events === null ? 'missing' : 'present',
    context: context === null ? 'missing' : 'present',
    rdd: rdd === null ? 'missing' : 'present',
  };
  return card;
}

function render(card) {
  const l = [];
  l.push('证据卡：' + card.dir);
  l.push('来源：' + Object.entries(card.sources).map(([k, v]) => k + '=' + v).join(' '));
  const a = card.actions || {};
  l.push('[动作] ' + (a.status || 'UNKNOWN') + ' 调用=' + (a.calls ?? '?') + ' 身份覆盖=' + (a.identityKnown || '?') + ' 仅受理=' + (a.acceptedOnly ?? '?'));
  const f = card.finalRequest || {};
  l.push('[最终请求] ' + (f.status || 'UNKNOWN') + ' why 交付=' + (f.delivered || '?') + ' 类型=' + JSON.stringify(f.byKind || {}));
  const s = card.settle || {};
  l.push('[结算] ' + (s.status || 'UNKNOWN') + ' 按最终目标核验=' + ((s.coverage && s.coverage.judged) || '?') + ' legacy=' + ((s.settled && s.settled.legacy) ?? '?') + ' 被拒=' + ((s.rejected && s.rejected.finals && s.rejected.finals.length) || 0));
  if (card.reasons.length) l.push('缺口：' + card.reasons.join(','));
  const fs2 = [...(f.reasons || []), ...(s.reasons || [])];
  if (fs2.length) l.push('理由：' + fs2.join(','));
  return l.join('\n');
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const card = buildCard(path.join(require('os').tmpdir(), '__no_such_dir__'));
  ok(card.actions.status === 'UNKNOWN', '①缺文件必须 UNKNOWN');
  ok(card.reasons.includes('tools.jsonl-missing'), '②缺口要列出来');
  ok(render(card).includes('UNKNOWN'), '③渲染不空');
  return fails;
}

module.exports = { buildCard, render, selftest };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const di = argv.indexOf('--dir');
  const dir = di >= 0 ? argv[di + 1] : path.join('D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor');
  if (argv.includes('--selftest')) {
    const fails = selftest();
    if (fails.length) { console.error('evidence-card selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
    console.log('evidence-card selftest PASS（3 组）');
    process.exit(0);
  }
  const card = buildCard(dir);
  if (argv.includes('--json')) console.log(JSON.stringify(card, null, 2));
  else console.log(render(card));
}
