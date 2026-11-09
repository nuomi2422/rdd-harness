'use strict';
/**
 * acceptance-table.js（CLI）—— 一键比对真实尾部，输出 MATCH/MISMATCH/UNKNOWN（只读）。
 * 用法：node bin/acceptance-table.js [--dir <monitor>] [--json]
 */
const fs = require('fs');
const path = require('path');
const { buildCard } = require('./evidence-card');
const AT = require('./lib/acceptance-table');

function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function main() {
  const argv = process.argv.slice(2);
  const di = argv.indexOf('--dir');
  const dir = di >= 0 ? argv[di + 1] : 'D:/rdd/mc/The Best of Twilight Forest/config/numen/monitor';
  const card = buildCard(dir);
  const res = AT.build(card, { events: readIf(path.join(dir, 'events.jsonl')), rdd: readIf(path.join(dir, 'rdd.jsonl')) });
  if (argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return res.overall === 'MISMATCH' ? 1 : 0; }
  console.log('部署后验收表：' + dir);
  for (const r of res.rows) console.log('  ' + r.verdict.padEnd(8) + r.id + ' ' + r.name + ' — ' + r.detail);
  console.log('  总判定：' + res.overall);
  return res.overall === 'MISMATCH' ? 1 : 0;
}

module.exports = { main };
if (require.main === module) process.exit(main());
