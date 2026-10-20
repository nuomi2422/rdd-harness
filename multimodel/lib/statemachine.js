'use strict';
/**
 * statemachine.js —— run 生命周期状态机（设计草案 §5.1）
 *
 * 两条必须分开的东西：
 *   1. **生命周期状态**（本文件）：实验走到哪一步。
 *   2. **测试结果**（verdict.js）：实验的结论。
 *   `COMPLETED` 只表示「结束了」，不表示 PASS。把这两者混在一起，
 *   就会出现「跑完了 = 成功」这种最典型的假绿。
 *
 * 每次转换都记 reasonCode、前后状态、触发证据、deadline、ownerEpoch。
 * reasonCode 缺失直接抛错 —— 没有理由的状态迁移等于没记录。
 */

const STATE = {
  CREATED: 'CREATED',
  SPEC_VALIDATED: 'SPEC_VALIDATED',
  PREFLIGHT: 'PREFLIGHT',
  ENV_STARTING: 'ENV_STARTING',
  WORLD_READY: 'WORLD_READY',
  CAPABILITIES_READY: 'CAPABILITIES_READY',
  CONTROL_READY: 'CONTROL_READY',
  OBSERVATION_READY: 'OBSERVATION_READY',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  RECOVERING: 'RECOVERING',
  FINALIZING: 'FINALIZING',
  COMPLETED: 'COMPLETED',
  SAFE_PAUSED: 'SAFE_PAUSED',
  ABORTING: 'ABORTING',
};

const TRANSITIONS = {
  CREATED: ['SPEC_VALIDATED', 'SAFE_PAUSED', 'ABORTING'],
  SPEC_VALIDATED: ['PREFLIGHT', 'SAFE_PAUSED', 'ABORTING'],
  PREFLIGHT: ['ENV_STARTING', 'SAFE_PAUSED', 'ABORTING'],
  ENV_STARTING: ['WORLD_READY', 'SAFE_PAUSED', 'ABORTING'],
  WORLD_READY: ['CAPABILITIES_READY', 'SAFE_PAUSED', 'ABORTING'],
  CAPABILITIES_READY: ['CONTROL_READY', 'SAFE_PAUSED', 'ABORTING'],
  CONTROL_READY: ['OBSERVATION_READY', 'SAFE_PAUSED', 'ABORTING'],
  OBSERVATION_READY: ['EXECUTING', 'SAFE_PAUSED', 'ABORTING'],
  EXECUTING: ['VERIFYING', 'RECOVERING', 'SAFE_PAUSED', 'ABORTING'],
  VERIFYING: ['EXECUTING', 'RECOVERING', 'FINALIZING', 'SAFE_PAUSED', 'ABORTING'],
  RECOVERING: ['EXECUTING', 'VERIFYING', 'SAFE_PAUSED', 'ABORTING'],
  SAFE_PAUSED: ['FINALIZING', 'RECOVERING', 'ABORTING'],
  ABORTING: ['FINALIZING'],
  FINALIZING: ['COMPLETED'],
  COMPLETED: [],
};

class StateMachineError extends Error {
  constructor(message) { super(message); this.name = 'StateMachineError'; }
}

class RunStateMachine {
  constructor(options) {
    const o = options || {};
    this.runId = o.runId || 'run-unknown';
    this.state = o.initial || STATE.CREATED;
    this.ownerEpoch = o.ownerEpoch || 0;
    this.history = [{ at: new Date().toISOString(), from: null, to: this.state, reasonCode: 'INIT', ownerEpoch: this.ownerEpoch }];
    this.listeners = o.listeners || [];
  }

  can(to) {
    return (TRANSITIONS[this.state] || []).includes(to);
  }

  isTerminal() { return this.state === STATE.COMPLETED; }

  transition(to, meta) {
    const m = meta || {};
    if (!m.reasonCode) throw new StateMachineError(`状态迁移必须带 reasonCode（${this.state} → ${to}）`);
    if (!this.can(to)) throw new StateMachineError(`非法迁移：${this.state} → ${to}（允许：${(TRANSITIONS[this.state] || []).join(', ') || '无'}）`);
    const from = this.state;
    this.state = to;
    if (m.ownerEpoch !== undefined) this.ownerEpoch = m.ownerEpoch;
    const rec = {
      at: new Date().toISOString(),
      from, to,
      reasonCode: m.reasonCode,
      ownerEpoch: this.ownerEpoch,
      deadlineMs: m.deadlineMs,
      evidenceRefs: m.evidenceRefs || [],
    };
    this.history.push(rec);
    for (const fn of this.listeners) fn(rec);
    return rec;
  }
}

module.exports = { RunStateMachine, STATE, TRANSITIONS, StateMachineError };
