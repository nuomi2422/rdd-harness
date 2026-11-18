'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const samePath = (a, b) => {
  if (typeof a !== 'string' || !path.isAbsolute(a)) return false;
  const norm = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return norm(a) === norm(b);
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const blocked = (reason, detail = reason) => ({ state: 'BLOCK', reason, detail });

// Reuse the writer's full XML parser and suite/count rules. Importing this policy
// only defines functions; the invoked function reads just the selected reports.
function verifyReports(policyPath, reportDir, tests) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$input053 = $env:RDD_P6_XML_INPUT | ConvertFrom-Json',
    '. $input053.policyPath',
    '$result053 = Test-RddTestOnlyReceipt -ExitCode 0 -ReportDir $input053.reportDir -ExpectedTests @($input053.tests)',
    'if ($result053.ok -eq $true) { exit 0 }',
    '[Console]::WriteLine([string]$result053.reason)',
    'exit 1',
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, RDD_P6_XML_INPUT: JSON.stringify({ policyPath, reportDir, tests }) } });
  if (result.status === 0) return null;
  return result.status === 1 && result.stdout.trim() ? result.stdout.trim() : 'xml-verifier-unavailable';
}

/**
 * Call with change: 'new-code', the trusted rdd-selfcompile/mutations root, batch
 * mutationId/attemptId, independently selected sourceRoot/commit/module and a
 * batch sinceMs. Do not derive the expectations from the receipt being checked.
 * Call with change: 'verified-unchanged' only after independently confirming the
 * resumed run has the same source and installed jars. SKIP means no new test claim.
 * An unspecified mode is BLOCK; callers must not infer a skip from missing evidence.
 */
function p6TestProof(scope) {
  if (scope?.change === 'verified-unchanged')
    return { state: 'SKIP', reason: 'verified-unchanged', detail: '已确认本轮未改码、未换包；无需新测试票。' };
  if (scope?.change !== 'new-code') return blocked('test-scope-unknown');
  const { mutationsRoot, mutationId, attemptId, sourceRoot, commit, module, sinceMs } = scope;
  const sha = /^[0-9a-f]{40}$/i;
  if (typeof mutationsRoot !== 'string' || !path.isAbsolute(mutationsRoot)
      || typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)
      || typeof mutationId !== 'string' || !/^mutation-[\w-]+$/.test(mutationId)
      || typeof attemptId !== 'string' || !/^attempt-[a-f0-9]{32}$/.test(attemptId)
      || typeof module !== 'string' || !/^[\w-]+(?::[\w-]+)*$/.test(module)
      || typeof commit !== 'string' || !sha.test(commit)
      || !Number.isFinite(sinceMs) || sinceMs <= 0 || sinceMs > Date.now())
    return blocked('test-scope-incomplete');

  const matchesCommit = value => typeof value === 'string' && value.toLowerCase() === commit.toLowerCase();
  try {
    const mutation = path.join(fs.realpathSync(mutationsRoot), mutationId);
    const attempt = path.join(mutation, attemptId);
    const statePath = path.join(attempt, 'phase-test.json');
    const currentPath = path.join(mutation, 'current-attempt.json');
    const reportDir = path.join(attempt, 'test-results');
    const pinned = file => samePath(fs.realpathSync(file), file);
    if (![mutation, attempt, statePath, currentPath, reportDir].every(pinned)) return blocked('attempt-path-mismatch');
    const isCurrent = current => current?.attemptId === attemptId
      && samePath(current.statePath, statePath) && current.status === 'passed' && current.success === true;
    if (!isCurrent(readJson(currentPath))) return blocked('attempt-not-current-passed');
    const receipt = readJson(statePath);
    if (receipt?.attemptId !== attemptId || receipt.module !== module || !samePath(receipt.sourceRoot, sourceRoot)
        || !matchesCommit(receipt.expectedCommit) || !matchesCommit(receipt.sourceHead)
        || !matchesCommit(receipt.sourceHeadAfter) || !samePath(receipt.reportDir, reportDir))
      return blocked('receipt-scope-mismatch');
    if (receipt.stage !== 'test-only' || receipt.status !== 'passed' || receipt.success !== true
        || receipt.gradleExit !== 0 || receipt.deployed !== false || receipt.sourceVerified !== true
        || receipt.sourceProof !== 'pre-post-checks-consistent' || receipt.sourceDirtyCount !== 0
        || receipt.sourceDirtyCountAfter !== 0) return blocked('receipt-not-verified-passed');
    const start = Date.parse(receipt.startedAt);
    const end = Date.parse(receipt.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < sinceMs || end < start || end > Date.now())
      return blocked('receipt-outside-batch-window');

    const tests = receipt.tests;
    if (!Array.isArray(tests) || !tests.length || new Set(tests).size !== tests.length
        || !tests.every(name => typeof name === 'string' && /^[\w$]+(?:\.[\w$]+)+$/.test(name)))
      return blocked('receipt-missing-exact-test-classes');
    for (const name of tests) {
      const file = path.join(reportDir, 'TEST-' + name + '.xml');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || !pinned(file)) return blocked('report-path-mismatch');
      if (stat.mtimeMs < start || stat.mtimeMs > end) return blocked('report-outside-attempt-window', name);
    }
    const policyPath = path.resolve(mutationsRoot, '..', 'scripts', 'test-only-policy.ps1');
    const rejected = verifyReports(policyPath, reportDir, tests);
    if (rejected) return blocked('managed-xml-rejected', rejected);
    if (!isCurrent(readJson(currentPath))) return blocked('attempt-not-current-passed');
    return { state: 'PASS', reason: 'scoped-test-passed',
      detail: '受管批次 ' + mutationId + '/' + attemptId + '：' + module + ' @ ' + commit
        + '，' + tests.length + ' 个指定测试类有执行记录，失败与错误均为 0。' };
  } catch (err) {
    return blocked('test-evidence-unavailable', err?.code || 'invalid or unreadable test evidence');
  }
}

module.exports = { p6TestProof };
