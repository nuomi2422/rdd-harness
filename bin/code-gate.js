#!/usr/bin/env node
'use strict';
/**
 * code-gate.js —— 写代码前的薄门禁
 *
 * 为什么：进游戏有 preflight/postflight，改代码这一侧却没有门。
 * 这里只做两件事：① 把 8 条最容易犯错的硬规则摆在眼前；② 查 3 个实物在不在。
 * 不替你做判断，也不读你的意图。薄，才有人愿意跑。
 *
 * 用法：node bin/code-gate.js
 * 退出码：0=可以改码（可能有 WARN） 1=有 BLOCK 2=用法/环境错
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let REG;
try { REG = require('./lib/registry').load(); } catch { REG = null; }
if (!REG || !REG.roots) { console.error('registry 读不出来（bin/lib/registry.js）—— 这不是"没规则"，是环境坏了'); process.exit(2); }

const R = REG.roots;
const STD = path.join(R.harness, 'standards.md');
const BUG = path.join(R.knowledge, 'Bug修复', 'README.md');
const MUT = path.join(R.scripts, 'run-mutation.ps1');
const CORRECTION = path.join(R.knowledge, '施工文档', '042-整夜审计问题修正与实机收口施工单.md');

const STAGE_DOCS = [
  ['编码规范', STD],
  ['当前审计修正施工入口（R0-R7）', CORRECTION],
  // 2026-11-04 用户要求：环境/任务判定增量共源；曾有env攻略冒事实、展示与准入时效分叉。
  // 仅导航+现有WARN存在检查，不宣称接口已实现，也不新增业务BLOCK。
  ['环境读取/任务判定：统一请求迁移设计（先查provider；未支持登记旁路；逐主题核对已实现范围）', path.join(R.knowledge, '施工文档', '039-统一世界观测请求接口与增量迁移设计.md')],
  ['进游戏', path.join(R.knowledge, '进游戏验证', '001-进游戏核心工具.md')],
  ['验证规范', path.join(R.knowledge, '进游戏验证', '002-游戏验证规范及盲点.md')],
  ['实验台', path.join(R.knowledge, '进游戏验证', '003-实验台-当前世界-坑-怎么验证.md')],
  ['退游戏', path.join(R.knowledge, '退游戏', '001-退游戏检查单.md')],
  ['修 bug', path.join(R.knowledge, 'Bug修复', 'README.md')],
];

const RULES = [
  ['0', '先查台账', '知识库\\Bug修复\\：这处修过吗、复现几次、回归判据是什么（S-CODE-07）'],
  ['1', '编译唯一通道', 'run-mutation.ps1 -Requirement "<需求>" -Module <模块>；禁手写 gradle、禁手拷 jar'],
  ['2', '模块别猜', '改 core/common 必须 -Module core:neoforge；一个 mutation 只放一个 jar'],
  ['3', '执行层要有测试', '判据是 failures=0 errors=0，不是"跑得起来"'],
  ['4', '不信 DEPLOY_OK', 'BUILD SUCCESSFUL 只是回执；跑 check-runtime-deployment.js（exit 2 = 源码领先 jar）'],
  ['5', '改接口先查消费者', '枚举/方法名改动先 grep 全部 switch 与调用方'],
  ['6', '精确提交', 'git add <路径>；禁 git add -A（并行会话会互相卷）'],
  ['7', '留回归判据', '每修一个 bug 落一条：修复时间/复现次数/怎么改/回归判据'],
];

let block = 0;
let warn = 0;
console.log('=== 写代码前 · 薄门禁（code-gate）===');
console.log('规范真源：' + STD);
// 2026-11-05 用户要求挂起开工提醒；案例：旁路事件被写成判定迁移完成、过期值继续被消费。
// 只挂本轮行动提示，不伪装自动语义审查；撤下条件：042对应批次证据收口并复审。
warn++;
console.log('');
console.log('!!! ACTION_REQUIRED：先读042审计修正单，再继续当前批次 !!!');
console.log('入口：' + CORRECTION);
console.log('开工先写：领取R几 / 最新HEAD与在飞改动 / 真实反例 / 实机正反例与恢复判据。');
console.log('R0未闭合不继续自动发布；先修接缝，不继续扩大未验接口的消费者。');
console.log('只测纯函数、只发旁路事件、只有DEPLOY_OK，都不能写整批完成；UNKNOWN不得改PASS。');
console.log('先现场核实，最小改动，同场景复验；失败先定位，不靠继续加补丁掩盖。');
console.log('此提示不是已审查代码，也不是游戏放行许可；已修项目先核证据，不重复施工。');
console.log('');
console.log('规则（按顺序过一遍，别跳）：');
for (const [n, t, d] of RULES) console.log('  ' + n + '. ' + t + ' —— ' + d);
console.log('');
console.log('实物检查：');
const need = [[STD, '编程规范真源'], [BUG, 'Bug 修复台账'], [MUT, '唯一编译通道 run-mutation.ps1']];
for (const [p, label] of need) {
  const ok = fs.existsSync(p);
  if (!ok) block++;
  console.log('  ' + (ok ? 'PASS' : 'BLOCK') + '  ' + label + (ok ? '' : ' 不存在：' + p));
}

console.log('');
console.log('各阶段唯一 md（这里只给指针，正文去文件里看）：');
for (const [label, fp] of STAGE_DOCS) {
  const ok = fs.existsSync(fp);
  if (!ok) warn++;
  console.log('  ' + (ok ? 'OK  ' : 'WARN') + '  ' + label + ' → ' + fp);
}

// 脏树只提醒：并行会话常同时改仓，脏不等于错，但提交前必须逐行认领
function git() {
  const cands = ['git', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'MinGit', 'cmd', 'git.exe')];
  for (const g of cands) {
    const r = spawnSync(g, ['-C', R.numen, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 });
    if (!r.error && typeof r.stdout === 'string') return r;
  }
  return null;
}
const gs = git();
if (!gs) {
  warn++;
  console.log('  WARN   git 跑不了 —— 提交前自己确认工作树（不是"干净"）');
} else {
  const dirty = gs.stdout.split(/\r?\n/).filter(Boolean).length;
  console.log('  ' + (dirty ? 'WARN' : 'PASS') + '  工作树 ' + (dirty ? dirty + ' 处脏（逐行认领再提交，别 -A）' : '干净'));
  if (dirty) warn++;
}

// 记录/批次卡缺失提醒（WARN，不拦）
try {
  const today = new Date().toDateString();
  const cardDir = path.join(R.knowledge, '批次卡');
  const cards = fs.readdirSync(cardDir).filter((n) => n.endsWith('.md'));
  const fresh = cards.some((n) => new Date(fs.statSync(path.join(cardDir, n)).mtime).toDateString() === today);
  if (!fresh) { warn++; console.log('  WARN  今天没有批次卡（批次卡目录无今天更新）'); }
  const recDir = path.join(R.knowledge, '记录');
  const recs = fs.readdirSync(recDir).filter((n) => n.endsWith('.md') && n !== 'README.md' && n !== '000-总汇报.md');
  if (!recs.some((n) => /主干活|编码|驾驶员/.test(n))) { warn++; console.log('  WARN  记录/ 里没有主干活 AI 的记录文档'); }
} catch (e) { }

console.log('');
console.log('改完第一件事：check-runtime-deployment.js（源码有没有领先 jar）');
console.log('收工前：台账加一行 —— 修复时间 / 复现次数 / 怎么修改的 / 回归判据');
console.log('');
try { const r = block ? 'BLOCK' : (warn ? 'WARN' : 'PASS'); require('fs').appendFileSync('D:\\rdd\\.harness\\audit\\gate-usage.jsonl', JSON.stringify({ at: new Date().toISOString(), gate: 'code', result: r, note: 'block=' + block + ' warn=' + warn, items: STAGE_DOCS.map((x) => x[1]).concat(need.map((x) => x[0])) }) + '\n'); } catch (e) { }
if (block) { console.log('VERDICT=BLOCK（' + block + ' 项实物缺失，先补齐再动手）'); process.exit(1); }
console.log('VERDICT=OK（' + (warn ? warn + ' 条 WARN，不拦' : '无警告') + '）');
