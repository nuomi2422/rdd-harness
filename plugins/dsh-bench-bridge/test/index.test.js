import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { fromDir } = require('../../../bin/lib/evidence-pack.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
export function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge047-'));
  const monitor = path.join(dir, 'monitor'); fs.mkdirSync(monitor);
  for (const stream of ['tools', 'events', 'context', 'rdd']) {
    fs.writeFileSync(path.join(monitor, stream + '.jsonl'), stream === 'tools' ? JSON.stringify({
      timestamp: '2026-11-12T00:00:30Z', session: 'run047', category: stream, event_seq: 1,
      world_id: 'world047', server_session: 'server047', type: 'tool_call',
      data: { companion_id: 'companion047', tool_call_id: 'call047', tool: 'mine' },
    }) + String.fromCharCode(10) : '');
  }
  const b = { windowKey: 'window047', worldId: 'world047', serverSession: 'server047',
    companion: 'companion047', run: 'run047', since: '2026-11-12T00:00:00Z', cutoff: '2026-11-12T00:01:00Z' };
  b.end = { kind: 'normal-end', ...b, at: b.cutoff };
  const pack = fromDir(monitor, { mode: 'list', asOf: b.cutoff, worldId: b.worldId,
    serverSession: b.serverSession, companion: b.companion, run: b.run });
  const bytes = Buffer.from(JSON.stringify(pack));
  b.packageFile = path.join(dir, 'package.json'); fs.writeFileSync(b.packageFile, bytes);
  b.packageSha256 = hash(bytes);
  return { dir, monitor, pack, cfg: { enabled: true, targetSession: 'session-047',
    home: path.join(dir, 'home'), stateFile: path.join(dir, 'bridge-state.json'), binding: b } };
}

test('real apply timer accepts one host-bound end and queues a plugin-source summary', () => {
  const f = fixture();
  const cfgFile = path.join(f.dir, 'config.json'); fs.writeFileSync(cfgFile, JSON.stringify(f.cfg));
  const r = spawnSync(process.execPath, [path.join(here, 'tick-driver.js'), cfgFile, path.join(here, '..', 'lib', 'index.js')], { encoding: 'utf8', timeout: 10000 });
  fs.writeFileSync(path.join(f.dir, 'tick.stdout.txt'), r.stdout || '');
  fs.writeFileSync(path.join(f.dir, 'tick.stderr.txt'), r.stderr || '');
  console.log('047 real tick artifacts: ' + f.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout.trim());
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0].source.kind, 'plugin:dsh-bench-bridge');
  assert.ok(result.sent[0].content[0].text.length <= 1200);
});
