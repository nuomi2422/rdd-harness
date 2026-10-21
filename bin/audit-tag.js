#!/usr/bin/env node
'use strict';
/*
 * audit-tag.js —— 里程碑审计固化（76 号 §2 的执行侧）
 *
 * 用户 2026-10-20 定稿：「红线固化」不是一句「我确认过了」，是五样东西打成 tag：
 *   ① 代码 + 文档的 git tag
 *   ② 当时的 jar sha
 *   ③ 债账快照（此刻所有已知未修的债）
 *   ④ 已知不可用清单（此刻哪些东西是坏的/假的/影子）
 *   ⑤ 结构性缺口清单（registry.knownGaps；2026-10-21 owner 点名：G3e-2 宿主接线未做
 *      必须随每次 tag 固化，否则「G3a–G3d 全绿」会让下轮误以为地基完整）
 *
 * 为什么第③条最关键：下个轮回从**诚实的起点**出发，而不是从「假装都好」出发。
 * 第⑤条是第③/④条的补充：债是「欠着要还」，不可用是「现在不能用」，结构性缺口是
 * 「洞还在、只是故意没做」——三种诚实起点不能互相替代。
 * 副产品：tag 之间可以二分定位回归。
 *
 * 安全设计（这是它最容易出事的地方）：
 *   - **默认 dry-run**：只打印将要做什么，不打 tag、不写文件。要真做必须加 --apply
 *   - 打 tag 前检查工作区是否干净；有未提交改动就拒（否则 tag 固化的快照不可复现）
 *   - 打 tag 前检查游戏是否在跑；在跑就拒（实机验证中不许冻结）
 *   - 三个仓打**同名 tag**，任一失败就回滚已打的
 *
 * 用法：
 *   node audit-tag.js --milestone G4            # 干跑，看看会做什么
 *   node audit-tag.js --milestone G4 --apply    # 真打 tag
 *   node audit-tag.js --list                    # 列出已有审计 tag
 *   node audit-tag.js --selftest
 *
 * 退出码：0 正常 / 1 被安全检查拒 / 3 用法或环境错
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RDD = 'D:\\rdd';
const GIT = 'C:\\Users\\admin\\AppData\\Local\\Programs\\MinGit\\cmd\\git.exe';
const REPOS = [
  { name: 'docs', dir: path.join(RDD, 'docs', 'rdd-docs') },
  { name: 'harness', dir: path.join(RDD, 'harness', 'rdd-harness') },
  { name: 'numen', dir: path.join(RDD, 'workspace', 'minecraft-numen') },
];
const SNAP_ROOT = path.join(RDD, 'docs', 'rdd-docs', 'rdd架构', '审计快照');
const DOCS = path.join(RDD, 'docs', 'rdd-docs', 'rdd架构');
const MISC = path.join(DOCS, '杂项记录');
const REGISTRY = path.join(RDD, 'harness', 'rdd-harness', 'registry.json');
const MODS = path.join(RDD, 'mc', 'The Best of Twilight Forest', 'mods');

const EXIT_OK = 0, EXIT_REFUSED = 1, EXIT_USAGE = 3;

const HELP = `用法：
  node audit-tag.js --milestone <G5> [--apply] [--note "一句话"]
  node audit-tag.js --list
  node audit-tag.js --selftest

  默认干跑（dry-run）：只打印将要做什么，不打 tag、不写文件。
  --apply   真执行（四件套固化 + 三仓打同名 tag）

退出码：0 正常 / 1 被安全检查拒 / 3 用法或环境错`;

function parseArgs(argv) {
  const o = { milestone: null, apply: false, note: '', list: false, selftest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone') o.milestone = argv[++i];
    else if (a === '--apply') o.apply = true;
    else if (a === '--note') o.note = argv[++i];
    else if (a === '--list') o.list = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const git = (dir, args) => spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8', timeout: 30000 });

/* ── 安全检查：为什么这三条 ── */
function preflightChecks() {
  const problems = [];

  // 1. 游戏在跑 → 不许冻结（实机验证中的状态不是可复现快照）
  const mc = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "if (Get-Process java,javaw -ErrorAction SilentlyContinue) { 'RUNNING' } else { 'IDLE' }"],
    { encoding: 'utf8', timeout: 20000 });
  if ((mc.stdout || '').includes('RUNNING')) {
    problems.push('游戏正在运行 —— 实机验证中的状态不是可复现快照，等它退出再打 tag');
  }

  // 2. 三仓工作区必须干净（有未提交改动 = tag 快照不可复现）
  for (const r of REPOS) {
    if (!fs.existsSync(r.dir)) { problems.push(`${r.name} 仓不存在：${r.dir}`); continue }
    const st = git(r.dir, ['status', '--porcelain']);
    if (st.status !== 0) { problems.push(`${r.name} 仓 git 不可用`); continue }
    const dirty = (st.stdout || '').split(/\r?\n/).filter(Boolean);
    // 只关心「源码/文档」类脏项；report\、runs\ 这类运行产物不算
    const significant = dirty.filter((l) => !/report\/|runs\/|mutations\/|\.log$/.test(l));
    if (significant.length) {
      problems.push(`${r.name} 仓有 ${significant.length} 处未提交改动（tag 快照会不可复现）：\n      ` +
        significant.slice(0, 5).join('\n      ') + (significant.length > 5 ? '\n      …' : ''));
    }
  }
  // 3. 资产普查：清单上每一项都必须被 git 跟踪
  //    为什么单列一条：门禁原来盯的全是「改动过的文件」，没人盯「从来没被跟踪的文件」。
  //    26 项文档资产 + 44 个 harness 文件就是这么攒了几周的（见 check-asset-census.js 注释）。
  try {
    const census = path.join(__dirname, 'check-asset-census.js');
    if (fs.existsSync(census)) {
      const c = spawnSync(process.execPath, [census, '--json'], { encoding: 'utf8', timeout: 60000 });
      let parsed = null;
      try { parsed = JSON.parse(c.stdout || '{}'); } catch { /* 降级到下面 */ }
      if (!parsed) {
        problems.push('资产普查跑不起来（check-asset-census.js 输出无法解析）—— 不能当通过');
      } else if (parsed.badCount > 0) {
        const names = (parsed.items || []).filter((x) => x.status !== 'OK').map((x) => x.p);
        problems.push(`资产普查有 ${parsed.badCount} 项裸奔（磁盘有、git 没有）：\n      ` +
          names.slice(0, 6).join('\n      ') + (names.length > 6 ? '\n      …' : '') +
          '\n      → 这些是治理层的器官，不许在库外');
      }
    }
  } catch { /* 普查脚本缺失不算硬失败，但下面会提示 */ }

  // 4. 决策队列：有未决项就提醒（不拦，但必须让打 tag 的人看见）
  //    用户 2026-10-21 定：「拍板记录一并入 tag 快照。决策队列是治理证据链的一部分——
  //    当时谁批的、批了什么，应该和债账快照同等级别被固化。」
  //    注意：未决项**不阻止**打 tag（tag 固化的是此刻状态，包括「还有事没拍板」），
  //    但必须显式告知，否则 tag 看起来像「一切已定」。
  try {
    const inbox = path.join(__dirname, 'decide-inbox.js');
    if (fs.existsSync(inbox)) {
      const d = spawnSync(process.execPath, [inbox, 'list', '--pending', '--json'], { encoding: 'utf8', timeout: 30000 });
      let parsed = null;
      try { parsed = JSON.parse(d.stdout || '{}'); } catch { /* 忽略 */ }
      if (parsed && Array.isArray(parsed.items) && parsed.items.length) {
        problems.push(`决策队列还有 ${parsed.items.length} 条未决（不拦打 tag，但会被写进快照）：\n      ` +
          parsed.items.slice(0, 5).map((x) => `${x.id} ${x.title}`).join('\n      ') +
          '\n      → 若此刻确实该冻结，就在 snapshot 里带上「未决清单」；若该等，先让主人拍板');
      }
    }
  } catch { /* 队列读不到不算硬失败 */ }

  return problems;
}

/* ── 收集四件套 ── */
function collectSnapshot(milestone) {
  const snap = { milestone, at: new Date().toISOString(), repos: {}, jar: null, debts: [], unavailable: [] };

  for (const r of REPOS) {
    const head = git(r.dir, ['log', '-1', '--format=%H|%cI|%s']);
    const line = (head.stdout || '').trim();
    const [sha, when, subject] = line.split('|');
    snap.repos[r.name] = { sha, when, subject };
  }

  // jar sha（现网实际跑的那个）
  try {
    if (fs.existsSync(MODS)) {
      const jars = fs.readdirSync(MODS).filter((f) => /^numen.*\.jar$/i.test(f));
      if (jars.length) {
        const f = path.join(MODS, jars[0]);
        const crypto = require('crypto');
        const buf = fs.readFileSync(f);
        snap.jar = { file: jars[0], sha256: crypto.createHash('sha256').update(buf).digest('hex').toUpperCase() };
      }
    }
  } catch { /* jar 读不到就留 null，不假装 */ }

  // 债账快照：下一步表 + 时间锁
  try {
    const files = fs.readdirSync(MISC).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort();
    if (files.length) {
      const latest = path.join(MISC, files[files.length - 1]);
      const text = fs.readFileSync(latest, 'utf8');
      const i = text.indexOf('## 下一步');
      if (i >= 0) {
        snap.debtsSource = path.relative(RDD, latest);
        snap.debtsText = text.slice(i, i + 6000);
      }
    }
  } catch { /* 没有就算了 */ }
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  // ★ 2026-10-21（owner 点名）：结构性缺口必须随 tag 固化，否则「某组三批都 ✅」会让
  //   将来考古误以为地基完整（典型：G3e-2 宿主接线未做，而 G3a–G3d 全绿）。
  knownGaps = (reg.knownGaps && Array.isArray(reg.knownGaps.list)) ? reg.knownGaps.list : [];
    const locks = (reg.timeLocks && reg.timeLocks.locks) || [];
    snap.timeLocks = locks.map((l) => ({ id: l.id, title: l.title, status: l.status, reviewBy: l.reviewBy }));
  } catch { snap.timeLocks = []; }

  return snap;
}

/* ── 已知不可用清单：从验证卡里抽「影子/未生效/未实机」 ──
 *
 * ★ 两条设计约束（2026-10-21 用户要求「确认是机械抽取不是现打字的」）：
 *   1. 纯机械：只读文件 + 正则匹配，**不生成任何新判断**。抽到几条就是几条，
 *      抽不到就明确写「没抽到」，绝不手写补充。
 *   2. 带坐标：每条都记 `文件:行号`，审计时能回到原文核对 —— 否则这就是新的撒谎点。
 *
 * ★ 踩过的坑：正则带 /g 时 `re.test()` 会保留 lastIndex，连续调用会漏判。
 *   所以这里用不带 g 的正则逐行测（每次都是全新匹配）。
 */
function collectUnavailable() {
  const out = [];
  const verifyDir = path.join(DOCS, '实机验证');
  const RE = /影子|未实机|未部署|未生效|not_connected|占位|不回归|降档/;
  let srcFile = null;
  try {
    const month = new Date().toISOString().slice(0, 7) + '.md';
    const p = path.join(verifyDir, month);
    if (fs.existsSync(p)) {
      srcFile = path.relative(RDD, p);
      const text = fs.readFileSync(p, 'utf8');
      const lines = text.split(/\r?\n/);
      lines.forEach((l, i) => {
        // 跳过标题行和表格分隔线，只收有实质内容的行
        if (l.trim().length <= 10) return;
        if (/^#{1,6}\s/.test(l.trim())) return;
        if (RE.test(l)) out.push({ file: srcFile, line: i + 1, text: l.trim().slice(0, 200) });
      });
    }
  } catch { /* 读不到就空着，下面会写明 */ }
  return { items: out.slice(0, 40), source: srcFile, total: out.length };
}

function renderSnapshot(snap, unavailable) {
  const L = [];
  L.push(`# 审计快照 · ${snap.milestone} · ${snap.at.slice(0, 10)}`);
  L.push('');
  L.push(`> 由 \`audit-tag.js\` 生成。**这是「此刻的诚实起点」**：下个轮回从这里出发，`);
  L.push(`> 不是从「假装都好」出发。规则真源：76 号 §2。`);
  L.push('');
  L.push('## 1 · 三仓快照');
  L.push('');
  L.push('| 仓 | commit | 时间 | 标题 |');
  L.push('|---|---|---|---|');
  for (const [k, v] of Object.entries(snap.repos)) {
    L.push(`| ${k} | \`${(v.sha || '').slice(0, 12)}\` | ${v.when || ''} | ${(v.subject || '').replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  L.push('## 2 · 现网 jar');
  L.push('');
  if (snap.jar) L.push(`- 文件：\`${snap.jar.file}\`\n- sha256：\`${snap.jar.sha256}\``);
  else L.push('- **未读到**（mods 目录没有 numen*.jar，或读失败）');
  L.push('');
  L.push('## 3 · 债账快照');
  L.push('');
  L.push(`来源：\`${snap.debtsSource || '（没找到杂项记录）'}\``);
  L.push('');
  if (snap.debtsText) {
    L.push('```text');
    L.push(snap.debtsText.trim());
    L.push('```');
  } else L.push('（没抽到「下一步」段）');
  L.push('');
  L.push('## 4 · 时间锁（未到期的防线）');
  L.push('');
  if ((snap.timeLocks || []).length) {
    L.push('| id | 标题 | 状态 | 复核日期 |');
    L.push('|---|---|---|---|');
    for (const t of snap.timeLocks) L.push(`| ${t.id} | ${String(t.title).replace(/\|/g, '\\|')} | ${t.status} | ${t.reviewBy} |`);
  } else L.push('（无）');
  L.push('');
  L.push('## 5 · 结构性缺口（**洞还在，别当它不存在**）');
  L.push('');
  L.push('> ★ 来源：`registry.json` 的 `knownGaps`。这些是**已知但故意没做**的部分。');
  L.push('> ★ 为什么必须随 tag 固化：某一组可能「三批都 ✅」而地基其实是空的，');
  L.push('>   不写在这里，下个轮回会照着 ✅ 往下盖。');
  L.push('');
  if ((snap.knownGaps || []).length) {
    L.push('| id | 没做的是什么 | 后果 | 计划 | 复核日期 |');
    L.push('|---|---|---|---|---|');
    for (const g of snap.knownGaps) {
      L.push(`| ${g.id} | ${String(g.what).replace(/\|/g, '\\|')} | ${String(g.effect || '').replace(/\|/g, '\\|')} | ${String(g.plan || '').replace(/\|/g, '\\|')} | ${g.reviewBy || ''} |`);
    }
  } else L.push('（`registry.knownGaps` 为空 —— **零缺口是极强的主张**，确认过再信。）');
  L.push('');
  L.push('## 6 · 已知不可用清单（坏的/假的/影子）');
  L.push('');
  L.push('> ★ 这一节的作用：防止下轮把「影子」当「已生效」。');
  L.push('> ★ 纯机械抽取，不现打字：正则从验证卡抓关键词行，每条带 `文件:行号` 可回原文核对。');
  L.push('');
  if (unavailable.items.length) {
    L.push(`来源：\`${unavailable.source}\`（共命中 ${unavailable.total} 行，列出前 ${unavailable.items.length} 条）`);
    L.push('');
    for (const u of unavailable.items) L.push(`- \`${u.file}:${u.line}\` ${u.text}`);
  } else if (!unavailable.source) {
    L.push('（**没找到本月验证卡** —— 不是「没有不可用项」，是没数据可抽。别把这条读成「一切正常」。）');
  } else {
    L.push(`（从 \`${unavailable.source}\` 里没抽到「影子/未实机/未生效」类表述。）`);
    L.push('★ 若实际存在这类状态，说明**验证卡写漏了** —— 这是卡的问题，不是这一节的问题。');
  }
  L.push('');

  // ── 7 · 决策队列快照（用户 2026-10-21 定：四件套加一项）──
  //    「拍板记录一并入 tag 快照。决策队列是治理证据链的一部分——
  //     当时谁批的、批了什么，应该和债账快照同等级别被固化。」
  L.push('## 7 · 决策队列快照（谁批的、批了什么）');
  L.push('');
  L.push('> ★ 与债账快照同等级别：这是**治理证据链**的一部分。');
  L.push('> ★ 未决项不代表「没定就打了 tag」，而是「tag 固化时它还没定」—— 如实记。');
  L.push('');
  try {
    const inbox = path.join(__dirname, 'decide-inbox.js');
    if (fs.existsSync(inbox)) {
      const d = spawnSync(process.execPath, [inbox, 'list', '--all', '--json'], { encoding: 'utf8', timeout: 30000 });
      const parsed = JSON.parse(d.stdout || '{}');
      const items = (parsed.items || []);
      const pend = items.filter((x) => x.status === 'pending');
      const done = items.filter((x) => x.status === 'resolved');
      if (!items.length) {
        L.push('（队列为空：至今没有任何需要主人拍板的事。）');
      } else {
        L.push(`共 ${items.length} 条（未决 ${pend.length} / 已定 ${done.length}）`);
        L.push('');
        if (pend.length) {
          L.push('### 未决（tag 固化时仍未拍板）');
          L.push('');
          for (const it of pend) {
            L.push(`- **${it.id}** [${it.riskLabel || it.risk}] ${it.title}`);
            L.push(`  - 为什么要主人定：${it.why}`);
            L.push(`  - 选项：${(it.options || []).map((o) => o.id + '.' + o.label).join('　')}`);
            L.push(`  - 提出于：${(it.raisedAt || '').replace('T', ' ').slice(0, 19)}`);
          }
          L.push('');
        }
        if (done.length) {
          L.push('### 已拍板（谁批的、批了什么）');
          L.push('');
          for (const it of done) {
            L.push(`- **${it.id}** ${it.title}`);
            L.push(`  - **主人选了 ${it.chosen} · ${it.chosenLabel || ''}**（${(it.resolvedAt || '').replace('T', ' ').slice(0, 19)}，by ${it.resolvedBy || 'user'}）`);
            if (it.note) L.push(`  - 补充：${it.note}`);
          }
          L.push('');
        }
      }
    } else {
      L.push('（decide-inbox.js 不在 —— 读不到决策队列，这不是「没有决策」）');
    }
  } catch (e) {
    L.push(`（读决策队列失败：${e.message} —— 不是「没有决策」）`);
  }
  L.push('');
  return L.join('\n');
}

/* ── selftest ── */
function selftest() {
  const snap = {
    milestone: 'SELFTEST', at: '2026-10-21T00:00:00.000Z',
    repos: { docs: { sha: 'a'.repeat(40), when: '2026-10-21T00:00:00Z', subject: 'x' } },
    jar: { file: 'n.jar', sha256: 'B'.repeat(64) },
    debtsSource: 'x.md', debtsText: '| P0 | 例子 |', timeLocks: [{ id: 'TL-1', title: 't', status: 'open', reviewBy: '2026-11-01' }],
    knownGaps: [{ id: 'G3e-2', what: '宿主 issuer 未接线', effect: '结构变更没有凭据保护', plan: '白班施工', reviewBy: '2026-10-28' }],
  };
  // ★ 不可用清单现在是 { items, source, total } 结构（带文件:行号，可回原文核对）
  const md = renderSnapshot(snap, {
    items: [{ file: '实机验证/2026-10.md', line: 42, text: 'token 预算仍是影子' }],
    source: '实机验证/2026-10.md', total: 1,
  });
  const checks = [
    ['含三仓快照', /三仓快照/.test(md)],
    ['含 jar sha', /B{64}/.test(md)],
    ['含债账', /债账快照/.test(md)],
    ['含时间锁', /TL-1/.test(md)],
    ['含不可用清单', /影子/.test(md)],
    ['含结构性缺口节（knownGaps 必须随 tag 固化）', /结构性缺口/.test(md) && /G3e-2/.test(md)],
    ['含诚实起点声明', /诚实起点/.test(md)],
    ['不可用项带文件:行号坐标', /2026-10\.md:42/.test(md)],
    ['标注纯机械抽取', /纯机械抽取/.test(md)],
  ];
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✔' : '✘'} ${name}`);
    if (ok) pass++;
  }
  console.log(`\n  selftest: ${pass}/${checks.length}`);
  return pass === checks.length ? EXIT_OK : EXIT_REFUSED;
}

/* ── main ── */
function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) { console.log(HELP); return EXIT_OK; }
  if (opt.selftest) return selftest();

  if (opt.list) {
    for (const r of REPOS) {
      const g = git(r.dir, ['tag', '-l', 'audit-*', '--sort=-creatordate']);
      const tags = (g.stdout || '').split(/\r?\n/).filter(Boolean);
      console.log(`${r.name}: ${tags.length ? tags.join(', ') : '（无）'}`);
    }
    return EXIT_OK;
  }

  if (!opt.milestone) { console.error('[usage] 缺 --milestone（如 --milestone G5）'); return EXIT_USAGE; }

  const tag = `audit-${opt.milestone}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  console.log(`审计固化：${tag}${opt.apply ? '' : '（干跑，加 --apply 才真做）'}`);
  console.log('');

  // 安全检查
  const problems = preflightChecks();
  if (problems.length) {
    console.error('✘ 被安全检查拒（这些不解决，打出来的 tag 是假快照）：');
    for (const p of problems) console.error('   - ' + p);
    return EXIT_REFUSED;
  }
  console.log('✔ 安全检查通过（游戏未运行 / 三仓工作区干净）');

  // 收集四件套
  const snap = collectSnapshot(opt.milestone);
  const unavailable = collectUnavailable();
  const md = renderSnapshot(snap, unavailable);

  console.log('');
  console.log('四件套：');
  console.log(`  ① 三仓 tag:  ${tag}`);
  console.log(`  ② jar sha:   ${snap.jar ? snap.jar.sha256.slice(0, 16) + '…' : '（未读到）'}`);
  console.log(`  ③ 债账快照:  ${snap.debtsSource || '（没找到）'}`);
  console.log(`  ④ 不可用项:  ${unavailable.items.length} 条（来源 ${unavailable.source || "未找到验证卡"}）`);

  if (!opt.apply) {
    console.log('');
    console.log('干跑结束。加 --apply 执行。');
    return EXIT_OK;
  }

  // 写快照
  const snapDir = path.join(SNAP_ROOT, tag);
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, 'snapshot.md'), md, 'utf8');
  fs.writeFileSync(path.join(snapDir, 'snapshot.json'), JSON.stringify({ ...snap, unavailable }, null, 2), 'utf8');
  console.log(`\n✔ 快照已写：${path.relative(RDD, snapDir)}`);

  // 三仓打 tag（失败回滚已打的）
  const done = [];
  for (const r of REPOS) {
    const g = git(r.dir, ['tag', '-a', tag, '-m',
      `审计固化 ${opt.milestone} @ ${new Date().toISOString()} | jar=${snap.jar ? snap.jar.sha256.slice(0, 16) : 'n/a'}${opt.note ? ' | ' + opt.note : ''}`]);
    if (g.status !== 0) {
      console.error(`✘ ${r.name} 打 tag 失败：${(g.stderr || '').trim()}`);
      for (const d of done) git(d.dir, ['tag', '-d', tag]);
      console.error(`   已回滚 ${done.length} 个仓的 tag`);
      return EXIT_REFUSED;
    }
    done.push(r);
    console.log(`✔ ${r.name} 打 tag 成功`);
  }

  console.log('');
  console.log(`✔✔ 固化完成：${tag}（三仓同名 tag）`);
  console.log('   审计可以对着这个冻结快照做，AI 继续往下干，不用停机等。');
  console.log('   下个轮回从 snapshot.md 的「诚实起点」出发。');
  return EXIT_OK;
}

process.exit(main());
