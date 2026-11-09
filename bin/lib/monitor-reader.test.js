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

test('同 inode 原地覆写开头：靠锚检出 anchor-changed（部分盲区已被缓解）', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, 'aaa\n');
  r.pull('tools.jsonl');
  // 同长度原地覆写，且**改到了开头 64 字节内** → 锚比对能抓到
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.from('bbb\n'), 0, 4, 0);
  fs.closeSync(fd);
  r.pull('tools.jsonl');
  assert.equal(r.gaps['tools.jsonl'].reason, 'anchor-changed');
});

test('盲区（仍不支持）②覆写只发生在锚之后：识别不了', (t) => {
  const { r, file } = setup(t);
  const head = 'H'.repeat(64) + '\n';   // 前 64 字节固定
  fs.writeFileSync(file, head + 'tail-aaaa\n');
  r.pull('tools.jsonl');                  // 锚 = 前 64 字节
  const body = fs.readFileSync(file);
  const fd = fs.openSync(file, 'r+');
  // 只改锚之后的内容，长度不变、inode 不变 → 本模块无从判断
  fs.writeSync(fd, Buffer.from('tail-bbbb\n'), 0, 10, head.length);
  fs.closeSync(fd);
  r.pull('tools.jsonl');
  assert.equal(r.gaps['tools.jsonl'], undefined, '已知盲区：锚之后的原地覆写仍识别不了');
  assert.equal(body.length, fs.statSync(file).size, '大小未变');
});
test('事后复核：读完后内容未变 → verifySegments ok；改动已消费区域 → broken', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, 'aaa\nbbb\n');
  r.pull('tools.jsonl');
  let v = r.verifySegments();
  assert.equal(v.ok, true, '未变时应复核通过');
  assert.equal(v.files['tools.jsonl'].broken, 0);
  assert.equal(v.files['tools.jsonl'].segments, 1);
  // 改掉已消费区域（内容被替换）
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.from('zzz'), 0, 3, 0);
  fs.closeSync(fd);
  v = r.verifySegments();
  assert.equal(v.ok, false, '内容被改后必须复核失败');
  assert.ok(v.files['tools.jsonl'].broken >= 1);
});
test('窗口从非零 offset 起读：段从中间开始（窗口完整性不可证）', (t) => {
  const { dir, file } = setup(t);
  fs.writeFileSync(file, 'old1\nold2\nnew1\n');
  const start = fs.statSync(file).size;          // 模拟"窗口从此刻开始"，跳过历史
  const r2 = createPull({ dir, offsets: { 'tools.jsonl': start } });
  fs.appendFileSync(file, 'new2\n');
  const got = r2.pull('tools.jsonl');
  assert.equal(got, 'new2\n');
  const v = r2.verifySegments();
  assert.equal(v.ok, true, '已消费段本身一致');
  assert.ok(v.files['tools.jsonl'].from > 0, '段起点>0，说明窗口之前的内容没被覆盖');
});

test('空文件：没有可比对段，复核不算通过', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, '');
  assert.equal(r.pull('tools.jsonl'), '');
  const v = r.verifySegments();
  assert.equal(v.ok, false, '没有段就不能声称复核通过');
});

test('多个流缺一：只复核到有段的文件，另一流无段即视为不完整', (t) => {
  const { r, dir, file } = setup(t);
  fs.writeFileSync(file, 'a\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  r.pull('tools.jsonl');
  const v = r.verifySegments();
  assert.equal(Object.keys(v.files).length, 1, '只有 tools 有段');
  assert.equal(v.files['events.jsonl'], undefined);
});
test('窗口完整性：连续读取 → verified；截断后 → 不成立', (t) => {
  const { r, file } = setup(t);
  fs.writeFileSync(file, 'a\n');
  r.pull('tools.jsonl');
  fs.appendFileSync(file, 'b\n');
  r.pull('tools.jsonl');
  let w = r.verifyWindow();
  assert.equal(w.ok, true, '连续追加应满足窗口完整性');
  assert.equal(w.files['tools.jsonl'].contiguous, true);
  assert.equal(w.files['tools.jsonl'].endsAtNow, true);
  // 截断：窗口内出现缺口 → 不成立
  fs.writeFileSync(file, 'c\n');
  r.pull('tools.jsonl');
  w = r.verifyWindow();
  assert.equal(w.ok, false, '出现 truncated-or-rotated 后窗口完整性必须失败');
  assert.equal(w.files['tools.jsonl'].noGap, false);
});

test('窗口完整性是有界的：从中间起读仍然"窗口内成立"（起点>0）', (t) => {
  const { dir, file } = setup(t);
  fs.writeFileSync(file, 'old1\nold2\n');
  const start = fs.statSync(file).size;
  const r2 = createPull({ dir, offsets: { 'tools.jsonl': start } });
  fs.appendFileSync(file, 'new1\n');
  r2.pull('tools.jsonl');
  const w = r2.verifyWindow();
  assert.equal(w.ok, true);
  assert.ok(w.files['tools.jsonl'].from > 0, '窗口起点>0，声明只覆盖观测段');
});
