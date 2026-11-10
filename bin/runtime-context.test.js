'use strict';
// Pure VM tests: no child executable, game, network, or production ledger is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const runtime = require('./lib/runtime-context');
const source = fs.readFileSync(path.join(__dirname, 'harness-gate.js'), 'utf8');
const rawRegistry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'registry.json'), 'utf8'));
const titleArgs = ['--instance', 'test', '--title-only'];
function harness(args = [], status = 0) {
  const io = [], children = [], logs = [];
  const reg = JSON.parse(JSON.stringify(rawRegistry));
  for (const key of Object.keys(reg.roots)) reg.roots[key] = path.join('fixture-project', key);
  reg.roots.live = path.join('FORBIDDEN-LIVE', 'game');
  const before = JSON.stringify(reg);
  let loads = 0;
  const missing = p => { io.push(String(p)); throw new Error('fixture absent'); };
  const fakeFs = { existsSync: p => { io.push(String(p)); return false; }, accessSync: missing,
    statSync: missing, readdirSync: missing, readFileSync: missing,
    mkdirSync: p => { throw new Error('Unexpected write ' + p); },
    appendFileSync: p => { throw new Error('Unexpected write ' + p); } };
  const child = { spawnSync: (exe, argv) => { children.push({exe, argv}); return {status, stdout:'', stderr:''}; },
    execFileSync: () => { throw new Error('Unexpected execFileSync'); } };
  const sandbox = { __dirname, __filename: path.join(__dirname, 'harness-gate.js'),
    console: {log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' '))},
    process: {argv:['node', 'harness-gate.js', 'preflight', ...args], env:{}, execPath:process.execPath},
    require: name => {
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path;
      if (name === 'child_process') return child;
      if (name === './lib/runtime-context.js') return runtime;
      if (name === './lib/registry.js') return {load: () => { loads++; return reg; }};
      if (name === './lib/timelock-scope.js') return {excludedForRuntime: () => false};
      if (name === './lib/commander-gates.js' || name === './lib/learner-gates.js') return {};
      if (name === './lib/p22-digest.js') return {evaluateDigestLedger: () => ({state:'SKIP', detail:'fixture'})};
      throw new Error('Unexpected live-default require ' + name);
    } };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(0, source.lastIndexOf('try { process.exit(main()); }')) +
    '\n globalThis.api = { setMode(mode) { process.argv[2] = mode; }, main, preflight, postflight, builtinChecks, printPlannerBanner, printBenchReminder, appendGateUsage, results, setup() { REG = registryLib.load(); RUNTIME = runtimeContext.resolveRuntime(runtimeContext.selection(process.argv.slice(3)), REG); } };', sandbox);
  return {api:sandbox.api, io, children, logs, reg, before, loads:() => loads};
}
test('default scope unchanged and REG immutable; fixed test root ignores project root', () => {
  const reg = {roots:{live:'original-live', mc:'original-mc'}, env:{saveName:'live'}};
  const before = JSON.stringify(reg);
  assert.equal(runtime.resolveRuntime(runtime.selection([]), reg).gameRoot, 'original-live');
  const rt = runtime.resolveRuntime(runtime.selection(titleArgs), reg);
  assert.equal(rt.gameRoot, path.normalize(runtime.TEST_ROOT));
  assert.equal(rt.save, null);
  assert.equal(runtime.resolveRuntime(runtime.selection([]), reg).save, 'live');
  assert.deepEqual(runtime.deploymentArgs('check.js', rt), ['check.js', '--mods', path.join(rt.gameRoot,'mods')]);
  assert.deepEqual(runtime.deploymentArgs('check.js', runtime.resolveRuntime(runtime.selection([]), reg)), ['check.js']);
  assert.equal(JSON.stringify(reg), before);
});
test('invalid selectors refuse before registry, IO, children or ledger', () => {
  for (const args of [['--instance'], ['--instance','test'], ['--title-only'], ['--instance','live'],
    ['--instance','bogus','--title-only'], ['--instance=test','--title-only'], [...titleArgs,'--instance','test'], [...titleArgs,'--title-only=true']]) {
    const h = harness(args); const initial = h.io.length;
    assert.throws(() => h.api.main(), /runtime context/);
    assert.equal(h.loads(), 0); assert.equal(h.io.length, initial); assert.equal(h.children.length, 0);
  }
});
test('title-only refuses supervision/learning modes before registry or world reads', () => {
  for (const mode of ['round', 'learn', 'selftest', 'registry']) {
    const h = harness(titleArgs);
    // main mode is supplied by the fixture process, not by a real CLI execution.
    h.api.setMode(mode);
    assert.equal(h.api.main(), 3);
    assert.equal(h.loads(), 0); assert.equal(h.children.length, 0);
  }
});
test('deployment exit 3, failed spawn and stale output never pass', () => {
  for (const status of [1,2,3,null]) assert.equal(runtime.deploymentPassed({status}, ''), false);
  assert.equal(runtime.deploymentPassed({status:0}, 'VERDICT=STALE'), false);
  assert.equal(runtime.deploymentPassed({status:0}, 'VERDICT=DEPLOYED'), true);
});
for (const phase of ['preflight','postflight']) test(phase + ' isolated body: no live/world child reads; explicit SKIP before execution', () => {
  const h = harness(titleArgs, 3); h.api.setup();
  const ctx = {since:new Date('2026-11-11T00:00:00'), keyword:'fixture', head:'', stageTxt:''};
  h.api[phase](ctx); h.api.printPlannerBanner(ctx); h.api.printBenchReminder(); h.api.appendGateUsage({});
  const skips = phase === 'preflight' ? ['P0','P15','P18','P22'] : ['Q10','Q14','Q18','Q19','Q20'];
  for (const id of skips) assert.equal(h.api.results.find(r => r.id === id).state, 'SKIP', id);
  assert.equal(JSON.stringify(h.reg), h.before);
  assert.ok(!h.io.some(p => /FORBIDDEN-LIVE|gate-usage|bench-digest|The Best of Twilight Forest|snapshot-world/.test(p)), JSON.stringify(h.io));
  assert.ok(!h.children.some(c => /snapshot-world|check-evidence-anchor|check-experiment-reflection/.test(c.argv.join(' '))));
  if (phase === 'preflight') {
    const deployment = h.children.find(c => c.argv.some(a => /check-runtime-deployment/.test(a)));
    assert.equal(deployment.argv[1], '--mods'); assert.equal(deployment.argv[2], path.join(path.normalize(runtime.TEST_ROOT), 'mods'));
    assert.equal(h.api.results.find(r => r.id === 'P2').state, 'BLOCK');
  }
});
test('P22 default preflight keeps digest evaluation; title pre/post never read it', () => {
  const ctx = {since:new Date('2026-11-11T00:00:00'), keyword:'fixture', head:'', stageTxt:''};
  const normal = harness([]); normal.api.setup(); normal.api.builtinChecks(ctx, 'preflight');
  assert.ok(normal.io.some(p => /bench-digest\.jsonl/.test(p)));
  assert.notEqual(normal.api.results.find(r => r.id === 'P22').state, 'SKIP');
  for (const phase of ['preflight','postflight']) {
    const isolated = harness(titleArgs); isolated.api.setup(); isolated.api[phase](ctx);
    assert.ok(!isolated.io.some(p => /bench-digest/.test(p)));
    if (phase === 'preflight') assert.equal(isolated.api.results.find(r => r.id === 'P22').state, 'SKIP');
  }
});
