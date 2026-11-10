'use strict';
/**
 * R-06 回执门（runner 与测试共用）：MCP content JSON 解析通过 ≠ 业务成功。
 * delivery 白名单（命令只认 SEEN）、目标 UUID 相等、身份/字段类型、epoch 严格安全非负整数。
 */
function validateReceipt(receipt, selectedUuid) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'not-object' };
  if (receipt.delivery !== 'SEEN') return { ok: false, reason: 'delivery-not-seen' };
  if (typeof receipt.commandId !== 'string' || receipt.commandId.length === 0) {
    return { ok: false, reason: 'no-command-id' };
  }
  if (typeof receipt.companionUuid !== 'string' || !selectedUuid
      || receipt.companionUuid.toLowerCase() !== String(selectedUuid).toLowerCase()) {
    return { ok: false, reason: 'companion-uuid-mismatch' };
  }
  if (receipt.identityStatus !== 'OK') return { ok: false, reason: 'identity-not-ok' };
  if (typeof receipt.worldId !== 'string' || receipt.worldId.length === 0) {
    return { ok: false, reason: 'no-world-id' };
  }
  if (typeof receipt.serverSession !== 'string' || receipt.serverSession.length === 0) {
    return { ok: false, reason: 'no-server-session' };
  }
  if (typeof receipt.epoch !== 'number' || !Number.isSafeInteger(receipt.epoch) || receipt.epoch < 0) {
    return { ok: false, reason: 'epoch-invalid' };
  }
  return { ok: true, reason: 'ok' };
}

module.exports = { validateReceipt };
