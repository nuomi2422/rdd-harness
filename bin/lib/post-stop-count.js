'use strict';
const fs = require('fs');
const path = require('path');

/** Count llm_request lines at/after an ISO cutoff across current + rotated context files. */
function countContextRequestsSince(dir, iso) {
  let n = 0;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^context.*\.jsonl$/.test(f)) : [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"llm_request"')) continue;
      const m = /"timestamp":"([^"]+)"/.exec(line);
      if (m && m[1] >= iso) n++;
    }
  }
  return n;
}

module.exports = { countContextRequestsSince };
