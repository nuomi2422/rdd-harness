'use strict';
/**
 * capabilities.js —— 声明 / 发现 / 生效，三者必须一致（设计草案 §4）
 *
 *   REGISTERED  在表里（静态声明）
 *   DISCOVERED  运行时真的暴露了（MCP tools/list、插件版本、相机状态）
 *   HEALTHY     无副作用行为探针通过
 *   DISABLED    明确不可用（未实现 / 未接线 / 探针失败后人工停用）
 *
 * 任务只能调用同时满足版本、权限、健康与作用域要求的能力。
 * ★ 「名字像」永远不构成可用性：文本模型不因为叫 GLM 就被当作视觉模型，
 *    这条规则在 router.js 里同样成立。
 */

const fs = require('fs');
const path = require('path');

const MMM = path.resolve(__dirname, '..');
const STATES = { REGISTERED: 'REGISTERED', DISCOVERED: 'DISCOVERED', HEALTHY: 'HEALTHY', DISABLED: 'DISABLED' };

function loadCatalog(file) {
  const f = file || path.join(MMM, 'capabilities.json');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  const capabilities = {};
  for (const c of raw.capabilities || []) capabilities[c.capabilityId] = Object.assign({}, c);
  const predicates = {};
  for (const p of raw.predicates || []) predicates[p.predicate] = Object.assign({}, p);
  return { raw, capabilities, predicates, version: raw.version || 1, file: f };
}

class CapabilityRegistry {
  constructor(catalog) {
    this.catalog = catalog || loadCatalog();
    this.state = {};
    this.evidence = {};
    for (const [id, c] of Object.entries(this.catalog.capabilities)) {
      this.state[id] = c.status === 'disabled' ? STATES.DISABLED : STATES.REGISTERED;
    }
  }

  /** 运行时发现：只有明确报告「暴露了」才升级状态 */
  discover(id, info) {
    if (!(id in this.state)) throw new Error(`未声明的能力：${id}`);
    if (this.state[id] === STATES.DISABLED) return this.state[id];
    this.state[id] = STATES.DISCOVERED;
    this.evidence[id] = Object.assign({ discoveredAt: new Date().toISOString() }, info || {});
    return this.state[id];
  }

  /** 行为探针：无副作用调用通过才算 HEALTHY */
  markProbe(id, ok, detail) {
    if (!(id in this.state)) throw new Error(`未声明的能力：${id}`);
    if (this.state[id] === STATES.DISABLED) return this.state[id];
    if (ok) {
      this.state[id] = STATES.HEALTHY;
      this.evidence[id] = Object.assign(this.evidence[id] || {}, { probedAt: new Date().toISOString(), probe: detail || 'ok' });
    } else {
      this.state[id] = STATES.REGISTERED;
      this.evidence[id] = Object.assign(this.evidence[id] || {}, { probedAt: new Date().toISOString(), probe: detail || 'failed' });
    }
    return this.state[id];
  }

  disable(id, why) {
    this.state[id] = STATES.DISABLED;
    this.evidence[id] = Object.assign(this.evidence[id] || {}, { disabledAt: new Date().toISOString(), why: why || '' });
  }

  stateOf(id) {
    if (!(id in this.state)) return 'UNKNOWN';
    return this.state[id];
  }

  /**
   * 任务能不能开跑。返回结构化的缺口，**不返回布尔** —— 「缺什么」比「不行」有用得多。
   * healthy 模式下要求 HEALTHY；只读骨架阶段允许 requireDiscovered 放宽到 DISCOVERED。
   */
  checkRequires(ids, opts) {
    const options = opts || {};
    const min = options.minState || STATES.HEALTHY;
    const order = [STATES.DISABLED, 'UNKNOWN', STATES.REGISTERED, STATES.DISCOVERED, STATES.HEALTHY];
    const rank = (s) => order.indexOf(s);
    const missing = [];
    const disabled = [];
    const unknown = [];
    const unhealthy = [];
    for (const id of ids || []) {
      const s = this.stateOf(id);
      if (s === 'UNKNOWN') { unknown.push(id); continue; }
      if (s === STATES.DISABLED) { disabled.push(id); continue; }
      if (rank(s) < rank(min)) { unhealthy.push({ id, state: s, need: min }); continue; }
    }
    return {
      ok: !missing.length && !disabled.length && !unknown.length && !unhealthy.length,
      unknown,
      disabled,
      unhealthy,
      missing,
    };
  }

  predicates() { return this.catalog.predicates; }
  predicate(id) { return this.catalog.predicates[id]; }
  all() {
    return Object.entries(this.catalog.capabilities).map(([id, c]) => Object.assign({}, c, { state: this.stateOf(id), evidence: this.evidence[id] || null }));
  }
}

module.exports = { CapabilityRegistry, loadCatalog, STATES, MMM };
