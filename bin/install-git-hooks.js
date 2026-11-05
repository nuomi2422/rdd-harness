#!/usr/bin/env node
'use strict';
// install-git-hooks.js —— 把 pre-commit 物理门装进指定仓库（默认 minecraft-numen）
const fs = require('fs');
const path = require('path');
const REPO = process.argv[2] || 'D:/rdd/workspace/minecraft-numen';
const HOOK = path.join(REPO, '.git', 'hooks', 'pre-commit');
const sh = '#!/bin/sh\n# 物理门禁：没有近 30 分钟内的 code-gate 记录，commit 直接拒绝（2026-11-05）。\n"D:/rdd/tools/node/node.exe" "D:/rdd/harness/rdd-harness/bin/precommit-gate.js" || exit 1\n';
fs.writeFileSync(HOOK, sh, 'utf8');
console.log('installed ' + HOOK);
