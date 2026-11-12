# dsh-bench-bridge

This existing plugin is maintained only in this RDD harness directory. The original
C:\Users\admin\Documents\deepseek-harness\default-workspace\dsh-bench-bridge
0.1.0 package remains unchanged as provenance, not a second maintenance source.
Original file hashes are in provenance.json.

Default: disabled. This candidate has not been installed or enabled in DSH.
Installation/profile changes and a real coding-session delivery remain separate validation.

Configure enabled: true, an explicit targetSession, and either binding or bindingFile
(an absolute path to at most 16 KiB of host-written JSON). No target discovery occurs.
The host runtime supplies this binding; game/model text must never choose the target.

Binding fields: windowKey, worldId, serverSession, companion, run, since, cutoff,
packageFile (absolute existing evidence-pack JSON export), packageSha256 (exact bytes),
and end. since/cutoff/end.at require an explicit timezone. end contains kind
(normal-end or save), at, and the same windowKey/worldId/serverSession/companion/run/cutoff.
The notice is a trigger reported by the host; it does not prove a world effect or save durability.

Produce the existing package with the normal bench evidence list/export, selected raw
world/server/companion/run and --as-of cutoff. The bridge consumes that package result,
including rotation-aware physical references, rather than parsing monitor streams again.
The package is bounded to 1 MiB by default (maxPackageBytes, maximum 2 MiB). Oversize, missing and non-file
packages produce UNKNOWN without queueing; changed hashes, scope or cutoff prevent delivery.
maxChars is at most 1200; complete metadata that cannot fit is reported UNKNOWN.
Payload text is never rendered or executed. At most three physical refs with line hashes
are included; package pagination, omitted refs and coverage gaps stay explicit.
Raw identity remains UNKNOWN. Tool results do not prove task/world effects.

Delivery uses official createUserMessage with source.kind=plugin:dsh-bench-bridge and
the explicitly addressed agent.followup. No human source, SessionController RPC,
session-log writes, Electron subprocess, model instructions, or agent/status polling.
The official dsh-llm peer dependency is resolved by the managed DSH plugin installation.

stateFile defaults to ~/.dsh/bench-bridge-delivery.json. State version 2 rejects legacy unbound markers rather than guessing a migration.
The windowKey is stable across target/cutoff changes; a changed binding for the same
window is refused, including after restart. Only 32 delivered markers
and one pending item are kept; retired older cutoffs are refused conservatively.
A sending intent is persisted before enqueue; only normal queue acceptance plus a
successful delivered-marker write reports DELIVERED. Sending/unknown after restart
is UNKNOWN and cannot auto-retry. Explicit queue rejection stays one PENDING item:
the returned controller.retryPending() retries once on explicit host request.
The controller.tick()/status()/dispose() are also available to the host integration.
Acceptance is queue admission, not evidence that the model adopted the summary.
There is no claim of exactly-once delivery across crash, disk loss or restored state.

Node regression: node --test plugins/dsh-bench-bridge/test/index.test.js
Tests exercise actual apply/tick with synthetic official queue/message boundaries
and real evidence-pack fixtures in os.tmpdir; they do not prove host enablement.
Rollback: keep enabled false/remove this plugin binding, preserving bench and evidence.
