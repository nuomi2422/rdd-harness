'use strict';
// 防截断回退：关键脚本的行数不得明显少于 HEAD。
// 起因（2026-11-09 22:03）：对 bench.js 做"整文件读→改→整文件写"，
// 而 read 在大文件上只返回前 ~45KB（829 行）、totalLines=1385，
// 结果把 1328 行的文件写成了 829 行。这条测试用来在回归里立刻抓住同类事故。
// 注意：这只是**弱启发**，不是防覆盖证明——正常大幅删减会误报，等长截断会漏。
// 真正的防线是操作纪律：读文件先核对 totalLines，不足分段读，优先精确 edit。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');