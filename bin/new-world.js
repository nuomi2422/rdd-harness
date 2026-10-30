'use strict';
/**
 * new-world.js —— 造一个「全新存档」：只要 level.dat，地形由游戏按新种子现生成。
 *
 * 为什么这么做（2026-10-30 用户定）：主线不是打龙，是**从零开始**玩。
 * 老的 saves/live 里有基地、箱子、别人的玩家数据，拿它当母版永远说不清「哪些是给的」。
 * 全新存档 = 没有基地、没有物品、没有旧玩家数据，地形按新种子生成。
 *
 * 做法：复制一个模板的 level.dat，改 LevelName / RandomSeed / Difficulty / keepInventory，
 * 其余目录（playerdata / advancements / stats / data / region）**一律不复制** ——
 * 它们正是「上一个世界留下的东西」。
 *
 * 用法：
 *   node bin/new-world.js --name rdd-zero --seed 20261030 [--dir <saves/xxx>] [--from <模板存档>]
 *   node bin/new-world.js --selftest
 *
 * 退出码：0=建好  1=失败  2=用法错
 */
const fs = require('fs');
const path = require('path');
const { readLevelInfo, patchLevel } = require('./lib/nbt');

const SAVES = path.join(__dirname, '..', '..', '..', 'mc', 'The Best of Twilight Forest', 'saves');
// 2026-10-30：saves 下只留用户当前在用的那个存档（`live`），母版不再占 saves。
// 模板 level.dat 挪到 templates/world/ —— 它只是「世界设置」，不是存档，别跟世界混在一起。
const TEMPLATE = path.join(__dirname, '..', 'templates', 'world');

function makeWorld(opts) {
  const name = String(opts.name || '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error('--name 只能用 1-32 位字母数字_-（实得 ' + name + '）');
  const template = opts.from ? path.resolve(opts.from) : TEMPLATE;
  const templateLevel = path.join(template, 'level.dat');
  if (!fs.existsSync(templateLevel)) throw new Error('模板 level.dat 不存在: ' + templateLevel);
  const dir = opts.dir ? path.resolve(opts.dir) : path.join(SAVES, name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error('目标已存在且非空，拒绝覆盖: ' + dir);

  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(templateLevel, path.join(dir, 'level.dat'));

  const seed = opts.seed !== undefined && opts.seed !== null ? opts.seed : String(Math.floor(Math.random() * 2 ** 31));
  const patched = patchLevel(path.join(dir, 'level.dat'), {
    levelName: name,
    seed,
    difficulty: typeof opts.difficulty === 'number' ? opts.difficulty : 2,   // 2=normal（生存压力）
    keepInventory: 'false',                                                   // 死了要掉东西，否则死亡率没意义
  });
  if (patched.error) throw new Error('patch level.dat 失败: ' + patched.error);

  const info = readLevelInfo(path.join(dir, 'level.dat'));
  const files = fs.readdirSync(dir);
  return { dir, name, seed, changed: patched.changed, level: { LevelName: info.LevelName, Difficulty: info.Difficulty, keepInventory: info.keepInventory, GameType: info.GameType }, files };
}

function selftest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  // 自测只在临时目录里造一个空模板 level.dat，绝不碰真存档
  const tmp = path.join(__dirname, '..', 'runs', '.tmp-newworld');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const tpl = path.join(tmp, 'tpl');
  fs.mkdirSync(tpl, { recursive: true });
  if (!fs.existsSync(TEMPLATE)) {
    console.log('new-world selftest SKIP：模板不存在（' + TEMPLATE + '）');
    return 0;
  }
  fs.copyFileSync(path.join(TEMPLATE, 'level.dat'), path.join(tpl, 'level.dat'));
  const out = makeWorld({ name: 'selftest-world', seed: '12345', from: tpl, dir: path.join(tmp, 'out') });
  ok(out.level.LevelName === 'selftest-world', '① LevelName 改对（实得 ' + out.level.LevelName + '）');
  ok(String(out.changed.join(',')).includes('seed='), '② seed 改过（changed=' + out.changed.join(',') + '）');
  ok(out.level.Difficulty === 2, '③ difficulty=2（实得 ' + out.level.Difficulty + '）');
  ok(out.level.keepInventory === 'false', '④ keepInventory=false（实得 ' + out.level.keepInventory + '）');
  ok(out.files.length === 1 && out.files[0] === 'level.dat', '⑤ 只复制 level.dat（实得 ' + out.files.join(',') + '）');
  let refused = false;
  try { makeWorld({ name: 'selftest-world', from: tpl, dir: path.join(tmp, 'out') }); } catch { refused = true; }
  ok(refused, '⑥ 目标非空时拒绝覆盖');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails.length ? 'new-world selftest FAIL: ' + fails.join(' | ') : 'new-world selftest PASS（6 组）');
  return fails.length ? 1 : 0;
}

if (require.main === module) {
  if (process.argv[2] === '--selftest') process.exit(selftest());
  const a = process.argv.slice(2);
  const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const r = makeWorld({ name: arg('--name'), seed: arg('--seed'), dir: arg('--dir'), from: arg('--from'), difficulty: arg('--difficulty') ? Number(arg('--difficulty')) : undefined });
    console.log('新存档已建：' + r.dir);
    console.log('  LevelName=' + r.level.LevelName + '  seed=' + r.seed + '  Difficulty=' + r.level.Difficulty + '  keepInventory=' + r.level.keepInventory);
    console.log('  changed: ' + (r.changed.join(', ') || '(无)'));
    console.log('  文件: ' + r.files.join(', '));
    process.exit(0);
  } catch (e) {
    console.error('建世界失败：' + e.message);
    process.exit(1);
  }
}

module.exports = { makeWorld, selftest };
