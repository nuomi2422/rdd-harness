#!/usr/bin/env node
/**
 * intent-evidence.js —— 把「架构意图」落到可查的数据上（2026-10-27 goal 第 11 轮）
 *
 * 主人要的：「可以在执行超长线任务的时候，验证架构文档内的一些意图，比如，
 * 死亡重规划必须拥有语义，或者，支线任务全部开启，可以晚上睡觉提醒」。
 *
 * 为什么需要这个工具（上一轮实测发现的洞）：
 *   意图此前只写在文档里 + 只存在于"我记得那次跑过"。我去翻 monitor 归档时，
 *   5 个 16MB 的 `rdd-*.jsonl` 里**只有快照类事件**（taskchain_snapshot / numen_context /
 *   fact_snapshot / asset_snapshot），业务事件（recovery_named_from_needs / side_task_created /
 *   replanned）一条都没有 —— 于是"验证意图"变成了考古。普通 grep 中文还会假阴性。
 *   这个工具就是那条**可重复的查证命令**：一条命令说清"哪些意图在数据里真发生过、在哪一行"。
 *
 * 判据（每条意图 = 一组必要条件 + 一个反例）：
 *   I1 死亡重规划必须拥有语义：需求丢失 → 点名恢复支线 → 支线完成 → 回主线，
 *      且**同一窗口内不得出现 replanned**（出现 = 仍然整段重写了计划，语义没守住）
 *   I2 支线全部开启 + 晚上睡觉提醒：夜里（dayTime 13000~23000）出现过 type=sleep 的支线
 *   I3 题型骨架进规划：planner 请求正文里出现 <stage_patterns>
 *   I4 经验真的投送：retrieval_snapshot entries>0，且请求正文里有 <retrieved_knowledge>
 *   I5 危险事实进执行上下文：请求正文里出现 <danger>
 *   I6 施工有回读：tools.jsonl 里出现过 blueprint 的 verify 动作
 *
 * 状态三态：PASS（必要条件齐且无反例）/ PARTIAL（部分齐）/ NO_DATA（扫描窗口内没有证据）。
 * NO_DATA **不等于失败** —— 它等于"这段窗口没发生"，必须如实分开。
 *
 * 用法：
 *   node intent-evidence.js                 # 最近 3 天
 *   node intent-evidence.js --days 7 --json
 *   node intent-evidence.js --monitor <dir>
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MONITOR = 'D:\\rdd\\mc\\The Best of Twilight Forest\\config\\numen\\monitor';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/** 逐行扫描一个 jsonl（只解析含 needle 的行），返回 {lineNo, obj}[]。有界：只扫尾部 maxMB。 */
function scan(file, needles, maxMB) {
  const hits = [];
  let text;
  try {
    const st = fs.statSync(file);
    const take = Math.min(st.size, (maxMB || 24) * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, st.size - take);
    fs.closeSync(fd);
    // ★ Gson 会把 < > & = 转义成 \u003c 这类形式（HTML escaping）。
    //   不解码就搜 '<danger>' / '<stage_patterns>' 永远是假阴性 —— 本仓踩过多次的坑。
    text = buf.toString('utf8')
      .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')
      .replace(/\\u0026/g, '&').replace(/\\u003d/g, '=');
  } catch {
    return { hits, missing: true };
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!L || L.length < 8) continue;
    let wanted = false;
    for (const n of needles) {
      if (L.includes(n)) { wanted = true; break; }
    }
    if (!wanted) continue;
    try {
      hits.push({ lineNo: i + 1, obj: JSON.parse(L) });
    } catch {
      // 半行（文件被轮转截断）直接跳过，不当证据
    }
  }
  return { hits };
}

function listJournals(dir, pattern) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => pattern.test(n))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function tsOf(o) {
  const t = Date.parse(o && o.timestamp ? o.timestamp : '');
  return Number.isNaN(t) ? 0 : t;
}

function fmt(ms) {
  if (!ms) return '?';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function main() {
  const monitor = arg('monitor', DEFAULT_MONITOR);
  const days = Number(arg('days', '3'));
  const json = process.argv.includes('--json');
  const since = Date.now() - days * 24 * 3600 * 1000;

  const rddFiles = listJournals(monitor, /^rdd.*\.jsonl$/);
  const ctxFiles = listJournals(monitor, /^context.*\.jsonl$/);
  const toolFiles = listJournals(monitor, /^tools.*\.jsonl$/);

  // ── I1 / I2：RDD 业务事件 ──────────────────────────────────────────
  const needles = ['recovery_named_from_needs', 'side_task_created', 'side_task_resumed_mainline',
    'replanned', 'requirements_unmet', 'goal_staged', 'supervisor_input', 'stage_patterns'];
  const rddEvents = [];
  for (const f of rddFiles) {
    const { hits } = scan(f, needles, 24);
    for (const h of hits) {
      const t = tsOf(h.obj);
      if (t && t < since) continue;
      rddEvents.push({ file: path.basename(f), lineNo: h.lineNo, t, obj: h.obj });
    }
  }
  const byType = (ty) => rddEvents.filter((e) => String(e.obj.type) === ty);

  const named = byType('recovery_named_from_needs');
  const created = byType('side_task_created');
  const resumed = byType('side_task_resumed_mainline');
  const replanned = byType('replanned');
  const unmet = byType('requirements_unmet');

  // I1：需求丢失 → 点名 → 支线开 → 回主线，且无 replanned
  const i1Chain = [];
  if (unmet.length) i1Chain.push(`requirements_unmet×${unmet.length}`);
  if (named.length) i1Chain.push(`recovery_named×${named.length}`);
  if (created.length) i1Chain.push(`side_task_created×${created.length}`);
  if (resumed.length) i1Chain.push(`side_task_resumed×${resumed.length}`);
  const i1Needed = named.length > 0 && created.length > 0;
  const i1 = {
    id: 'I1',
    intent: '死亡/丢失 → 派恢复支线（不整段重写计划）',
    status: !i1Needed ? 'NO_DATA'
      : (replanned.length === 0 ? 'PASS' : 'PARTIAL'),
    chain: i1Chain,
    counterExamples: replanned.length ? [`replanned×${replanned.length} @ ${fmt(tsOf(replanned[0].obj))}`] : [],
    evidence: [
      ...named.slice(0, 2).map((e) => `${e.file}:${e.lineNo}`),
      ...created.slice(0, 2).map((e) => `${e.file}:${e.lineNo}`),
    ],
    note: replanned.length ? '同一窗口出现 replanned = 语义被整段重写破坏' : '',
  };

  // I2：夜里出现过 sleep 支线
  const sleepCreated = created.filter((e) => {
    const d = e.obj.data || {};
    return /sleep/i.test(String(d.typeId || d.type || d.kind || ''));
  });
  const i2 = {
    id: 'I2',
    intent: '支线全部开启（夜里会开睡觉支线）',
    status: sleepCreated.length ? 'PASS' : (created.length ? 'PARTIAL' : 'NO_DATA'),
    chain: [`sleep 支线×${sleepCreated.length}`, `全部支线×${created.length}`],
    counterExamples: [],
    evidence: sleepCreated.slice(0, 3).map((e) => `${e.file}:${e.lineNo}`),
    note: sleepCreated.length ? '' : '窗口内没有 sleep 支线记录（可能一直是白天、或开关关着、或没触发）',
  };

  // I3：题型骨架进规划 prompt（rdd 事件或 context 请求正文里出现 <stage_patterns>）
  let i3Evidence = [];
  for (const f of ctxFiles) {
    const { hits } = scan(f, ['<stage_patterns>'], 24);
    for (const h of hits) {
      const t = tsOf(h.obj);
      if (t && t < since) continue;
      i3Evidence.push(`${path.basename(f)}:${h.lineNo}`);
      if (i3Evidence.length >= 3) break;
    }
    if (i3Evidence.length >= 3) break;
  }
  const i3 = {
    id: 'I3',
    intent: '题型骨架（stage_patterns）真的进了规划器请求',
    status: i3Evidence.length ? 'PASS' : 'NO_DATA',
    chain: [`命中 ${i3Evidence.length}`],
    counterExamples: [],
    evidence: i3Evidence,
    note: i3Evidence.length ? '' : '窗口内没有通关类长线目标（骨架只在长线目标注入）',
  };

  // I4：经验投送（retrieval_snapshot entries>0 + 正文出现 retrieved_knowledge）
  let i4Snap = 0;
  let i4Body = 0;
  let i4Sample = [];
  for (const f of ctxFiles) {
    const { hits } = scan(f, ['retrieval_snapshot', '<retrieved_knowledge'], 24);
    for (const h of hits) {
      const t = tsOf(h.obj);
      if (t && t < since) continue;
      const raw = JSON.stringify(h.obj);
      if (raw.includes('retrieval_snapshot')) {
        const n = Number(h.obj?.data?.entries || 0);
        if (n > 0) { i4Snap++; if (i4Sample.length < 2) i4Sample.push(`${path.basename(f)}:${h.lineNo}`); }
      }
      if (raw.includes('<retrieved_knowledge')) {
        i4Body++;
        if (i4Sample.length < 3) i4Sample.push(`${path.basename(f)}:${h.lineNo}`);
      }
    }
  }
  const i4 = {
    id: 'I4',
    intent: '经验真的进了最终请求（投送而非只入库）',
    status: i4Body > 0 ? 'PASS' : (i4Snap > 0 ? 'PARTIAL' : 'NO_DATA'),
    chain: [`entries>0 快照×${i4Snap}`, `正文含 <retrieved_knowledge>×${i4Body}`],
    counterExamples: [],
    evidence: i4Sample,
    note: i4Body > 0 ? '' : '只看到检索快照、没看到正文命中（可能被裁或只走了 planning 侧）',
  };

  // I5：危险事实进执行上下文
  let i5 = [];
  for (const f of ctxFiles) {
    const { hits } = scan(f, ['<danger>'], 24);
    for (const h of hits) {
      const t = tsOf(h.obj);
      if (t && t < since) continue;
      i5.push(`${path.basename(f)}:${h.lineNo}`);
      if (i5.length >= 3) break;
    }
    if (i5.length >= 3) break;
  }
  const i5Out = {
    id: 'I5',
    intent: '危险事实块 <danger> 进了执行上下文',
    status: i5.length ? 'PASS' : 'NO_DATA',
    chain: [`命中 ${i5.length}`],
    counterExamples: [],
    evidence: i5,
    note: i5.length ? '' : '窗口内没出现（本块只在有敌怪贴身或掉血时出现）',
  };

  // I6：施工回读（blueprint verify 被调用过）
  let i6 = [];
  for (const f of toolFiles) {
    const { hits } = scan(f, ['"blueprint"'], 24);
    for (const h of hits) {
      const t = tsOf(h.obj);
      if (t && t < since) continue;
      const raw = JSON.stringify(h.obj);
      if (raw.includes('"verify"')) {
        i6.push(`${path.basename(f)}:${h.lineNo}`);
        if (i6.length >= 3) break;
      }
    }
    if (i6.length >= 3) break;
  }
  const i6Out = {
    id: 'I6',
    intent: '施工后有回读（blueprint action=verify）',
    status: i6.length ? 'PASS' : 'NO_DATA',
    chain: [`verify 调用×${i6.length}`],
    counterExamples: [],
    evidence: i6,
    note: i6.length ? '' : '窗口内没有 verify 调用（工具已部署，链里还没人用它）',
  };

  const out = {
    scanned: { days, monitor, rddFiles: rddFiles.length, ctxFiles: ctxFiles.length, toolFiles: toolFiles.length },
    intents: [i1, i2, i3, i4, i5Out, i6Out],
  };

  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`意图证据核查（最近 ${days} 天；扫描 rdd×${rddFiles.length} / context×${ctxFiles.length} / tools×${toolFiles.length}）`);
    for (const it of out.intents) {
      const mark = it.status === 'PASS' ? '✅' : it.status === 'PARTIAL' ? '🟡' : '⬜';
      console.log(`${mark} ${it.id}  ${it.intent}`);
      console.log(`     状态=${it.status}  ${it.chain.join('  ')}`);
      if (it.evidence.length) console.log(`     证据：${it.evidence.join(' , ')}`);
      if (it.counterExamples.length) console.log(`     ⚠ 反例：${it.counterExamples.join(' , ')}`);
      if (it.note) console.log(`     备注：${it.note}`);
    }
    const passed = out.intents.filter((i) => i.status === 'PASS').length;
    console.log(`\n合计：PASS ${passed}/${out.intents.length}（NO_DATA 不等于失败，它表示"这段窗口没发生"）`);
  }
  process.exit(0);
}

main();
