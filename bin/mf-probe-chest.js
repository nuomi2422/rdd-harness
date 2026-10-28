// 看矿井口那个 chest 里有什么（可能直接给出木头/镐，解开死锁）
module.exports = async ({ bot }) => {
  const kit = require('D:/rdd/harness/rdd-harness/bin/mf-kit.js');
  kit.setup(bot);
  await new Promise((r) => setTimeout(r, 1200));
  const out = [];
  const chestBlock = bot.findBlock({ matching: bot.registry.blocksByName.chest.id, maxDistance: 64 });
  if (!chestBlock) return 'no chest nearby';
  out.push('chest at ' + JSON.stringify(chestBlock.position));
  // 走过去
  const g = await kit.goto(bot, chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2);
  out.push('goto: ' + JSON.stringify(g));
  try {
    const w = await bot.openContainer(chestBlock);
    const items = w.containerItems().map(i => i.name + ' x' + i.count);
    out.push('contents(' + items.length + '): ' + (items.join(', ') || '(empty)'));
    await w.close();
  } catch (e) {
    out.push('open failed: ' + String(e.message).slice(0, 150));
  }
  out.push('state: ' + JSON.stringify(kit.state(bot)));
  return out.join('\n');
};
