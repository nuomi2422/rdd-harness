#!/usr/bin/env node
'use strict';
/**
 * gate-usage.js —— 三道门禁的使用痕迹（薄）
 *
 * 用法：
 *   node bin/gate-usage.js record --gate code|preflight|postflight|selftest --result PASS|WARN|BLOCK|FAIL [--note "..."]
 *   node bin/gate-usage.js status [--json]
 *
 * 痕迹文件：D:\rdd\.harness\audit\gate-usage.jsonl（append-only）
 * 健康判定：7 天内 PASS/WARN=HEALTHY；BLOCK/FAIL=UNHEALTHY；>7 天=STALE；从未跑=UNUSED。
 */
const fs = require('fs');
const path = require('path');

let REG;
try { REG = require('./lib/registry').load(); } catch { REG = null; }
const R = REG && REG.roots ? REG.roots : { harness: path.resolve(__dirname, '..'), knowledge: 'D:\\rdd\\docs\\rdd-docs\\知识库' };
const LEDGER = 'D:\\rdd\\.harness\\audit\\gate-usage.jsonl';
const STALE_MS = 7 * 24 * 3600 * 1000;

function arg(name, dflt) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }

function codeItems() {
  const k = R.knowledge;
  return [
    ['md', '编码规范', path.join(R.harness, 'standards.md')],
    ['md', '进游戏核心工具', path.join(k, '进游戏验证', '001-进游戏核心工具.md')],
    ['md', '游戏验证规范', path.join(k, '进游戏验证', '002-游戏验证规范及盲点.md')],
    ['md', '实验台', path.join(k, '进游戏验证', '003-实验台-当前世界-坑-怎么验证.md')],
    ['md', '退游戏检查单', path.join(k, '退游戏', '001-退游戏检查单.md')],
    ['md', 'Bug 修复台账', path.join(k, 'Bug修复', 'README.md')],
    ['tool', 'run-mutation.ps1', path.join(R.scripts, 'run-mutation.ps1')],
    ['tool', 'check-runtime-deployment.js', path.join(R.scripts, 'verify-tools', 'check-runtime-deployment.js')],
  ];
}

function checkItems(which) {
  const g = (REG && REG.gates && REG.gates[which]) || {};
  const checks = g.checks || [];
  return checks.map((c) => ['check', (c.id || '?') + ' ' + (c.name || ''), null]);
}

function readLedger() {
  const out = [];
  try {
    for (const line of fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      // ★ 2026-11-06：旧版本 __GATE_MODE 未设时写入的 unknown，按 items 里的 P/Q 推断回真实模式；
      //   只改读时归一化，不回写账本（历史留证）。2026-11-06 起门禁写账一律带 mode，不再产生新的 unknown。
      try { const r = JSON.parse(line); if (r.gate === 'unknown') { const ids = Array.isArray(r.items) ? r.items : []; const hasP = ids.some((i) => String(i)[0] === 'P'); const hasQ = ids.some((i) => String(i)[0] === 'Q'); r.gate = hasP && hasQ ? 'selftest' : (hasQ ? 'postflight' : 'preflight'); } out.push(r); } catch (e) { }
    }
  } catch (e) { }
  return out;
}

function gateStatus(id, name, items, ledger) {
  const mine = ledger.filter((x) => x.gate === id || (x.gate === 'selftest' && (id === 'preflight' || id === 'postflight')));
  const last = mine.length ? mine[mine.length - 1] : null;
  let health = 'UNUSED';
  if (last) {
    const t = Date.parse(last.at);
    if (!Number.isNaN(t) && Date.now() - t > STALE_MS) health = 'STALE';
    else health = (last.result === 'BLOCK' || last.result === 'FAIL') ? 'UNHEALTHY' : 'HEALTHY';
  }
  const used = last && Array.isArray(last.items) ? new Set(last.items) : null;
  return {
    id, name, health,
    lastAt: last ? last.at : null,
    lastResult: last ? last.result : null,
    count: mine.length,
    items: items.map(([kind, label, p]) => ({
      kind, label,
      exists: p ? fs.existsSync(p) : null,
      path: p || null,
      status: (health === 'UNUSED' || !used) ? 'UNUSED' : (used.has(p) || used.has(label) || used.has(String(label).split(' ')[0]) ? health : 'UNUSED'),
    })),
  };
}

const cmd = process.argv[2] || 'status';
if (cmd === 'record') {
  const rec = {
    at: new Date().toISOString(),
    gate: arg('--gate', 'unknown'),
    result: arg('--result', 'UNKNOWN'),
    note: arg('--note', ''),
  };
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n', 'utf8');
  console.log('recorded ' + rec.gate + ' ' + rec.result);
  process.exit(0);
}

const ledger = readLedger();
const out = {
  at: new Date().toISOString(),
  ledger: LEDGER,
  gates: [
    gateStatus('code', '写代码前薄门禁（8 条规则 + 实物）', codeItems(), ledger),
    gateStatus('preflight', '进游戏前 preflight', checkItems('preflight'), ledger),
    gateStatus('postflight', '退游戏后 postflight', checkItems('postflight'), ledger),
    gateStatus('selftest', '门禁自身健康自检（2026-11-06 起记账）', [['check','SELFTEST',null]], ledger),
  ],
};
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const g of out.gates) console.log(g.health.padEnd(10) + ' ' + g.name + '  last=' + (g.lastAt || '-') + '  count=' + g.count);
}
