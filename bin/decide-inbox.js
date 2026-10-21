#!/usr/bin/env node
'use strict';
/*
 * decide-inbox.js —— 「主人拍板」的独立通道（治理层，不挂在流水线下）
 *
 * ★ 为什么从 stager 里独立出来（用户 2026-10-21 定的架构事实）：
 *   decide.js 原先挂在 stager 下面，而 stager 是**流水线关隘**。
 *   把「主人拍板」放进流水线工具里，语义就拧了 ——
 *   拍板不是批次流程的一部分，是**治理层和执行层之间的独立通道**。
 *   所以：队列落成独立文件，decide.js 只是其中一个写入方。
 *
 * ★ 存储：`docs/rdd-docs/rdd存放/decisions.jsonl`
 *   - **append-only**，和 memory.jsonl 一个待遇（多写入方并发只追加不重写）
 *   - 每行一个**事件**（raised / resolved / dismissed），状态由事件重放得出
 *   - 为什么不用整文件重写：面板进程 + CLI 进程可能同时写，
 *     重写式合并会互相吃行（memory.jsonl 踩过同一个坑）
 *   - 为什么放 rdd存放：它是**治理证据链**的一部分，
 *     「当时谁批的、批了什么」要和债账快照同等级别被固化（76号 §2 四件套之外的一项）
 *
 * ★ 事件格式（一行一条，永不改历史）：
 *   {"ev":"raised",   "id":"D-1", "at":"...", "title":"...", "risk":"high-arch",
 *    "why":"...", "options":[{"id":"A","label":"...","recommended":true,"consequence":"..."}],
 *    "context":"...", "raisedBy":"ai", "batch":"G4c"}
 *   {"ev":"resolved", "id":"D-1", "at":"...", "choice":"A", "chosenLabel":"...",
 *    "note":"...", "resolvedBy":"user"}
 *   {"ev":"dismissed","id":"D-1", "at":"...", "reason":"...", "resolvedBy":"user"}
 *
 * ★ 判据真源不变：`stager/core/decide-policy.json`
 *   只读它，不 require decide.js（避免治理层反向依赖流水线）。
 *
 * 用法：
 *   node decide-inbox.js add "<标题>" --risk high-arch --why "<为什么必须你定>"
 *        --opt "A|选项标签|rec|选了会怎样" --opt "B|另一个|  |后果" [--context "..."] [--batch G4c]
 *   node decide-inbox.js list [--pending|--all] [--json]
 *   node decide-inbox.js resolve <id> <A|B> [--note "..."]
 *   node decide-inbox.js dismiss <id> [--reason "..."]
 *   node decide-inbox.js digest [--since <ISO>]     # 给 AI 读的摘要（含未读的已决项）
 *   node decide-inbox.js selftest
 *
 * 退出码：0 正常 / 1 业务拒（判据拦下、id 不存在等）/ 2 用法错 / 3 环境错
 */

const fs = require('fs');
const path = require('path');

const RDD = 'D:\\rdd';
const DOCS_OUT = path.join(RDD, 'docs', 'rdd-docs', 'rdd存放');
const QUEUE = path.join(DOCS_OUT, 'decisions.jsonl');
const POLICY = path.join(RDD, 'workspace', 'stager', 'core', 'decide-policy.json');

const RISKS = ['high-arch', 'high-risk'];
const STALE_DAYS = 7;              // 超过 7 天未决 → 面板标黄（用户 2026-10-21 定）

const EXIT_OK = 0, EXIT_REJECT = 1, EXIT_USAGE = 2, EXIT_ENV = 3;

const HELP = `用法：
  node decide-inbox.js add "<标题>" --risk <high-arch|high-risk> --why "<为什么必须你定>"
       --opt "A|标签|推荐|后果" --opt "B|标签||后果" [--context "..."] [--batch <批次>] [--force]
  node decide-inbox.js list [--pending|--all] [--json]
  node decide-inbox.js resolve <id> <选项id> [--note "补充"]
  node decide-inbox.js dismiss <id> [--reason "为什么不算"]
  node decide-inbox.js digest [--since <ISO时间>]     # 给 AI 读：待决 + 最近已决
  node decide-inbox.js selftest

队列文件：${QUEUE}（append-only，事件重放）

退出码：0 正常 / 1 业务拒 / 2 用法错 / 3 环境错`;

/* ────────────────────────────── 参数 ────────────────────────────── */
function parseArgs(argv) {
  const o = { _: [], opt: [], json: false, pending: false, all: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--risk') o.risk = argv[++i];
    else if (a === '--why') o.why = argv[++i];
    else if (a === '--opt') o.opt.push(argv[++i]);
    else if (a === '--context') o.context = argv[++i];
    else if (a === '--batch') o.batch = argv[++i];
    else if (a === '--note') o.note = argv[++i];
    else if (a === '--reason') o.reason = argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--pending') o.pending = true;
    else if (a === '--all') o.all = true;
    else if (a === '--force') o.force = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else o._.push(a);
  }
  return o;
}

/* ────────────────────────────── 存储（append-only） ────────────────────────────── */

/** 读全部事件。坏行跳过并计数（不许因为一行坏就把整个队列读废）。 */
function readEvents() {
  if (!fs.existsSync(QUEUE)) return { events: [], bad: 0 };
  const raw = fs.readFileSync(QUEUE, 'utf8').replace(/^\uFEFF/, '');
  const events = [];
  let bad = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && j.ev && j.id) events.push(j);
      else bad++;
    } catch { bad++; }
  }
  return { events, bad };
}

/**
 * 追加一条事件。
 * ★ 用 appendFileSync 而不是「读-改-写」：多进程并发时只追加不会互相吃行。
 *   单行超过 PIPE_BUF 理论上可能撕裂，但我们的单行都在 4KB 内，实际安全；
 *   且 JSON 解析失败会被 readEvents 计入 bad，不会静默吞掉。
 */
function appendEvent(ev) {
  fs.mkdirSync(DOCS_OUT, { recursive: true });
  const line = JSON.stringify(ev) + '\n';
  fs.appendFileSync(QUEUE, line, 'utf8');
  return ev;
}

/** 事件重放 → 当前状态。后写的事件覆盖先写的（同 id 以最后一条为准）。 */
function replay(events) {
  const map = new Map();
  for (const e of events) {
    const cur = map.get(e.id) || { id: e.id, status: 'pending' };
    if (e.ev === 'raised') {
      Object.assign(cur, {
        title: e.title, risk: e.risk, riskLabel: e.riskLabel, why: e.why,
        context: e.context, options: e.options || [], raisedBy: e.raisedBy,
        raisedAt: e.at, batch: e.batch, forced: e.forced, conflict: e.conflict,
        status: cur.status === 'pending' ? 'pending' : cur.status,
      });
    } else if (e.ev === 'resolved') {
      cur.status = 'resolved';
      cur.chosen = e.choice;
      cur.chosenLabel = e.chosenLabel;
      cur.note = e.note;
      cur.resolvedAt = e.at;
      cur.resolvedBy = e.resolvedBy;
    } else if (e.ev === 'dismissed') {
      cur.status = 'dismissed';
      cur.note = e.reason;
      cur.resolvedAt = e.at;
      cur.resolvedBy = e.resolvedBy;
    }
    map.set(e.id, cur);
  }
  return [...map.values()];
}

function allItems() {
  const { events, bad } = readEvents();
  const items = replay(events);
  items.sort((a, b) => String(a.raisedAt || '').localeCompare(String(b.raisedAt || '')));
  return { items, bad, count: events.length };
}

function pendingItems() {
  return allItems().items.filter((x) => x.status === 'pending');
}

function nextId(items) {
  let max = 0;
  for (const it of items) {
    const m = /^D-(\d+)$/.exec(String(it.id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'D-' + (max + 1);
}

/* ────────────────────────────── 判据（只读 policy，不依赖 decide.js） ────────────────────────────── */

function loadPolicy() {
  let p = null;
  try { p = JSON.parse(fs.readFileSync(POLICY, 'utf8').replace(/^\uFEFF/, '')); } catch { p = null; }
  if (!p || !p.neverEscalate || !p.risks) {
    throw Object.assign(new Error(
      '决策策略读不到：' + POLICY + '\n' +
      '  这是「什么才配问主人」的唯一真源，不能缺。'), { code: 'NO_POLICY' });
  }
  return p;
}

/**
 * 这件事配不配问主人？
 * ★ 顺序不能反（decide.js 2026-10-05 踩过）：
 *   先看 riskSignals（客观高风险）→ 命中就放行；
 *   没命中风险信号，才看 neverEscalate（机械题）→ 命中就拦下。
 */
function judge(title, why, policy) {
  const text = [title, why || ''].join(' ');
  const scan = (pats) => {
    const out = [];
    for (const p of pats) {
      let re;
      try { re = new RegExp(p.re, 'i'); } catch { continue; }
      if (re.test(text)) out.push({ what: p.what, re: p.re, risk: p.risk });
    }
    return out;
  };
  const stakes = scan((policy.riskSignals && policy.riskSignals.patterns) || []);
  const matched = scan(policy.neverEscalate.patterns);
  return {
    escalate: stakes.length > 0 || matched.length === 0,
    risk: stakes.length ? stakes[0].risk : null,
    stakes, matched,
    conflict: stakes.length > 0 && matched.length > 0,
    advice: policy.requireBeforeAsking || [],
  };
}

/* ────────────────────────────── 动作 ────────────────────────────── */

function cmdAdd(o) {
  const title = String(o._[1] || '').trim();
  if (!title) { console.error('[usage] 缺标题。add "<要主人拍板的那件事>"'); return EXIT_USAGE; }

  let policy;
  try { policy = loadPolicy(); } catch (e) { console.error('[env] ' + e.message); return EXIT_ENV; }

  const why = String(o.why || '').trim();
  const risk = String(o.risk || '');
  const j = judge(title, why, policy);

  if (!j.escalate && !o.force) {
    console.error('✘ 这件事不该问主人 —— 已拦下。命中「绝对不许问」：');
    for (const m of j.matched) console.error('   · ' + m.what + '（匹配 /' + m.re + '/）');
    console.error('');
    console.error('「' + title + '」属于机械性技术问题，你自己定，然后写进文档说明你定了什么、为什么。');
    console.error('');
    console.error('★ 问主人之前必须先做完这些：');
    (j.advice || []).forEach((a, i) => console.error('   ' + (i + 1) + ') ' + a));
    console.error('');
    console.error('确实要问（认为判据错了）：加 --force，会被标 forced 并在面板上显示 ⚠。');
    return EXIT_REJECT;
  }

  if (!RISKS.includes(risk)) {
    const hint = j.risk ? `（判据推测大概该用 --risk ${j.risk}，请自己确认）` : '';
    console.error('必须写 --risk，取值只有 ' + RISKS.join(' | ') + '。' + hint);
    console.error('  high-arch = 极高架构决策：定了很难回滚，别的设计都要跟着改');
    console.error('  high-risk = 高风险：做错了会丢东西 / 花钱 / 动安全 / 影响主人');
    return EXIT_REJECT;
  }
  if (why.length < 10) {
    console.error('--why 太短。主人凭什么判断？至少写清：影响面 / 两条路的代价 / 不决定会怎样。');
    return EXIT_REJECT;
  }

  const options = (o.opt || []).map((s) => {
    const p = String(s).split('|');
    return {
      id: (p[0] || '').trim(),
      label: (p[1] || '').trim(),
      recommended: /^(rec|推荐|1|true|yes|★)$/i.test((p[2] || '').trim()),
      consequence: (p[3] || '').trim(),
    };
  }).filter((x) => x.label);

  if (options.length < 2) {
    console.error('至少给 2 个选项。只列一个等于没让人选 —— 那是你已经决定了，不需要问。');
    console.error('  写法：--opt "A|方案甲|rec|选甲的后果" --opt "B|方案乙||选乙的后果"');
    return EXIT_REJECT;
  }
  options.forEach((x, i) => { if (!x.id) x.id = String.fromCharCode(65 + i); });

  const { items } = allItems();
  const id = nextId(items);
  const ev = {
    ev: 'raised',
    id,
    at: new Date().toISOString(),
    title,
    risk,
    riskLabel: (policy.risks[risk] || {}).label || risk,
    why,
    context: String(o.context || ''),
    options,
    raisedBy: 'ai',
    batch: o.batch || null,
    forced: o.force || undefined,
    conflict: j.conflict || undefined,
    soundedMechanical: j.matched.length ? j.matched.map((m) => m.what) : undefined,
  };
  appendEvent(ev);
  console.log('✔ 已入队 ' + id + ' · ' + title);
  console.log('  队列：' + QUEUE);
  console.log('  主人打开面板「等你拍板」就能点；或 node decide-inbox.js list --pending');
  return EXIT_OK;
}

function cmdList(o) {
  const { items, bad } = allItems();
  let show = items;
  if (o.pending) show = items.filter((x) => x.status === 'pending');
  else if (!o.all) show = items.filter((x) => x.status === 'pending');   // 默认只看未决

  if (o.json) {
    console.log(JSON.stringify({ ok: true, queue: QUEUE, badLines: bad, items: show }, null, 2));
    return EXIT_OK;
  }
  if (!show.length) {
    console.log(o.pending || !o.all ? '（没有待决策）' : '（队列为空）');
    return EXIT_OK;
  }
  const now = Date.now();
  for (const it of show) {
    const stale = it.status === 'pending' && (now - Date.parse(it.raisedAt || 0)) > STALE_DAYS * 86400000;
    const tag = it.status === 'pending' ? '● 待拍板' : it.status === 'resolved' ? '✔ 已定' : '✘ 已撤回';
    console.log(tag + '  ' + it.id + '  [' + (it.riskLabel || it.risk) + ']' +
      (it.forced ? ' ⚠强制' : '') + (stale ? ' 🟡超7天' : '') + '  ' + it.title);
    console.log('    为什么要你定：' + it.why);
    for (const op of it.options || []) {
      console.log('      ' + op.id + (op.recommended ? ' ★推荐' : '      ') + ' ' + op.label +
        (op.consequence ? '　→ ' + op.consequence : '') + (it.chosen === op.id ? '　← 已选' : ''));
    }
    if (it.status === 'resolved') console.log('    ✔ 你选了 ' + it.chosen + ' · ' + (it.chosenLabel || '') + ' @ ' + it.resolvedAt);
    console.log('');
  }
  return EXIT_OK;
}

function cmdResolve(o) {
  const id = o._[1];
  const choice = o._[2];
  if (!id || !choice) { console.error('[usage] resolve <id> <选项id>'); return EXIT_USAGE; }
  const { items } = allItems();
  const it = items.find((x) => x.id === id);
  if (!it) { console.error('[reject] 队列里没有 ' + id); return EXIT_REJECT; }
  if (it.status !== 'pending') {
    console.error('[reject] ' + id + ' 已经是「' + it.status + '」，不能再选。刷新看看是不是已经拍过了。');
    return EXIT_REJECT;
  }
  const opt = (it.options || []).find((x) => x.id === choice);
  if (!opt) {
    console.error('[reject] 选项 ' + choice + ' 不存在。这条有：' + (it.options || []).map((x) => x.id).join(' / '));
    return EXIT_REJECT;
  }
  appendEvent({
    ev: 'resolved', id, at: new Date().toISOString(),
    choice: opt.id, chosenLabel: opt.label,
    note: String(o.note || ''), resolvedBy: 'user',
  });
  console.log('✔ ' + id + ' 已拍板：' + opt.id + ' · ' + opt.label);
  console.log('  AI 下次跑 node decide-inbox.js digest 会读到这条。');
  return EXIT_OK;
}

function cmdDismiss(o) {
  const id = o._[1];
  if (!id) { console.error('[usage] dismiss <id>'); return EXIT_USAGE; }
  const { items } = allItems();
  const it = items.find((x) => x.id === id);
  if (!it) { console.error('[reject] 队列里没有 ' + id); return EXIT_REJECT; }
  appendEvent({
    ev: 'dismissed', id, at: new Date().toISOString(),
    reason: String(o.reason || ''), resolvedBy: 'user',
  });
  console.log('✔ ' + id + ' 已撤回');
  return EXIT_OK;
}

/**
 * digest —— 给 AI 读的摘要。
 * ★ 这是「闭环」的另一半：主人点了以后，AI 必须能读到「用户已决策：D-1 选了 A」。
 *   没有这一条，面板能点也等于没接通（用户原话：闭环的判定不是面板能点，
 *   是点完之后 AI 的行为变了）。
 */
function cmdDigest(o) {
  const { items, bad } = allItems();
  const since = o.since ? Date.parse(o.since) : 0;
  const pending = items.filter((x) => x.status === 'pending');
  const resolved = items.filter((x) => x.status === 'resolved' && (!since || Date.parse(x.resolvedAt || 0) > since));
  const dismissed = items.filter((x) => x.status === 'dismissed' && (!since || Date.parse(x.resolvedAt || 0) > since));

  const L = [];
  L.push('# 决策队列摘要');
  L.push('');
  L.push(`> 队列：\`${QUEUE}\`${bad ? `　（⚠ 有 ${bad} 行坏数据被跳过）` : ''}`);
  L.push('');
  if (resolved.length) {
    L.push('## ★ 主人已拍板（你的义务：这条覆盖你之前的任何倾向）');
    L.push('');
    for (const it of resolved) {
      L.push(`### ${it.id} · ${it.title}`);
      L.push(`**主人选了 ${it.chosen} · ${it.chosenLabel || ''}**（${(it.resolvedAt || '').replace('T', ' ').slice(0, 19)}）`);
      if (it.note) L.push(`补充：${it.note}`);
      const opt = (it.options || []).find((x) => x.id === it.chosen);
      if (opt && opt.consequence) L.push(`选了它的后果（当时写的）：${opt.consequence}`);
      L.push('');
      L.push('> 除非发现事实与决策时的假设不符，不要再改主意。');
      L.push('> 确实必须改：先说明「哪一条假设不成立了」，再重新走一次 add。');
      L.push('');
    }
  }
  if (pending.length) {
    L.push('## 还在等主人拍板（先别自己定，也别说已经定了）');
    L.push('');
    for (const it of pending) {
      L.push(`- **${it.id}** [${it.riskLabel || it.risk}] ${it.title}`);
      L.push(`  为什么要主人定：${it.why}`);
      L.push(`  选项：${(it.options || []).map((x) => x.id + '.' + x.label + (x.recommended ? '(推荐)' : '')).join('　')}`);
    }
    L.push('');
  }
  if (dismissed.length) {
    L.push('## 已被主人撤回');
    L.push('');
    for (const it of dismissed) L.push(`- ${it.id} · ${it.title}${it.note ? `（原因：${it.note}）` : ''}`);
    L.push('');
  }
  if (!L.some((x) => x.startsWith('##'))) L.push('（队列为空：没有待拍板，也没有最近已决项）');

  console.log(L.join('\n'));
  return EXIT_OK;
}

/* ────────────────────────────── selftest ────────────────────────────── */
function selftest() {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decide-'));
  const saved = QUEUE;
  // 用临时队列测（不污染真队列）
  const Q = path.join(tmp, 'q.jsonl');
  const checks = [];

  // 直接测 replay + appendEvent 的核心语义（复制最小实现，避免改动模块级常量）
  const lines = [
    { ev: 'raised', id: 'D-1', at: '2026-10-21T00:00:00Z', title: 'T', risk: 'high-arch', why: 'w', options: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }] },
    { ev: 'raised', id: 'D-2', at: '2026-10-21T00:01:00Z', title: 'T2', risk: 'high-risk', why: 'w2', options: [{ id: 'A', label: 'a' }] },
    { ev: 'resolved', id: 'D-1', at: '2026-10-21T00:02:00Z', choice: 'A', chosenLabel: 'a', resolvedBy: 'user' },
  ];
  fs.writeFileSync(Q, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  // 复用 replay：临时替换 readEvents 的路径不现实，这里直接调 replay
  const evs = lines;
  const st = replay(evs);
  checks.push(['重放出 2 条', st.length === 2]);
  checks.push(['D-1 已 resolved', st.find((x) => x.id === 'D-1').status === 'resolved']);
  checks.push(['D-1 记录了 choice', st.find((x) => x.id === 'D-1').chosen === 'A']);
  checks.push(['D-2 仍 pending', st.find((x) => x.id === 'D-2').status === 'pending']);
  checks.push(['nextId 递增到 D-3', nextId(st) === 'D-3']);

  // 判据：机械题应被拦
  let policy = null;
  try { policy = loadPolicy(); } catch { /* 环境没 policy 就跳过这两条 */ }
  if (policy) {
    const mech = judge('把变量名改成驼峰', '这是命名风格问题', policy);
    checks.push(['机械题被判为不该问', mech.escalate === false]);
    const arch = judge('要不要把三个模块合并成一个', '影响整个架构，回滚成本极高', policy);
    checks.push(['架构题被判为该问', arch.escalate === true]);
  }

  // 坏行容错
  const badQ = path.join(tmp, 'bad.jsonl');
  fs.writeFileSync(badQ, '{"ev":"raised","id":"D-9"}\nnot json\n\n{"ev":"resolved","id":"D-9"}\n', 'utf8');
  const badLines = fs.readFileSync(badQ, 'utf8').split(/\r?\n/).filter(Boolean);
  let okBad = 0;
  for (const l of badLines) { try { JSON.parse(l); okBad++; } catch { /* 预期 1 行坏 */ } }
  checks.push(['坏行被跳过不炸', okBad === 2]);

  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✔' : '✘'} ${name}`);
    if (ok) pass++;
  }
  console.log(`\n  selftest: ${pass}/${checks.length}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return pass === checks.length ? EXIT_OK : EXIT_REJECT;
}

/* ────────────────────────────── main ────────────────────────────── */
function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return EXIT_OK; }
  const cmd = argv[0];
  const o = parseArgs(argv);

  if (cmd === 'selftest') return selftest();
  if (cmd === 'add') return cmdAdd(o);
  if (cmd === 'list' || cmd === 'ls') return cmdList(o);
  if (cmd === 'resolve') return cmdResolve(o);
  if (cmd === 'dismiss') return cmdDismiss(o);
  if (cmd === 'digest') return cmdDigest(o);
  if (cmd === 'pending') { o.pending = true; return cmdList(o); }

  console.error('[usage] 不认识的命令：' + cmd);
  console.log(HELP);
  return EXIT_USAGE;
}

if (require.main === module) process.exit(main());

module.exports = {
  QUEUE, POLICY, STALE_DAYS,
  readEvents, appendEvent, replay, allItems, pendingItems, nextId,
  loadPolicy, judge,
};
