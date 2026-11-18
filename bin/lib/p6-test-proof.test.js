'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { p6TestProof } = require('./p6-test-proof');

const cls = 'com.example.SelectorTest';
const tests = [cls];
const proofPolicy = process.env.RDD_P6_TEST_POLICY;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdd-p6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'mutations');
  const mutationId = 'mutation-fixture';
  const attemptId = 'attempt-' + 'a'.repeat(32);
  const attemptDir = path.join(root, mutationId, attemptId);
  const reportDir = path.join(attemptDir, 'test-results');
  fs.mkdirSync(reportDir, { recursive: true });
  if (proofPolicy) {
    const scripts = path.join(dir, 'scripts');
    fs.mkdirSync(scripts);
    fs.copyFileSync(proofPolicy, path.join(scripts, 'test-only-policy.ps1'));
  }
  const sourceRoot = path.join(dir, 'source with spaces');
  const commit = 'e'.repeat(40);
  const module = 'plugins:thing';
  const now = Date.now();
  const start = now - 10_000;
  const end = now - 1_000;
  const statePath = path.join(attemptDir, 'phase-test.json');
  const pointerPath = path.join(root, mutationId, 'current-attempt.json');
  const xml = path.join(reportDir, 'TEST-' + cls + '.xml');
  const scope = { change: 'new-code', mutationsRoot: root, mutationId, attemptId, sourceRoot, commit, module, sinceMs: start - 1000 };
  const receipt = { attemptId, sourceRoot, module, reportDir, tests, expectedCommit: commit, sourceHead: commit,
    sourceHeadAfter: commit, sourceVerified: true, sourceProof: 'pre-post-checks-consistent', sourceDirtyCount: 0,
    sourceDirtyCountAfter: 0, stage: 'test-only', deployed: false, gradleExit: 0, status: 'passed', success: true,
    startedAt: new Date(start).toISOString(), finishedAt: new Date(end).toISOString() };
  const pointer = { attemptId, statePath, status: 'passed', success: true };
  const put = (file, object) => fs.writeFileSync(file, JSON.stringify(object));
  const write = (attrs = {}, close = '</testsuite>') => {
    const fields = { name: cls, tests: 1, failures: 0, errors: 0, skipped: 0, ...attrs };
    const startTag = Object.entries(fields).map(([k, v]) => k + '="' + v + '"').join(' ');
    fs.writeFileSync(xml, '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite ' + startTag
      + '><testcase classname="' + cls + '" name="case"/>' + close);
    fs.utimesSync(xml, new Date(start + 1000), new Date(start + 1000));
  };
  put(statePath, receipt);
  put(pointerPath, pointer);
  if (process.platform === 'win32') {
    // The writer/reader permit Windows separator differences in the same absolute path.
    receipt.sourceRoot = receipt.sourceRoot.replaceAll('\\', '/');
    put(statePath, receipt);
  }
  write();
  return { scope, receipt, pointer, statePath, pointerPath, put, write, xml, start, end, dir };
}

test('a confirmed unchanged continuation needs no receipt; unknown change status cannot pass', () => {
  assert.equal(p6TestProof({ change: 'verified-unchanged' }).state, 'SKIP');
  assert.equal(p6TestProof({}).state, 'BLOCK');
  assert.equal(p6TestProof({ change: 'new-code' }).state, 'BLOCK');
});

test('source, module, selected attempt, and mutation are all required to match', t => {
  const f = fixture(t);
  for (const [change, reason] of [
    [{ sourceRoot: f.scope.sourceRoot + '-old' }, 'receipt-scope-mismatch'],
    [{ commit: 'd'.repeat(40) }, 'receipt-scope-mismatch'],
    [{ module: 'plugins:other' }, 'receipt-scope-mismatch'],
    [{ attemptId: 'attempt-' + 'b'.repeat(32) }, 'test-evidence-unavailable'],
    [{ mutationId: 'mutation-other' }, 'test-evidence-unavailable'],
  ]) assert.equal(p6TestProof({ ...f.scope, ...change }).reason, reason);
  for (const key of ['expectedCommit', 'sourceHead', 'sourceHeadAfter']) {
    f.put(f.statePath, { ...f.receipt, [key]: 'b'.repeat(40) });
    assert.equal(p6TestProof(f.scope).reason, 'receipt-scope-mismatch');
  }
});

test('superseded or pending pointer cannot be rescued by a passing receipt', t => {
  const f = fixture(t);
  for (const change of [{ attemptId: 'attempt-' + 'b'.repeat(32) }, { status: 'pending', success: false }]) {
    f.put(f.pointerPath, { ...f.pointer, ...change });
    assert.equal(p6TestProof(f.scope).reason, 'attempt-not-current-passed');
  }
});

test('unverified, nonzero, or dirty result cannot be rescued by an XML', t => {
  const f = fixture(t);
  for (const change of [{ sourceVerified: false }, { sourceProof: 'pre-check-only' },
    { sourceDirtyCountAfter: 1 }, { gradleExit: 1 }, { status: 'pending', success: false }]) {
    f.put(f.statePath, { ...f.receipt, ...change });
    assert.equal(p6TestProof(f.scope).reason, 'receipt-not-verified-passed');
  }
});

test('empty class list, missing XML, old XML, future XML and an earlier batch do not pass', t => {
  const f = fixture(t);
  f.put(f.statePath, { ...f.receipt, tests: [] });
  assert.equal(p6TestProof(f.scope).reason, 'receipt-missing-exact-test-classes');
  f.put(f.statePath, f.receipt);
  assert.equal(p6TestProof({ ...f.scope, sinceMs: f.start + 1 }).reason, 'receipt-outside-batch-window');
  for (const time of [f.start - 1000, f.end + 1000]) {
    fs.utimesSync(f.xml, new Date(time), new Date(time));
    assert.equal(p6TestProof(f.scope).reason, 'report-outside-attempt-window');
  }
  fs.unlinkSync(f.xml);
  assert.equal(p6TestProof(f.scope).reason, 'test-evidence-unavailable');
});

test('reportDir from another attempt is not trusted', t => {
  const f = fixture(t);
  f.put(f.statePath, { ...f.receipt, reportDir: path.join(f.dir, 'other-test-results') });
  assert.equal(p6TestProof(f.scope).reason, 'receipt-scope-mismatch');
});

const managedOnly = { skip: !proofPolicy || process.platform !== 'win32'
  ? 'set RDD_P6_TEST_POLICY to the managed test-only-policy.ps1 on Windows' : false };
test('managed verifier accepts only the requested suite despite unrelated old failures', managedOnly, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'TEST-unrelated.xml'), '<testsuite tests="1" failures="1" errors="0"/>');
  fs.writeFileSync(path.join(path.dirname(f.xml), 'TEST-unselected.xml'), '<testsuite tests="1" failures="1" errors="0"/>');
  const result = p6TestProof(f.scope);
  assert.equal(result.state, 'PASS', result.detail);
});

test('managed verifier rejects zero, failure, error, all skipped, wrong suite and malformed XML', managedOnly, t => {
  const f = fixture(t);
  for (const [attributes, close, reason] of [
    [{ tests: 0 }, undefined, 'test-failed-or-empty'], [{ failures: 1 }, undefined, 'test-failed-or-empty'],
    [{ errors: 1 }, undefined, 'test-failed-or-empty'], [{ skipped: 1 }, undefined, 'test-failed-or-empty'],
    [{ name: 'other.Suite' }, undefined, 'wrong-suite'], [{}, '</not-a-suite>', 'bad-xml'],
  ]) {
    f.write(attributes, close);
    const result = p6TestProof(f.scope);
    assert.equal(result.reason, 'managed-xml-rejected');
    assert.equal(result.detail, reason + ':' + cls);
  }
});
