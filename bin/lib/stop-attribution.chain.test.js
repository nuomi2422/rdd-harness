'use strict';
/**
 * P1-B 全链（R-02 第 6 点）：真实事件行 → stop-counter → buildStopEvidence（runner 同一组装缝）
 * → envelope.json → exp-judge 真实入口。断言 judge 写出的 S4，而不是手写 coverage 字段。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createStopCounter } = require('./stop-counter');
const { buildStopEvidence } = require('./stop-evidence');

const JUDGE = path.join(__dirname, '..', 'exp-judge.js');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SCOPE = { worldId: 'w1', serverSession: 's1', companionId: 'uuid-1' };
const CUT = '2026-11-10T12:00:00.000Z';
const AFTER = '2026-11-10T12:00:01.000Z';

function makeStop({ lines, correlation = { receiptAt: CUT }, scope = SCOPE, observationComplete = true }) {
  const chunk = (lines || []).join('\n');
  const counter = createStopCounter(() => chunk, CUT, scope, correlation);
  counter.collect();
  const snap = counter.snapshot();
  const stop = buildStopEvidence({
    counterSnapshot: snap,
    observation: { complete: observationComplete, observedMs: 60000 },
    coverageVerified: true,
    scopeVerified: true,
    observedGraceMs: 60000,
    javaExited: true,
    stopAt: CUT,
    stopEffectiveAt: CUT,
    stopEffectiveReceipt: { state: 'EFFECTIVE', at: CUT },
    stopScope: scope,
    postStopStatus: 'PRESENT',
    postStopReasons: snap.errors,
    rawScanCount: snap.rawCount,
  });
  return { stop, snap };
}

function runJudge(stop) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1b-chain-'));
  const contract = path.join(dir, 'contract.json');
  const cbuf = Buffer.from(JSON.stringify({ revision: 'P1B-R02' }));
  fs.writeFileSync(contract, cbuf);
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence', 'boot.log'), 'boot');
  const env = {
    phase: 'done',
    contract: { path: contract, sha256: sha(cbuf), revision: 'P1B-R02' },
    jarsAtPrepare: [{ file: 'numen-a.jar' }], jarsAtLaunch: [{ file: 'numen-a.jar' }],
    timings: { watchSeconds: 100 },
    stop,
    a0: { version: 'a0-v1' },
    session: { status: 'CLEAN', first_request_message_count: 1 },
    interventions: { status: 'NONE', count: 0 },
    context_delivery: { status: 'PRESENT' },
  };
  fs.writeFileSync(path.join(dir, 'envelope.json'), JSON.stringify(env, null, 2));
  spawnSync(process.execPath, [JUDGE, dir], { encoding: 'utf8', timeout: 120000 });
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8'));
  return (v.assertions || []).find((a) => a.id === 'S4') || { verdict: 'MISSING', detail: '' };
}

const req = (over = {}) => JSON.stringify({
  type: 'llm_request', timestamp: AFTER, world_id: 'w1', server_session: 's1',
  data: { requestId: 'r1', attempt: 1, status: 'dispatched', companionId: 'uuid-1', ...over },
});

test('合法完整零（窗口可归属、0 违规）→ S4 PASS', () => {
  const { stop } = makeStop({ lines: [] });
  assert.equal(stop.postStopAttribution, 'bound-clean');
  const s4 = runJudge(stop);
  assert.strictEqual(s4.verdict, 'PASS', JSON.stringify(s4));
});

test('归属未知（无回执关联）且 0 条 → NOT_COVERED，不得 PASS', () => {
  const { stop } = makeStop({ lines: [], correlation: {} });
  assert.equal(stop.postStopAttribution, 'unknown');
  const s4 = runJudge(stop);
  assert.strictEqual(s4.verdict, 'NOT_COVERED', JSON.stringify(s4));
});

test('已归属 1 条违规 → FAIL', () => {
  const { stop } = makeStop({ lines: [req()] });
  assert.equal(stop.postStopAttribution, 'bound-violation');
  const s4 = runJudge(stop);
  assert.strictEqual(s4.verdict, 'FAIL', JSON.stringify(s4));
});

test('未归属 raw>0（别的同伴）→ NOT_COVERED，不拿别人请求判 FAIL', () => {
  const { stop, snap } = makeStop({ lines: [req({ companionId: 'uuid-other' })] });
  assert.equal(snap.foreign, 1);
  assert.equal(stop.postStopAttribution, 'bound-clean', 'foreign 不算违规，窗口本身可归属');
  const s4 = runJudge(stop);
  // 归属可判但无违规 → 合法零 PASS；关键在于不能把 foreign 当违规 FAIL
  assert.strictEqual(s4.verdict, 'PASS', JSON.stringify(s4));
});

test('failed 后同 requestId 再 dispatched → 计违规 → FAIL', () => {
  const { stop } = makeStop({ lines: [req({ status: 'failed' }), req({ attempt: 2 })] });
  assert.equal(stop.postStopRequests, 1);
  assert.strictEqual(runJudge(stop).verdict, 'FAIL');
});

test('坏 JSON → 窗口不可归属 → NOT_COVERED', () => {
  const { stop } = makeStop({ lines: ['not-json'] });
  assert.equal(stop.postStopAttribution, 'unknown');
  assert.strictEqual(runJudge(stop).verdict, 'NOT_COVERED');
});
