#!/usr/bin/env node
'use strict';
/*
 * or-free-models.js —— 维护「OpenRouter 只留可用的免费模型」清单
 *
 * 用户 2026-10-21 要求：
 *   「我是说 openrouter 模型太多了，删掉 gpt 和 claude 等用不了的地区限制的」
 *
 * 事实（2026-10-21 实测）：
 *   OpenRouter 共 468 个模型，其中免费（pricing.prompt=0）20 个。
 *   GPT / Claude 本来就不在免费列表里 —— 它们要钱，且地区受限。
 *   真正需要排除的是「免费但地区受限」的：Google（gemma/lyria）、Cohere。
 *
 * 用法：
 *   node or-free-models.js --fetch     # 从 OpenRouter 拉最新免费清单（需要 key）
 *   node or-free-models.js --list      # 看当前清单
 *   node or-free-models.js --verify    # 逐个实测可用性（慢，但最可信）
 *
 * 输出：harness/rdd-harness/openrouter-free-models.json（真源）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OUT = 'D:\\rdd\\harness\\rdd-harness\\openrouter-free-models.json';
const CRED = path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', '.credentials.yaml');

// ★ 地区受限厂商：模型本身免费，但调用会被拒（或用户明确用不了）
//   用户原话「外国的 gpt claude 我也用不了」—— 这里一并排除同族。
const BLOCKED_VENDORS = [
  'openai/', 'anthropic/', 'google/', 'cohere/',
  'meta-llama/', 'x-ai/', 'mistralai/', 'ai21/', 'perplexity/',
];

function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    const raw = fs.readFileSync(CRED, 'utf8');
    const m = raw.match(/^\s+OPENROUTER_API_KEY:\s*(\S+)\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
}

async function api(p, key, opts) {
  const res = await fetch('https://openrouter.ai/api/v1' + p, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + key,
      'User-Agent': 'dsh',
      'Content-Type': 'application/json',
      ...(opts && opts.headers),
    },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function cmdFetch(key) {
  const all = await api('/models', key);
  const free = (all.data || []).filter((m) => {
    const p = m.pricing || {};
    return String(p.prompt) === '0' || Number(p.prompt) === 0;
  });
  const blocked = [];
  const usable = [];
  for (const m of free) {
    const vendor = m.id.split('/')[0] + '/';
    const rec = {
      id: m.id,
      name: m.name,
      contextWindow: m.context_length || null,
      maxOutput: (m.top_provider && m.top_provider.max_completion_tokens) || null,
      vision: Array.isArray(m.architecture && m.architecture.input_modalities)
        ? m.architecture.input_modalities.includes('image') : null,
    };
    if (BLOCKED_VENDORS.some((v) => m.id.startsWith(v))) blocked.push(rec);
    else usable.push(rec);
  }
  const out = {
    fetchedAt: new Date().toISOString(),
    source: 'https://openrouter.ai/api/v1/models',
    note: '只含 pricing.prompt=0 的免费模型；已排除地区受限厂商',
    blockedVendors: BLOCKED_VENDORS,
    totalAllModels: (all.data || []).length,
    totalFree: free.length,
    usableCount: usable.length,
    blockedCount: blocked.length,
    models: usable,
    blocked,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`✔ 已写 ${OUT}`);
  console.log(`   全部 ${out.totalAllModels} 个 → 免费 ${out.totalFree} 个 → 可用 ${usable.length} / 排除 ${blocked.length}`);
  console.log('');
  console.log('可用：');
  for (const m of usable) console.log(`  ✔ ${m.id.padEnd(54)} ctx=${m.contextWindow}${m.vision ? ' 👁' : ''}`);
  console.log('');
  console.log('排除（地区受限）：');
  for (const m of blocked) console.log(`  ✘ ${m.id}`);
  return 0;
}

function cmdList() {
  if (!fs.existsSync(OUT)) { console.error('[env] 还没拉过：先跑 --fetch'); return 3; }
  const j = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  console.log(`清单：${OUT}`);
  console.log(`拉取于 ${j.fetchedAt}　可用 ${j.usableCount} / 排除 ${j.blockedCount}（总免费 ${j.totalFree}）`);
  console.log('');
  for (const m of j.models) console.log(`  ✔ ${m.id.padEnd(54)} ctx=${m.contextWindow}`);
  return 0;
}

async function cmdVerify(key) {
  if (!fs.existsSync(OUT)) { console.error('[env] 先 --fetch'); return 3; }
  const j = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  console.log(`逐个实测 ${j.models.length} 个模型（每个发一条最短请求）…\n`);
  const results = [];
  for (const m of j.models) {
    let ok = false, detail = '';
    const t0 = Date.now();
    try {
      const r = await api('/chat/completions', key, {
        method: 'POST',
        body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 3 }),
      });
      ok = !!(r.choices && r.choices.length);
      detail = ok ? (r.model || m.id) : 'no choices';
    } catch (e) { detail = e.message.slice(0, 120); }
    // ★ 区分「真不可用」和「只对普通 API 拒绝」
    //   403 里带 "only available on agentic harnesses" = 它要求调用方是编程 agent，
    //   **DSH 本身就是 agent**，所以这类在 DSH 里可能能用 —— 不能一刀切剔除。
    const agentOnly = /agentic harness/i.test(detail);
    const rateLimited = /\b429\b/.test(detail);
    results.push({ id: m.id, ok, detail, ms: Date.now() - t0, agentOnly, rateLimited });
    console.log(`  ${ok ? '✔' : '✘'} ${m.id.padEnd(54)} ${((Date.now() - t0) / 1000).toFixed(1)}s ${ok ? '' : detail}`);
  }
  const bad = results.filter((r) => !r.ok);
  j.verifiedAt = new Date().toISOString();
  j.verified = results;
  j.usableCount = results.filter((r) => r.ok).length;
  // ★ 只剔除「真不可用」；agentOnly（只对普通 API 拒绝）保留 —— DSH 是 agent，可能能用
  const keep = results.filter((r) => r.ok || r.agentOnly).map((r) => r.id);
  const agentOnlyIds = results.filter((r) => !r.ok && r.agentOnly).map((r) => r.id);
  j.models = j.models.filter((m) => keep.includes(m.id));
  j.usableCount = j.models.length;
  j.agentOnlyCount = agentOnlyIds.length;
  j.agentOnly = agentOnlyIds;
  fs.writeFileSync(OUT, JSON.stringify(j, null, 2), 'utf8');
  console.log('');
  console.log(`✔ 实测完成：${j.usableCount} 个保留（其中 ${agentOnlyIds.length} 个「仅限 agent 调用」，DSH 可用）/ ${bad.length - agentOnlyIds.length} 个剔除`);
  if (agentOnlyIds.length) {
    console.log('   agent-only（普通 API 拒，DSH 是 agent 应该能过）：');
    for (const id of agentOnlyIds) console.log('     · ' + id);
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) return cmdList();
  const key = readKey();
  if (!key) { console.error('[env] 读不到 OPENROUTER_API_KEY（凭据文件或环境变量）'); return 3; }
  if (argv.includes('--fetch')) return cmdFetch(key);
  if (argv.includes('--verify')) return cmdVerify(key);
  console.log('用法：node or-free-models.js --fetch | --list | --verify');
  return 2;
}

main().then((c) => process.exit(c)).catch((e) => { console.error('ERR: ' + e.message); process.exit(1); });
