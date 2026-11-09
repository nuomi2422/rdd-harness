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

/**
 * 按时间窗过滤原始行：只保留时间戳落在 [since, until] 的事件。
 * 认 `timestamp` 或 `at` 字段；没有时间字段的行**保留**（交给下游判 malformed），不静默丢。
 */
function filterByWindow(text, since, until) {
  if (!since && !until) return text;
  const lo = since ? Date.parse(since) : -Infinity;
  const hi = until ? Date.parse(until) : Infinity;
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return text;
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let t = NaN;
    try {
      const o = JSON.parse(line);
      const raw = o.timestamp || o.at || (o.data && (o.data.timestamp || o.data.at));
      t = raw ? Date.parse(raw) : NaN;
    } catch { out.push(line); continue; }
    if (!Number.isFinite(t)) { out.push(line); continue; }
    if (t >= lo && t <= hi) out.push(line);
  }
  return out.join('\n');
}

function buildCard(dir, opts = {}) {
  const d = dir || '';
  // 2026-11-09：默认走生产读取器（monitor-reader）拿缺口/窗口信号，
  // 直接 readFileSync 会看不到截断/轮转/半行这类"悄悄丢内容"的情形。
  let reader = null;
  if (opts.viaReader !== false) {
    try {
      reader = require('./lib/monitor-reader').createPull({ dir: d });
    } catch { reader = null; }
  }
  const readThrough = (name) => {
    if (!reader) return readIf(path.join(d, name));
    const chunk = reader.pull(name);
    const raw = chunk && chunk.length ? chunk : (readIf(path.join(d, name)) || '');
    return filterByWindow(raw, opts.since, opts.until);
  };
  const tools = fs.existsSync(path.join(d, 'tools.jsonl')) ? readThrough('tools.jsonl') : null;
  const events = fs.existsSync(path.join(d, 'events.jsonl')) ? readThrough('events.jsonl') : null;
  const context = fs.existsSync(path.join(d, 'context.jsonl')) ? readThrough('context.jsonl') : null;
  const rdd = fs.existsSync(path.join(d, 'rdd.jsonl')) ? readThrough('rdd.jsonl') : null;

  const card = { dir: d, sources: {}, actions: null, finalRequest: null, settle: null, reasons: [] };

  // 动作账本：没有 tools 流就 UNKNOWN
  if (tools === null) { card.reasons.push('tools.jsonl-missing'); card.actions = { status: 'UNKNOWN', attributable: 'UNKNOWN', identityKnown: null, reasons: ['tools.jsonl-missing'] }; }
  else {
    const lg = AL.build(tools, events || '', { minStreak: 3 });
    // ★ 2026-11-09（指挥官指出）：**"动作流存在"绝不等于"可归属/完成/健康"**。
    // 身份覆盖 0/6477 时若还叫 PRESENT，极容易被读成"动作没问题"。
    // 所以这里拆两个维度：
    //   rawPresent   = 原始动作流里确实有调用（只是"有数据"）
    //   attributable = 能否归属到具体世界/会话/同伴并判断终态（身份未证时恒为 UNKNOWN）
    const knownStr = String((lg.summary.coverage && lg.summary.coverage.identityKnown) || '0/0');
    const kn = knownStr.split('/');
    const allKnown = Number(kn[1]) > 0 && Number(kn[0]) === Number(kn[1]);
    card.actions = {
      status: lg.summary.calls > 0 ? 'RAW_PRESENT' : 'UNKNOWN',
      semantics: 'raw-flow-only; NOT attributable/completed/healthy',
      attributable: allKnown ? 'PRESENT' : 'UNKNOWN',
      identityKnown: knownStr,
      calls: lg.summary.calls,
      states: lg.summary.states,
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

  // 缺口与观测窗口：有缺口就整体降级并显式记，不让"读到一半"看起来像完整。
  if (reader) {
    card.gaps = reader.gaps;
    const w = reader.verifyWindow(['tools.jsonl', 'events.jsonl']);
    card.observedWindow = { scope: 'observed-bytes-only', ok: !!w.ok, files: w.files };
    if (Object.keys(reader.gaps).length) card.reasons.push('log-gap');
  }
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
  l.push('[动作] ' + (a.status || 'UNKNOWN') + '（仅表示原始流有数据，不代表可归属/完成/健康） 调用=' + (a.calls ?? '?') + ' 可归属=' + (a.attributable || 'UNKNOWN') + ' 身份覆盖=' + (a.identityKnown || '?') + ' 仅受理=' + (a.acceptedOnly ?? '?'));
  const f = card.finalRequest || {};
  l.push('[最终请求] ' + (f.status || 'UNKNOWN') + ' why 交付=' + (f.delivered || '?') + ' 类型=' + JSON.stringify(f.byKind || {}));
  const s = card.settle || {};
  l.push('[结算] ' + (s.status || 'UNKNOWN') + ' 按最终目标核验=' + ((s.coverage && s.coverage.judged) || '?') + ' legacy=' + ((s.settled && s.settled.legacy) ?? '?') + ' 被拒=' + ((s.rejected && s.rejected.finals && s.rejected.finals.length) || 0));
  const g = Object.keys(card.gaps || {});
  if (g.length) l.push('[读取缺口] ' + g.map((k) => k + ':' + card.gaps[k].reason).join(' '));
  // ★ 措辞必须点明：这是**观测到的字节窗口**，不是业务时间完整。
  if (card.observedWindow) l.push('[观测窗口] ' + (card.observedWindow.ok ? '本窗口内字节完整（非业务时间完整）' : '字节窗口不完整') + (card.observedWindow.files ? ' 流=' + Object.keys(card.observedWindow.files).join(',') : ''));
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
  ok(card.actions.attributable === 'UNKNOWN', '①无可归属信息时必须 UNKNOWN');
  ok(card.reasons.includes('tools.jsonl-missing'), '②缺口要列出来');
  ok(render(card).includes('UNKNOWN'), '③渲染不空');
  return fails;
}

module.exports = { buildCard, render, selftest };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const di = argv.indexOf('--dir');
  const si = argv.indexOf('--since');
  const ui = argv.indexOf('--until');
  const dir = di >= 0 ? argv[di + 1] : path.join('D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor');
  if (argv.includes('--selftest')) {
    const fails = selftest();
    if (fails.length) { console.error('evidence-card selftest FAIL: ' + fails.join(' | ')); process.exit(1); }
    console.log('evidence-card selftest PASS（3 组）');
    process.exit(0);
  }
  const card = buildCard(dir, { since: si >= 0 ? argv[si + 1] : null, until: ui >= 0 ? argv[ui + 1] : null });
  if (argv.includes('--json')) console.log(JSON.stringify(card, null, 2));
  else console.log(render(card));
}