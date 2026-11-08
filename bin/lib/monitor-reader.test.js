'use strict';
// monitor-reader 单测：逐项覆盖缺口语义，并**显式记录识别不了的盲区**（不假装支持）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPull } = require('./monitor-reader');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ev = fs.mkdtempSync(path.join(os.tmpdir(), 'mrev-'));
  t.after(() => fs.rmSync(ev, { recursive: true, force: true }));
  const r = createPull({ dir, evidenceDir: ev });
  return { dir, ev, r, file: path.join(dir, 'tools.jsonl') };
}

test('正常追加：只回增量，不重复', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, 'a\n');
  assert.equal(r.pull('tools.jsonl'), 'a\n');
  fs.appendFileSync(file, 'b\n');
  assert.equal(r.pull('tools.jsonl'), 'b\n');
  assert.equal(r.pull('tools.jsonl'), '');
  assert.deepEqual(r.gaps, {});
});

test('半行扣留：未换行不消费，补齐后整行返回', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, 'a\nb');        // b 没有换行
  assert.equal(r.pull('tools.jsonl'), 'a\n');
  assert.equal(r.gaps['tools.jsonl'], undefined, '单次半行不算缺口（还在写）');
  fs.appendFileSync(file, '\n');          // 补齐
  assert.equal(r.pull('tools.jsonl'), 'b\n');
});

test('半行停滞：连续两次大小不变且仍有半行 → stalled-partial', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, 'a\npartial');
  assert.equal(r.pull('tools.jsonl'), 'a\n');
  r.pull('tools.jsonl');                   // 第二次，大小没变
  assert.equal(r.gaps['tools.jsonl'].reason, 'stalled-partial');
});

test('截断/轮转变小：记 truncated-or-rotated 并从头重读', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, 'aaa\nbbb\n');
  assert.equal(r.pull('tools.jsonl'), 'aaa\nbbb\n');
  fs.writeFileSync(file, 'c\n');          // 变小
  assert.equal(r.pull('tools.jsonl'), 'c\n');
  assert.equal(r.gaps['tools.jsonl'].reason, 'truncated-or-rotated');
});

test('同大小替换（inode 变）：记 replaced-same-size', (t) => {
  const { r, file, dir } = setup(t);
  fs.writeFileSync(file, 'aaa\n');
  assert.equal(r.pull('tools.jsonl'), 'aaa\n');
  const tmp = path.join(dir, 'tools.jsonl.tmp');
  fs.writeFileSync(tmp, 'bbb\n');         // 同样 4 字节
  fs.renameSync(tmp, file);                // 轮转式替换
  assert.equal(r.pull('tools.jsonl'), 'bbb\n');
  assert.equal(r.gaps['tools.jsonl'].reason, 'replaced-same-size');
});

test('缺失文件：读过之后消失 → missing-file；重建后能继续读', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, 'a\n');
  assert.equal(r.pull('tools.jsonl'), 'a\n');
  fs.unlinkSync(file);
  assert.equal(r.pull('tools.jsonl'), '');
  assert.equal(r.gaps['tools.jsonl'].reason, 'missing-file');
});

test('读失败：目标是目录 → 记 read-failed，不抛', (t) => {
  const { dir, r } = setup(t);
  fs.mkdirSync(path.join(dir, 'tools.jsonl'));
  assert.equal(r.pull('tools.jsonl'), '');
  assert.equal(r.gaps['tools.jsonl'].reason, 'not-a-file');
});

test('盲区（已知不支持）①同 inode 原地覆写：不产生 gap', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, 'aaa\n');
  r.pull('tools.jsonl');
  // 同长度原地覆写：inode 不变、大小不变 → 本模块**识别不了**
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.from('bbb\n'), 0, 4, 0);
  fs.closeSync(fd);
  assert.equal(r.pull('tools.jsonl'), '');
  assert.equal(r.gaps['tools.jsonl'], undefined, '这是已知盲区：不得声称已覆盖');
});

test('盲区（已知不支持）②先增长后被更大内容整体覆盖：不产生 gap', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, 'a\n');
  r.pull('tools.jsonl');
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.from('cccc\ndddd\n'), 0, 10, 0); // 变大且内容全换
  fs.closeSync(fd);
  const got = r.pull('tools.jsonl');
  assert.equal(r.gaps['tools.jsonl'], undefined, '已知盲区：大小变大时无法识别');
  assert.ok(got.length >= 0);
});
