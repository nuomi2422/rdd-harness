'use strict';
/**
 * guard.js —— H1（103 号）：起跑前的世界状态体检。
 *
 * 为什么需要它（2026-10-29 实测）：`exp-loop-r1` 里同伴复活点被钉在末地虚空，
 * AI 用 `tp`×3 + `setblock … end_portal` 自救。那一轮测到的不是能力，是环境逼出来的作弊。
 *
 * 这里只做**纯文本判定**（喂 get_self_status 的回执），不解析 NBT、不改存档。
 * 命中 → 调用方拒绝起跑；`--allow-void` 可显式绕过。
 */

const DIM_RE = /\b(the_end|the_nether|overworld)\b/i;
const POS_RE = /\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/;

/** 虚空判据：末地且 y<0，或任意维度 y<=-64（原版虚空层）。 */
function isVoid(dim, y) {
  const d = String(dim || '').toLowerCase();
  if (d === 'the_end' && y < 0) return true;
  if (y <= -64) return true;
  return false;
}

/**
 * @param {string} text get_self_status 的回执（JSON 或纯文本都行）
 * @returns {null | {kind:string, dim:string, x:number, y:number, z:number, message:string}}
 */
function voidProblem(text) {
  const s = String(text || '');
  const d = s.match(DIM_RE);
  const p = s.match(POS_RE);
  if (!d || !p) return null;                 // 读不到就不猜
  const dim = d[1].toLowerCase();
  const x = Number(p[1]), y = Number(p[2]), z = Number(p[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  if (!isVoid(dim, y)) return null;
  return {
    kind: dim === 'the_end' ? 'end_void' : 'below_void',
    dim, x, y, z,
    message: '同伴在' + (dim === 'the_end' ? '末地虚空' : '虚空层') + ' (' + x + ',' + y + ',' + z
      + ')；这样跑出来的不是能力，是环境逼出来的 tp/setblock 自救。先修母版出生点/床，或加 --allow-void 显式放行。',
  };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };

  const v1 = voidProblem('位置 the_end (163,-269,681) 脚下空气');
  ok(v1 && v1.kind === 'end_void' && v1.y === -269, '① 末地虚空必须命中');

  const v2 = voidProblem('dimension=overworld pos=(100, 64, 100)');
  ok(v2 === null, '② 主世界正常不得命中');

  const v3 = voidProblem('位置 the_end (3,62,3)');
  ok(v3 === null, '③ 末地地面（y>=0）不得命中');

  const v4 = voidProblem('overworld (0,-80,0)');
  ok(v4 && v4.kind === 'below_void', '④ 任意维度 y<=-64 命中');

  ok(voidProblem('') === null, '⑤ 空文本不猜');
  ok(voidProblem('no coordinates here') === null, '⑥ 读不到坐标不猜');

  console.log(fails.length ? 'guard selftest FAIL: ' + fails.join(' | ') : 'guard selftest PASS（6 组）');
  return fails.length ? 1 : 0;
}

module.exports = { voidProblem, isVoid, selftest };

if (require.main === module) {
  if (process.argv[2] === 'selftest') process.exit(selftest());
  console.error('usage: guard.js selftest');
  process.exit(2);
}
