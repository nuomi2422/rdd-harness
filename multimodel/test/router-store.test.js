'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ModelRouter, BudgetLedger, loadPolicies, classifyError, ERROR_CLASS } = require('../lib/router.js');
const { MockAdapter } = require('../adapters/mock.js');
const { DshAdapter } = require('../adapters/dsh.js');
const { RunStore } = require('../lib/runstore.js');
const registryLib = require('../../bin/lib/registry.js');

function policies() {
  const p = loadPolicies();
  return JSON.parse(JSON.stringify(p));
}

function routerWith(over) {
  const o = over || {};
  const p = policies();
  const budget = o.budget || p.budgets['survival-small-v1'];
  const script = o.script || {};
  return new ModelRouter({
    routing: p.routing,
    budgets: p.budgets,
    ledger: new BudgetLedger(budget),
    modelCapabilities: o.modelCapabilities || {
      'deepseek-v4.1-flash': ['text', 'tools'],
      'glm-5.3-flash': ['text', 'vision', 'image_input'],
      'glm-5.3': ['text', 'tools', 'long_context'],
      'gpt-6-astra': ['text', 'tools'],
    },
    adapters: {
      'opencode-go': new MockAdapter(script, 'opencode-go'),
      moyuu: new MockAdapter(script, 'moyuu'),
    },
    sleep: async () => {},
    disabledRoles: o.disabledRoles || [],
  });
}

test('错误分类：401/403 鉴权、402 配额、429 限流、5xx 可重试', () => {
  assert.equal(classifyError(401), ERROR_CLASS.AUTH);
  assert.equal(classifyError(403), ERROR_CLASS.AUTH);
  assert.equal(classifyError(402), ERROR_CLASS.QUOTA);
  assert.equal(classifyError(429), ERROR_CLASS.RATE_LIMIT);
  assert.equal(classifyError(503), ERROR_CLASS.SERVER);
  assert.equal(classifyError(400), ERROR_CLASS.BAD_REQUEST);
});

test('能力决定路由：没有 vision 能力的角色永远不进视觉链', () => {
  const r = routerWith({ modelCapabilities: { 'deepseek-v4.1-flash': ['text', 'tools'], 'glm-5.3': ['text', 'tools'], 'gpt-6-astra': ['text', 'tools'] } });
  assert.deepEqual(r.chainFor('vision'), []);
  // 即使他们把名字叫得像视觉模型也不行：必须探针给出 image_input/vision
  const r2 = routerWith({ modelCapabilities: { 'glm-5.3': ['text', 'tools', 'vision'] } });
  assert.ok(!r2.chainFor('vision').includes('code_specialist'));
});

test('401 → 熔断该 provider 并安全暂停（不重试同一请求）', async () => {
  const r = routerWith({ script: { worker: [{ statusCode: 401, errorCode: 'INVALID_KEY' }] } });
  const out = await r.runChain('normal', { inputTokens: 100, maxOutputTokens: 100 });
  assert.equal(out.status, 'BLOCKED');
  assert.equal(out.action, 'SAFE_PAUSE');
  assert.ok(r.circuitOpen.has('opencode-go'));
});

test('402 配额耗尽 → 换预授权角色，不盲目重试同一请求', async () => {
  const r = routerWith({
    script: {
      worker: [{ statusCode: 402, errorCode: 'QUOTA' }],
      code_specialist: [{ status: 'OK', output: { text: '复杂代码已修' }, usage: { inputTokens: 10, outputTokens: 5, cost: 0.001, currency: 'CNY' } }],
    },
  });
  const out = await r.runChain('normal', { inputTokens: 100, maxOutputTokens: 100 });
  assert.equal(out.status, 'OK');
  assert.equal(out.used, 'code_specialist');
});

test('429 → 退避重试（有上限），最终成功', async () => {
  const r = routerWith({ script: { worker: [{ statusCode: 429, errorCode: 'RATE_LIMIT' }, { status: 'OK', output: { text: '好了' } }] } });
  const out = await r.runChain('normal', { inputTokens: 100, maxOutputTokens: 100 });
  assert.equal(out.status, 'OK');
  assert.ok(out.records.some((x) => x.status === 'BACKOFF'));
});

test('GPT-6 兜底调用次数用尽 → BLOCKED，适配器根本没被调用', async () => {
  const p = policies();
  const budget = p.budgets['survival-small-v1'];
  budget.roles.fallback = { maxCalls: 0, maxCost: 0, maxTokens: 0 };
  const r = routerWith({ budget, script: {} });
  const res = await r.invoke('fallback', { inputTokens: 10, maxOutputTokens: 10 });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(res.reasonCode, 'ROLE_CALL_LIMIT');
  assert.equal(res.invoked, false);
});

test('预算原子预留：两次预留不能同时看到同一份余额', () => {
  const p = policies();
  const budget = p.budgets['survival-small-v1'];
  budget.total = 0.03;   // 单次预留约 0.0192（4000 输入 + 1000 输出 × 安全系数 1.2）
  const led = new BudgetLedger(budget);
  const a = led.reserve('worker', 'deepseek-v4.1-flash', 4000, 1000);
  assert.equal(a.ok, true);
  const b = led.reserve('worker', 'deepseek-v4.1-flash', 4000, 1000);
  assert.equal(b.ok, false);
  assert.ok(['BUDGET_EXHAUSTED', 'ROLE_COST_LIMIT'].includes(b.reason));
  assert.equal(led.remaining() >= 0, true);
});

test('价格未知 → 不许绕过金额预算（PRICE_UNKNOWN）', () => {
  const p = policies();
  const led = new BudgetLedger(p.budgets['survival-small-v1']);
  const r = led.reserve('worker', 'some-unpriced-model', 10, 10);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'PRICE_UNKNOWN');
});

test('全部路由失败 → SAFE_PAUSE，绝不自动启用未授权模型', async () => {
  const r = routerWith({ script: { worker: [{ statusCode: 400, errorCode: 'BAD_REQUEST' }], code_specialist: [{ statusCode: 400, errorCode: 'BAD_REQUEST' }], fallback: [{ statusCode: 400, errorCode: 'BAD_REQUEST' }] } });
  const out = await r.runChain('normal', { inputTokens: 10, maxOutputTokens: 10 });
  assert.equal(out.status, 'EXHAUSTED');
  assert.equal(out.action, 'SAFE_PAUSE');
});

test('DSH 真实适配器：未接通就明确抛 NOT_CONNECTED，不返回假成功', async () => {
  const d = new DshAdapter();
  await assert.rejects(() => d.invoke({}), (e) => e.code === 'NOT_CONNECTED');
  assert.equal(d.capabilities().connected, false);
  const c = await d.cancel('r1');
  assert.equal(c.ok, false);
});

// ───────────────────────── RunStore ─────────────────────────

test('RunStore：原子写、事件 seq 单调、证据哈希可校验、篡改可发现', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdd-runs-'));
  const store = new RunStore(root);
  const { runId } = store.createRun({ cardId: 'x.y' });
  store.writeSpec(runId, { cardId: 'x.y', canonicalSha256: 'a'.repeat(64) });
  const e1 = store.appendEvent(runId, { type: 'a' });
  const e2 = store.appendEvent(runId, { type: 'b' });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  const put = store.putEvidence(runId, 'snap.json', '{"hello":1}');
  assert.equal(store.verifyEvidence(runId, put.ref, put.sha256), true);
  const abs = path.join(store.dir(runId), ...put.ref.split('/'));
  fs.writeFileSync(abs, '{"hello":2}');
  assert.equal(store.verifyEvidence(runId, put.ref, put.sha256), false);
  store.writeReport(runId, { runId, verdict: 'INCONCLUSIVE', flags: [], reasons: [], calls: [], evidence: {} });
  const back = store.readRun(runId);
  assert.equal(back.spec.cardId, 'x.y');
  assert.equal(back.events.length, 2);
  assert.match(fs.readFileSync(path.join(store.dir(runId), 'report.md'), 'utf8'), /INCONCLUSIVE/);
  assert.equal(store.listRuns()[0].runId, runId);
});

// ───────────────────────── registry 相对路径 ─────────────────────────

test('registry：路径是相对 RDD 根，加载后解析成绝对路径', () => {
  const reg = registryLib.load();
  assert.equal(reg.version, 2);
  for (const [k, v] of Object.entries(reg.roots)) {
    assert.equal(path.isAbsolute(reg.rootsRaw[k]), false, `roots.${k} 应当相对`);
    assert.equal(path.isAbsolute(v), true, `roots.${k} 解析后应当绝对`);
  }
  assert.equal(path.basename(reg.roots.harness), 'rdd-harness');
  assert.equal(fs.existsSync(reg.roots.harness), true);
});

test('registry：RDD_ROOT 环境变量可以整体搬家（换机器/临时副本）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdd-root-'));
  const old = process.env.RDD_ROOT;
  try {
    process.env.RDD_ROOT = tmp;
    const reg = registryLib.load();
    assert.equal(reg.roots.workspace, path.join(tmp, 'workspace'));
    assert.equal(reg._meta.envApplied, true);
  } finally {
    if (old === undefined) delete process.env.RDD_ROOT; else process.env.RDD_ROOT = old;
  }
});

test('registry：registerIn 的“§补注”不被当成路径的一部分', () => {
  const reg = registryLib.load();
  const entry = reg.docNumbers.registerIn[0];
  assert.ok(entry.includes('§二目录表'));
  const pathPart = entry.split(/[ §（(]/)[0].trim();
  assert.equal(registryLib.splitAnnotation(reg.docNumbersRaw.registerIn[0]).suffix.trim().startsWith('§'), true);
  assert.equal(path.isAbsolute(pathPart), true);
});
