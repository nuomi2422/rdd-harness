#!/usr/bin/env node
/**
 * checkpoint.js —— 压缩前落盘 / 唤醒续接（2026-10-22 用户定的「超长线底座」第一版）
 *
 * 问题：上下文一压缩，批次断点、坐标、正在跑的状态机节点全丢；下个会话只能从聊天记录考古。
 * 做法：**不赌模型记得住**，把「醒来必须先看的那几件事」写成一个固定 schema 的文件，
 *       压缩前写、醒来第一件事读。
 *
 * 用法：
 *   node checkpoint.js write --objective "..." --where "x=1 y=64 z=2" --doing "..." --next "..." [--batch G6a] [--note "..."]
 *   node checkpoint.js read            # 醒来第一件事：把快照打出来（紧凑，<40 行）
 *   node checkpoint.js show --json
 *   node checkpoint.js clear
 *
 * 文件：docs/rdd-docs/rdd架构/_memory/CHECKPOINT.md（跟 git 走，换机器也在）
 *
 * ⚠️ 边界（写清楚，别假装）：DSH 的自动压缩在应用内部，**没有对外钩子**。
 *    所以这个脚本只能提供「写/读」两端；「压缩前自动调用」目前靠两条纪律触发：
 *    ①每批收尾 ②任何时候感觉上下文吃紧。真正的自动钩子需要 DSH 插件 API（未确认存在）。
 */
const fs = require('node:fs');
const path = require('node:path');

const RDD = 'D:\\rdd';
const FILE = path.join(RDD, 'docs', 'rdd-docs', 'rdd架构', '_memory', 'CHECKPOINT.md');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function flag(name) {
  return process.argv.includes('--' + name);
}

function now() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function readRaw() {
  if (!fs.existsSync(FILE)) return null;
  return fs.readFileSync(FILE, 'utf8');
}

function parse(text) {
  if (!text) return {};
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^- \*\*(.+?)\*\*[:：]\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function write() {
  const objective = arg('objective') || '(未填)';
  const where = arg('where') || '(未填)';
  const doing = arg('doing') || '(未填)';
  const next = arg('next') || '(未填)';
  const batch = arg('batch') || '';
  const note = arg('note') || '';
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const body = [
    '# CHECKPOINT —— 醒来先看这个',
    '',
    `> 写入时间：${now()}${batch ? `（批次 ${batch}）` : ''}`,
    '> 读法（新会话第一条命令）：`node D:\\rdd\\harness\\rdd-harness\\bin\\checkpoint.js read`',
    '',
    `- **主线目标**：${objective}`,
    `- **人在哪**：${where}`,
    `- **正在做什么**：${doing}`,
    `- **下一步**：${next}`,
    note ? `- **备注**：${note}` : null,
    '',
    '## 为什么只有这几行',
    '压缩后能救命的不是「全部历史」，是「我现在在哪、要干什么」。细节去 `_memory` 记忆库搜，',
    '判据去 `实机验证/<批次卡>.md` 看。这张纸只负责让你**醒来不迷路**。',
    '',
  ].filter((x) => x !== null).join('\n');
  fs.writeFileSync(FILE, body, 'utf8');
  console.log(`已写：${FILE}`);
  console.log(body.split('\n').filter((l) => l.startsWith('- **')).join('\n'));
}

function read() {
  const raw = readRaw();
  if (!raw) {
    console.log('（没有 CHECKPOINT —— 说明上一轮没写；先看 _memory 记忆库与最近的批次卡）');
    return;
  }
  console.log(raw);
}

function show() {
  const raw = readRaw();
  console.log(JSON.stringify({ file: FILE, exists: !!raw, fields: parse(raw) }, null, 2));
}

function clear() {
  if (fs.existsSync(FILE)) {
    fs.unlinkSync(FILE);
    console.log('已清：' + FILE);
  } else {
    console.log('（本来就没有）');
  }
}

const cmd = process.argv[2];
if (cmd === 'write') write();
else if (cmd === 'read') read();
else if (cmd === 'show') show();
else if (cmd === 'clear') clear();
else {
  console.log('用法：node checkpoint.js write --objective ... --where ... --doing ... --next ... [--batch ...]');
  console.log('      node checkpoint.js read | show [--json] | clear');
  process.exit(1);
}
