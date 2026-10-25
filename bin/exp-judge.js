#!/usr/bin/env node
'use strict';
/**
 * exp-judge.js —— 游戏内实验的机械裁判（79号 W1，2026-10-25 首版）
 *
 * 只读证据、只出裁决：不调模型、不采信任何"完成了"的口头声明，不看聊天语气。
 * 每一条断言输出 PASS / FAIL / NOT_EXERCISED / INCONCLUSIVE；整体 PASS 必须全部必需项 PASS。
 *
 * 用法：
 *   node exp-judge.js <runDir>        # 对一次 run 出裁决（写 verdict.json + verdict.md）
 *   node exp-judge.js --selftest      # 离线自测：三种假绿必须被拒 + 两条诚实路径
 *
 * 判据来源：experiments/smoke-r1.contract.json（运行前冻结；运行后改契约=作废）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BT = String.fromCharCode(96); // 反引号：避免生成脚本的模板字符串冲突
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readMaybe(p) { try { return fs.readFileSync(p); } catch { return null; } }
function lines(buf) { return buf ? buf.toString('utf8').split('\n').filter(Boolean) : []; }
function num(re, s) { const m = s.match(re); return m ? parseInt(m[1], 10) : null; }
function oakLogCount(raw) {
  if (!raw) return null;
  try {
    const j = JSON.parse(String(raw));
    const items = j && j.data && j.data.items;
    if (items && typeof items === 'object') {
      return Number(items['minecraft:oak_log'] || 0);
    }
  } catch { /* fall through to text scan */ }
  for (const p of [/"minecraft:oak_log"\s*:\s*(\d+)/, /"oak_log"\s*:\s*(\d+)/, /oak_log[^0-9]{0,80}?(\d+)/]) {
    const m = String(raw).match(p); if (m) return parseInt(m[1], 10);
  }
  return null;
}

const ACTION_TOOLS = ['mine', 'craft', 'goto', 'attack', 'interact_at', 'place', 'build', 'collect_items', 'acx_execute'];
const CLAIM_WORDS = ['完成', '搞定', '拿到了', '采集到', '做好了', '收到', '已交付', '砍到', '装进背包', '放进背包'];
const realActionCalls = (toolLines) => toolLines.filter((l) => l.includes('"type":"tool_call"') && ACTION_TOOLS.some((t) => l.includes('"tool":"' + t + '"')));
const claimIn = (s) => CLAIM_WORDS.some((w) => s.includes(w));

function evaluate(runDir) {
  const envBuf = readMaybe(path.join(runDir, 'envelope.json'));
  if (!envBuf) return { overall: 'INCONCLUSIVE', reason: 'envelope.json missing', assertions: [] };
  const env = JSON.parse(envBuf.toString('utf8'));
  const ev = (f) => readMaybe(path.join(runDir, 'evidence', f));
  const contractBuf = readMaybe(env.contract.path);
  const contractChanged = !contractBuf || sha256(contractBuf) !== env.contract.sha256;

  const A = [];
  const add = (id, verdict, detail, evidence) => A.push({ id, verdict, detail, evidence: evidence || [] });

  // ---------- S1 LOAD ----------
  {
    const boot = ev('boot.log');
    const jarsP = env.jarsAtPrepare || [];
    const jarsL = env.jarsAtLaunch || [];
    const numen = jarsP.filter((j) => /numen/i.test(j.file));
    if (!boot || !jarsP.length || !jarsL.length) {
      add('S1', 'INCONCLUSIVE', '缺 boot.log 或 jar 清单', ['evidence/boot.log', 'evidence/jars.json']);
    } else {
      const text = boot.toString('latin1');
      const found = (text.match(/Found mod file "([^"]+)"/g) || []).map((s) => s.replace(/^Found mod file "/, '').replace(/"$/, ''));
      const missing = numen.filter((j) => !found.includes(j.file));
      const swap = jarsP.filter((j) => { const l = jarsL.find((x) => x.file === j.file); return !l || l.sha256 !== j.sha256; });
      const dupWarn = /duplicate mods|Attempted to load.*twice|stale jar/i.test(text);
      const ok = numen.length > 0 && missing.length === 0 && swap.length === 0 && !dupWarn;
      add('S1', ok ? 'PASS' : 'FAIL',
        ok ? ('jar 级启动身份一致：' + numen.length + ' 个 numen jar 均被 NeoForge 发现，hash 前后未变')
           : ('启动身份不符：未发现=' + missing.map((x) => x.file).join(',') + '；启动前后 hash 变化=' + swap.map((x) => x.file).join(',') + (dupWarn ? '；日志含 duplicate/stale 警告' : '')),
        ['evidence/boot.log', 'evidence/jars.json']);
    }
  }

  // ---------- S2 TRIM ----------
  {
    const ctx = lines(ev('context.jsonl'));
    const gates = ctx.filter((l) => l.includes('"type":"budget_gate"'));
    const trims = gates.map((l) => num(/"trimmed":(\d+)/, l)).filter((n) => n !== null && n > 0);
    const toolsCounts = new Set(lines(ev('ai.jsonl')).filter((l) => l.includes('"type":"turn"')).map((l) => num(/"tools":(\d+)/, l)).filter((n) => n !== null));
    if (!ctx.length) add('S2', 'NOT_EXERCISED', '无 context.jsonl 证据', []);
    else if (trims.length === 0) add('S2', 'NOT_EXERCISED', '窗口内无 trimmed>0 的 budget_gate（未触发生产裁剪）', ['evidence/context.jsonl']);
    else if (toolsCounts.size > 1) add('S2', 'FAIL', '窗口内 tools 字段变化（callable 集不稳定）: ' + [...toolsCounts].join(','), ['evidence/ai.jsonl']);
    else add('S2', 'PASS', '真实生产裁剪 ' + trims.length + ' 次（trimmed>0），tools 计数恒定=' + [...toolsCounts].join(','), ['evidence/context.jsonl', 'evidence/ai.jsonl']);
  }

  // ---------- S3 ACT ----------
  {
    const invAfterRaw = ev('inventory-after.json') ? ev('inventory-after.json').toString('utf8') : '';
    const beforeRaw = ev('inventory-before.json') ? ev('inventory-before.json').toString('utf8') : '';
    const before = beforeRaw ? oakLogCount(beforeRaw) : (env.inventory ? env.inventory.oakLogBefore : null);
    const after = oakLogCount(invAfterRaw);
    const toolLines = lines(ev('tools.jsonl'));
    const realCalls = realActionCalls(toolLines);
    const aiLines = lines(ev('ai.jsonl'));
    const turns = new Set(aiLines.filter((l) => l.includes('"type":"turn"')).map((l) => num(/"turn":(\d+)/, l)).filter((n) => n !== null));
    const assistantText = aiLines.filter((l) => l.includes('"type":"assistant"')).join('\n');
    const chainBuf = ev('taskchain-final.json');
    let chainStatus = null, chainDesc = null;
    if (chainBuf) { try { const c = JSON.parse(chainBuf.toString('utf8')); chainStatus = c.data && c.data.taskChain ? c.data.taskChain.primaryStatus : null; chainDesc = c.data && c.data.taskChain ? c.data.taskChain.description : null; } catch {} }
    const evLines = lines(ev('events.jsonl'));
    const finOk = evLines.some((l) => l.includes('"type":"task_finished"')
      && /"status":"(done|success|completed)"/i.test(l)
      && /oak_log|原木/i.test(l));
    const chainRelevant = chainStatus === 'COMPLETED' && chainDesc && /(oak|原木|木材|log)/i.test(chainDesc);
    const claimDone = finOk || chainRelevant || claimIn(assistantText);
    const wall = (env.timings && env.timings.watchSeconds) || null;
    const deadlineOk = turns.size <= 12 && wall !== null && wall <= 600;

    if (before === null || after === null) {
      add('S3', 'INCONCLUSIVE', '缺背包前后证据（before=' + before + ', after=' + after + '）', ['evidence/inventory-before.json', 'evidence/inventory-after.json']);
    } else {
      const delta = after - before;
      const factsOk = delta >= 4 && realCalls.length >= 1;
      const aligned = claimDone === (delta >= 4);
      let verdict, detail;
      if (!deadlineOk) { verdict = 'FAIL'; detail = '超预算：决策轮 ' + turns.size + '（≤12）、墙钟 ' + wall + 's（≤600）'; }
      else if (!factsOk) { verdict = 'FAIL'; detail = '世界事实不达标：oak_log ' + before + '→' + after + '（增量 ' + delta + '，需≥4），真实动作调用 ' + realCalls.length + '；' + (claimDone ? '且已声明完成=虚报' : '未声明完成'); }
      else if (!aligned) { verdict = 'FAIL'; detail = '声明与事实不一致：事实增量 ' + delta + ' 但最终未声明完成'; }
      else { verdict = 'PASS'; detail = 'oak_log ' + before + '→' + after + '（Δ' + delta + '），真实动作 ' + realCalls.length + ' 次，决策轮 ' + turns.size + '，墙钟 ' + wall + 's，声明与事实一致'; }
      add('S3', verdict, detail, ['evidence/inventory-before.json', 'evidence/inventory-after.json', 'evidence/tools.jsonl', 'evidence/ai.jsonl']);
    }
  }

  // ---------- S4 STOP ----------
  {
    const stop = env.stop || {};
    const post = stop.postStopRequests;
    const exited = stop.javaExited;
    const done = env.phase === 'done';
    if (post === undefined || exited === undefined) add('S4', 'INCONCLUSIVE', '缺停止期证据（run 未跑完？）', []);
    else if (post > 0) add('S4', 'FAIL', '停止后仍有 ' + post + ' 条新 llm_request', ['evidence/context.jsonl']);
    else if (!exited) add('S4', 'FAIL', 'java 未退出（实例仍在运行=污染生产状态）', []);
    else if (!done) add('S4', 'FAIL', 'runner 未走到 done（复位/归档可能缺）phase=' + env.phase, []);
    else add('S4', 'PASS', '停止后 0 条新请求，java 已退出，证据已归档，状态已复位', ['envelope.json', 'evidence/']);
  }

  // ---------- overall ----------
  const required = ['S1', 'S3', 'S4'];
  const get = (id) => A.find((x) => x.id === id);
  const anyFail = required.some((id) => get(id) && get(id).verdict === 'FAIL');
  const anyInc = required.some((id) => !get(id) || get(id).verdict === 'INCONCLUSIVE');
  let overall;
  if (contractChanged) overall = 'INCONCLUSIVE';
  else if (env.phase !== 'done') overall = 'INCONCLUSIVE';
  else if (anyFail) overall = 'FAIL';
  else if (anyInc) overall = 'INCONCLUSIVE';
  else overall = get('S2').verdict === 'PASS' ? 'PASS' : 'PASS_WITH_GAPS';

  return {
    runId: env.runId || path.basename(runDir),
    scenarioId: env.contract.scenarioId,
    contractRevision: env.contract.revision,
    contractSha256: env.contract.sha256,
    contractChanged,
    overall,
    assertions: A,
    notes: contractChanged ? ['契约文件在冻结后被改动（hash 不符）→ 本次裁决作废'] : [],
    judgedAt: new Date().toISOString(),
  };
}

function renderMd(v) {
  const icon = { PASS: '✅', FAIL: '❌', NOT_EXERCISED: '⬜', INCONCLUSIVE: '❓' };
  const out = [];
  out.push('# 裁决 · ' + v.runId);
  out.push('');
  out.push('> ' + v.scenarioId + ' / ' + v.contractRevision + ' ｜ **' + v.overall + '** ｜ ' + v.judgedAt);
  out.push('');
  out.push('| 断言 | 结果 | 说明 |');
  out.push('|---|---|---|');
  for (const a of v.assertions) out.push('| ' + a.id + ' | ' + (icon[a.verdict] || '') + ' ' + a.verdict + ' | ' + a.detail + ' |');
  if (v.notes && v.notes.length) { out.push(''); out.push('> ⚠️ ' + v.notes.join('；')); }
  out.push('');
  out.push('证据目录：' + BT + v.runId + '/evidence/' + BT + '（boot.log、jars.json、inventory-*.json、tools/context/ai.jsonl 窗口切片）');
  return out.join('\n') + '\n';
}

function judgeRun(runDir, quiet) {
  const v = evaluate(runDir);
  fs.writeFileSync(path.join(runDir, 'verdict.json'), JSON.stringify(v, null, 2));
  fs.writeFileSync(path.join(runDir, 'verdict.md'), renderMd(v));
  if (!quiet) { console.log(renderMd(v)); }
  return v;
}

// ---------- selftest: 三种假绿必须被拒 ----------
function selftest() {
  const root = path.join(__dirname, '..', 'runs', '_selftest-' + Date.now());
  fs.mkdirSync(root, { recursive: true });
  const contractPath = path.join(__dirname, '..', 'experiments', 'smoke-r1.contract.json');
  const contractSha = sha256(fs.readFileSync(contractPath));

  function makeRun(name, mut) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    const env = {
      runId: name, phase: 'done', contract: { path: contractPath, sha256: contractSha, revision: 'SMOKE-r1', scenarioId: 'live-log-delivery' },
      timings: { watchSeconds: 120 },
      inventory: { oakLogBefore: 0 },
      jarsAtPrepare: [{ file: 'numen-neoforge-1.21.1-0.1.3-dev.jar', sha256: 'aaa' }],
      jarsAtLaunch: [{ file: 'numen-neoforge-1.21.1-0.1.3-dev.jar', sha256: 'aaa' }],
      stop: { postStopRequests: 0, javaExited: true },
      master: { world: 'exp-x', worldPath: 'x' },
    };
    fs.writeFileSync(path.join(dir, 'envelope.json'), JSON.stringify(env, null, 2));
    const W = (f, c) => fs.writeFileSync(path.join(dir, 'evidence', f), c);
    W('boot.log', 'Found mod file "numen-neoforge-1.21.1-0.1.3-dev.jar" [locator: mods]\nFound mod file "numen-plugin-acx-1.21.1-0.1.3-dev.jar"\n');
    W('jars.json', JSON.stringify(env.jarsAtPrepare));
    W('inventory-before.json', '{"items":{"minecraft:oak_log":0}}');
    W('inventory-after.json', '{"items":{"minecraft:oak_log":4}}');
    W('tools.jsonl', '{"type":"tool_call","data":{"tool":"mine"}}\n{"type":"tool_call","data":{"tool":"goto"}}\n');
    W('ai.jsonl', '{"type":"turn","data":{"turn":1,"tools":113}}\n{"type":"assistant","data":{"text":"拿到了4个原木，完成了。"}}\n');
    W('context.jsonl', '{"type":"budget_gate","data":{"trimmed":167979}}\n');
    W('taskchain-final.json', JSON.stringify({ data: { taskChain: { primaryStatus: 'COMPLETED', description: '采集4个原木' } } }));
    if (mut) mut(env, W, dir);
    return { dir, env };
  }

  const cases = [];
  {
    const { dir } = makeRun('good');
    cases.push({ name: 'good（事实+声明一致）', dir, expect: 'PASS' });
  }
  {
    const { dir } = makeRun('wrong-load', (env, W, d) => {
      env.jarsAtLaunch = [{ file: 'numen-neoforge-1.21.1-0.1.3-dev.jar', sha256: 'BBB' }];
      fs.writeFileSync(path.join(d, 'envelope.json'), JSON.stringify(env, null, 2));
    });
    cases.push({ name: '假绿-加载错（hash 变化）', dir, expect: 'FAIL', expectAssertion: ['S1', 'FAIL'] });
  }
  {
    const { dir } = makeRun('missing-trim', (env, W) => { W('context.jsonl', '{"type":"budget_gate","data":{"trimmed":0}}\n'); });
    cases.push({ name: '假绿-缺裁剪事件', dir, expect: 'PASS_WITH_GAPS', expectAssertion: ['S2', 'NOT_EXERCISED'] });
  }
  {
    const { dir } = makeRun('claim-only', (env, W) => { W('inventory-after.json', '{"items":{"minecraft:oak_log":0}}'); });
    cases.push({ name: '假绿-只回成功无产物', dir, expect: 'FAIL', expectAssertion: ['S3', 'FAIL'] });
  }
  {
    const { dir } = makeRun('missing-evidence', (env, W, d) => { fs.rmSync(path.join(d, 'evidence', 'inventory-after.json')); });
    cases.push({ name: '缺证据（应 INCONCLUSIVE 不冒充）', dir, expect: 'INCONCLUSIVE', expectAssertion: ['S3', 'INCONCLUSIVE'] });
  }

  let pass = 0;
  for (const c of cases) {
    const v = judgeRun(c.dir, true);
    let ok = v.overall === c.expect;
    let detail = 'overall=' + v.overall + '（期望 ' + c.expect + '）';
    if (c.expectAssertion) {
      const a = v.assertions.find((x) => x.id === c.expectAssertion[0]);
      const aok = a && a.verdict === c.expectAssertion[1];
      ok = ok && aok;
      detail += '；' + c.expectAssertion[0] + '=' + (a ? a.verdict : 'missing') + '（期望 ' + c.expectAssertion[1] + '）';
    }
    if (ok) pass++;
    console.log((ok ? '  ✅ ' : '  ❌ ') + c.name + ' — ' + detail);
  }
  console.log('\nselftest: ' + pass + '/' + cases.length + ' 通过');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(pass === cases.length ? 0 : 1);
}

// ---- CLI ----
const arg = process.argv[2];
if (arg === '--selftest') selftest();
else if (arg) {
  const v = judgeRun(path.resolve(arg), false);
  process.exit(v.overall === 'PASS' || v.overall === 'PASS_WITH_GAPS' ? 0 : 1);
} else {
  console.log('usage: node exp-judge.js <runDir> | --selftest');
  process.exit(2);
}