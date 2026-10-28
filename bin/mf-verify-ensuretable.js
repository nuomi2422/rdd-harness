// ensureTable 失败路径验证：flat 世界没有木板 → 应给 cannot-craft-table，而不是挂死/编成功
module.exports = async ({ bot }) => {
  const kit = require('D:/rdd/harness/rdd-harness/bin/mf-kit.js');
  kit.setup(bot);
  await new Promise((r) => setTimeout(r, 1200));
  const out = [];
  out.push('state: ' + JSON.stringify(kit.state(bot)));
  const t0 = Date.now();
  const r = await kit.ensureTable(bot);
  out.push('ensureTable: ' + JSON.stringify(r));
  out.push('elapsed_ms: ' + (Date.now() - t0));
  // 再验一次 craft 3x3 的真实失败原因
  out.push('craft(wooden_pickaxe): ' + JSON.stringify(await kit.craft(bot, 'wooden_pickaxe', 1)));
  return out.join('\n');
};
