#!/usr/bin/env node
'use strict';
/**
 * harness-run.js —— 多模型协同 + 实机验证闭环的离线入口（M1 骨架）
 *
 *   node multimodel/bin/harness-run.js index
 *   node multimodel/bin/harness-run.js validate <card.yaml>
 *   node multimodel/bin/harness-run.js plan <card.yaml> [--runtime mock]
 *   node multimodel/bin/harness-run.js scenarios
 *   node multimodel/bin/harness-run.js mock-run --scenario <id> [--runs <dir>] [--json]
 *   node multimodel/bin/harness-run.js mock-run <card.yaml> --scenario happy
 *   node multimodel/bin/harness-run.js runs [--runs <dir>]
 *   node multimodel/bin/harness-run.js report <runId> [--runs <dir>]
 *   node multimodel/bin/harness-run.js selftest [--runs <dir>]
 *
 * 退出码：0 正常 / 1 结果与预期不符 / 2 用法或输入错 / 3 环境错
 *
 * ★ 默认不读、默认不跑。这是「用户不在时才可能用」的那条线：
 *   它不接游戏、不接 DSH、不改 live。详见 multimodel/README.md。
 */

const fs = require('fs');
const path = require('path');

const MMM = path.resolve(__dirname, '..');
const lib = (n) => require(path.join(MMM, 'lib', n));

const { loadCard } = lib('taskcard.js');
const { loadCatalog, CapabilityRegistry, STATES } = lib('capabilities.js');
const { loadPolicies } = lib('router.js');
const { runScenario, planCard } = lib('coordinator.js');
const { RunStore } = lib('runstore.js');
const { SCENARIOS, getScenario } = require(path.join(MMM, 'scenarios.js'));

function arg(name, dflt) {
  const a = process.argv;
  const i = a.indexOf(name);
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : dflt;
}
const has = (name) => process.argv.includes(name);

function cardContext() {
  const catalog = loadCatalog();
  const policies = loadPolicies();
  return {
    predicates: catalog.predicates,
    roles: policies.routing.roles,
    budgets: policies.budgets,
    fixturesDir: path.join(MMM, 'fixtures'),
  };
}

function cmdValidate(file) {
  if (!file) { console.error('用法：validate <card.yaml>'); return 2; }
  try {
    const info = loadCard(file, cardContext());
    console.log(`✔ 合法：${info.card.metadata.id} v${info.card.metadata.version}`);
    console.log(`  sourceSha256    ${info.lock.sourceSha256}`);
    console.log(`  canonicalSha256 ${info.lock.canonicalSha256}`);
    console.log(`  断言 ${info.card.spec.assertions.length} · 不变量 ${(info.card.spec.invariants || []).length} · 必需能力 ${info.card.spec.requires.length}`);
    return 0;
  } catch (e) {
    console.error(`✘ ${e.code || 'ERROR'}：${e.message}`);
    for (const d of e.details || []) console.error(`   · ${d}`);
    return 2;
  }
}

function buildRuntimeCaps() {
  const catalog = loadCatalog();
  const caps = new CapabilityRegistry(catalog);
  // --runtime mock：把非 disabled 的能力当作「探针通过」，用来单独看「还有哪些是真缺口」
  for (const c of caps.all()) {
    if (c.state === STATES.DISABLED) continue;
    caps.discover(c.capabilityId, { by: 'cli --runtime mock' });
    caps.markProbe(c.capabilityId, true, 'cli mock probe');
  }
  return caps;
}

function cmdPlan(file) {
  if (!file) { console.error('用法：plan <card.yaml> [--runtime mock]'); return 2; }
  let info;
  try { info = loadCard(file, cardContext()); }
  catch (e) { console.error(`✘ ${e.code || 'ERROR'}：${e.message}`); for (const d of e.details || []) console.error(`   · ${d}`); return 2; }
  const runtime = arg('--runtime', 'declared');
  const caps = runtime === 'mock' ? buildRuntimeCaps() : new CapabilityRegistry(loadCatalog());
  const plan = planCard(info.card, { capabilities: caps, minState: runtime === 'mock' ? STATES.HEALTHY : STATES.HEALTHY });
  console.log(`测试卡 ${info.card.metadata.id} v${info.card.metadata.version}`);
  console.log(`运行时 ${runtime}`);
  console.log(`必需能力：`);
  for (const id of plan.requires) console.log(`  - ${id} → ${caps.stateOf(id)}`);
  if (plan.ok) {
    console.log('✔ 可以开跑（能力对账通过）');
    if (runtime === 'mock') console.log('★ 注意：这是 mock 探针的结论，只说明「逻辑上缺什么」，不代表实机可用（verified_in_game 仍为 0）。');
    return 0;
  }
  console.log('✘ 开跑前 BLOCKED，逐条缺口：');
  for (const r of plan.blocked.reasons) console.log(`  · [${r.code}] ${r.detail}`);
  if (runtime !== 'mock') console.log('提示：加 --runtime mock 只用来分辨「真缺口」与「探针没跑」；不许拿 mock 结果当实机可用。');
  return 1;
}

function makeStore() {
  return new RunStore(arg('--runs'));
}

async function cmdMockRun() {
  const positional = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
  const scenarioId = arg('--scenario', null);
  let scenario;
  if (scenarioId) {
    scenario = getScenario(scenarioId);
    if (positional && positional !== scenarioId) {
      // 允许用别的卡复跑同一注入形状：只替换 card
      scenario.card = path.resolve(positional);
    }
  } else if (positional) {
    scenario = getScenario('happy');
    scenario.card = path.resolve(positional);
    scenario.id = 'adhoc';
    scenario.title = `临时卡 ${path.basename(positional)}`;
  } else {
    console.error('用法：mock-run --scenario <id>  或  mock-run <card.yaml> --scenario happy');
    return 2;
  }
  const store = makeStore();
  const { report, runId } = await runScenario({ scenario, store });
  if (has('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`run ${runId}（mode=${report.mode}）`);
    console.log(`verdict=${report.verdict}  task=${report.taskVerdict || '-'}  flags=${(report.flags || []).join(',') || '无'}`);
    for (const r of report.reasons || []) console.log(`  · [${r.code}] ${r.detail}`);
    console.log(`报告：${path.join(store.dir(runId), 'report.md')}`);
  }
  return 0;
}

async function cmdSelftest() {
  const store = makeStore();
  const ids = Object.keys(SCENARIOS);
  const rows = [];
  let bad = 0;
  for (const id of ids) {
    const scenario = getScenario(id);
    const { report, runId } = await runScenario({ scenario, store });
    const exp = scenario.expect || {};
    const problems = [];
    if (exp.verdict && report.verdict !== exp.verdict) problems.push(`verdict 期望 ${exp.verdict} 实际 ${report.verdict}`);
    if (exp.taskVerdict && report.taskVerdict !== exp.taskVerdict) problems.push(`taskVerdict 期望 ${exp.taskVerdict} 实际 ${report.taskVerdict}`);
    for (const f of exp.flagsInclude || []) if (!(report.flags || []).includes(f)) problems.push(`缺 flag ${f}`);
    if (exp.noFallbackCall && (report.calls || []).some((c) => c.role === 'fallback')) problems.push('不该调用 fallback 却调用了');
    if (exp.fallbackCalls !== undefined) {
      const n = (report.calls || []).filter((c) => c.role === 'fallback' && c.invoked).length;
      if (n !== exp.fallbackCalls) problems.push(`fallback 实际发出调用数期望 ${exp.fallbackCalls} 实际 ${n}`);
    }
    // ★ 任何 PASS 都必须同时满足「全部必需断言为真 + 证据门通过」—— 假绿的机器防线
    if (report.verdict === 'PASS') {
      const req = (report.assertions || []).filter((a) => a.required);
      if (!req.every((a) => a.result === true)) problems.push('PASS 但存在未成立的必需断言（假绿）');
      if (!(report.evidence || {}).ok) problems.push('PASS 但证据门没过（假绿）');
      if ((report.flags || []).length) problems.push('PASS 却带 flags：' + report.flags.join(','));
    }
    if (problems.length) bad++;
    rows.push({ id, verdict: report.verdict, expect: exp.verdict || '-', ok: problems.length === 0, problems, runId });
  }
  console.log('══════════ multimodel · 离线场景矩阵（对照设计草案 §11）══════════');
  for (const r of rows) {
    console.log(`  ${r.ok ? '✔' : '✘'} ${r.id.padEnd(8)} verdict=${r.verdict.padEnd(13)} 期望=${r.expect}`);
    for (const p of r.problems) console.log(`        ↳ ${p}`);
  }
  console.log('');
  console.log(`  场景 ${rows.length} 个 · 不符 ${bad} 个`);
  console.log(`  运行数据根：${store.root}`);
  console.log(bad === 0
    ? '  VERDICT=MOCK_MATRIX_OK（注意：这是离线逻辑验证，不是实机验证）'
    : '  VERDICT=MOCK_MATRIX_FAIL（判定逻辑与设计不一致 —— 先修逻辑，别去改期望）');
  return bad === 0 ? 0 : 1;
}

function cmdScenarios() {
  for (const [id, s] of Object.entries(SCENARIOS)) {
    console.log(`  ${id.padEnd(8)} ${s.title}`);
    console.log(`           卡：${path.basename(s.card)}  期望：${(s.expect || {}).verdict || '-'}`);
  }
  return 0;
}

function cmdRuns() {
  const store = makeStore();
  const runs = store.listRuns();
  console.log(`运行数据根：${store.root}（${runs.length} 个 run）`);
  for (const r of runs.slice(0, 30)) console.log(`  ${r.runId}  ${r.verdict || '-'}  ${r.cardId || ''}`);
  return 0;
}

function cmdReport(runId) {
  if (!runId) { console.error('用法：report <runId> [--runs <dir>]'); return 2; }
  const store = makeStore();
  const file = path.join(store.dir(runId), 'report.md');
  if (!fs.existsSync(file)) { console.error(`没有这个 run 的报告：${file}`); return 2; }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  return 0;
}

function printIndex() {
  const file = path.join(MMM, 'README.md');
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  return 0;
}

async function main() {
  const cmd = process.argv[2] || 'index';
  switch (cmd) {
    case 'index': return printIndex();
    case 'validate': return cmdValidate(process.argv[3]);
    case 'plan': return cmdPlan(process.argv[3]);
    case 'scenarios': return cmdScenarios();
    case 'mock-run': return cmdMockRun(process.argv[3]);
    case 'selftest': return cmdSelftest();
    case 'runs': return cmdRuns();
    case 'report': return cmdReport(process.argv[3]);
    case 'help':
    case '--help':
      process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, '').replace(/^ \* ?/gm, ''));
      return 0;
    default:
      console.error(`未知命令 ${cmd}（index / validate / plan / scenarios / mock-run / selftest / runs / report）`);
      return 2;
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('harness-run 自身崩了（这不是判定结果，是 bug）：' + (e && e.stack || e));
  process.exit(3);
});
