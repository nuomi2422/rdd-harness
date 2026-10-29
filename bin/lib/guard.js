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

/**
 * H1.1（104 号）：重生点判据。
 * @param {{bound?:boolean, dimension?:string, x?:number, y?:number, z?:number}} info
 * @returns {null | {kind:string, dim:string, x?:number, y:number, z?:number, message:string}}
 */
function respawnProblem(info) {
  if (!info || typeof info !== "object") return null;
  if (!info.bound) return null;                       // 没绑床 ≠ 虚空
  const dim = String(info.dimension || "").toLowerCase();
  const y = Number(info.y);
  if (!Number.isFinite(y)) return null;
  const endVoid = dim === "the_end" && y < 0;
  const belowVoid = y <= -64;
  if (!endVoid && !belowVoid) return null;
  return {
    kind: endVoid ? "respawn_in_end_void" : "respawn_below_void",
    dim, x: Number(info.x), y, z: Number(info.z),
    message: "同伴的重生点绑在" + (endVoid ? "末地虚空" : "虚空层") + " (" + info.x + "," + y + "," + info.z
      + ")；一死就掉进虚空，实验会变成 tp/setblock 自救。先重绑重生点（或加 --allow-void 显式放行）。",
  };
}

/** 从 rdd_respawn_info 的回执文本里取 data 再判（取不到返回 null，不猜）。 */
function respawnProblemFromText(text) {
  try {
    const j = JSON.parse(String(text || ""));
    const d = (j && j.data) ? j.data : j;
    return respawnProblem(d);
  } catch {
    return null;
  }
}

/**
 * H7（118 号）：母版世界体检——从 rdd_nearby_entities 的回执里读末影龙。
 *
 * <p>为什么：exp-loop-r8 里母版有 8 只龙卡在 (0,0,0)，AI 花 8 分钟去猜「数据是不是假的」。
 * 该轮目标本可完成，但它不在主世界。起跑前断言一次，比跑完再归因便宜得多。
 *
 * <p>只读断言：不杀龙、不改母版、不加新工具（复用已有 rdd_nearby_entities）。
 *
 * @param {string} text rdd_nearby_entities 的回执（JSON）
 * @returns {null | {count:number, atOrigin:boolean, message:string}}
 */
function worldSanity(text) {
  let j;
  try { j = JSON.parse(String(text || "")); } catch { return null; }
  const d = (j && j.data) || {};
  // count_only 形态：{total, by_type:{...}}；清单形态：{count, entities:[...]}
  let count = 0;
  let atOrigin = false;
  if (d.by_type && typeof d.by_type === "object") {
    count = Number(d.by_type["minecraft:ender_dragon"] || 0);
  } else if (Array.isArray(d.entities)) {
    for (const e of d.entities) {
      if (String(e && e.type) !== "minecraft:ender_dragon") continue;
      count++;
      if (Math.abs(Number(e.x)) < 0.5 && Math.abs(Number(e.y)) < 0.5 && Math.abs(Number(e.z)) < 0.5) {
        atOrigin = true;
      }
    }
  } else {
    return null;                       // 读不到就不猜
  }
  if (!count) return null;
  const dirty = count > 1 || atOrigin;
  if (!dirty) return null;
  return {
    count, atOrigin,
    message: "母版末地有 " + count + " 只末影龙" + (atOrigin ? "（至少一只卡在原点 0,0,0）" : "")
      + "；这是母版素材污染，不是 AI 能力问题。跑下去只会让它反复猜「数据是不是假的」。"
      + "清母版或加 --allow-dirty-world 显式放行。",
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

  // H1.1：重生点
  ok(respawnProblem({ bound: true, dimension: "the_end", x: 163, y: -269, z: 681 })?.kind === "respawn_in_end_void", "⑦ 重生点绑在末地虚空必须命中");
  ok(respawnProblem({ bound: true, dimension: "overworld", x: 100, y: 64, z: 100 }) === null, "⑧ 主世界重生点不命中");
  ok(respawnProblem({ bound: false }) === null, "⑨ 未绑床不命中（无床 ≠ 虚空）");
  ok(respawnProblemFromText(JSON.stringify({ success: true, data: { bound: true, dimension: "the_end", x: 1, y: -70, z: 2 } }))?.kind === "respawn_in_end_void", "⑩ 回执文本解析命中");
  ok(respawnProblemFromText("not json") === null, "⑪ 解析失败不猜");
  // H7：母版世界体检
  ok(worldSanity(JSON.stringify({ success: true, data: { by_type: { "minecraft:ender_dragon": 8 } } }))?.count === 8, "⑫ 8 只龙必须命中");
  ok(worldSanity(JSON.stringify({ success: true, data: { by_type: { "minecraft:ender_dragon": 1 } } })) === null, "⑬ 正常 1 只龙不误伤");
  ok(worldSanity(JSON.stringify({ success: true, data: { entities: [{ type: "minecraft:ender_dragon", x: 0, y: 0, z: 0 }] } }))?.atOrigin === true, "⑭ 单只但在原点也命中");
  ok(worldSanity(JSON.stringify({ success: true, data: { entities: [{ type: "minecraft:ender_dragon", x: 12, y: 60, z: -8 }] } })) === null, "⑮ 单只且不在原点放行");
  ok(worldSanity("not json") === null, "⑯ 解析失败不猜");
  console.log(fails.length ? 'guard selftest FAIL: ' + fails.join(' | ') : 'guard selftest PASS（16 组）');
  return fails.length ? 1 : 0;
}

module.exports = { voidProblem, respawnProblem, respawnProblemFromText, worldSanity, isVoid, selftest };

if (require.main === module) {
  if (process.argv[2] === 'selftest') process.exit(selftest());
  console.error('usage: guard.js selftest');
  process.exit(2);
}
