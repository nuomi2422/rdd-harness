'use strict';
/**
 * coordinator.js —— run 协调器：把「测试卡 → 能力对账 → 证据 → 裁决」串起来
 *
 * ⚠ 现状（不许含糊）：
 *   本文件当前跑的是 **mock 场景**（mode='mock'）。它验证的是 Harness 自己的
 *   判定逻辑与数据流，**不是实机能力**。真实接入点（游戏世界、MCP、相机、
 *   DSH 模型、mutation 沙盒）全部是 adapters/ 里明确标注未接通的桩。
 *   报告里永远带 mode 与 limitations；没有进游戏就不许出现 verified_in_game。
 */

const path = require('path');
const { loadCard } = require('./taskcard');
const { CapabilityRegistry, loadCatalog, STATES } = require('./capabilities');
const { EvidenceLog, alignEvidence } = require('./evidence');
const { ModelRouter, BudgetLedger, loadPolicies } = require('./router');
const { decide, FLAGS } = require('./verdict');
const { RunStateMachine } = require('./statemachine');
const { RunStore } = require('./runstore');
const { MockAdapter } = require('../adapters/mock');

const MMM = path.resolve(__dirname, '..');

const SUCCESS_TEXT = /完成|成功|已收集|done|completed|success/i;

function planCard(card, ctx) {
  const o = ctx || {};
  const caps = o.capabilities;
  const reasons = [];
  const requires = [...(card.spec.requires || []), ...((o.extraRequires) || [])];
  const strict = card.spec.observation.profile === 'strict_dual_quantity';
  const strictUi = 'vision.inventory_count_ui';

  let strictBlocked = false;
  if (strict && requires.includes(strictUi) && caps.stateOf(strictUi) !== STATES.HEALTHY) {
    strictBlocked = true;
    reasons.push({
      code: 'STRICT_PROFILE_UNSUPPORTED',
      flag: FLAGS.STRICT_PROFILE_UNSUPPORTED,
      detail: 'strict_dual_quantity 需要同伴背包 UI 视觉能力，但它当前不可用 —— 缺 UI 能力则 BLOCKED，不自动降级成 state_exact_visual_context',
    });
  }

  const checkList = strictBlocked ? requires.filter((r) => r !== strictUi) : requires;
  const check = caps.checkRequires(checkList, { minState: o.minState || STATES.HEALTHY });
  for (const id of check.disabled) reasons.push({ code: 'CAPABILITY_DISABLED', flag: FLAGS.CAPABILITY_MISSING, detail: `${id} 在能力目录里是 disabled（未实现/未接线/探针失败）` });
  for (const id of check.unknown) reasons.push({ code: 'CAPABILITY_UNKNOWN', flag: FLAGS.CAPABILITY_MISSING, detail: `${id} 未声明，任务不许调用未知能力` });
  for (const u of check.unhealthy) reasons.push({ code: 'CAPABILITY_NOT_VERIFIED', flag: FLAGS.CAPABILITY_MISSING, detail: `${u.id} 目前 ${u.state}，未达到 ${u.need}（探针没过就不算可用）` });

  // 执行权：外脑接管模式必须先确认 assist 关闭 / driving 为真
  const requested = o.requestedControl || (card.spec.environment.controlMode === 'external' ? 'external' : null);
  if (requested === 'external') {
    const ctl = o.control || {};
    if (ctl.driving !== true) {
      reasons.push({
        code: 'CONTROL_NOT_AVAILABLE',
        flag: FLAGS.CAPABILITY_MISSING,
        detail: `请求外脑独占执行权，但当前 driving=${ctl.driving === true}（assist=${ctl.assist === true}）—— assist 开着时内脑还在跑，外脑下底层动作会抢身体`,
      });
    }
  }

  return {
    ok: reasons.length === 0,
    requires,
    profile: card.spec.observation.profile,
    controlMode: card.spec.environment.controlMode,
    blocked: { reasons, nextAction: 'SAFE_PAUSE' },
  };
}

function makeCapabilities(scenario) {
  const catalog = loadCatalog();
  const caps = new CapabilityRegistry(catalog);
  const rt = scenario.runtime || {};
  const c = rt.capabilities || {};
  for (const id of c.healthy || []) { caps.discover(id, { by: 'scenario' }); caps.markProbe(id, true, 'scenario probe'); }
  for (const id of c.discovered || []) caps.discover(id, { by: 'scenario' });
  for (const id of c.disabled || []) caps.disable(id, 'scenario');
  return { caps, catalog };
}

/**
 * 确定性谓词求值。**不调用模型**：模型只提供 claim，不提供判据。
 * 返回 { result: true|false|'unknown', reason, trusted }
 */
function evaluatePredicate(predicateId, args, data, ctx) {
  const a = args || {};
  const companionId = ctx.companionId;
  switch (predicateId) {
    case 'world.nearby_block_count': {
      const n = (data.preconditions || {}).nearbyBlocks;
      if (typeof n !== 'number') return { result: 'unknown', reason: '没有 nearbyBlocks 读数' };
      return { result: n >= (a.min || 0), reason: `半径内方块数 ${n}` };
    }
    case 'agent.alive': {
      const alive = (data.preconditions || {}).alive;
      if (typeof alive !== 'boolean') return { result: 'unknown', reason: '没有存活读数' };
      return { result: alive === (a.equals !== false), reason: `alive=${alive}` };
    }
    case 'inventory.delta_gte': {
      const inv = data.inventory || {};
      const owner = inv.owner;
      if (a.owner === 'targetCompanion' && owner !== 'targetCompanion') {
        return { result: 'unknown', reason: `结构化背包证据的 owner=${owner}，不是目标同伴 —— 拒绝合并（玩家背包不能凑数）` };
      }
      const base = (data.baseline || {})[a.baselineKey];
      if (typeof base !== 'number' || typeof inv.logs !== 'number') return { result: 'unknown', reason: '缺少基线或当前计数' };
      const delta = inv.logs - base;
      return { result: delta >= (a.value || 0), reason: `本轮净增 ${delta}（${base} → ${inv.logs}）` };
    }
    case 'vision.target_context_confirmed': {
      const role = a.frameRole || 'before_verdict';
      const frames = data.frames || [];
      const f = frames.find((x) => x.role === role);
      if (!f) return { result: 'unknown', reason: `缺少关键帧 ${role}` };
      if (f.ok !== true) return { result: 'unknown', reason: `关键帧 ${role} 质量不合格：${f.reason || '黑屏/遮挡/菜单'}` };
      if (f.companionId && f.companionId !== 'targetCompanion') return { result: 'unknown', reason: `关键帧主体不是目标同伴（${f.companionId}）` };
      return { result: true, reason: `关键帧 ${role} 中目标身份与上下文成立` };
    }
    case 'vision.inventory_count_gte': {
      const f = (data.frames || []).find((x) => x.role === (a.frameRole || 'before_verdict'));
      if (!f || typeof f.visualCount !== 'number') return { result: 'unknown', reason: '没有可归属同伴的背包 UI 数量识别结果' };
      return { result: f.visualCount >= (a.value || 0), reason: `画面识别数量 ${f.visualCount}` };
    }
    case 'audit.no_prohibited_action': {
      const seen = data.prohibitedActions || [];
      const declared = (data.invariants || {})[a.id || ''] ;
      const violated = seen.length > 0 || (data.invariants && Object.values(data.invariants).some((v) => v && v.violated));
      return { result: !violated, reason: seen.length ? `出现禁止动作：${seen.join(', ')}` : (declared && declared.detail) || '审计无禁止动作' };
    }
    case 'evidence.sources_fresh':
      return { result: ctx.aligned ? ctx.aligned.ok : 'unknown', reason: '证据新鲜度与对齐结果' };
    case 'build.live_hash_unchanged': {
      const base = (data.baseline || {})[a.baselineKey];
      const now = (data.build || {}).liveJarSha;
      if (!now) return { result: 'unknown', reason: '没有 build 产物哈希读数' };
      return { result: base === now, reason: `live 产物哈希 ${base} → ${now}` };
    }
    default:
      return { result: 'unknown', reason: `没有为谓词 ${predicateId} 实现确定性求值器` };
  }
}

function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

function mergeBudget(base, over) {
  const b = deepClone(base);
  if (!over) return b;
  if (over.total !== undefined) b.total = over.total;
  for (const [role, cfg] of Object.entries(over.roles || {})) {
    b.roles[role] = Object.assign({}, b.roles[role] || {}, cfg);
  }
  return b;
}

async function runScenario(options) {
  const o = options || {};
  const scenario = o.scenario;
  const store = o.store || new RunStore(o.runsRoot);
  const policies = loadPolicies();
  const cardFile = scenario.card;
  const { caps, catalog } = makeCapabilities(scenario);
  const cardInfo = loadCard(cardFile, {
    predicates: catalog.predicates,
    roles: policies.routing.roles,
    budgets: policies.budgets,
  });
  const card = cardInfo.card;
  const world = scenario.world;
  const plan = planCard(card, {
    capabilities: caps,
    extraRequires: (scenario.runtime || {}).extraRequires,
    requestedControl: (scenario.runtime || {}).requestedControl,
    control: (scenario.runtime || {}).control,
  });
  const { runId } = store.createRun({
    cardId: card.metadata.id, cardVersion: card.metadata.version,
    scenarioId: scenario.id, mode: 'mock', plan: plan.ok ? 'runnable' : 'blocked',
  });
  store.writeSpec(runId, cardInfo.lock);

  const lifecycle = new RunStateMachine({
    runId,
    ownerEpoch: world.ownerEpoch,
    listeners: [(rec) => store.appendEvent(runId, { type: 'lifecycle', ...rec })],
  });
  lifecycle.transition('SPEC_VALIDATED', { reasonCode: 'CARD_FROZEN', evidenceRefs: [cardInfo.lock.canonicalSha256] });

  const reportBase = {
    runId, mode: 'mock', scenarioId: scenario.id, scenarioTitle: scenario.title,
    cardId: card.metadata.id, cardVersion: card.metadata.version,
    specLock: cardInfo.lock,
    world,
  };

  // ── 开跑前阻断 ──────────────────────────────────────────────────────
  if (!plan.ok) {
    lifecycle.transition('SAFE_PAUSED', { reasonCode: 'PREFLIGHT_BLOCKED' });
    lifecycle.transition('FINALIZING', { reasonCode: 'NO_ACTION_TAKEN' });
    lifecycle.transition('COMPLETED', { reasonCode: 'FINALIZED' });
    const verdict = decide({ blocked: plan.blocked });
    const report = Object.assign(reportBase, {
      verdict: verdict.verdict, taskVerdict: verdict.taskVerdict || 'BLOCKED', flags: verdict.flags,
      reasons: verdict.reasons,
      plan, assertions: [], invariants: [], calls: [], budget: null,
      evidence: { ok: false, issues: [], entryCount: 0 },
      lifecycle: lifecycle.history,
      nextAction: plan.blocked.nextAction,
      limitations: ['mock 模式：未接触游戏/DSH/相机/mutation 沙箱', '实测状态 verified_in_game = 0'],
    });
    store.writeReport(runId, report);
    store.appendEvent(runId, { type: 'verdict', verdict: report.verdict, flags: report.flags });
    return { report, runId };
  }

  lifecycle.transition('PREFLIGHT', { reasonCode: 'ENGINEERING_GATES_PASSED' });
  lifecycle.transition('ENV_STARTING', { reasonCode: 'SANDBOX_SELECTED' });
  lifecycle.transition('WORLD_READY', { reasonCode: 'WORLD_IDENTITY_CONFIRMED' });
  lifecycle.transition('CAPABILITIES_READY', { reasonCode: 'CAPABILITY_PROBE_PASSED' });
  lifecycle.transition('CONTROL_READY', { reasonCode: 'OWNER_EPOCH_CLAIMED' });
  lifecycle.transition('OBSERVATION_READY', { reasonCode: 'CAMERA_BOUND' });
  lifecycle.transition('EXECUTING', { reasonCode: 'GOAL_SUBMITTED' });

  // ── 证据采集（mock）────────────────────────────────────────────────
  const data = scenario.data || {};
  const log = new EvidenceLog({
    runId, attemptId: 'attempt-01', worldSessionId: world.worldSessionId,
    instanceId: world.instanceId, worldId: world.worldId, dimension: world.dimension,
    companionId: world.companionId, ownerEpoch: world.ownerEpoch,
  });
  let seq = 1;
  const add = (kind, source, payload, opts) => {
    const put = store.putEvidence(runId, `${kind}.json`, JSON.stringify(payload));
    const env = log.add(kind, source, payload, Object.assign({
      payloadRef: put.ref, sha256: put.sha256, sourceSeq: seq++,
    }, opts || {}));
    store.appendEvent(runId, { type: 'evidence', eventId: env.eventId, kind, source, sha256: env.sha256 });
    return env;
  };

  const inv = data.inventory || {};
  if (data.inventory) {
    add('inventory.snapshot', 'worldstate', { owner: inv.owner, logs: inv.logs }, {
      serverTick: world.serverTick,
      companionId: inv.owner === 'targetCompanion' ? world.companionId : 'player-uuid-elsewhere',
    });
  }
  if (data.baseline) add('inventory.baseline', 'worldstate', { baseline: data.baseline }, { serverTick: world.serverTick });
  if (data.prohibitedActions || data.invariants) {
    add('audit.actions', 'runtime_events', { prohibited: data.prohibitedActions || [], invariants: data.invariants || {} }, { serverTick: world.serverTick + 2 });
  }
  (data.frames || []).forEach((f, idx) => {
    add(`frame.${f.role}`, 'camera', { role: f.role, ok: f.ok, visualCount: f.visualCount }, {
      serverTick: world.serverTick + 5 + idx,
      worldSessionId: f.worldSessionId,
      companionId: f.companionId === 'targetCompanion' ? world.companionId : (f.companionId || world.companionId),
    });
  });
  if (data.build) add('build.manifest', 'build_artifacts', data.build, { serverTick: world.serverTick + 3 });

  const aligned = alignEvidence(log.entries, {
    attemptId: 'attempt-01',
    worldSessionId: world.worldSessionId,
    dimension: world.dimension,
    companionId: world.companionId,
    ownerEpoch: world.ownerEpoch,
    maxEvidenceAgeMs: card.spec.observation.maxEvidenceAgeMs || 2000,
    maxAlignmentSkewTicks: card.spec.observation.maxAlignmentSkewTicks || 20,
    pairs: [],
  });

  // ── 确定性断言 ─────────────────────────────────────────────────────
  const assertionResults = (card.spec.assertions || []).map((a) => {
    const r = evaluatePredicate(a.predicate, a.args, data, { companionId: world.companionId, aligned });
    return {
      id: a.id, predicate: a.predicate, required: a.required !== false,
      result: r.result, reason: r.reason, trusted: true,
    };
  });
  const invariantResults = (card.spec.invariants || []).map((i) => {
    const r = evaluatePredicate(i.predicate, i.args, data, { companionId: world.companionId, aligned });
    return { id: i.id, predicate: i.predicate, violated: r.result === false, trusted: true, reason: r.reason };
  });

  // 视觉必需帧：只认断言里真正引用的 frameRole（keyframes 是采集指引，不是裁决门槛）
  const requiredFrameRoles = [...new Set((card.spec.assertions || [])
    .filter((a) => a.predicate.startsWith('vision.'))
    .map((a) => (a.args && a.args.frameRole) || 'before_verdict'))];
  const availableFrameRoles = new Set((data.frames || []).filter((f) => f.ok === true).map((f) => f.role));
  const missingFrames = requiredFrameRoles.filter((r) => !availableFrameRoles.has(r));

  // ── 模型链（mock 适配器；真适配器在 adapters/dsh.js 抛 NOT_CONNECTED）──
  const bp = mergeBudget(policies.budgets[card.spec.budget.policyRef], scenario.budget);
  const ledger = new BudgetLedger(bp);
  const script = (scenario.modelPlan && scenario.modelPlan.script) || {};
  // ★ 适配器按【provider】注册，provider 名字从策略里读 —— 不再写死 deepseek/glm/openai。
  //   现在真实映射是：opencode-go（DeepSeek/GLM）+ moyuu（GPT-6 Astra）。
  const adapters = {};
  for (const role of Object.values(policies.routing.roles || {})) {
    if (!role.provider || adapters[role.provider]) continue;
    adapters[role.provider] = new MockAdapter(script, role.provider);
  }
  const router = new ModelRouter({
    routing: policies.routing, budgets: policies.budgets, budgetId: card.spec.budget.policyRef,
    modelCapabilities: (scenario.runtime || {}).modelCapabilities || {},
    adapters, ledger, sleep: async () => {},
    disabledRoles: (scenario.runtime || {}).disabledRoles || [],
  });
  const chain = await router.runChain((scenario.modelPlan && scenario.modelPlan.kind) || 'normal', {
    inputTokens: 4000, maxOutputTokens: 1000, deadlineMs: 30000,
  });
  for (const rec of router.calls) store.appendEvent(runId, { type: 'model.call', ...rec });

  const routeBlocked = [];
  if (chain.status !== 'OK') {
    const budgetHit = chain.records.find((r) => /CALL_LIMIT|COST_LIMIT|BUDGET_EXHAUSTED|PRICE_UNKNOWN/.test(r.reasonCode || ''));
    if (budgetHit) {
      routeBlocked.push({ code: 'BUDGET_' + budgetHit.reasonCode, flag: FLAGS.BUDGET_EXHAUSTED, detail: budgetHit.detail || '预算/调用次数不允许继续' });
    } else if (chain.records.some((r) => (r.status === 'BLOCKED') && r.reasonCode === 'ADAPTER_NOT_CONNECTED')) {
      routeBlocked.push({ code: 'DSH_NOT_CONNECTED', flag: FLAGS.CAPABILITY_MISSING, detail: 'DSH 真实模型接口未接通（M0 未完成），不许偷偷直连别家冒充完成' });
    } else {
      routeBlocked.push({ code: 'ALL_ROUTES_FAILED', flag: null, detail: '所有预授权路由都失败/不可用 → 安全暂停，不自动启用未授权高价模型' });
    }
  }

  // ── claim（模型口头声明）────────────────────────────────────────────
  const requiredAsserts = assertionResults.filter((a) => a.required);
  const allRequiredTrue = requiredAsserts.every((a) => a.result === true);
  const supportOk = allRequiredTrue && aligned.ok;
  const claims = (data.claims || []).map((c) => Object.assign({}, c, { supported: supportOk && c.supported !== false }));
  for (const rec of router.calls) {
    if (rec.status === 'OK' && rec.output && SUCCESS_TEXT.test(JSON.stringify(rec.output))) {
      claims.push({ actor: rec.modelRef, role: rec.role, kind: 'success', text: (rec.output.text || '').slice(0, 200), supported: supportOk });
    }
  }

  // ── 裁决 ───────────────────────────────────────────────────────────
  const blocked = routeBlocked.length ? { reasons: routeBlocked, nextAction: 'SAFE_PAUSE' } : null;
  const verdict = decide({
    blocked,
    environment: { healthy: true },
    assertions: assertionResults,
    invariants: invariantResults,
    evidence: aligned,
    observation: {
      profile: card.spec.observation.profile,
      visualRequired: (card.spec.observation.requiredSources || []).includes('camera'),
      visionAvailable: missingFrames.length === 0,
      frames: (data.frames || []).map((f) => ({ role: f.role, ok: f.ok, required: requiredFrameRoles.includes(f.role), reason: f.reason })),
      missingKeyframes: missingFrames,
    },
    conflict: data.conflict ? { detected: true, detail: data.conflictDetail || '双源冲突' } : { detected: false },
    claims,
    engineering: data.engineering || { gatesPassed: true },
    archive: data.archive || { ok: true },
  });

  lifecycle.transition('VERIFYING', { reasonCode: 'EVIDENCE_COLLECTED' });
  if (verdict.verdict === 'BLOCKED' || verdict.verdict === 'INCONCLUSIVE') {
    lifecycle.transition('SAFE_PAUSED', { reasonCode: verdict.flags[0] || verdict.verdict });
  }
  lifecycle.transition('FINALIZING', { reasonCode: 'VERDICT_COMPUTED' });
  lifecycle.transition('COMPLETED', { reasonCode: 'FINALIZED' });

  const report = Object.assign(reportBase, {
    verdict: verdict.verdict,
    taskVerdict: verdict.taskVerdict,
    flags: verdict.flags,
    reasons: verdict.reasons,
    plan,
    assertions: assertionResults,
    invariants: invariantResults,
    observation: { requiredFrameRoles, missingFrames, profile: card.spec.observation.profile },
    calls: router.calls.map((c) => ({
      role: c.role, modelRef: c.modelRef, status: c.status, invoked: c.invoked === true,
      reasonCode: c.reasonCode || null,
      cost: c.usage ? c.usage.cost : 0, usageSource: c.usageSource || null, latencyMs: c.latencyMs || 0,
    })),
    budget: ledger.snapshot(),
    evidence: { ok: aligned.ok, issues: aligned.issues, entryCount: log.entries.length, entries: log.entries.map((e) => ({ eventId: e.eventId, kind: e.kind, source: e.source, sha256: e.sha256, payloadRef: e.payloadRef })) },
    claims,
    chainStatus: chain.status,
    lifecycle: lifecycle.history,
    nextAction: verdict.verdict === 'PASS' ? 'NONE' : (blocked ? 'SAFE_PAUSE' : 'REVIEW'),
    limitations: [
      'mock 模式：未接触游戏/DSH/相机/mutation 沙箱',
      '相机/MCP/DSH/mutation 适配器未接通（not_connected）',
      '实测状态 verified_in_game = 0 —— 「离线通过」不等于「实机通过」',
    ],
  });
  store.writeReport(runId, report);
  store.appendEvent(runId, { type: 'verdict', verdict: report.verdict, taskVerdict: report.taskVerdict, flags: report.flags });
  return { report, runId };
}

module.exports = { runScenario, planCard, evaluatePredicate, mergeBudget, SUCCESS_TEXT };
