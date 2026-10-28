#!/usr/bin/env node
'use strict';
/**
 * mf-kit.js —— 便宜模型用的「基础函数库」（组合层，2026-10-28）
 *
 * 为什么存在：
 *   写代码的 AI 要直接进 MC 干活。让便宜模型自己写「挖三个石头」，它得处理寻路失败、
 *   背包满了、方块类型不对十几条分支 —— 那是把聪明用错了地方。这个库把 mineflayer
 *   生态（pathfinder/collectblock/pvp/auto-eat/armor-manager/blockfinder）拼成
 *   一行能调的动作，报错也少。
 *
 * 定位：**不重写底层**。寻路/挖/战斗/吃饭全是 npm 现成插件，本文件只做编排。
 *   同理 RDD 主实例走 Numen 的 81 个 MCP 工具，这里是「AI 自己动手」那条路。
 *
 * 用法（在 eval 脚本里）：
 *   const kit = require('D:/rdd/harness/rdd-harness/bin/mf-kit.js');
 *   await kit.setup(bot);                       // 必须：装插件 + 配 pathfinder
 *   await kit.collect(bot, 'oak_log', 4);       // 砍 4 个原木（寻路+破坏+拾取全包）
 *   await kit.goto(bot, 100, 64, 200);          // 走过去
 *   await kit.mine(bot, 'stone', 3);            // 挖 3 个石头
 *   await kit.craft(bot, 'crafting_table');     // 合成（自动找/放工作台）
 *   await kit.eatIfHungry(bot);                 // 饿了就吃
 *   await kit.attackNearest(bot, 'zombie');     // 打最近的僵尸
 *   await kit.findBlock(bot, 'iron_ore', 32);   // 找最近的铁矿
 *   const st = kit.state(bot);                  // 读状态（位置/血量/背包/时间）
 *
 * 设计纪律：
 *   - 每个动作都返回**可判读的结果**（ok/reason/data），不抛裸异常给模型猜。
 *   - 全部带超时；超时返回 { ok:false, reason:'timeout' }，不让调用方挂死。
 *   - 失败不改世界、不静默重试：让模型看见「为什么没成」再决定。
 */
const path = require('path');

const SEAT = process.env.MF_SEAT || 'D:/rdd/tools/mineflayer';
const NM = path.join(SEAT, 'node_modules');

function req(name) {
  try { return require(path.join(NM, name)); } catch (e) { return null; }
}

const pathfinderMod = req('mineflayer-pathfinder');
const collectBlockMod = req('mineflayer-collectblock');
const pvpMod = req('mineflayer-pvp');
const autoEatMod = req('mineflayer-auto-eat');
const armorMod = req('mineflayer-armor-manager');
const blockfinderMod = req('mineflayer-blockfinder');
// ★ collectblock 的硬依赖：CollectBlock.js:189-190 明确检查 bot.tool == null 就抛
//   UnresolvedDependency。这个包是 collectblock 的传递依赖，但插件仍要自己 load。
const toolMod = req('mineflayer-tool');

/** 已装插件清单（诊断用）。 */
function plugins() {
  return {
    pathfinder: !!pathfinderMod,
    collectblock: !!collectBlockMod,
    pvp: !!pvpMod,
    autoEat: !!autoEatMod,
    armorManager: !!armorMod,
    blockfinder: !!blockfinderMod,
  };
}

/** 装插件 + 配 pathfinder。每个 bot 调一次。 */
function setup(bot) {
  const missing = [];
  if (pathfinderMod) bot.loadPlugin(pathfinderMod.pathfinder);
  else missing.push('mineflayer-pathfinder');
  if (collectBlockMod) bot.loadPlugin(collectBlockMod.plugin);
  else missing.push('mineflayer-collectblock');
  if (pvpMod) bot.loadPlugin(pvpMod.plugin);
  else missing.push('mineflayer-pvp');
  // 各插件的导出形态不一样（实测 2026-10-28）：
  //   collectblock / pvp  → { plugin, ... }        → bot.loadPlugin(x.plugin)
  //   auto-eat            → { loader }             → bot.loadPlugin(x.loader)
  //   armor-manager       → 直接是 initializeBot   → bot.loadPlugin(fn)
  // 三种都试，失败记进 missing 而不是抛。
  if (autoEatMod) {
    const fn = autoEatMod.loader || autoEatMod.plugin || autoEatMod;
    try { bot.loadPlugin(fn); } catch (e) { missing.push('mineflayer-auto-eat(' + e.message + ')'); }
  }
  if (armorMod) {
    const fn = typeof armorMod === 'function' ? armorMod : (armorMod.plugin || armorMod);
    try { bot.loadPlugin(fn); } catch (e) { missing.push('mineflayer-armor-manager(' + e.message + ')'); }
  }
  if (toolMod) bot.loadPlugin(toolMod.plugin || toolMod);
  else missing.push('mineflayer-tool');
  bot.__mfkit = { missing };
  return { ok: missing.length === 0, missing, plugins: plugins() };
}

/** 等 pathfinder 就绪（loadPlugin 是异步挂上的）。 */
async function waitPathfinder(bot, ms = 3000) {
  const t0 = Date.now();
  while (!bot.pathfinder && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  return !!bot.pathfinder;
}

function withTimeout(sec, fn, onTimeout) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(async () => {
      if (done) return;
      done = true;
      try { if (onTimeout) await onTimeout(); } catch { /* ignore */ }
      resolve({ ok: false, reason: 'timeout', seconds: sec });
    }, sec * 1000);
    Promise.resolve()
      .then(fn)
      .then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
      .catch((e) => { if (!done) { done = true; clearTimeout(t); resolve({ ok: false, reason: 'error', error: String(e && e.message ? e.message : e) }); } });
  });
}

/** 读状态：位置/血量/饥饿/背包/时间/维度。模型最常要的就是这些。 */
function state(bot) {
  const p = bot.entity && bot.entity.position;
  const items = {};
  try {
    for (const it of bot.inventory.items()) items[it.name] = (items[it.name] || 0) + it.count;
  } catch { /* ignore */ }
  let timeOfDay = null, isDay = null;
  try { timeOfDay = bot.time.timeOfDay; isDay = bot.time.isDay; } catch { /* ignore */ }
  return {
    ok: !!p,
    pos: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null,
    health: bot.health,
    food: bot.food,
    dimension: bot.game && bot.game.dimension,
    timeOfDay, isDay,
    items,
    itemKinds: Object.keys(items).length,
    freeSlots: 36 - (bot.inventory.items().length || 0),
  };
}

/** 走到坐标。 */
async function goto(bot, x, y, z, range = 1) {
  if (!(await waitPathfinder(bot))) return { ok: false, reason: 'no-pathfinder' };
  const { goals } = pathfinderMod;
  const Goal = y === undefined || y === null
    ? new goals.GoalNearXZ(x, z, range)
    : new goals.GoalNear(x, y, z, range);
  return withTimeout(120, async () => {
    await bot.pathfinder.goto(Goal);
    const p = bot.entity.position;
    return { ok: true, pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } };
  }, () => { try { bot.pathfinder.stop(); } catch { } });
}

/**
 * 方块名 → ID。★ 2026-10-28 实测踩坑：bot.findBlocks({matching}) 只认 **ID 或数组/函数**，
 * 传名字字符串会静默返回空数组（不报错！），表现为「collect 说没找到，其实一直在挖」。
 */
function blockIds(bot, name) {
  const b = bot.registry.blocksByName[name];
  if (!b) return null;
  return b.id;
}

/** 采集 N 个指定方块（寻路+破坏+拾取全包）。 */
async function collect(bot, blockName, count = 1, timeoutSec = 180, maxDistance = 96) {
  if (!bot.collectBlock) return { ok: false, reason: 'no-collectblock' };
  const id = blockIds(bot, blockName);
  if (id === null) return { ok: false, reason: 'unknown-block', blockName };
  const before = countOf(bot, blockName);
  return withTimeout(timeoutSec, async () => {
    // ★ 2026-10-28：半径原来是硬编码 64，实测树在 71 格外 → 永远 not-found。
    //   改成参数（默认 96），让调用方能按场景放开。
    const positions = bot.findBlocks({ matching: id, maxDistance, count: Math.max(count * 4, 8) });
    if (!positions.length) return { ok: false, reason: 'not-found', blockName, maxDistance };
    // ★ 2026-10-28 实测踩坑：collectBlock.collect() 只吃 **Block 对象**。
    //   Targets.getClosest() 会调 target.position.distanceTo(...)；传 Vec3 就报
    //   「Cannot read properties of undefined (reading 'distanceTo')」。
    const blocks = positions.map((p) => bot.blockAt(p)).filter((b) => b && b.name && b.name !== 'air');
    if (!blocks.length) return { ok: false, reason: 'blocks-unloaded', blockName };
    await bot.collectBlock.collect(blocks, { ignoreNoPath: true });
    const after = countOf(bot, blockName);
    return { ok: after > before, gained: after - before, total: after, wanted: count };
  }, () => { try { bot.collectBlock.cancelTask(); } catch { } });
}

/** 挖 N 个指定方块（不强制拾取，用于挖通道）。 */
async function mine(bot, blockName, count = 1, timeoutSec = 180) {
  const id = blockIds(bot, blockName);
  if (id === null) return { ok: false, reason: 'unknown-block', blockName };
  return withTimeout(timeoutSec, async () => {
    let dug = 0;
    for (let i = 0; i < count; i++) {
      const blocks = bot.findBlocks({ matching: id, maxDistance: 48, count: 8 });
      if (!blocks.length) break;
      const b = bot.blockAt(blocks[0]);
      if (!b || !b.diggable) break;
      try { await bot.dig(b, true); dug++; } catch { break; }
    }
    return { ok: dug > 0, dug, wanted: count };
  }, () => { try { bot.pathfinder && bot.pathfinder.stop(); } catch { } });
}

/** 找最近的指定方块，返回坐标（找不到 ok:false）。 */
function findBlock(bot, blockName, maxDistance = 32) {
  const id = blockIds(bot, blockName);
  if (id === null) return { ok: false, reason: 'unknown-block', blockName };
  const p = bot.findBlock({ matching: id, maxDistance });
  if (!p) return { ok: false, reason: 'not-found', blockName, maxDistance };
  return { ok: true, pos: { x: p.position.x, y: p.position.y, z: p.position.z }, name: p.name };
}

/** 合成一个物品（自动处理工作台）。 */
async function craft(bot, itemName, count = 1, timeoutSec = 90) {
  const mcData = req('minecraft-data')(bot.version);
  const item = mcData.itemsByName[itemName];
  if (!item) return { ok: false, reason: 'unknown-item', itemName };
  return withTimeout(timeoutSec, async () => {
    const recipes = bot.recipesFor(item.id, null, 1, null);
    if (!recipes.length) {
      // 可能需要工作台
      const table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 16 });
      if (!table) return { ok: false, reason: 'no-recipe-or-table', itemName };
      const r2 = bot.recipesFor(item.id, null, 1, table);
      if (!r2.length) return { ok: false, reason: 'no-recipe', itemName };
      await bot.craft(r2[0], count, table);
    } else {
      await bot.craft(recipes[0], count, null);
    }
    return { ok: true, itemName, count, nowHas: countOf(bot, itemName) };
  });
}

/**
 * 保证身边有一个可用的工作台（没有就做一个并放下）。
 *
 * 为什么需要：craft() 只会**找**现成工作台，不会**造并放**。
 * 于是「木板 → 工作台 → 木镐」这条最基础的链会卡在第二步：
 * 工作台合出来了，却因为它躺在地上而 3x3 配方永远 no-recipe。
 *
 * 做法：① 16 格内有工作台 → 直接用；② 没有 → 用 4 木板合一个；
 * ③ 合出来但没放 → 挑一个「目标格是空气、下面有实心块」的相邻格，放上去。
 */
async function ensureTable(bot, opts = {}) {
  // ★ 必须走 req()：本文件住在 harness/bin，Node 的 require 只按**本文件位置**找
  //   node_modules；直接 require('vec3') 会 Cannot find module（座位在 tools/mineflayer）。
  const Vec3 = req('vec3');
  const mcData = req('minecraft-data')(bot.version);
  const tableId = mcData.blocksByName.crafting_table.id;

  const near = bot.findBlock({ matching: tableId, maxDistance: opts.maxDistance ?? 16 });
  if (near) {
    return { ok: true, existing: true, pos: { x: near.position.x, y: near.position.y, z: near.position.z } };
  }

  if (!countOf(bot, 'crafting_table')) {
    const r = await craft(bot, 'crafting_table', 1, opts.timeoutSec ?? 60);
    if (!r.ok) return { ok: false, reason: 'cannot-craft-table', detail: r };
  }

  const item = bot.inventory.items().find((i) => i.name === 'crafting_table');
  if (!item) return { ok: false, reason: 'table-not-in-inventory' };

  try { await bot.equip(item, 'hand'); } catch (e) {
    return { ok: false, reason: 'equip-failed', error: String(e.message).slice(0, 120) };
  }

  const base = bot.entity.position.floored();
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of dirs) {
    const targetPos = base.offset(dx, 0, dz);
    const target = bot.blockAt(targetPos);
    const under = bot.blockAt(base.offset(dx, -1, dz));
    if (!target || target.name !== 'air') continue;
    if (!under || under.name === 'air' || under.boundingBox !== 'block') continue;
    try {
      await bot.placeBlock(under, new Vec3(0, 1, 0));
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, placed: true, pos: { x: targetPos.x, y: targetPos.y, z: targetPos.z } };
    } catch (e) {
      return { ok: false, reason: 'place-failed', error: String(e.message).slice(0, 120) };
    }
  }
  return { ok: false, reason: 'no-placement-spot' };
}

/** 饿了就吃（auto-eat 的显式版，模型可直接调）。 */
async function eatIfHungry(bot, threshold = 16) {
  if (bot.food > threshold) return { ok: true, skipped: true, food: bot.food };
  const food = bot.inventory.items().find((i) => /bread|cooked_|apple|carrot|potato|beef|porkchop|chicken|mutton/.test(i.name));
  if (!food) return { ok: false, reason: 'no-food', food: bot.food };
  return withTimeout(20, async () => {
    await bot.equip(food, 'hand');
    await bot.consume();
    return { ok: true, ate: food.name, food: bot.food };
  });
}

/** 打最近的指定类型怪（不传类型则打最近敌对）。 */
async function attackNearest(bot, typeName, timeoutSec = 60) {
  if (!bot.pvp) return { ok: false, reason: 'no-pvp' };
  const filter = typeName
    ? (e) => e.name === typeName
    : (e) => e.type === 'hostile' || e.type === 'mob';
  const target = bot.nearestEntity(filter);
  if (!target) return { ok: false, reason: 'no-target', typeName };
  return withTimeout(timeoutSec, async () => {
    bot.pvp.attack(target);
    await new Promise((r) => {
      const iv = setInterval(() => {
        if (!target.isValid || bot.pvp.target !== target) { clearInterval(iv); r(); }
      }, 500);
      setTimeout(() => { clearInterval(iv); r(); }, timeoutSec * 1000 - 1000);
    });
    return { ok: true, target: target.name || target.type, hp: bot.health };
  }, () => { try { bot.pvp.stop(); } catch { } });
}

/**
 * 竖井下降：一直挖脚下到 targetY。
 *
 * 为什么需要：worldgen-flat 的木头全在 y≈0 的矿井里（实测最近 61 格、垂直 59 格），
 * pathfinder 穿不过实心岩 —— 想拿到木头只能自己挖下去。这也是「AI 用代码玩游戏」
 * 最典型的一件事：没有现成插件干这个，必须自己写。
 *
 * 安全：每挖一层先看脚下是什么，遇到 lava/water/bedrock 立刻停（返回值里说明）。
 */
async function digDown(bot, targetY, opts = {}) {
  const maxSteps = opts.maxSteps ?? 128;
  const stopOn = new Set(['lava', 'water', 'bedrock', 'flowing_lava', 'flowing_water']);
  let steps = 0;
  const startY = Math.floor(bot.entity.position.y);
  return withTimeout(opts.timeoutSec ?? 240, async () => {
    while (bot.entity.position.y > targetY + 1 && steps < maxSteps) {
      // 需要一把镐；没有就先报告（空手挖石头极慢且大概率失败）
      if (!bot.heldItem || !/pickaxe/.test(bot.heldItem.name)) {
        const pick = bot.inventory.items().find((i) => /pickaxe/.test(i.name));
        if (pick) await bot.equip(pick, 'hand');
      }
      const feet = bot.entity.position.floored();
      const below = bot.blockAt(feet.offset(0, -1, 0));
      if (!below || below.name === 'air') {
        // 已经是空的，直接掉下去
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      if (stopOn.has(below.name)) {
        return { ok: false, reason: 'danger-below', block: below.name, y: Math.floor(bot.entity.position.y), steps };
      }
      if (!below.diggable) {
        return { ok: false, reason: 'not-diggable', block: below.name, y: Math.floor(bot.entity.position.y), steps };
      }
      try { await bot.dig(below); } catch (e) {
        return { ok: false, reason: 'dig-failed', error: String(e.message).slice(0, 120), steps };
      }
      steps++;
      // 等落地
      const t0 = Date.now();
      while (!bot.entity.onGround && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 100));
    }
    const y = Math.floor(bot.entity.position.y);
    return { ok: y <= targetY + 2, y, startY, steps, reachedTarget: y <= targetY + 2 };
  }, () => { try { bot.pathfinder && bot.pathfinder.stop(); } catch { } });
}

/** 丢出背包里的物品（腾格子）。 */
async function drop(bot, itemName, count = 999) {
  const it = bot.inventory.items().find((i) => i.name === itemName);
  if (!it) return { ok: false, reason: 'not-carried', itemName };
  const n = Math.min(count, it.count);
  await bot.toss(it.type, null, n);
  return { ok: true, dropped: n, itemName };
}

function countOf(bot, name) {
  try {
    return bot.inventory.items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);
  } catch { return 0; }
}

module.exports = {
  setup, plugins, state, goto, collect, mine, findBlock, craft,
  eatIfHungry, attackNearest, drop, digDown, ensureTable, countOf, blockIds, withTimeout,
};
