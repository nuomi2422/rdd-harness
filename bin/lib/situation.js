'use strict';
/**
 * situation.js —— A3（95 号）capability / tool 两层的**归档后处理**。
 *
 * 为什么是后处理而不是实时：`plugins/rdd` 没有工具回执钩子（grep 无 tool_result），
 * 实时事件要改 `api/common` 的 dispatcher 并重新部署两个 jar；本轮先用 run 归档的
 * `evidence/tools.jsonl` 做同口径分类，明确标 `realtime:false`，不冒充实时。
 *
 * 两层：
 *   - capability：`attack` 失败且原因像「没有效果/没有目标/够不到」→ capability_gap（不是 failure）；
 *   - tool：同一工具、同样参数长度在 60s 内 ≥3 次 → redundant_query（重复查询/重复调用）。
 *
 * 缺失 = UNKNOWN（没有 tools.jsonl 就不猜）；有文件但 0 条 = NONE。
 */

const CAP_PATTERNS = [
  /no\s*effect/i, /cannot|can't|can not/i, /not\s*found/i, /out\s*of\s*reach|too\s*far/i,
  /无效/, /没有目标/, /够不到|打不到|无法攻击/, /no\s*such\s*entity/i,
];

// 2026-10-29 实测：`attack`/`mine` 的失败不一定进 tool_result（异步任务），
// 但 `task_negotiation` 的 COUNTER 会写出**具体能力边界**（例如
// "mine 回执明确 can't harvest end_stone with the current tools"）。
// 这里只认「明确的能力不可能」，不把普通策略分歧算成 capability_gap。
const CAP_PATTERNS_NEGOTIATION = [
  /can'?t\s+harvest/i, /requires?\s+(a\s+)?(diamond|iron)\s+pickaxe/i,
  /物理上做不到/, /拿不到|做不出|凑不到/, /没有可用的?工具/, /空手.*挖不到/, /can'?t\s+mine/i,
];

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * @param {object} p
 * @param {Array|null} p.toolsRows  evidence/tools.jsonl 的行（null = 归档缺失）
 * @param {number} [p.windowMs]     重复查询窗口，默认 60s
 * @param {number} [p.minRepeat]    同工具同参数长度几次算重复，默认 3
 */
function classify({ toolsRows, rddRows, windowMs = 60000, minRepeat = 3 } = {}) {
  const out = { status: 'UNKNOWN', realtime: false, entries: [], reasons: [] };
  if (!Array.isArray(toolsRows) && !Array.isArray(rddRows)) {
    out.reasons.push('no-tools-archive');
    return out;
  }
  const calls = [];
  const caps = [];
  const toolRows = Array.isArray(toolsRows) ? toolsRows : [];
  for (const e of toolRows) {
    if (!e || typeof e !== 'object') continue;
    const d = e.data || {};
    if (e.type === 'tool_call') {
      calls.push({
        tool: d.tool || '?',
        argsChars: Number(d.args_chars || 0),
        at: toMs(e.timestamp),
        ts: e.timestamp,
        id: d.tool_call_id || null,
      });
    }
    if (e.type === 'tool_result' && d.success === false) {
      const tool = d.tool || '?';
      const msg = norm(d.message || d.error || '');
      if (tool === 'attack' && CAP_PATTERNS.some((re) => re.test(msg))) {
        caps.push({
          layer: 'capability',
          kind: 'capability_gap',
          subject: 'attack',
          at: e.timestamp || null,
          reason: msg.slice(0, 120) || 'attack_no_effect',
          evidence: 'evidence/tools.jsonl#tool_result',
        });
      }
    }
  }

  // capability（补充数据源）：task_negotiation 的 COUNTER 写出能力边界；同 subject 只留第一条。
  const rdd = Array.isArray(rddRows) ? rddRows : [];
  const capSeen = new Set();
  for (const e of rdd) {
    if (!e || e.type !== 'task_negotiation') continue;
    const d = e.data || {};
    if (d.kind !== 'COUNTER') continue;
    const reason = norm(d.reason || '');
    if (!reason) continue;
    if (!CAP_PATTERNS_NEGOTIATION.some((re) => re.test(reason))) continue;
    const subject = d.taskId || 'task';
    if (capSeen.has(subject)) continue;
    capSeen.add(subject);
    caps.push({
      layer: 'capability', kind: 'capability_gap', subject,
      at: e.timestamp || null, reason: reason.slice(0, 140),
      evidence: 'evidence/rdd.jsonl#task_negotiation',
    });
  }
  // 重复查询：同一 tool + 同 args_chars，窗口内 ≥ minRepeat
  const redundant = [];
  const byKey = new Map();
  for (const c of calls) {
    if (c.at == null) continue;
    const key = c.tool + '|' + c.argsChars;
    const arr = byKey.get(key) || [];
    arr.push(c);
    byKey.set(key, arr);
  }
  for (const [key, arr] of byKey) {
    arr.sort((a, b) => a.at - b.at);
    let start = 0;
    for (let i = 0; i < arr.length; i++) {
      while (arr[i].at - arr[start].at > windowMs) start++;
      if (i - start + 1 >= minRepeat) {
        const [tool, chars] = key.split('|');
        redundant.push({
          layer: 'tool',
          kind: 'redundant_query',
          subject: tool,
          argsChars: Number(chars),
          count: i - start + 1,
          windowSeconds: Math.round(windowMs / 1000),
          at: arr[i].ts || null,
          evidence: 'evidence/tools.jsonl#tool_call',
        });
        start = i + 1; // 一个窗口只报一条，避免刷屏
      }
    }
  }
  out.entries = caps.concat(redundant).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  out.status = out.entries.length ? 'PRESENT' : 'NONE';
  return out;
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const call = (ts, tool, chars) => ({ type: 'tool_call', timestamp: ts, data: { tool, args_chars: chars } });
  const res = (ts, tool, success, message) => ({ type: 'tool_result', timestamp: ts, data: { tool, success, message } });

  ok(classify({ toolsRows: null }).status === 'UNKNOWN', '① 缺归档必须 UNKNOWN');
  ok(classify({ toolsRows: [] }).status === 'NONE', '② 空归档应 NONE');

  const cap = classify({
    toolsRows: [
      res('2026-10-29T08:00:00Z', 'attack', false, 'no effect on ender crystal'),
      res('2026-10-29T08:00:05Z', 'attack', false, 'target out of reach'),
      res('2026-10-29T08:00:06Z', 'attack', true, 'hit'),
    ],
  });
  ok(cap.entries.filter((e) => e.kind === 'capability_gap').length === 2, '③ attack 无效应记 2 条 capability_gap');
  ok(cap.entries.every((e) => e.layer === 'capability'), '④ 能力层不能混进度/工具层');

  const red = classify({
    toolsRows: [
      call('2026-10-29T08:00:00Z', 'task_status', 12),
      call('2026-10-29T08:00:10Z', 'task_status', 12),
      call('2026-10-29T08:00:20Z', 'task_status', 12),
      call('2026-10-29T08:00:30Z', 'get_self_status', 8),
    ],
  });
  const reds = red.entries.filter((e) => e.kind === 'redundant_query');
  ok(reds.length === 1 && reds[0].subject === 'task_status' && reds[0].count === 3, '⑤ 同工具同参数 3 次应记 1 条 redundant_query');

  const slow = classify({
    toolsRows: [
      call('2026-10-29T08:00:00Z', 'task_status', 12),
      call('2026-10-29T08:05:00Z', 'task_status', 12),
      call('2026-10-29T08:10:00Z', 'task_status', 12),
    ],
  });
  ok(slow.entries.filter((e) => e.kind === 'redundant_query').length === 0, '⑥ 超出 60s 窗口不算重复');

  // ⑦ 能力边界：task_negotiation 的 COUNTER 明确写出「做不到」→ capability_gap
  const neg = (taskId, reason) => ({ type: 'task_negotiation', timestamp: '2026-10-29T08:20:00Z', data: { kind: 'COUNTER', taskId, reason } });
  const cap2 = classify({
    toolsRows: [],
    rddRows: [
      neg('t1', "mine 回执明确 can't harvest end_stone with the current tools，做不到"),
      neg('t1', '重复的同一条'),
      neg('t2', '这个策略我不太喜欢，换一条'),
    ],
  });
  const gaps = cap2.entries.filter((e) => e.kind === 'capability_gap');
  ok(gaps.length === 1 && gaps[0].subject === 't1', '⑦ 能力边界只认明确「做不到」且同 subject 去重');

  console.log(fails.length ? ('situation selftest FAIL: ' + fails.join(' | ')) : 'situation selftest PASS（7 组）');
  return fails.length ? 1 : 0;
}

module.exports = { classify, selftest, CAP_PATTERNS };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'selftest') process.exit(selftest());
  console.error('usage: situation.js selftest');
  process.exit(2);
}
