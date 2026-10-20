'use strict';
/**
 * taskcard.js —— 测试卡：解析 → 严格校验 → 语义对账 → 冻结哈希
 *
 * 立场（设计草案 §7.1）：
 *   测试卡是「被验收对象」的一部分。修复 Agent 可以提交新卡供审查，
 *   但**不得修改正在验收自己的那张卡来放绿** —— 所以 load 时立刻算出
 *   sourceHash 与 canonicalHash，之后所有证据、报告、conflict 判断都引用它。
 *
 * 语义对账比 Schema 更狠：Schema 只能保证「字段像样」，
 * 谓词是否存在、baselineKey 有没有被引用、严格档位有没有对应能力，
 * 这些必须在这里一次性拒绝 —— 否则会拖到运行时才变成「假绿」。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseYaml, YamlError } = require('./yaml.js');
const { validate } = require('./schema.js');

const SCHEMA_ID = 'rdd.harness/task-card@1';
const MMM = path.resolve(__dirname, '..');

class TaskCardError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TaskCardError';
    this.code = code;
    this.details = details || [];
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 路径越界防护：任何「名字 → 文件」的映射都必须过这一关 */
function safeJoin(base, relative) {
  const abs = path.resolve(base, relative);
  const rel = path.relative(path.resolve(base), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new TaskCardError('PATH_ESCAPE', `路径越界：${relative} 不在 ${base} 之下`);
  }
  return abs;
}

function loadSchema(schemaFile) {
  const file = schemaFile || path.join(MMM, 'schemas', 'task-card.schema.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function semanticChecks(card, ctx) {
  const errors = [];
  const spec = card.spec;
  const ids = (arr) => (arr || []).map((x) => x.id).filter(Boolean);
  const allIds = [...ids(spec.assertions), ...ids(spec.invariants), ...ids(spec.preconditions)];
  const dup = allIds.filter((id, i) => allIds.indexOf(id) !== i);
  if (dup.length) errors.push(`id 重复：${[...new Set(dup)].join(', ')}`);

  const predicates = ctx.predicates || {};
  const checkPredicate = (node, where) => {
    const p = predicates[node.predicate];
    if (!p) { errors.push(`${where} 用了未注册谓词 ${node.predicate}`); return null; }
    return p;
  };
  for (const a of spec.assertions || []) checkPredicate(a, `assertions[${a.id || '?'}]`);
  for (const i of spec.invariants || []) checkPredicate(i, `invariants[${i.id || '?'}]`);
  for (const p of spec.preconditions || []) checkPredicate(p, `preconditions[${p.id || p.predicate}]`);

  // baselineKey 必须真的存在
  const baseKeys = new Set((spec.baseline || []).map((b) => b.key));
  const dupBase = (spec.baseline || []).map((b) => b.key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupBase.length) errors.push(`baseline key 重复：${[...new Set(dupBase)].join(', ')}`);
  const walkArgs = (node) => {
    const args = node.args || {};
    if (args.baselineKey && !baseKeys.has(args.baselineKey)) {
      errors.push(`${node.id || node.predicate} 引用了不存在的 baselineKey=${args.baselineKey}`);
    }
  };
  (spec.assertions || []).forEach(walkArgs);
  (spec.invariants || []).forEach(walkArgs);

  // 谓词需要的能力必须在 requires 里
  const requires = new Set(spec.requires || []);
  for (const node of [...(spec.assertions || []), ...(spec.invariants || []), ...(spec.preconditions || [])]) {
    const p = predicates[node.predicate];
    if (!p) continue;
    for (const need of p.requires || []) {
      if (!requires.has(need)) errors.push(`${node.id || node.predicate} 需要能力 ${need}，但 spec.requires 里没有它`);
    }
  }

  // 严格双源档位：没有同伴背包 UI 能力就不是「自动降级」，是 BLOCKED
  if (spec.observation.profile === 'strict_dual_quantity') {
    if (!requires.has('vision.inventory_count_ui')) {
      errors.push('observation.profile=strict_dual_quantity 但 requires 里没有 vision.inventory_count_ui —— 不许自动降级为 state_exact_visual_context');
    }
    if (!(spec.assertions || []).some((a) => a.predicate === 'vision.inventory_count_gte')) {
      errors.push('observation.profile=strict_dual_quantity 但断言里没有 vision.inventory_count_gte（只改档位名不算严格双源）');
    }
  }

  // 观测源必须覆盖断言/谓词所需
  const sources = new Set(spec.observation.requiredSources || []);
  const sourceForPredicate = {
    'world.nearby_block_count': 'worldstate',
    'agent.alive': 'worldstate',
    'inventory.delta_gte': 'worldstate',
    'vision.target_context_confirmed': 'camera',
    'vision.inventory_count_gte': 'camera',
    'audit.no_prohibited_action': 'runtime_events',
    'build.live_hash_unchanged': 'build_artifacts',
  };
  for (const node of [...(spec.assertions || []), ...(spec.invariants || []), ...(spec.preconditions || [])]) {
    const need = sourceForPredicate[node.predicate];
    if (need && !sources.has(need)) errors.push(`${node.id || node.predicate} 需要观测源 ${need}，但 observation.requiredSources 里没有`);
  }

  // 路由角色必须存在
  if (spec.routing && ctx.roles) {
    for (const [k, role] of Object.entries(spec.routing)) {
      if (role && !ctx.roles[role]) errors.push(`routing.${k}=${role} 在路由策略里不存在`);
    }
  }

  // 预算策略必须能找到
  if (ctx.budgets && !ctx.budgets[spec.budget.policyRef]) {
    errors.push(`budget.policyRef=${spec.budget.policyRef} 在预算策略里找不到`);
  }

  return errors;
}

function freeze(card, sourceText, extra) {
  const canonical = stableStringify(card);
  return Object.assign({
    schemaId: SCHEMA_ID,
    cardId: card.metadata.id,
    version: card.metadata.version,
    sourceSha256: sha256(sourceText),
    canonicalSha256: sha256(canonical),
    frozenAt: new Date().toISOString(),
    predicatesVersion: (extra && extra.predicatesVersion) || 1,
  }, extra && extra.extra || {});
}

/**
 * @param {string} file YAML 文件
 * @param {object} ctx  { predicates, roles, budgets, fixturesDir }
 */
function loadCard(file, ctx) {
  const context = ctx || {};
  const text = fs.readFileSync(file, 'utf8');
  let doc;
  try {
    doc = parseYaml(text);
  } catch (e) {
    if (e instanceof YamlError) throw new TaskCardError('YAML_INVALID', `测试卡不是合法 YAML：${e.message}`, [e.message]);
    throw e;
  }
  const schema = loadSchema(context.schemaFile);
  const schemaErrors = validate(schema, doc);
  if (schemaErrors.length) {
    throw new TaskCardError('SCHEMA_INVALID', `测试卡不符合 ${SCHEMA_ID}`,
      schemaErrors.map((e) => `${e.path} ${e.message}`));
  }
  const sem = semanticChecks(doc, context);
  if (sem.length) throw new TaskCardError('SEMANTIC_INVALID', '测试卡语义对账失败', sem);

  // fixture 只在真要用到时才碰文件系统；这里只做路径安全校验
  if (doc.spec.environment.fixture && context.fixturesDir) {
    safeJoin(context.fixturesDir, doc.spec.environment.fixture);
  }
  return { card: doc, source: file, sourceText: text, lock: freeze(doc, text, context) };
}

function discoverCards(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth < 0) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth - 1);
      else if (/\.(ya?ml)$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir, 3);
  return out.sort();
}

module.exports = { loadCard, discoverCards, freeze, semanticChecks, safeJoin, stableStringify, sha256, TaskCardError, SCHEMA_ID };
