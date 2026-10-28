// 探测 flat 世界有什么资源（决定能不能走完整合成链）
module.exports = async ({ bot }) => {
  const kit = require('D:/rdd/harness/rdd-harness/bin/mf-kit.js');
  kit.setup(bot);
  await new Promise((r) => setTimeout(r, 1200));
  const out = [];
  const kinds = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log',
                 'grass_block','dirt','stone','cobblestone','sand','gravel','coal_ore','iron_ore',
                 'crafting_table','chest','water','lava'];
  for (const k of kinds) {
    const r = kit.findBlock(bot, k, 128);
    if (r.ok) out.push(k + ' -> ' + JSON.stringify(r.pos));
  }
  out.push('state: ' + JSON.stringify(kit.state(bot)));
  return out.join('\n');
};
