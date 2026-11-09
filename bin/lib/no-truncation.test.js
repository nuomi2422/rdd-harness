'use strict';
// 防截断回退：关键脚本的行数不得明显少于 HEAD。
// 起因（2026-11-09 22:03）：对 bench.js 做"整文件读→改→整文件写"，
// 而 read 在大文件上只返回前 ~45KB（829 行）、totalLines=1385，
// 结果把 1328 行的文件写成了 829 行。这条测试用来在回归里立刻抓住同类事故。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = ['bench.js', 'exp-runner.js', 'bench-watch.js'];
const MIN_RATIO = 0.8;

const isRepo = (() => {
  try { execFileSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

test('关键脚本不得被整文件写截断（行数 ≥ HEAD 的 80%）', { skip: isRepo ? false : '不是 git 仓库' }, () => {
  const bad = [];
  for (const name of FILES) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    let headText;
    try { headText = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:bin/' + name], { encoding: 'utf8' }); } catch { continue; }
    const headLines = headText.split('\n').length;
    const nowLines = fs.readFileSync(p, 'utf8').split('\n').length;
    if (headLines > 50 && nowLines < headLines * MIN_RATIO) bad.push(name + ': ' + nowLines + ' < ' + headLines + '×' + MIN_RATIO);
  }
  assert.deepEqual(bad, [], '疑似被整文件写截断：' + bad.join('; '));
});
