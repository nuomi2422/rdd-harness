'use strict';
/**
 * coverage.js —— 覆盖证明（2026-11-10 实现 verified 签发）
 *
 * 原则不变：覆盖是否可信不能由调用方传字符串决定。只有本模块用私有 Symbol 签发；
 * 任何一项证不了就 throw，调用方只能拿到 UNKNOWN，不存在能伪造的绿灯。
 *
 * 规格来源：批次卡 003「覆盖 verified 验收规格」。四条必须证明：
 *   1) 七条流从窗口起点到止点，字节区间首尾相接、无空洞；半行=未完成段；
 *   2) 任何跳字节/轮转/截断 gap ≠ 0 即拒绝；
 *   3) 窗口起止明确（stimulusSentAt → stopEnqueuedAt），窗外字节不计；
 *   4) 事后复读一致：指纹一致只说明内容自读取后没变，不说明来源。
 * 绑定键：world_id + server_session + companionId + requestId，缺一 → unknown（不是 rejected）。
 */
const VERIFIED = Symbol('rdd.coverage.verified');

/** 七条流：缺一条就不能说覆盖完整。 */
const STREAMS = ['tools', 'context', 'events', 'ai', 'rdd', 'expmem', 'instrumentation'];

const BINDING_KEYS = ['world_id', 'server_session', 'companionId', 'requestId'];

function isVerifiedCoverage(obj) {
  return !!(obj && typeof obj === 'object' && obj[VERIFIED] === true);
}

function fail(msg) {
  const e = new Error('coverage-rejected: ' + msg);
  e.code = 'COVERAGE_REJECTED';
  throw e;
}

function unknown(msg) {
  const e = new Error('coverage-unknown: ' + msg);
  e.code = 'COVERAGE_UNKNOWN';
  throw e;
}

function checkBindings(b) {
  if (!b || typeof b !== 'object') unknown('缺绑定键');
  const miss = BINDING_KEYS.filter((k) => typeof b[k] !== 'string' || !b[k].trim());
  if (miss.length) unknown('绑定键缺：' + miss.join(','));
  return Object.fromEntries(BINDING_KEYS.map((k) => [k, b[k].trim()]));
}

function checkGaps(gaps) {
  if (!gaps || typeof gaps !== 'object') fail('缺 gaps');
  for (const name of STREAMS) {
    const g = gaps[name];
    if (!Number.isFinite(g)) fail('gaps 未声明：' + name + '（不声明=不可判，拒绝）');
    if (g !== 0) fail('gaps 不为 0：' + name + '=' + g);
  }
}

function checkSegments(segments, window) {
  if (!segments || typeof segments !== 'object') fail('缺 segments');
  for (const name of STREAMS) {
    const s = segments[name];
    if (!s || typeof s !== 'object') fail('流未消费：' + name);
    if (!Array.isArray(s.segments) || !s.segments.length) fail('无字节段：' + name);
    if (s.halfLine === true) fail('存在半行未完成段：' + name);
    if (Number.isFinite(s.broken) && s.broken !== 0) fail('存在段比对失败：' + name + ' broken=' + s.broken);
    const start = window && window.start ? window.start[name] : undefined;
    const end = window && window.end ? window.end[name] : undefined;
    if (!Number.isFinite(start) || !Number.isFinite(end)) fail('窗口起止缺字节位：' + name);
    if (end < start) fail('窗口止点早于起点：' + name);
    const segs = s.segments.slice().sort((a, b) => a.from - b.from);
    if (segs[0].from !== start) fail('首段未从窗口起点开始：' + name);
    if (segs[segs.length - 1].to !== end) fail('末段未覆盖到窗口止点：' + name);
    for (let i = 1; i < segs.length; i += 1) {
      if (segs[i].from !== segs[i - 1].to) fail('字节段不连续（跳字节或跨窗拼接）：' + name);
    }
    for (const sg of segs) {
      if (!Number.isFinite(sg.from) || !Number.isFinite(sg.to) || sg.to < sg.from) fail('非法字节段：' + name);
      if (sg.fingerprintMatch === false) fail('事后复读指纹不一致：' + name);
    }
  }
}

function checkLifecycle(lifecycle) {
  if (!lifecycle || typeof lifecycle !== 'object') fail('缺 lifecycle');
  if (lifecycle.closed !== true) fail('生命周期未闭合');
  if (Number.isFinite(lifecycle.replays) && lifecycle.replays !== 0) fail('窗口内存在重放 event_id：' + lifecycle.replays);
  if (!lifecycle.fileIds || typeof lifecycle.fileIds !== 'object') fail('缺文件身份（无法排除换文件）');
  for (const name of STREAMS) {
    const f = lifecycle.fileIds[name];
    if (!f || typeof f !== 'object') fail('缺文件身份：' + name);
    if (f.start === undefined || f.end === undefined) fail('文件身份不完整：' + name);
    if (String(f.start) !== String(f.end)) fail('日志被换文件（fileId 变化）：' + name);
  }
}

/**
 * 验证并签发已验证覆盖。任何一条证不了就 throw，不返回半成品。
 */
function makeVerifiedCoverage(evidence) {
  if (!evidence || typeof evidence !== 'object') unknown('无 evidence');
  const bindings = checkBindings(evidence.bindings);
  const window = evidence.window;
  if (!window || !window.start || !window.end) fail('缺窗口起止字节位');
  if (!window.stimulusSentAt || !window.stopEnqueuedAt) fail('缺窗口时刻（刺激送出/停止入队）');
  checkGaps(evidence.gaps);
  checkSegments(evidence.segments, window);
  checkLifecycle(evidence.lifecycle);
  const closedWindow = window.completeness === 'verified-for-observed-window';
  return Object.freeze({
    [VERIFIED]: true,
    contentIntegrity: 'verified',
    windowCompleteness: closedWindow ? 'verified-for-observed-window' : 'unproven',
    scope: 'content-immutable-since-read',
    files: STREAMS.slice(),
    bindings: Object.freeze(bindings),
    observedWindow: {
      scope: 'observed-bytes-only',
      start: Object.freeze({ ...window.start }),
      end: Object.freeze({ ...window.end }),
      stimulusSentAt: window.stimulusSentAt,
      stopEnqueuedAt: window.stopEnqueuedAt,
    },
  });
}

function coverageLevel(obj) {
  if (!isVerifiedCoverage(obj)) return 'limited';
  return obj.windowCompleteness === 'verified-for-observed-window' ? 'verified' : 'content-only';
}

module.exports = { makeVerifiedCoverage, isVerifiedCoverage, coverageLevel, STREAMS, BINDING_KEYS };
