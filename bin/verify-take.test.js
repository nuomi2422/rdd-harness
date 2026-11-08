'use strict';
// verify-take.js 的离线回归：用合成 take 目录，绝不碰真实截图/游戏。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'verify-take.js');

function take(t, rows, pngs, stats) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'take-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  if (rows) fs.writeFileSync(path.join(d, 'frames.csv'), ['capture,epochNanos,gameTime,cameraX,cameraY,cameraZ', ...rows].join('\n'));
  for (const [name, buf] of Object.entries(pngs || {})) fs.writeFileSync(path.join(d, name), Buffer.from(buf));
  if (stats) fs.writeFileSync(path.join(d, 'frame-stats.csv'), ['name,std,edge,uniq', ...stats].join('\n'));
  const r = spawnSync(process.execPath, [SCRIPT, d], { encoding: 'utf8' });
  return { d, code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('没有 frames.csv 时判不可判，且不当通过', (t) => {
  const r = take(t, null, { 'f_00000.png': 'A' });
  assert.equal(r.code, 2);
  assert.match(r.out, /没有 frames.csv/);
});

test('相机在动而画面不变：只报需分别核，不判采集故障', (t) => {
  const r = take(t, [
    '0,1000,100,1.0,2.0,3.0',
    '1,2000,105,2.0,2.0,3.0',
    '2,3000,110,3.0,2.0,3.0',
  ], { 'f_00000.png': 'AAAA', 'f_00001.png': 'AAAA', 'f_00002.png': 'BBBB' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /相机在动而画面不变（1 帧）/);
  assert.match(r.out, /不能据此判采集故障/);
});

test('世界没走时说明画面重复属真实', (t) => {
  const r = take(t, [
    '0,1000,100,1.0,2.0,3.0',
    '1,2000,100,1.0,2.0,3.0',
  ], { 'f_00000.png': 'AAAA', 'f_00001.png': 'AAAA' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /世界确实停过/);
});

test('采集时刻倒序时判 UNKNOWN，不定因果', (t) => {
  const r = take(t, [
    '0,5000,100,1.0,2.0,3.0',
    '1,1000,105,2.0,2.0,3.0',
  ], { 'f_00000.png': 'AAAA', 'f_00001.png': 'BBBB' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /采集时刻倒序/);
});

test('帧统计存在时只输出告警，且明说不得因低信息删素材', (t) => {
  const r = take(t, [
    '0,1000,100,1.0,2.0,3.0',
    '1,2000,105,1.0,2.0,3.0',
  ], { 'f_00000.png': 'AAAA', 'f_00001.png': 'BBBB' }, [
    'f_00000.png,1.0,0.5,2',
    'f_00001.png,1.2,0.4,2',
  ]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /画面信息量（告警，不判无效）/);
  assert.match(r.out, /严禁因低信息自动删素材/);
});
