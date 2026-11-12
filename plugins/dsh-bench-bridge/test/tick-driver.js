// Runs the real plugin apply/timer path in a separate process, including old unhandled errors.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let scheduled;
const sent = [];
const errors = [];
process.env.DSH_HOME = cfg.home;
globalThis.setInterval = callback => { scheduled = callback; return { unref() {} }; };
globalThis.clearInterval = () => {};
process.on('unhandledRejection', error => { errors.push(String(error)); process.exitCode = 1; });
const ctx = { agents: { get: id => id === cfg.targetSession ? { id, session: { header: { origin: 'primary' } },
  followup: message => { sent.push(message); } } : undefined }, effect: effect => { effect(); }, logger: { info() {}, warn() {} } };
try {
  const plugin = await import(pathToFileURL(process.argv[3]));
  await plugin.apply(ctx, cfg, { createUserMessage: input => ({ ...input, role: 'user', id: 'fixture-message' }), now: () => Date.parse('2026-11-12T00:02:00Z') });
  await scheduled?.();
} catch (error) { errors.push(String(error)); process.exitCode = 1; }
await new Promise(resolve => setImmediate(resolve));
console.log(JSON.stringify({ sent, errors }));
