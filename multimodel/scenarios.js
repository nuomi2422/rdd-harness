'use strict';
/**
 * scenarios.js —— 故障注入场景（离线）
 *
 * 这些场景对应设计草案 §11「核心自动化验收矩阵」里**不需要真游戏**就能验证的那几条。
 * 每条都带 expect：跑出来的 verdict / flags 必须与它一致，selftest 才算过。
 * 场景是**测试数据**，不是「实机已验证」：report 里 mode 一律标 mock。
 */

const PATH = require('path');

const CARD = (name) => PATH.join(__dirname, 'cards', name);

function world(over) {
  return Object.assign({
    instanceId: 'sandbox-1',
    worldSessionId: 'ws-test-1',
    worldId: 'world-test-1',
    dimension: 'minecraft:overworld',
    companionId: 'companion-uuid-1',
    ownerEpoch: 1,
    serverTick: 1000,
  }, over || {});
}

/** 运行时可用的 mock 事实（探针结果）。真机时由 M2/M3 的适配器填。 */
function runtimeBase(over) {
  return Object.assign({
    capabilities: {
      healthy: [
        'worldstate.inventory.snapshot', 'worldstate.nearby.blocks', 'camera.capture',
        'camera.binding.status', 'agent.goal.submit', 'runtime.events.read',
      ],
      discovered: [],
      disabled: [],
    },
    modelCapabilities: {
      'deepseek-v4.1-flash': ['text', 'tools'],
      'glm-5.3-flash': ['text', 'vision', 'image_input'],
      'glm-5.3': ['text', 'tools', 'long_context'],
      'gpt-6-astra': ['text', 'tools'],
    },
    adapters: { mock: true },
    control: { mode: 'autonomous', driving: false, assist: true },
  }, over || {});
}

function dataBase(over) {
  return Object.assign({
    preconditions: { nearbyBlocks: 8, alive: true },
    baseline: { logsBefore: 0 },
    inventory: { owner: 'targetCompanion', logs: 3 },
    frames: [{ role: 'before_verdict', ok: true, companionId: 'targetCompanion' }],
    vision: { available: true },
    conflict: false,
    claims: [],
    invariants: {},
    engineering: { gatesPassed: true },
    archive: { ok: true },
    deadlineExceeded: false,
  }, over || {});
}

const SCENARIOS = {
  happy: {
    id: 'happy',
    title: '正常路径：结构化计数达标 + 关键帧可用 → PASS，且不应调用 GPT-6',
    card: CARD('survival.collect-three-logs.yaml'),
    world: world(),
    runtime: runtimeBase(),
    data: dataBase(),
    modelPlan: { kind: 'normal', script: { worker: [{ status: 'OK', output: { text: '已提交采集目标' }, usage: { inputTokens: 800, outputTokens: 120, cost: 0.002, currency: 'CNY' } }] } },
    expect: { verdict: 'PASS', taskVerdict: 'PASS', noFallbackCall: true },
  },

  t01: {
    id: 't01',
    title: 'T01 模型说完成但背包无增量 → FAIL，不采信口头成功',
    card: CARD('survival.collect-three-logs.yaml'),
    world: world(),
    runtime: runtimeBase(),
    data: dataBase({
      inventory: { owner: 'targetCompanion', logs: 0 },
      claims: [{ actor: 'deepseek-v4.1-flash', role: 'worker', kind: 'success', text: '任务完成，已收集 3 个原木' }],
    }),
    modelPlan: { kind: 'normal', script: { worker: [{ status: 'OK', output: { text: '任务完成：已收集 3 个原木' }, usage: { inputTokens: 500, outputTokens: 40, cost: 0.001, currency: 'CNY' } }] } },
    expect: { verdict: 'FAIL', flagsInclude: ['UNSUPPORTED_SUCCESS_CLAIM'] },
  },

  t02: {
    id: 't02',
    title: 'T02 背包达标但必需关键帧丢失 → INCONCLUSIVE',
    card: CARD('survival.collect-three-logs.yaml'),
    world: world(),
    runtime: runtimeBase(),
    data: dataBase({ frames: [] }),
    modelPlan: { kind: 'normal', script: {} },
    expect: { verdict: 'INCONCLUSIVE', flagsInclude: ['VISION_UNKNOWN'] },
  },

  t03: {
    id: 't03',
    title: 'T03 看到玩家背包却测试同伴 → 身份不匹配，拒绝合并',
    card: CARD('survival.collect-three-logs.yaml'),
    world: world(),
    runtime: runtimeBase(),
    data: dataBase({ inventory: { owner: 'Player', logs: 3 } }),
    modelPlan: { kind: 'normal', script: {} },
    expect: { verdict: 'INCONCLUSIVE', flagsInclude: ['EVIDENCE_INVALID'] },
  },

  t05: {
    id: 't05',
    title: 'T05 状态与帧来自不同轮次/会话 → 拒绝合并',
    card: CARD('survival.collect-three-logs.yaml'),
    world: world(),
    runtime: runtimeBase(),
    data: dataBase({ frames: [{ role: 'before_verdict', ok: true, companionId: 'targetCompanion', worldSessionId: 'ws-old-run' }] }),
    modelPlan: { kind: 'normal', script: {} },
    expect: { verdict: 'INCONCLUSIVE', flagsInclude: ['EVIDENCE_INVALID'] },
  },

  t06: {
    id: 't06',
    title: 'T06 同步双源互相矛盾 → EVIDENCE_CONFLICT，禁止 PASS',
    card: CARD('survival.collect-three-logs.yaml'),
    world: world(),
    runtime: runtimeBase(),
    data: dataBase({
      conflict: true,
      conflictDetail: 'worldstate 显示净增 3，before_verdict 帧里的同伴背包可见原木为 0',
      frames: [{ role: 'before_verdict', ok: true, companionId: 'targetCompanion', visualCount: 0 }],
    }),
    modelPlan: { kind: 'normal', script: {} },
    expect: { verdict: 'INCONCLUSIVE', flagsInclude: ['EVIDENCE_CONFLICT'] },
  },

  t07: {
    id: 't07',
    title: 'T07 assist 内脑运行时外脑请求独占执行权 → 仲裁拒绝',
    card: CARD('survival.collect-three-logs.yaml'),
    world: world(),
    runtime: runtimeBase({ control: { mode: 'autonomous', driving: false, assist: true }, requestedControl: 'external' }),
    data: dataBase(),
    modelPlan: { kind: 'normal', script: {} },
    expect: { verdict: 'BLOCKED', flagsInclude: ['CAPABILITY_MISSING'] },
  },

  t10: {
    id: 't10',
    title: 'T10 GPT-6 预算已满 → 安全暂停，不额外调用',
    card: CARD('survival.collect-three-logs.yaml'),
    world: world(),
    runtime: runtimeBase(),
    data: dataBase({ inventory: { owner: 'targetCompanion', logs: 0 } }),
    budget: { roles: { fallback: { maxCalls: 0, maxCost: 0, maxTokens: 0 } } },
    modelPlan: {
      kind: 'normal',
      script: {
        worker: [{ statusCode: 402, errorCode: 'QUOTA_EXHAUSTED', message: '余额不足' }],
        code_specialist: [{ statusCode: 402, errorCode: 'QUOTA_EXHAUSTED', message: '余额不足' }],
        fallback: [{ status: 'OK', output: { text: '不应该被调到' } }],
      },
    },
    expect: { verdict: 'BLOCKED', flagsInclude: ['BUDGET_EXHAUSTED'], fallbackCalls: 0 },
  },

  t11: {
    id: 't11',
    title: 'T11 声明 build-only，但 live 产物哈希变了 → FAIL（不认「构建成功」）',
    card: CARD('selfcompile.build-only.yaml'),
    world: world(),
    runtime: runtimeBase({
      capabilities: {
        healthy: ['build.artifact.manifest', 'mutation.build_only'],
        discovered: [],
        disabled: [],
      },
    }),
    data: {
      preconditions: {},
      baseline: { liveJarSha: 'aaaa' },
      frames: [],
      vision: { available: true },
      conflict: false,
      claims: [],
      invariants: {},
      engineering: { gatesPassed: true },
      archive: { ok: true },
      deadlineExceeded: false,
      build: { declaredBuildOnly: true, liveJarSha: 'bbbb' },
    },
    modelPlan: { kind: 'normal', script: {} },
    expect: { verdict: 'FAIL' },
  },

  t12: {
    id: 't12',
    title: 'T12 需要尚未实现的能力（mutation.build_only）→ 开跑前 BLOCKED',
    card: CARD('selfcompile.build-only.yaml'),
    world: world(),
    runtime: runtimeBase({ extraRequires: ['mutation.build_only'] }),
    data: {
      preconditions: {},
      baseline: { liveJarSha: 'aaaa' },
      frames: [],
      vision: { available: true },
      conflict: false,
      claims: [],
      invariants: {},
      engineering: { gatesPassed: true },
      archive: { ok: true },
      deadlineExceeded: false,
      build: { declaredBuildOnly: true, liveJarSha: 'aaaa' },
    },
    modelPlan: { kind: 'normal', script: {} },
    expect: { verdict: 'BLOCKED', flagsInclude: ['CAPABILITY_MISSING'] },
  },

  strict: {
    id: 'strict',
    title: '严格双源档位缺同伴背包 UI 能力 → BLOCKED（不自动降级）',
    card: CARD('survival.strict-dual-quantity-logs.yaml'),
    world: world(),
    runtime: runtimeBase(),
    data: dataBase(),
    modelPlan: { kind: 'normal', script: {} },
    expect: { verdict: 'BLOCKED', flagsInclude: ['STRICT_PROFILE_UNSUPPORTED'] },
  },
};

function getScenario(id) {
  const s = SCENARIOS[id];
  if (!s) throw new Error(`未知场景 ${id}。可用：${Object.keys(SCENARIOS).join(', ')}`);
  return JSON.parse(JSON.stringify(s, (k, v) => (typeof v === 'function' ? undefined : v)));
}

module.exports = { SCENARIOS, getScenario, CARD };
