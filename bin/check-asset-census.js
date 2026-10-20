#!/usr/bin/env node
'use strict';
/*
 * check-asset-census.js —— 资产普查（76 号 §2 的补充检查）
 *
 * 用户 2026-10-21 定：
 *   「全景文档就是现成的应跟踪清单，以后每个 tag 对一遍『清单上有 vs git 里有』，
 *    差距为零才许打。这次 26 项的发现应该变成例行检查，而不是靠哪次清扫顺手动好运。」
 *
 * 为什么需要它（这条债所有既有门禁都抓不住）：
 *   门禁原来盯的全是「改动过的文件」，没人盯「从来没被跟踪的文件」。
 *   26 项文档资产 + 44 个 harness 文件就是这么攒了几周 ——
 *   治理层自己的器官（红线回退索引、七类格式规范、memory.jsonl）一直在裸奔。
 *   迁移指南本身没入库更是一句黑色幽默：真盘坏了，连「怎么迁移」都查不到。
 *
 * 判定：清单上每一项都必须被 git 跟踪（ls-files 非空）。不检查内容，只检查「在不在库里」。
 *
 * 用法：
 *   node check-asset-census.js            # 查默认清单
 *   node check-asset-census.js --json
 *   node check-asset-census.js --selftest
 *
 * 退出码：0 全跟踪 / 2 有裸奔资产 / 3 环境错
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RDD = 'D:\\rdd';
const GIT = 'C:\\Users\\admin\\AppData\\Local\\Programs\\MinGit\\cmd\\git.exe';
const DOCS = path.join(RDD, 'docs', 'rdd-docs');
const HARNESS = path.join(RDD, 'harness', 'rdd-harness');

// 应跟踪清单（与 全景文档 §六 一致）
const CENSUS = [
  { repo: DOCS, p: 'rdd架构/_memory/memory.jsonl', why: 'MCP 记忆库：跨会话唯一经验载体（414 实体）' },
  { repo: DOCS, p: 'rdd架构/_格式规范.md', why: 'rdd架构 根格式规范' },
  { repo: DOCS, p: 'rdd架构/代码解释/', why: '跨模块代码↔意图绑定' },
  { repo: DOCS, p: 'rdd架构/模块架构/', why: '每模块七节 + §8 绑定' },
  { repo: DOCS, p: 'rdd架构/红线回退/', why: '红线 tag → 回退点索引（治理层器官）' },
  { repo: DOCS, p: 'rdd架构/项目历史/', why: '大事记（时间/为什么/代价）' },
  { repo: DOCS, p: 'rdd架构/杂项记录/', why: '债账 #NNN' },
  { repo: DOCS, p: 'rdd架构/运维/', why: '起停/端口/备份/救火' },
  { repo: DOCS, p: 'rdd架构/实机验证/', why: '验证卡（判据/证据/结果）' },
  { repo: DOCS, p: 'rdd架构/自编译统一版/_格式规范.md', why: '编号文档规范' },
  { repo: DOCS, p: 'rdd存放/_格式规范.md', why: '给老板看的东西的写法' },
  { repo: HARNESS, p: 'bin/', why: 'harness 脚本（门禁/审计/goal）' },
  { repo: HARNESS, p: 'multimodel/', why: '多模型协同模块' },
  { repo: HARNESS, p: 'registry.json', why: '工具注册表（机器真源）' },
  { repo: HARNESS, p: 'standards.md', why: '编程规范（机器真源）' },
];

const EXIT_OK = 0, EXIT_BAD = 2, EXIT_USAGE = 3;

function lsFiles(repo, p) {
  const g = spawnSync(GIT, ['-C', repo, 'ls-files', '--', p], { encoding: 'utf8', timeout: 30000 });
  if (g.status !== 0) return null;
  return (g.stdout || '').split(/\r?\n/).filter(Boolean);
}

function run() {
  const results = [];
  for (const c of CENSUS) {
    if (!fs.existsSync(path.join(c.repo, c.p.replace(/\/$/, '')))) {
      results.push({ ...c, status: 'MISSING', count: 0, detail: '磁盘上不存在' });
      continue;
    }
    const files = lsFiles(c.repo, c.p);
    if (files === null) { results.push({ ...c, status: 'GIT_ERR', count: 0, detail: 'git 不可用' }); continue }
    if (files.length === 0) results.push({ ...c, status: 'UNTRACKED', count: 0, detail: '磁盘有、git 没有（裸奔）' });
    else results.push({ ...c, status: 'OK', count: files.length, detail: `${files.length} 个文件已跟踪` });
  }
  return results;
}

function selftest() {
  // 用真实仓库验证：清单里必须至少有一条 OK，且结构完整
  const r = run();
  const checks = [
    ['清单非空', r.length === CENSUS.length],
    ['每条都有 status', r.every((x) => ['OK', 'MISSING', 'UNTRACKED', 'GIT_ERR'].includes(x.status))],
    ['memory.jsonl 已跟踪', r.some((x) => x.p.includes('memory.jsonl') && x.status === 'OK')],
    ['模块架构 已跟踪', r.some((x) => x.p.includes('模块架构') && x.status === 'OK')],
  ];
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✔' : '✘'} ${name}`);
    if (ok) pass++;
  }
  console.log(`\n  selftest: ${pass}/${checks.length}`);
  return pass === checks.length ? EXIT_OK : EXIT_BAD;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node check-asset-census.js [--json] [--selftest]');
    return EXIT_OK;
  }
  if (argv.includes('--selftest')) return selftest();

  const r = run();
  const bad = r.filter((x) => x.status !== 'OK');

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ok: bad.length === 0, items: r, badCount: bad.length }, null, 2));
  } else {
    console.log(`资产普查：${r.length} 项\n`);
    for (const x of r) {
      const mark = x.status === 'OK' ? '✔' : '✘';
      console.log(`  ${mark} ${x.p.padEnd(42)} ${x.detail}`);
      if (x.status !== 'OK') console.log(`      ↳ ${x.why}`);
    }
    console.log('');
    if (bad.length === 0) console.log('VERDICT: 全部已跟踪，可以打 tag');
    else console.log(`VERDICT: ${bad.length} 项裸奔 —— 这些是治理层的器官，不许在库外`);
  }
  return bad.length === 0 ? EXIT_OK : EXIT_BAD;
}

process.exit(main());
