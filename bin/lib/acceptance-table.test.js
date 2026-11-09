'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AT = require('./acceptance-table');

const card = (over) => ({ finalRequest: { status: 'PRESENT', total: 2, delivered: '2/2' },
  settle: { status: 'PRESENT', coverage: { judged: '1/1' } }, ...(over || {}) });
const ev = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');

test('全部达标 → MATCH', () => {
  const res = AT.build(card(), {
    events: ev([{ type: 'knowledge_gap', data: { reason: 'body-missing' } }, { type: 'side_context', data: { status: 'UNKNOWN' } }]),
    rdd: '',
  });
  assert.equal(res.overall, 'MATCH');
});

test('why 未全覆盖 → MISMATCH', () => {
  const res = AT.build(card({ finalRequest: { status: 'PARTIAL', total: 2, delivered: '1/2' } }), { events: '', rdd: '' });
  assert.equal(res.overall, 'MISMATCH');
  assert.equal(res.rows.find((r) => r.id === 'R1').verdict, 'MISMATCH');
});

test('缺数据 → UNKNOWN，不算通过', () => {
  const res = AT.build({ finalRequest: { status: 'UNKNOWN' }, settle: { status: 'UNKNOWN' } }, { events: '', rdd: '' });
  assert.equal(res.overall, 'UNKNOWN');
});

test('SIDE_CONTEXT 声称身份已验证 → MISMATCH', () => {
  const res = AT.build(card(), {
    events: ev([{ type: 'knowledge_gap', data: { reason: 'read-failed' } }, { type: 'side_context', data: { identityVerified: true } }]),
    rdd: '',
  });
  assert.equal(res.rows.find((r) => r.id === 'R4').verdict, 'MISMATCH');
});

test('knowledge_gap 形状不全 → MISMATCH', () => {
  const res = AT.build(card(), { events: ev([{ type: 'knowledge_gap', data: {} }]), rdd: '' });
  assert.equal(res.rows.find((r) => r.id === 'R3').verdict, 'MISMATCH');
});
