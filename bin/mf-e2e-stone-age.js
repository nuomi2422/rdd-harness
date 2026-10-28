// 端到端实跑：从零到石镐（验证「组合层」能撑起一条真实任务链）
// 判据：每一步都要拿到 ok:true 且背包里真出现该物品；任何一步失败就停并报告卡在哪。
module.exports = async ({ bot }) => {
  const kit = require('D:/rdd/harness/rdd-harness/bin/mf-kit.js');
  const out = [];
  const step = (label, r) => { out.push(label + ': ' + JSON.stringify(r)); return r.ok; };

  step('setup', kit.setup(bot));
  await new Promise((r) => setTimeout(r, 1500));

  // 1) 砍 3 个原木（离得最近的树在 161,0,119，会比较远）
  // 树在 (161,0,119)，垂直 63 格 → 半径要放到 160
  if (!step('collect oak_log x3', await kit.collect(bot, 'oak_log', 3, 300, 160))) return out.join('\n') + '\n[STOP] 砍树失败';

  // 2) 原木 → 木板
  if (!step('craft oak_planks x4', await kit.craft(bot, 'oak_planks', 4))) return out.join('\n') + '\n[STOP] 合木板失败';

  // 3) 木板 → 木棍
  if (!step('craft stick x4', await kit.craft(bot, 'stick', 4))) return out.join('\n') + '\n[STOP] 合木棍失败';

  // 4) 木棍+木板 → 木镐（需要工作台）
  if (!step('craft crafting_table', await kit.craft(bot, 'crafting_table', 1))) return out.join('\n') + '\n[STOP] 合工作台失败';
  if (!step('craft wooden_pickaxe', await kit.craft(bot, 'wooden_pickaxe', 1))) return out.join('\n') + '\n[STOP] 合木镐失败';

  out.push('state after tool: ' + JSON.stringify(kit.state(bot)));
  return out.join('\n');
};
