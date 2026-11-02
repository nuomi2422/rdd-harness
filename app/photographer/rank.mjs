#!/usr/bin/env node
/**
 * rank.mjs —— 给所有「有成片」的 take 打一个客观分，回答「哪几条其实是精华」。
 * 分数 = 成片时长 × 最强场景分 × 机位距离惩罚（贴脸/过远扣分）；被 curation 排除的直接 0。
 * 用法: node rank.mjs [--top 10] [--write]
 */
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = process.env.NUMENCAM_SHOTS || 'D:\\rdd\\mc\\The Best of Twilight Forest\\screenshots';
const OUT = path.join(SHOTS, '_photographer', 'take-ranking.md');
const args = process.argv.slice(2);
const top = Number((args.find((a) => a.startsWith('--top=')) || '--top=10').split('=')[1]);
const write = args.includes('--write');

const curation = (() => { try { return JSON.parse(fs.readFileSync(path.join(SHOTS, '_photographer', 'curation.json'), 'utf8')); } catch { return { exclude: [] }; } })();
const exclude = new Set(curation.exclude || []);
const timeline = (() => {
  try {
    return fs.readFileSync(path.join(SHOTS, '_timeline', 'numencam.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
})();

const rows = [];
for (const name of fs.readdirSync(SHOTS)) {
  if (!name.startsWith('numencam_')) continue;
  const h = path.join(SHOTS, name, 'cut', 'highlights.json');
  if (!fs.existsSync(h)) continue;
  let j; try { j = JSON.parse(fs.readFileSync(h, 'utf8')); } catch { continue; }
  const meta = timeline.filter((o) => o.kind === 'take' && o.take === name).pop() || {};
  const minDist = meta.minDist ?? null;
  const secs = j.clipSeconds || 0;
  const maxScore = Math.max(0, ...(j.clips || []).map((c) => c.score || 0));
  const distPen = minDist == null ? 1 : (minDist < 2.5 ? 0.3 : Math.max(0.5, 1 - Math.abs(minDist - 5) / 10));
  const excluded = exclude.has(name);
  rows.push({ name, secs, maxScore, minDist, excluded, score: +(excluded ? 0 : secs * (0.5 + maxScore) * distPen).toFixed(2), task: (meta.reason || '').slice(0, 40) });
}
rows.sort((a, b) => b.score - a.score);

const lines = rows.slice(0, top).map((r, i) =>
  '| ' + (i + 1) + ' | \`' + r.name + '\` | ' + r.secs + 's | ' + r.maxScore + ' | ' + (r.minDist ?? '—') + ' | **' + r.score + '** | ' + (r.excluded ? '已排除' : '收') + ' |');
const md = '# take 客观评分（' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '）\n\n' +
  '> 分数 = 成片时长 × 最强场景分 × 机位距离惩罚；被 curation 排除的记 0。\n\n' +
  '| # | take | 时长 | 场景分 | 最近距离 | 分数 | 状态 |\n|---|---|---|---|---|---|---|\n' + lines.join('\n') + '\n';

console.log(md);
if (write) { fs.writeFileSync(OUT, md, 'utf8'); console.log('[rank] 写入 ' + OUT); }
