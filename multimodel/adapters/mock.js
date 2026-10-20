'use strict';
/**
 * adapters/mock.js —— 离线 mock 适配器
 *
 * 用途只有一个：**在没有游戏、没有真模型、没有 DSH 接口的情况下，验证
 * 路由/预算/裁决的行为是不是设计里写的那样**。它绝不用于生成「实机已通过」。
 *
 * 每个角色一个脚本队列；脚本项可以是：
 *   { status:'OK', output:{...}, usage:{inputTokens,outputTokens,cost,currency} }
 *   { statusCode: 429, errorCode:'RATE_LIMITED', message:'...' }   → 走退避
 *   { statusCode: 402, ... }                                        → 配额
 *   { statusCode: 401, ... }                                        → 熔断
 *   { errorCode:'TIMEOUT', statusCode:null, canceled:false }        → 超时
 */

class MockAdapter {
  constructor(script, id) {
    this.script = script || {};
    this.id = id || 'mock';
    this.cursor = {};
    this.canceled = [];
    this.calls = [];
  }

  async invoke(request) {
    const role = request.role;
    const list = this.script[role] || this.script['*'] || [];
    const i = this.cursor[role] || 0;
    this.cursor[role] = i + 1;
    const step = list.length ? list[Math.min(i, list.length - 1)] : { status: 'OK', output: { text: '（mock 默认回复）' } };
    this.calls.push({ role, modelRef: request.modelRef, step });
    if (step.statusCode || step.errorCode) {
      return {
        status: step.errorCode === 'TIMEOUT' ? 'TIMED_OUT' : 'FAILED',
        statusCode: step.statusCode,
        errorCode: step.errorCode || 'HTTP_' + step.statusCode,
        message: step.message || `mock 注入错误 ${step.statusCode || step.errorCode}`,
        canceled: step.canceled === true,
      };
    }
    return { status: 'OK', output: step.output, usage: step.usage };
  }

  async cancel(requestId) {
    this.canceled.push(requestId);
    return { ok: true, requestId };
  }
}

module.exports = { MockAdapter };
