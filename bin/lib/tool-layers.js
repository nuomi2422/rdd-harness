#!/usr/bin/env node
'use strict';
/**
 * tool-layers.js —— 外部编码 AI 的 Harness 工具分层（2026-10-29 施工单第 2 阶段）
 *
 * 为什么存在：
 *   registry.json 是「工具目录」，不是「每轮该看什么」。98 项平铺会让外部 AI 直接翻原始日志、
 *   漏掉 bench 已有结论。这里把**外部 AI 的工具面**收成四层，核心不超过 5 项。
 *
 * 三层数据来源（不复制真源）：
 *   1. registry.json        —— 有哪些工具（98 项，唯一真源）
 *   2. tool-layers.json     —— 人工分层覆盖（core / specialist / operator + operator 风险）
 *   3. registry 的 side      —— 兜底规则：build/writeMods/writeGame 未分类 → operator；其余 → legacy
 *
 * ★ 边界：
 *   - 这是**发现性与工作流约束，不是授权凭据**。工具可见 ≠ 已授权；operator 层必须先显式选择。
 *   - 本模块不改 registry、不删工具、不给游戏内 Numen 工具分层（那是另一张表）。
 *   - 未分类的新工具默认 legacy_or_unverified，不能静默升到 core/operator。
 *   - 只统计「目录」，不声称「每轮模型收到几个定义」—— 那个数字本机拿不到，标 unverified。
 */

const fs = require('fs');
const path = require('path');

const HARNESS = path.resolve(__dirname, '..', '..');
const REGISTRY = path.join(HARNESS, 'registry.json');
const OVERLAY = path.join(HARNESS, 'tool-layers.json');

const MUTATING_SIDES = new Set(['build', 'writeMods', 'writeGame']);
const LAYERS = ['core', 'specialist', 'operator', 'legacy_or_unverified'];

function readJson(p, label) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    const err = new Error('读不了 ' + label + '（' + p + '）：' + e.message);
    err.code = 'ELAYERS';
    throw err;
  }
}

function defaultRiskBySide(side) {
  if (side === 'build') return '构建/编译；可能部署或起实例（运行时随之改变）';
  if (side === 'writeMods') return '改 live mods 里的 jar / 版本指针';
  if (side === 'writeGame') return '直接改游戏内世界或玩家状态';
  if (side === 'write') return '写文件/配置';
  if (side === 'run') return '会启动进程或驱动外部程序';
  return '显式选择后才用；可见≠已授权';
}

function load(registryPath, overlayPath) {
  const registry = readJson(registryPath || REGISTRY, 'registry.json');
  const overlay = readJson(overlayPath || OVERLAY, 'tool-layers.json');
  const tools = Array.isArray(registry.tools) ? registry.tools : [];
  const byId = new Map(tools.map((t) => [t.id, t]));
  const core = Array.isArray(overlay.core) ? overlay.core.slice() : [];
  const specialist = new Set(overlay.specialist || []);
  const operator = new Set(overlay.operator || []);
  const coreLimit = Number(overlay.notes && overlay.notes.coreLimit) || 5;

  // ── 校验：core ≤5；core/specialist/operator 的 id 必须都在 registry 里 ──
  const problems = [];
  if (core.length > coreLimit) problems.push('core 有 ' + core.length + ' 项，超过上限 ' + coreLimit);
  const seenCore = new Set();
  for (const c of core) {
    if (!c || !c.id) { problems.push('core 项缺 id'); continue; }
    if (!byId.has(c.id)) problems.push('core 引用了 registry 里没有的 id: ' + c.id);
    // core 可以同一个工具两条命令（如 bench brief / bench health），但命令不能重复
    const key = c.id + '::' + (c.cmd || '');
    if (seenCore.has(key)) problems.push('core 重复项: ' + key);
    seenCore.add(key);
  }
  for (const id of specialist) if (!byId.has(id)) problems.push('specialist 引用了 registry 里没有的 id: ' + id);
  for (const id of operator) if (!byId.has(id)) problems.push('operator 引用了 registry 里没有的 id: ' + id);
  if (problems.length) {
    const err = new Error('tool-layers.json 与 registry.json 不一致：\n  - ' + problems.join('\n  - '));
    err.code = 'ELAYERS';
    throw err;
  }

  // ── 排队：显式分层优先；其余按 side 兜底；都没命中 → legacy ──
  const rows = new Map();
  const assign = (id, layer, why) => {
    if (rows.has(id)) return; // core/specialist/operator 有重叠时以先到为准，最后在 problems 里提示
    rows.set(id, { id, name: byId.get(id).name, side: byId.get(id).side || '?', needsGame: !!byId.get(id).needsGame, layer, why });
  };
  for (const c of core) assign(c.id, 'core', c.why || '');
  for (const id of specialist) assign(id, 'specialist', '当前任务确实需要时再展开');
  for (const id of operator) assign(id, 'operator', overlay.operatorRisk && overlay.operatorRisk[id] ? overlay.operatorRisk[id] : '显式选择；可能改源码/构建部署/起停实例/改世界');  for (const t of tools) {
    if (rows.has(t.id)) continue;
    if (MUTATING_SIDES.has(t.side)) assign(t.id, 'operator', defaultRiskBySide(t.side) + '（registry side=' + t.side + '，兜底归入 operator）');
    else assign(t.id, 'legacy_or_unverified', '未分层（默认不推荐；有近期使用证据再升层）');
  }
  // 同一 id 被分到多层 → 记录提示（不致命，但提醒改 overlay）
  const layerCount = {};
  for (const [id, r] of rows) { (layerCount[id] = layerCount[id] || []).push(r.layer); }
  for (const [id, ls] of Object.entries(layerCount)) if (ls.length > 1) problems.push('id ' + id + ' 同时出现在：' + ls.join('/'));

  const grouped = {};
  for (const l of LAYERS) grouped[l] = [];
  for (const r of rows.values()) grouped[r.layer].push(r);
  for (const l of LAYERS) grouped[l].sort((a, b) => a.id.localeCompare(b.id));

  return {
    registryPath: registryPath || REGISTRY,
    overlayPath: overlayPath || OVERLAY,
    registryCount: tools.length,
    counts: { registry: tools.length, core: core.length, specialist: grouped.specialist.length, operator: grouped.operator.length, legacy: grouped.legacy_or_unverified.length },
    layers: grouped,
    coreOverlay: core,
    operatorRisk: overlay.operatorRisk || {},
    problems,
    exposure: 'unverified：这是 registry 目录数量与分层视图，不是每轮请求实际发给模型的工具定义数。DSH 侧可用会话 request/header 核实；RDD 侧看不到别家 AI 的请求面。',
  };
}

function fmtRisks(view) {
  const out = [];
  for (const r of view.layers.operator) {
    const risk = view.operatorRisk[r.id] || defaultRiskBySide(r.side);
    out.push('- `' + r.id + '` — ' + risk);
  }
  return out;
}

function renderText(view) {
  const c = view.counts;
  const out = [];
  out.push('# 外部编码 AI · Harness 工具分层（generated）');
  out.push('registry：' + c.registry + ' 项（目录数量，不是每轮工具定义数）  core ' + c.core + ' / specialist ' + c.specialist + ' / operator ' + c.operator + ' / legacy_or_unverified ' + c.legacy);
  out.push('生成源：registry.json + tool-layers.json ｜ 读法：node bin/bench.js layers');
  out.push('');
  out.push('## core —— 每轮开工/收工，最多 5 项');
  for (const e of view.coreOverlay) {
    out.push('- ' + (e.cmd || e.id) + '   [' + (e.side || 'read') + ']');
    if (e.why) out.push('    ' + e.why);
  }
  out.push('');
  out.push('## specialist —— 当前任务确实需要时再展开（' + c.specialist + ' 项）');
  for (const r of view.layers.specialist) out.push('- `' + r.id + '`  ' + r.name + (r.needsGame ? '  [needsGame]' : ''));
  out.push('');
  out.push('## operator —— ⚠ 显式选择；可能改源码/构建部署/起停实例/改世界（' + c.operator + ' 项）');
  out.push('  ★ 可发现 ≠ 已授权；in-game live/存档/作弊动作一律先绑 card/runId。');
  for (const line of fmtRisks(view)) out.push(line);
  const noRisk = view.layers.operator.filter((r) => !view.operatorRisk[r.id]).length;
  if (noRisk) out.push('  （其中 ' + noRisk + ' 项没有逐条风险文案，按 registry 的 side 兜底提示；要更细就写进 tool-layers.json 的 operatorRisk）');
  out.push('');
  out.push('## legacy_or_unverified —— 保留兼容，默认不推荐（' + c.legacy + ' 项）');
  out.push('  ' + view.layers.legacy_or_unverified.map((r) => '`' + r.id + '`').join(' '));
  out.push('');
  out.push('## 未核实边界');
  out.push('  ' + view.exposure);
  out.push('  未分类规则：任何未在 tool-layers.json 出现、且 side 不是 build/writeMods/writeGame 的新工具 → legacy_or_unverified。');
  return out.join('\n');
}

function renderJson(view) {
  return {
    registry: view.registryCount,
    counts: view.counts,
    core: view.layers.core.map((r) => r.id),
    specialist: view.layers.specialist.map((r) => r.id),
    operator: view.layers.operator.map((r) => ({ id: r.id, risk: view.operatorRisk[r.id] || null })),
    legacy_or_unverified: view.layers.legacy_or_unverified.map((r) => r.id),
    exposure: view.exposure,
    problems: view.problems,
  };
}

module.exports = { LAYERS, load, renderText, renderJson, HARNESS };

// 单独跑也给一份（便于施工核对，但正式入口仍是 bench layers）
if (require.main === module) {
  try {
    const view = load();
    if (process.argv.includes('--json')) console.log(JSON.stringify(renderJson(view), null, 2));
    else console.log(renderText(view));
    if (view.problems.length) console.error('\n[warn] ' + view.problems.join('\n[warn] '));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
