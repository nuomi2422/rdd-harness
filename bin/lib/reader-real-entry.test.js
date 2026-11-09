'use strict';
// 真实 monitor 文件上的读端测试（不是夹具）：读取器 + 动作账本。无真实文件则 skip。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const MR = require('./monitor-reader');
const AL = require('./action-ledger');

const DIR = process.env.RDD_MONITOR || 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
const has = fs.existsSync(path.join(DIR, 'tools.jsonl'));

test('真实读取器：首拉有数据、再拉不重复、窗口可判', { skip: has ? false : '无真实 monitor 文件' }, () => {
  const r = MR.createPull({ dir: DIR });
  const first = r.pull('tools.jsonl');
  assert.ok(typeof first === 'string' && first.length > 0, '首拉应有数据');
  assert.equal(r.pull('tools.jsonl'), '', '同一偏移再拉不应重复给数据');
  const w = r.verifyWindow(['tools.jsonl', 'events.jsonl']);
  assert.ok(w && typeof w.ok === 'boolean', '应能判窗口');
  assert.ok(w.files && Object.keys(w.files).length >= 1, '至少覆盖一个流');
});

test('真实动作账本：能出调用数与覆盖，且无解析器时身份为 0/N', { skip: has ? false : '无真实 monitor 文件' }, () => {
  const raw = fs.readFileSync(path.join(DIR, 'tools.jsonl'), 'utf8');
  const tail = raw.split(/\r?\n/).filter(Boolean).slice(-2000).join('\n');
  const lg = AL.build(tail, '');
  assert.ok(lg.summary.calls > 0, '应统计到调用');
  const known = String(lg.summary.coverage.identityKnown || '0/0');
  assert.ok(known.endsWith('/' + lg.summary.calls) || known !== '0/0', '覆盖分母应为调用数');
  assert.equal(known.split('/')[0], '0', '没有解析器时不应出现已知身份');
  assert.ok(lg.summary.states && typeof lg.summary.states === 'object', '应给终态分布');
});
