'use strict';
/**
 * router.js —— 模型路由、预算预留、退避、升级（设计草案 §3）
 *
 * 三条铁律：
 *   1. **能力决定路由**：角色能不能用，取决于探针通过的能力集合，
 *      不取决于商品名。文本 GLM 不因为叫 GLM 就被塞进视觉链。
 *   2. **预算原子预留**：并发任务不能各自看到同一份剩余预算然后各花一份。
 *   3. **一切都是可失败的有界调用**：401/403 熔断、402 换预授权路由、
 *      429/5xx 退避重试、超时先取消再发新的 —— 旧回答永远不可提交。
 *
 * 真实 DSH 适配器未接通（adapters/dsh.js 明确抛 NOT_CONNECTED）。
 * 本文件只提供契约与确定性行为，mock 适配器负责离线验证这些行为。
 */

const fs = require('fs');
const path = require('path');
const { parseYaml } = require('./yaml.js');

const MMM = path.resolve(__dirname, '..');

const ERROR_CLASS = {
  AUTH: 'AUTH',
  QUOTA: 'QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  SERVER: 'SERVER',
  BAD_REQUEST: 'BAD_REQUEST',
  FORMAT: 'FORMAT',
  NOT_CONNECTED: 'NOT_CONNECTED',
  BLOCKED: 'BLOCKED',
  UNKNOWN: 'UNKNOWN',
};

function classifyError(status, code) {
  if (code === 'NOT_CONNECTED') return ERROR_CLASS.NOT_CONNECTED;
  if (code === 'TIMEOUT') return ERROR_CLASS.TIMEOUT;
  if (code === 'FORMAT') return ERROR_CLASS.FORMAT;
  if (status === 401 || status === 403) return ERROR_CLASS.AUTH;
  if (status === 402) return ERROR_CLASS.QUOTA;
  if (status === 429) return ERROR_CLASS.RATE_LIMIT;
  if (status >= 500 && status <= 599) return ERROR_CLASS.SERVER;
  if (status >= 400 && status < 500) return ERROR_CLASS.BAD_REQUEST;
  return ERROR_CLASS.UNKNOWN;
}

function loadPolicies(options) {
  const o = options || {};
  const routingFile = o.routingFile || path.join(MMM, 'policies', 'model-routing.yaml');
  const budgetFile = o.budgetFile || path.join(MMM, 'policies', 'budgets.yaml');
  const routing = parseYaml(fs.readFileSync(routingFile, 'utf8'));
  const budgets = {};
  for (const doc of [{ file: budgetFile }]) {
    const b = parseYaml(fs.readFileSync(doc.file, 'utf8'));
    if (b.kind === 'BudgetPolicy') budgets[b.metadata.id] = b;
  }
  if (o.extraBudgetFiles) {
    for (const f of o.extraBudgetFiles) {
      const b = parseYaml(fs.readFileSync(f, 'utf8'));
      budgets[b.metadata.id] = b;
    }
  }
  return { routing, budgets };
}

class BudgetLedger {
  constructor(policy) {
    if (!policy) throw new Error('BudgetLedger 需要一份 BudgetPolicy');
    this.policy = policy;
    this.total = policy.total;
    this.spent = 0;
    this.reservations = new Map();
    this.roleUsage = {};
    this.events = [];
    this.seq = 0;
  }

  roleOf(name) {
    const r = (this.policy.roles || {})[name];
    return r || { maxCalls: 0, maxCost: 0, maxTokens: 0 };
  }

  usage(role) {
    return this.roleUsage[role] || (this.roleUsage[role] = { calls: 0, cost: 0, tokens: 0 });
  }

  priceOf(modelRef) {
    const t = this.policy.priceTable || {};
    const e = (t.entries || {})[modelRef];
    return e || null;
  }

  /** 估算一次调用的最大花费；价格未知返回 null（不许绕过金额预算） */
  estimate(modelRef, inputTokens, maxOutputTokens) {
    const p = this.priceOf(modelRef);
    if (!p) return null;
    const factor = ((this.policy.reservation || {}).safetyFactor) || 1;
    return ((inputTokens / 1e6) * p.inputPerMTok + (maxOutputTokens / 1e6) * p.outputPerMTok) * factor;
  }

  reservedTotal() {
    let s = 0;
    for (const r of this.reservations.values()) s += r.amount;
    return s;
  }

  remaining() {
    return this.total - this.spent - this.reservedTotal();
  }

  reserve(role, modelRef, inputTokens, maxOutputTokens) {
    const amount = this.estimate(modelRef, inputTokens, maxOutputTokens);
    const id = `rsv-${++this.seq}`;
    const u = this.usage(role);
    const limit = this.roleOf(role);
    if (amount === null) return { ok: false, reason: 'PRICE_UNKNOWN', id: null, detail: `没有 ${modelRef} 的价格，且策略禁止未定价调用` };
    if (u.calls >= limit.maxCalls) return { ok: false, reason: 'ROLE_CALL_LIMIT', id: null, detail: `${role} 调用次数已达上限 ${limit.maxCalls}` };
    if (u.cost + amount > limit.maxCost) return { ok: false, reason: 'ROLE_COST_LIMIT', id: null, detail: `${role} 费用上限 ${limit.maxCost}，本次需 ${amount.toFixed(4)}` };
    if (amount > this.remaining()) return { ok: false, reason: 'BUDGET_EXHAUSTED', id: null, detail: `剩余预算 ${this.remaining().toFixed(4)} < 预留 ${amount.toFixed(4)}` };
    this.reservations.set(id, { role, modelRef, amount, at: new Date().toISOString() });
    this.events.push({ at: new Date().toISOString(), kind: 'reserve', id, role, amount });
    return { ok: true, id, amount };
  }

  settle(id, usage, usageSource) {
    const r = this.reservations.get(id);
    if (!r) return { ok: false, reason: 'UNKNOWN_RESERVATION' };
    this.reservations.delete(id);
    const cost = usage && typeof usage.cost === 'number' ? usage.cost : r.amount;
    const tokens = usage ? (usage.inputTokens || 0) + (usage.outputTokens || 0) : 0;
    this.spent += cost;
    const u = this.usage(r.role);
    u.calls += 1;
    u.cost += cost;
    u.tokens += tokens;
    this.events.push({ at: new Date().toISOString(), kind: 'settle', id, role: r.role, cost, usageSource: usageSource || 'unknown' });
    return { ok: true, cost, spent: this.spent, remaining: this.remaining() };
  }

  release(id) {
    const r = this.reservations.get(id);
    if (!r) return { ok: false, reason: 'UNKNOWN_RESERVATION' };
    this.reservations.delete(id);
    this.events.push({ at: new Date().toISOString(), kind: 'release', id, role: r.role });
    return { ok: true };
  }

  snapshot() {
    return {
      total: this.total, spent: +this.spent.toFixed(6), reserved: +this.reservedTotal().toFixed(6),
      remaining: +this.remaining().toFixed(6), roles: JSON.parse(JSON.stringify(this.roleUsage)),
      events: this.events.slice(),
    };
  }
}

class ModelRouter {
  /**
   * @param {object} opts
   *   routing / budgets        loadPolicies() 的产物
   *   modelCapabilities        { modelRef: ['text','tools','vision','image_input',...] }  ← 探针结果，不是猜测
   *   adapters                 { adapterId: { invoke(req), cancel(requestId) } }
   *   disabledRoles            Set<string>
   *   sleep                    (ms)=>void（测试注入，避免真等）
   */
  constructor(opts) {
    const o = opts || {};
    const policies = o.routing && o.budgets ? { routing: o.routing, budgets: o.budgets } : loadPolicies(o);
    this.routing = policies.routing;
    this.budgets = policies.budgets;
    this.modelCapabilities = o.modelCapabilities || {};
    this.adapters = o.adapters || {};
    this.disabledRoles = new Set(o.disabledRoles || []);
    this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ledger = o.ledger || new BudgetLedger(o.budgetId ? this.budgets[o.budgetId] : this.firstBudget());
    this.attemptsBySignature = new Map();
    this.circuitOpen = new Set();
    this.calls = [];
  }

  firstBudget() {
    const ids = Object.keys(this.budgets);
    if (!ids.length) throw new Error('没有任何 BudgetPolicy');
    return this.budgets[ids[0]];
  }

  capabilitiesOf(modelRef) {
    return new Set(this.modelCapabilities[modelRef] || []);
  }

  roleViable(roleName) {
    const role = (this.routing.roles || {})[roleName];
    if (!role) return { ok: false, reason: 'ROLE_UNKNOWN' };
    if (this.disabledRoles.has(roleName)) return { ok: false, reason: 'ROLE_DISABLED' };
    if (this.circuitOpen.has(role.provider)) return { ok: false, reason: 'PROVIDER_CIRCUIT_OPEN' };
    const caps = this.capabilitiesOf(role.modelRef);
    const lack = (role.requiredCapabilities || []).filter((c) => !caps.has(c));
    if (lack.length) return { ok: false, reason: 'ROLE_CAPABILITY_MISSING', detail: lack.join(',') };
    return { ok: true, role };
  }

  /**
   * 视觉链的额外门槛：**不管角色自己声明什么，必须探针给过 vision + image_input**。
   * 这条是「文本 GLM 不因名字相似就被当作视觉模型」的执行点：
   * fallback 角色平时只要 text/tools，但被拉进视觉链时必须另有图像能力探针通过。
   */
  roleViableFor(kind, roleName) {
    const v = this.roleViable(roleName);
    if (!v.ok) return v;
    if (kind === 'vision') {
      const caps = this.capabilitiesOf(v.role.modelRef);
      const lack = ['vision', 'image_input'].filter((c) => !caps.has(c));
      if (lack.length) return { ok: false, reason: 'ROLE_NOT_VISUAL', detail: `探针未确认图像能力：${lack.join(',')}` };
    }
    return v;
  }

  /** kind: normal | code | vision。返回可用角色名数组（按策略顺序） */
  chainFor(kind) {
    const chain = (this.routing.chains || {})[kind] || [];
    return chain.filter((r) => this.roleViableFor(kind, r).ok);
  }

  /**
   * 有界升级链。每个角色最多 role.maxAttempts 次；相同错误签名重复
   * maxSameErrorSignatureRepeats 次就停止原地重试，换下一个角色。
   * 全部走完仍失败 → 返回 { status:'EXHAUSTED', action:'SAFE_PAUSE' }（绝不自动启用未授权高价模型）。
   */
  async runChain(kind, payload, options) {
    const o = options || {};
    const wanted = (this.routing.chains || {})[kind] || [];
    const records = [];
    for (const roleName of wanted) {
      const viable = this.roleViableFor(kind, roleName);
      if (!viable.ok) {
        records.push({ role: roleName, status: 'SKIPPED', reason: viable.reason, detail: viable.detail });
        continue;
      }
      const role = viable.role;
      const maxAttempts = role.maxAttempts || 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const r = await this.invoke(roleName, payload, { attempt, kind });
        records.push(r);
        if (r.status === 'OK') return { status: 'OK', records, used: roleName, attemptCount: attempt };
        if (r.errorClass === ERROR_CLASS.AUTH) {
          this.circuitOpen.add(role.provider);
          return { status: 'BLOCKED', records, action: 'SAFE_PAUSE', reason: 'PROVIDER_AUTH_FAILURE' };
        }
        if (r.errorClass === ERROR_CLASS.QUOTA) {
          records.push({ role: roleName, status: 'SKIPPED', reason: 'PROVIDER_QUOTA' });
          break; // 不重试同一请求，交给下一个预授权角色
        }
        if (r.errorClass === ERROR_CLASS.RATE_LIMIT || r.errorClass === ERROR_CLASS.SERVER) {
          if (attempt < maxAttempts) {
            const backoff = this.backoffMs(attempt);
            records.push({ role: roleName, status: 'BACKOFF', ms: backoff });
            await this.sleep(backoff);
            continue;
          }
        }
        if (r.errorClass === ERROR_CLASS.TIMEOUT && r.canceled !== true) {
          records.push({ role: roleName, status: 'CANCEL_REQUESTED', detail: '超时后必须先取消，旧回答不可提交' });
        }
        const sig = `${r.errorClass}:${r.status}`;
        const n = (this.attemptsBySignature.get(sig) || 0) + 1;
        this.attemptsBySignature.set(sig, n);
        if (n >= ((this.routing.limits || {}).maxSameErrorSignatureRepeats || 2)) {
          records.push({ role: roleName, status: 'STOP_RETRY', reason: 'SAME_ERROR_SIGNATURE_REPEATED', signature: sig });
          break;
        }
      }
    }
    return { status: 'EXHAUSTED', records, action: 'SAFE_PAUSE', reason: 'ALL_ROUTES_FAILED' };
  }

  backoffMs(attempt) {
    const l = (this.routing.limits || {}).retry || {};
    const base = l.baseMs || 500;
    const jitter = l.jitterRatio || 0;
    // 确定性抖动：用 attempt 而不是随机数，便于复现
    return Math.round(base * Math.pow(2, attempt - 1) * (1 + jitter * ((attempt % 3) / 3)));
  }

  async invoke(roleName, payload, options) {
    const o = options || {};
    const viable = this.roleViableFor(o.kind || null, roleName);
    if (!viable.ok) {
      return { status: 'BLOCKED', role: roleName, reasonCode: viable.reason, detail: viable.detail || '', errorClass: ERROR_CLASS.BLOCKED };
    }
    const role = viable.role;
    const adapter = this.adapters[role.adapter || role.provider];
    if (!adapter) {
      return { status: 'BLOCKED', invoked: false, role: roleName, provider: role.provider, modelRef: role.modelRef, reasonCode: 'ADAPTER_NOT_CONNECTED', errorClass: ERROR_CLASS.NOT_CONNECTED };
    }
    const inputTokens = (payload && payload.inputTokens) || 0;
    const maxOutputTokens = (payload && payload.maxOutputTokens) || 1000;
    const rsv = this.ledger.reserve(role.budgetRole || roleName, role.modelRef, inputTokens, maxOutputTokens);
    const record = {
      requestId: `req-${this.calls.length + 1}`,
      role: roleName, provider: role.provider, modelRef: role.modelRef,
      attempt: o.attempt || 1, kind: o.kind || 'normal',
      startedAt: new Date().toISOString(),
    };
    if (!rsv.ok) {
      this.calls.push(record);
      return Object.assign(record, {
        status: 'BLOCKED', invoked: false, reasonCode: rsv.reason, detail: rsv.detail,
        errorClass: rsv.reason === 'PRICE_UNKNOWN' ? ERROR_CLASS.BLOCKED : ERROR_CLASS.BLOCKED,
      });
    }
    record.reservationId = rsv.id;
    record.invoked = true;
    const t0 = Date.now();
    let out;
    try {
      out = await adapter.invoke({ role: roleName, modelRef: role.modelRef, payload: payload || {}, deadlineMs: (payload && payload.deadlineMs) || 30000 });
    } catch (e) {
      out = { status: 'FAILED', errorCode: e.code || 'UNKNOWN', message: e.message, canceled: e.canceled };
    }
    record.latencyMs = Date.now() - t0;
    const status = out.status || 'FAILED';
    if (status === 'OK') {
      const usageSource = out.usage ? 'provider' : 'estimate';
      const usage = out.usage || { inputTokens, outputTokens: maxOutputTokens, cost: rsv.amount, currency: this.ledger.policy.currency };
      this.ledger.settle(rsv.id, usage, usageSource);
      Object.assign(record, { status: 'OK', output: out.output, usage, usageSource });
    } else {
      this.ledger.release(rsv.id);
      Object.assign(record, {
        status, errorClass: classifyError(out.statusCode, out.errorCode),
        reasonCode: out.errorCode || 'ADAPTER_FAILED', detail: out.message || '',
        canceled: out.canceled === true,
      });
    }
    this.calls.push(record);
    return record;
  }
}

module.exports = { ModelRouter, BudgetLedger, loadPolicies, classifyError, ERROR_CLASS };
