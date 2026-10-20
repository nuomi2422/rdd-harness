'use strict';
/**
 * adapters/dsh.js —— 真实 DSH 模型调用适配器（**未接通**）
 *
 * 设计草案 §1.2 明确要求：本会话工具里能看到「按 provider/model 指定子任务模型」
 * 的编排描述，但这**不证明**已有可供 RDD 长期后台直接调用的稳定 SDK/HTTP 接口。
 *
 * 所以这里不猜接口、不偷偷直连别家、也不返回假成功 —— 它只会抛 NOT_CONNECTED，
 * 并把「M0 必须先记录哪四件事」写在错误信息里。
 */

class NotConnectedError extends Error {
  constructor(detail) {
    super('DSH 真实模型调用接口未核验：' + (detail || 'M0 尚未完成'));
    this.name = 'NotConnectedError';
    this.code = 'NOT_CONNECTED';
  }
}

const M0_CHECKLIST = [
  '当前 DSH 版本号与打包形态（是否可用 SDK / HTTP / stdio）',
  'provider / model 的真实枚举（不是商品名推断）',
  '图片传输格式（能否真的把图片字节送到模型，而不是只给本地路径）',
  '取消语义与用量返回格式（inputTokens/outputTokens/cost/currency 从哪来）',
];

class DshAdapter {
  constructor(options) {
    this.options = options || {};
  }

  capabilities() {
    return { connected: false, reason: 'NOT_CONNECTED', checklist: M0_CHECKLIST };
  }

  async invoke() {
    throw new NotConnectedError(M0_CHECKLIST.join('；'));
  }

  async cancel() {
    // 连不上就没有可取消的请求 —— 不能报「已取消」假装有语义
    return { ok: false, reason: 'NOT_CONNECTED' };
  }
}

module.exports = { DshAdapter, NotConnectedError, M0_CHECKLIST };
