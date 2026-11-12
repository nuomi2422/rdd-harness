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
The official registered tool bench_bridge_delivery accepts only action=status|deliver|retry.
Only the configured targetSession may call it (subagents/foreign sessions denied). Paths,
target, scope and payload are host config only. status performs no file reads; deliver and
retry reuse the existing tick/state machine. Tool registration uses official dsh-tools,
its failure reports UNKNOWN and prevents the timer starting; unload removes tool/timer.
Disabled mode does not import the SDK or register anything. The controller.ready promise
settles registration; tick()/status()/dispose() remain available to isolated host integrations.
Acceptance is queue admission, not evidence that the model adopted the summary.
There is no claim of exactly-once delivery across crash, disk loss or restored state.

Node regression: node --test plugins/dsh-bench-bridge/test/index.test.js
Tests exercise actual apply/tick with synthetic official queue/message boundaries
and real evidence-pack fixtures in os.tmpdir; they do not prove host enablement.
Rollback: keep enabled false/remove this plugin binding, preserving bench and evidence.


外层生产通知（2026-11-12）：现有 bench-watch 在明确绑定后读同一 latest.log；无需另建 runner。外部 driver 将已核原始 scope 写入一个 <=16KiB JSON，执行：

~~~text
node bin/bench.js live bind-window <absolute-host-binding.json>
~~~

输入字段为 windowKey、worldId、serverSession、companion、run、targetSession、since（带时区 ISO）、logFile（绝对路径）、encoding（utf-8 或 gb18030）、timezone（明确偏移，如 +08:00）。命令捕获当时 EOF、文件身份、末尾锚点与绑定时间；旧保存不回放，同窗重跑不移动起点，改同窗绑定拒绝。新窗口须明确绑定。此命令只写 observer 控制面，不停止游戏。测试的 --out 仅指定隔离 live 目录。

现 observer 下一拍读取 watch.json 的 bridgeWindow，仅完整匹配受支持的 Minecraft logger 的 Stopping! 后 All dimensions are saved，才有界调用现 evidence-pack.fromDir（12 文件、4MiB 主读预算、24 行页、64KB 行预算）。UTF-8/GB18030 解码错误、半行、替换、跳读、时序不明保持 UNKNOWN；status.json.bridge 显示原因。当前支持实见中文日期 ddMM月yyyy 加毫秒，其他格式不猜。包保留源覆盖、缺口、分页和 raw UNKNOWN；保存标记只证明日志通知，未证明世界效果。

产物为 live/bench-bridge-<windowhash>.json 及原子更新 live/bench-bridge-binding.json。插件配置使用该 bindingFile 和同一明确 targetSession；未绑定不扫描日志。此接线的 Node 测试使用 fake 官方 followup 边界，不能等同宿主启用成功；本批没有安装、启用插件、改 C 原件、改当前 watch.json 或重启 DSH/MC。

2026-11-12 真实退出回归：原冻结日志 `live-20261112-0930-bb0-normal-exit.log:163336/163349` 为 UTF-8 CRLF，MinecraftServer 保存消息含准确 `ThreadedAnvilChunkStorage: ` 前缀。原严格匹配漏触发；现仅在既定 Server thread + MinecraftServer logger 下同时接受有此前缀或旧无前缀格式，仍需先见本窗 Stopping!。测试保留两行原字节和原来源坐标；临时合成测试文件的物理坐标另计，不将其冒作原日志行号。
