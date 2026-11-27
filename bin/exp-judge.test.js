'use strict';
// 2026-11-11: SMOKE-r1 requires a mine attempt; goto/craft must not satisfy it.
// Exercise the real judge CLI, not an imported helper. All fixtures are synthetic
// and live in a fresh temp directory; keep receipts there for failure diagnosis.
// Run: node bin/exp-judge.test.js (optional EXP_JUDGE_TEST_TMP parent directory).
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(process.env.EXP_JUDGE_TEST_TMP || os.tmpdir(), 'exp-judge-cli-'));
const judge = path.join(__dirname, 'exp-judge.js');
const frozenPath = path.join(__dirname, '..', 'experiments', 'smoke-r1.contract.json');
const frozen = fs.readFileSync(frozenPath);
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const at = '2026-11-11T00:00:00.000Z';
const row = (type, data) => JSON.stringify({ timestamp: at, session: 'fixture-process',
  world_id: 'fixture-world', server_session: 'fixture-server', category: 'tools', type,
  data: { companion_id: 'fixture-companion', tool_call_id: 'fixture-call', ...data } });
const cases = [
  { name: 'smoke-mine-attempt', revision: 'SMOKE-r1', tool: 'mine', s3: 'PASS', overall: 'PASS_WITH_GAPS', exit: 0 },
  { name: 'smoke-goto-only', revision: 'SMOKE-r1', tool: 'goto', s3: 'FAIL', overall: 'FAIL', exit: 1 },
  { name: 'smoke-craft-only', revision: 'SMOKE-r1', tool: 'craft', s3: 'FAIL', overall: 'FAIL', exit: 1 },
  { name: 'smoke-no-mine', revision: 'SMOKE-r1', tool: null, s3: 'FAIL', overall: 'FAIL', exit: 1 },
  // A call alone is not success: require a matching successful result.
  { name: 'smoke-mine-failed-result', revision: 'SMOKE-r1', tool: 'mine', failed: true, s3: 'FAIL', overall: 'FAIL', exit: 1 },
  { name: 'smoke-mine-missing-result', revision: 'SMOKE-r1', tool: 'mine', missingResult: true, s3: 'INCONCLUSIVE', overall: 'INCONCLUSIVE', exit: 1 },
  { name: 'smoke-mine-identity-conflict', revision: 'SMOKE-r1', tool: 'mine', conflict: true, s3: 'INCONCLUSIVE', overall: 'INCONCLUSIVE', exit: 1 },
  { name: 'coverage-still-not-exercised', revision: 'COV-fixture', tool: null, s3: 'NOT_EXERCISED', overall: 'PASS_WITH_GAPS', exit: 0 },
  { name: 'other-goto-unchanged', revision: 'OTHER-fixture', tool: 'goto', s3: 'PASS', overall: 'PASS_WITH_GAPS', exit: 0 },
  { name: 'other-craft-unchanged', revision: 'OTHER-fixture', tool: 'craft', s3: 'PASS', overall: 'PASS_WITH_GAPS', exit: 0 },
  { name: 'smoke-missing-a0-still-blocks', revision: 'SMOKE-r1', tool: 'mine', missingA0: true, s3: 'PASS', s5: 'INCONCLUSIVE', overall: 'INCONCLUSIVE', exit: 1 },
];
const results = [];
console.log('Synthetic CLI artifacts: ' + root);
for (const c of cases) {
  const dir = path.join(root, c.name);
  const evidence = path.join(dir, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const write = (file, value) => fs.writeFileSync(path.join(evidence, file), value);
  // Alternate revisions get temp contracts; never rewrite the frozen source.
  const contractPath = c.revision === 'SMOKE-r1' ? frozenPath : path.join(dir, 'contract.json');
  if (contractPath !== frozenPath) fs.writeFileSync(contractPath, JSON.stringify({
    ...JSON.parse(frozen), contractRevision: c.revision, fixtureOnly: true,
  }));
  const jars = [{ file: 'numen-fixture.jar', sha256: 'synthetic-jar-hash' }];
  const env = {
    runId: c.name, phase: 'done', contract: { path: contractPath,
      sha256: hash(fs.readFileSync(contractPath)), revision: c.revision, scenarioId: 'synthetic-log-delivery' },
    timings: { watchSeconds: 120 }, jarsAtPrepare: jars, jarsAtLaunch: jars,
    stop: { postStopRequests: 0, cleanZeroVerified: true, javaExited: true,
      coverageVerified: true, scopeVerified: true, postStopStatus: 'PRESENT',
      observation: { complete: true }, observedGraceMs: 60000 },
    a0: { version: 'a0-v1' },
    session: { status: 'CLEAN', first_request_message_count: 2, first_request_at: at },
    interventions: { status: 'NONE', count: 0, entries: [], reasons: [] },
    context_delivery: { status: 'NONE', truncatedCountedAsDelivered: false, delivered: { refs: [] } },
  };
  if (c.missingA0) delete env.a0;
  fs.writeFileSync(path.join(dir, 'envelope.json'), JSON.stringify(env, null, 2));
  write('boot.log', 'Found mod file "numen-fixture.jar"\n');
  write('inventory-before.json', JSON.stringify({ data: { items: { 'minecraft:oak_log': 0 } } }));
  write('inventory-after.json', JSON.stringify({ data: { items: { 'minecraft:oak_log': 4 } } }));
  const calls = c.tool ? [row('tool_call', { tool: c.tool })] : [];
  if (c.tool && !c.missingResult) calls.push(row('tool_result', { tool: c.tool, success: !c.failed,
    ...(c.conflict ? { world_id: 'other-world' } : {}),
    result: JSON.stringify({ success: !c.failed, message: c.failed ? 'synthetic rejected attempt' : 'synthetic success' }) }));
  write('tools.jsonl', calls.length ? calls.join('\n') + '\n' : '');
  write('events.jsonl', '');
  write('ai.jsonl', [JSON.stringify({ type: 'turn', data: { turn: 1, tools: 113 } }),
    JSON.stringify({ type: 'assistant', data: { text: '拿到了4个原木，完成了。' } })].join('\n') + '\n');

  const r = spawnSync(process.execPath, [judge, dir], { encoding: 'utf8', timeout: 15000 });
  fs.writeFileSync(path.join(dir, 'cli.stdout.txt'), r.stdout || '');
  fs.writeFileSync(path.join(dir, 'cli.stderr.txt'), r.stderr || '');
  fs.writeFileSync(path.join(dir, 'cli.exit.json'), JSON.stringify({
    command: [process.execPath, judge, dir], status: r.status, signal: r.signal,
    error: r.error ? r.error.message : null,
  }, null, 2));
  let actual = null;
  try {
    assert.ifError(r.error);
    assert.equal(r.signal, null);
    actual = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8'));
    const assertion = (id) => actual.assertions.find(a => a.id === id);
    assert.equal(actual.contractChanged, false, 'frozen contract hash must match');
    assert.equal(assertion('S1').verdict, 'PASS', 'load fixture stays valid');
    assert.equal(assertion('S4').verdict, 'PASS', 'stop fixture stays valid');
    assert.equal(assertion('S5').verdict, c.s5 || 'PASS', 'A0 gate remains active');
    assert.equal(assertion('S3').verdict, c.s3, 'S3 tool-family predicate');
    assert.equal(actual.overall, c.overall, 'S3/S5 must affect overall');
    assert.equal(r.status, c.exit, 'real CLI exit');
    assert.ok(fs.readFileSync(path.join(dir, 'verdict.md'), 'utf8').includes('| S3 |'));
    results.push({ name: c.name, passed: true, exit: r.status, s3: assertion('S3').verdict });
    console.log('PASS ' + c.name + ' exit=' + r.status + ' S3=' + assertion('S3').verdict + ' overall=' + actual.overall);
  } catch (e) {
    results.push({ name: c.name, passed: false, exit: r.status,
      s3: actual && actual.assertions.find(a => a.id === 'S3').verdict, error: e.message });
    console.error('FAIL ' + c.name + ' exit=' + r.status + ': ' + e.message);
  }
}
assert.equal(hash(fs.readFileSync(frozenPath)), hash(frozen), 'test must not change the frozen contract');
fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
const failures = results.filter(r => !r.passed).length;
console.log('exp-judge real CLI: ' + (results.length - failures) + '/' + results.length + ' PASS; failures=' + failures);
process.exitCode = failures ? 1 : 0;
