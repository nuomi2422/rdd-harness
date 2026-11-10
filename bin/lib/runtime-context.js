'use strict';
const path = require('path');

// 2026-11-11: title diagnostics must not borrow live world state (S5 evidence isolation).
const TEST_ROOT = 'D:/rdd/workspace/rdd-selfcompile/instances/test';
function selection(argv) {
  const instances = argv.filter(a => a === '--instance' || a.startsWith('--instance='));
  const titles = argv.filter(a => a === '--title-only' || a.startsWith('--title-only='));
  const i = argv.indexOf('--instance');
  const instance = i < 0 ? null : argv[i + 1];
  if (instances.length > 1 || titles.length > 1 || instances.some(a => a !== '--instance') || titles.some(a => a !== '--title-only'))
    throw new Error('runtime context: use --instance test --title-only exactly');
  if (instances.length && instance !== 'test') throw new Error('runtime context: only explicit --instance test is supported');
  if ((instance === 'test') !== (titles.length === 1)) throw new Error('runtime context: --instance test requires --title-only (and vice versa)');
  return Object.freeze({ instance: instance || 'live', titleOnly: titles.length === 1 });
}
function resolveRuntime(selected, reg) {
  const gameRoot = selected.titleOnly ? path.normalize(TEST_ROOT) : reg.roots.live;
  return Object.freeze({ ...selected, gameRoot, mods: path.join(gameRoot, 'mods'),
    monitor: selected.titleOnly ? path.join(gameRoot, 'config', 'numen', 'monitor')
      : path.join(reg.roots.mc || 'D:/rdd/mc', 'The Best of Twilight Forest', 'config', 'numen', 'monitor'),
    logs: path.join(gameRoot, 'logs'), saves: path.join(gameRoot, 'saves'),
    save: selected.titleOnly ? null : (reg.env && reg.env.saveName),
  });
}
function deploymentArgs(script, runtime) {
  return runtime.titleOnly ? [script, '--mods', runtime.mods] : [script];
}
function deploymentPassed(result, output) {
  return result.status === 0 && !/VERDICT=STALE/.test(output);
}
module.exports = { TEST_ROOT, selection, resolveRuntime, deploymentArgs, deploymentPassed };
