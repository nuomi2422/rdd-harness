// mf-kit 冒烟：验证「组合层」每个动作都能被一行调用且返回可判读结果。
// 用法：node mf-observer.js eval D:/rdd/harness/rdd-harness/bin/mf-kit-smoke.js
module.exports = async ({ bot }) => {
  const kit = require('D:/rdd/harness/rdd-harness/bin/mf-kit.js');
  const out = [];
  const log = (label, r) => { out.push(label + ': ' + JSON.stringify(r)); };

  log('setup', kit.setup(bot));
  await new Promise((r) => setTimeout(r, 1500));
  log('state@start', kit.state(bot));

  // 1) 找方块
  const tree = kit.findBlock(bot, 'oak_log', 64) || kit.findBlock(bot, 'birch_log', 64);
  log('findBlock', tree);

  // 2) 采集（flat 世界可能没树，用 dirt 兜底）
  let r = await kit.collect(bot, 'dirt', 2, 60);
  log('collect(dirt,2)', r);
  log('state@afterCollect', kit.state(bot));

  // 3) 挖
  r = await kit.mine(bot, 'dirt', 1, 45);
  log('mine(dirt,1)', r);

  // 4) 走到坐标（原地附近，验证 pathfinder 就绪）
  const p = bot.entity.position;
  r = await kit.goto(bot, Math.round(p.x) + 3, undefined, Math.round(p.z) + 3, 1);
  log('goto(+3,+3)', r);

  // 5) 吃（不饿就跳过）
  log('eatIfHungry', await kit.eatIfHungry(bot));

  // 6) 合成（无材料应给出明确 reason，而不是挂死）
  log('craft(crafting_table)', await kit.craft(bot, 'crafting_table'));

  // 7) 打怪（大概率没怪，应 no-target）
  log('attackNearest', await kit.attackNearest(bot, 'zombie', 10));

  log('state@end', kit.state(bot));
  return out.join('\n');
};
