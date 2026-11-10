'use strict';
/** R-07: MCP content JSON -> runner gate. Parsing success is not business success. */
const test = require('node:test');
const assert = require('node:assert');
const { validateReceipt } = require('./stop-receipt');

const UUID = 'a43d753e-790d-472b-8d5b-dc18ac0afbc0';
const good = {
  delivery: 'SEEN', commandId: 'cmd-1', companionUuid: UUID, identityStatus: 'OK',
  worldId: 'world-A', serverSession: 'session-A', epoch: 7,
};

test('valid MCP receipt passes the gate', () => {
  assert.equal(validateReceipt(good, UUID).ok, true);
});

test('delivery must be SEEN (business acceptance, not any enum)', () => {
  for (const d of ['QUEUED', 'HANDED_OFF', 'TO_EXTERNAL_BRAIN', 'REJECTED', undefined]) {
    assert.equal(validateReceipt({ ...good, delivery: d }, UUID).ok, false, String(d));
  }
});

test('companion UUID must equal the selected companion', () => {
  assert.equal(validateReceipt({ ...good, companionUuid: 'other' }, UUID).ok, false);
  assert.equal(validateReceipt({ ...good, companionUuid: undefined }, UUID).ok, false);
});

test('epoch must be a safe non-negative number, not a string/null', () => {
  for (const ep of ['7', null, undefined, true, 7.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateReceipt({ ...good, epoch: ep }, UUID).ok, false, String(ep));
  }
});

test('identity/world/session must be present and typed', () => {
  assert.equal(validateReceipt({ ...good, identityStatus: 'NO_IDENTITY' }, UUID).ok, false);
  assert.equal(validateReceipt({ ...good, worldId: '' }, UUID).ok, false);
  assert.equal(validateReceipt({ ...good, serverSession: 42 }, UUID).ok, false);
  assert.equal(validateReceipt({ ...good, commandId: '' }, UUID).ok, false);
});

test('MCP text envelope: JSON.parse then gate (same path runner uses)', () => {
  const out = JSON.stringify(good); // numen-mcp prints content text
  const parsed = JSON.parse(out);
  assert.equal(validateReceipt(parsed, UUID).ok, true);
});
