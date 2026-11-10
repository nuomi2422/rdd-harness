'use strict';
/**
 * P1-B 消费链（runner 产出 envelope → judge 真实入口）。
 * 用临时 runDir + 冻结契约，断言 judge 写出的 verdict.json 里 S4 的判定与措辞，
 * 证明“归属未核的 0 条”不会被当成 PASS，也证明已绑定违规优先 FAIL。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const JUDGE = path.join(__dirname, '..', 'exp-judge.js');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function runJudge(stopOver) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1b-judge-'));
  const contract = path.join(dir, 'contract.json');
  const cbuf = Buffer.from(JSON.stringify({ revision: 'P1B-1' }));
  fs.writeFileSync(contract, cbuf);
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence', 'boot.log'), 'boot');
  const env = {
    phase: 'done',
    contract: { path: contract, sha256: sha(cbuf), revision: 'P1B-1' },
    jarsAtPrepare: [{ file: 'numen-a.jar' }], jarsAtLaunch: [{ file: 'numen-a.jar' }],
    timings: { watchSeconds: 100 },
    stop: {
      postStopRequests: 0, postStopStatus: 'PRESENT', postStopReasons: [],
      coverageVerified: true, scopeVerified: true, observation: { complete: true },
      observedGraceMs: 60000, javaExited: true, ...stopOver,
    },
    a0: { version: 'a0-v1' },
    session: { status: 'CLEAN', first_request_message_count: 1 },
    interventions: { status: 'NONE', count: 0 },
    context_delivery: { status: 'PRESENT' },
  };
  fs.writeFileSync(path.join(dir, 'envelope.json'), JSON.stringify(env, null, 2));
  spawnSync(process.execPath, [JUDGE, dir], { encoding: 'utf8', timeout: 120000 });
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8'));
  const s4 = (v.assertions || []).find((a) => a.id === 'S4');
  return s4 || { verdict: 'MISSING', detail: '' };
}

test('停后 0 条但归属未核 → S4 不得 PASS', () => {
  const s4 = runJudge({ postStopAttribution: 'unknown' });
  assert.notStrictEqual(s4.verdict, 'PASS', '归属未核给了 PASS：' + JSON.stringify(s4));
  assert.match(String(s4.detail), /归属未核|未核/);
});

test('停后 0 条且归属已核 → S4 PASS', () => {
  const s4 = runJudge({ postStopAttribution: 'bound' });
  assert.strictEqual(s4.verdict, 'PASS', JSON.stringify(s4));
});

test('停后 2 条但归属未核 → FAIL，且不得宣称归属已核', () => {
  const s4 = runJudge({ postStopRequests: 2, postStopAttribution: 'unknown' });
  assert.strictEqual(s4.verdict, 'FAIL', JSON.stringify(s4));
  assert.doesNotMatch(String(s4.detail), /归属已核/);
});

test('停后 2 条且归属已核 → FAIL 并标注归属已核（违规优先）', () => {
  const s4 = runJudge({ postStopRequests: 2, postStopAttribution: 'bound' });
  assert.strictEqual(s4.verdict, 'FAIL', JSON.stringify(s4));
  assert.match(String(s4.detail), /归属已核/);
});
