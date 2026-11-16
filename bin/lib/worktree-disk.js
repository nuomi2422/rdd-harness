'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Count only conventional Gradle output directories, without following links or
// walking artifact contents. This is a lower bound, not a byte-size census.
function inspect(repo, runGit = spawnSync) {
  const git = runGit('git', ['-C', repo, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  if (git.error || git.status !== 0) return { error: 'git worktree list failed' };
  const trees = git.stdout.split('\0').filter(s => s.startsWith('worktree ')).map(s => s.slice(9));
  let builtTrees = 0, outputs = 0, inaccessible = 0;
  const volumes = new Map();
  for (const tree of trees) {
    let found = 0;
    function visit(dir, depth) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { inaccessible++; return; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (entry.name === 'build' || entry.name === '.gradle') { found++; continue; }
        if (depth < 2 && !entry.name.startsWith('.')) visit(path.join(dir, entry.name), depth + 1);
      }
    }
    visit(tree, 0);
    if (found) { builtTrees++; outputs += found; }
    const volume = path.parse(path.resolve(tree)).root;
    if (!volumes.has(volume)) {
      try { const s = fs.statfsSync(tree); volumes.set(volume, { root: volume, free: s.bavail * s.bsize }); }
      catch { volumes.set(volume, { root: volume, free: null }); }
    }
  }
  return { trees: trees.length, builtTrees, outputs, inaccessible, volumes: [...volumes.values()] };
}
module.exports = { inspect };
