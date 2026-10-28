// 找所有木头位置，判断有没有可走到的（flat 世界唯一的木头可能在矿井 y=0）
module.exports = async ({ bot }) => {
  const kit = require('D:/rdd/harness/rdd-harness/bin/mf-kit.js');
  kit.setup(bot);
  await new Promise((r) => setTimeout(r, 1200));
  const out = [];
  const p = bot.entity.position;
  out.push('bot at ' + JSON.stringify({x:Math.round(p.x),y:Math.round(p.y),z:Math.round(p.z)}));
  for (const name of ['oak_log','oak_planks','birch_log','spruce_log']) {
    const id = bot.registry.blocksByName[name] && bot.registry.blocksByName[name].id;
    if (id === undefined) { out.push(name + ': unknown block'); continue; }
    const pos = bot.findBlocks({ matching: id, maxDistance: 200, count: 40 });
    if (!pos.length) { out.push(name + ': 0 found'); continue; }
    const sorted = pos.map(v => ({v, d: v.distanceTo(p)})).sort((a,b)=>a.d-b.d).slice(0,5);
    out.push(name + ' (' + pos.length + ' found, nearest 5): ' + sorted.map(o=>Math.round(o.d)+'@'+o.v.y).join(', '));
  }
  return out.join('\n');
};
