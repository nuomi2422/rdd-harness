// 我的身体（观察者）跟随脚本：每 20 秒把 OBS 传到 RDD 身边 3 格，并采样她周围的事实
// 用法：node observe-rdd.js --minutes 20
// 输出：report/observer-rdd.jsonl（一行一次采样）
const fs = require('fs');
const { spawnSync } = require('child_process');

const MCP = 'D:\\rdd\\workspace\\rdd-selfcompile\\scripts\\mcp-call.js';
const OUT = 'D:\\rdd\\harness\\rdd-harness\\experiments\\journal\\observer-rdd.jsonl';

function call(tool, companion, args) {
  const r = spawnSync(process.execPath, [MCP, tool, companion, JSON.stringify(args)], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const i = out.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(out.slice(i)); } catch { return null; }
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const minutes = Number(arg('minutes', '20'));

function log(kind, data) {
  const rec = { t: new Date().toISOString(), kind, ...data };
  console.log(`[${rec.t.slice(11, 19)}] ${kind} ${JSON.stringify(data).slice(0, 230)}`);
  try { fs.appendFileSync(OUT, JSON.stringify(rec) + '\n'); } catch {}
}

(async () => {
  const until = Date.now() + minutes * 60000;
  while (Date.now() < until) {
    const w = call('rdd_whereami', 'RDD', {});
    const p = w && w.data;
    if (p) {
      // 站到她斜上方 3 格（创造模式不会掉下去、也不会挤到她）
      call('rdd_teleport', 'OBS', { x: Math.round(p.x) + 3, y: Math.round(p.y) + 2, z: Math.round(p.z) });
      const st = call('rdd_status', 'RDD', {});
      const ent = call('scan_nearby_entities', 'OBS', { type_filter: 'hostile', radius: 16 });
      const inv = call('rdd_get_inventory', 'RDD', {});
      const d = (st && st.data) || {};
      const items = (inv && inv.data && inv.data.items) || {};   // 注意：物品在 data.items 下面，直接读 inv.items 会永远拿到 0
      log('sample', {
        rdd: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), dim: p.dimension },
        subtask: d.subtask,
        status: d.subtask_status,
        cond: d.condition,
        assets: d.assets,
        obsidian: items['minecraft:obsidian'] || 0,
        steel: items['minecraft:flint_and_steel'] || 0,
        iron: items['minecraft:iron_ingot'] || 0,
        hostiles: (ent && ent.total_found) || 0,
        hostileKinds: (ent && ent.entities || []).slice(0, 3).map((e) => e.type),
      });
    } else {
      log('no-rdd', { raw: w });
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  log('done', { minutes });
})();
