# 多模型协同 + 实机验证闭环 · 索引（默认不读）

> **这是一条按需索引，不是每个 AI 都要读的规则。**
> 绝大多数任务（改代码、写文档、跑单测、查日志）**不要打开这里**，也不要因为看到它就启动游戏。
> 只有下面三种情况才进来：① 用户明确不在 / 要求长程无人值守；② 要做实机取证、沙盒晋级、多模型升级链；③ 要复现故障注入验收矩阵（T01–T20）。
>
> 设计原文（长文，只在实施/评审时读）：
> [`docs/rdd-docs/rdd架构/RDD-Harness-多模型协同与实机验证闭环-设计草案-20261019.md`](../../../docs/rdd-docs/rdd架构/RDD-Harness-多模型协同与实机验证闭环-设计草案-20261019.md)
> 机器索引：`registry.json` → `tools[harness.multimodel]`（带 `whenToUse`）。

## 提供商（2026-10-19 用户确认，别再按厂商名猜）

| 逻辑角色 | provider | 真实 model ID | 端点 |
|---|---|---|---|
| `worker`（默认主力） | **opencode-go** | `deepseek-v4.1-flash` | `https://opencode.ai/zen/go/v1` |
| `vision`（按需看图） | **opencode-go** | `glm-5.3-flash` | 同上 |
| `code_specialist`（复杂代码） | **opencode-go** | `glm-5.3` | 同上 |
| `fallback`（最终兜底） | **moyuu** | `gpt-6-astra` | `https://moyuu.cc/v1` |

- 前三个都挂在 **OpenCode Go** 下；只有 GPT-6 Astra 走 **moyuu** 中转。
- 真实 ID 以 `minecraft-numen/ai/src/main/resources/numen_providers.json` 为准：带 `.1` 与不带 `.1` 是两个模型（`deepseek-v4-flash` 在 Go 上 403，`deepseek-v4.1-flash` 才 200）。
- moyuu 上实测只有 `gpt-6-astra` 稳定（其余模型 500/503）。
- **provider 名字只从 `policies/model-routing.yaml` 读**，代码里不写死；探针没过时角色仍是 `unverified`，不是“能用”。

## our-free-model 免费模型池（2026-10-20 记录，当前**全部不可用**）

用户 2026-10-20 提出：DSH 的 our-free-model 里有很多免费模型，可以弄来当子 agent **定期开一下做独立审核**。
这条已登记为债账 H7（诊断子 agent）+ H11（免费模型池），但**调用侧现在跑不通**：

| 事实 | 值 |
|---|---|
| 探针时间 | 2026-10-20 22:52（`~\.dsh\our-free-model\availability.json`，`at=1792507950588`） |
| 结果 | 10 个模型**全部** `state: unavailable` |
| 原因（逐字） | "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account." |
| 出口 IP | `209.33.174.152`（`settings.json` 的 `egress` 走 `socks5h://127.0.0.1:7897`） |
| 性质 | **IP 被封，不是账号问题** —— 换出口/关代理可能恢复 |

池子里的 10 个（`catalog.json`）：`big-pickle`、`beam-free`、`mimo-v2.6-flash-free`、`nemotron-3.5-super-vl-free`、`nemotron-3.5-lightning-free`、`jev-1.13-free`、`longcat-2.5-preview-free`、`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、`space-bunny-free`、`minimax-m3.1-flash-free`。

> ★ 解封后**优先试这两个**（`kiloRows` 里带 vision + 1M ctx，最适合当「审核眼」）：
> `nvidia/nemotron-3.5-super-vl:free`（vision, 1M ctx / 131072 出）
> `minimax/minimax-m3.1-flash:free`（vision, 1M ctx / 524288 出）
> ★ 在 IP 恢复前，**不许**把这两个角色标成 `enabled`；诊断子 agent（H7）先用现有 opencode-go 链顶上，不因免费模型不可用而跳过。

## 一句话

默认 **DeepSeek V4.1 干活**，GLM 5.3 Flash 按需看图，GLM 5.3 接复杂代码，GPT-6 只在前述路径失败、证据仍不足且预算允许时兜底。
**所有模型只能提出方案，不能凭口头声明让测试通过。**

## 入口（全部离线，不需要游戏）

```powershell
node "D:\rdd\harness\rdd-harness\multimodel\bin\harness-run.js" index          # 就是本文件
node "...\harness-run.js" validate <card.yaml>                                 # 测试卡严格校验 + 冻结哈希
node "...\harness-run.js" plan <card.yaml> [--runtime mock]                    # 能力对账，逐条列缺口
node "...\harness-run.js" scenarios                                           # 列出故障注入场景
node "...\harness-run.js" mock-run --scenario t01                              # 跑单场景，写 run 报告
node "...\harness-run.js" selftest                                             # 跑完整场景矩阵（假绿防线）
node "...\harness-run.js" runs / report <runId>
```

单元测试（零依赖，node:test）：

```powershell
node --test <本目录>\test\*.test.js
```

退出码：`0` 正常 ／ `1` 结果与预期不符 ／ `2` 用法或输入错 ／ `3` 环境错。

## 现在的真实状态（不许当已接通）

| 部分 | 状态 | 说明 |
|---|---|---|
| TaskCard 严格 YAML + Schema + 语义对账 + 冻结哈希 | `implemented` | 拒绝未知字段/重复键/锚点别名/路径越界/未注册谓词 |
| 能力目录（声明/发现/探针三态） | `implemented`（声明层） | DISCOVERED/HEALTHY 由适配器填；离线时只有声明态 |
| 证据信封 / 对齐 / 冲突前置检查 | `implemented` | 身份/会话/维度/epoch/因果/tick/新鲜度；占位哈希不算哈希 |
| 确定性裁决引擎 | `implemented` | 模型口头成功永不参与 PASS；冲突禁止 PASS |
| 有界路由 + 预算原子预留 | `implemented` | 401 熔断、402 换路、429 退避、超时先取消；价格未知不许绕过预算 |
| RunStore | `implemented`（文件版） | 原子 JSON + 追加 JSONL；**SQLite 事务未实现** |
| 生命周期状态机 | `implemented` | `COMPLETED` ≠ PASS；缺 reasonCode 直接拒 |
| 故障注入场景矩阵（11 条） | `implemented`（离线） | 对照设计草案 §11 中不依赖真机的那几条 |
| 模型适配器（DSH 真实调用） | `not_connected` | 只抛 `NOT_CONNECTED`，并把 M0 必须核实的四件事写进错误 |
| 相机 / MCP / 游戏世界 / mutation 沙盒 | `mocked` 或 `not_connected` | 全部由场景数据扮演，**没有碰过真游戏** |
| `mutation.build_only` 真语义 | `not_connected` | 现有 `-SkipLaunch -SkipMcp` 仍会部署 → 能力目录里标 `disabled`，T12 因此必然 BLOCKED |
| `vision.inventory_count_ui`（同伴背包 UI） | `not_connected` | `disabled`；`strict_dual_quantity` 缺它必须 BLOCKED，不许自动降级 |
| `verified_in_game` | **0 条** | 没进游戏就不许写这四个字 |

## 目录

```text
multimodel/
  README.md             ← 本索引（唯一入口）
  capabilities.json     能力目录 + 谓词表（声明的唯一真源）
  scenarios.js          故障注入场景（测试数据，不是实机事实）
  schemas/              task-card / capability-extension 的 JSON Schema
  policies/             model-routing.yaml（角色/升级链/错误策略）、budgets.yaml（预算与价格表）
  cards/                示例与守卫测试卡
  lib/                  yaml / schema / taskcard / capabilities / evidence / verdict / router / runstore / statemachine / coordinator
  adapters/             dsh.js（未接通，明确抛错）、mock.js（离线脚本化）
  bin/harness-run.js    CLI（本索引的入口）
  test/                 node:test 单测
```

运行数据（可删，不进 git）：`registry.roots.runs` = `harness/rdd-harness/runs/<runId>/`。

## 三条最容易「假完成」的地方（已做成机器判据）

1. **跳过启动 ≠ 不部署**：`-SkipLaunch -SkipMcp` 仍会先部署。真正的 build-only 未实现 → 能力目录 `disabled`，任务直接 BLOCKED，而不是打印一句「已构建」。
2. **相机看到同伴 ≠ 看到同伴背包**：视觉证据只证明身份与上下文；数量必须来自可归属同伴的结构化背包。玩家背包凑数会被 `SUBJECT_MISMATCH` 拒绝。
3. **日志与画面冲突 ≠ 幻觉**：冲突先 `EVIDENCE_CONFLICT` 禁止 PASS，再补采；GPT-6 也不能一句话盖章消除冲突。

## 加一张测试卡

1. 在 `cards/` 新建 YAML，`apiVersion: rdd.harness/v1alpha1`、`kind: TaskCard`。
2. 只能使用 `capabilities.json` 里注册的谓词和 `spec.requires` 里声明的能力。
3. `node ... validate <card.yaml>`；再 `plan` 看能力缺口。
4. 要验证「失败也能被正确判出来」，写进 `scenarios.js` 并给 `expect` —— `selftest` 会对照它。
5. **不许改正在验收自己的卡来放绿**：哈希在 `spec.lock.json` 里冻结。

## 与门禁的关系

- `harness-gate.js`（preflight/postflight）**不读本目录**，也不因为你没跑它而拦你。
- 本目录的 `selftest` 是独立入口；只有在真要用这条线时才跑。
- 一旦要跑真机实验，preflight/postflight 照旧必须过 —— 本索引不替代门禁。

## 本次落地（2026-10-19，M1 离线骨架）

**新增**（全部在 `multimodel/` 下，不动游戏、不动 live、不改存档）：
`README.md`、`capabilities.json`、`scenarios.js`、`schemas/*.json`、`policies/*.yaml`、`cards/*.yaml`、
`lib/{yaml,schema,taskcard,capabilities,evidence,verdict,router,runstore,statemachine,coordinator}.js`、
`adapters/{dsh,mock}.js`、`bin/harness-run.js`、`test/*.test.js`。

**改动**（路径相对化，属用户要求的「harness 整理成相对目录」）：
`registry.json`（新增 `paths.rootAnchor/envOverride`，roots/standards/docNumbers 全改相对，新增 `roots.runs`、`tools[harness.multimodel]`、时间锁 `TL-2026-10-19-01`）、
新增 `bin/lib/registry.js`（唯一解析层）、`bin/harness-gate.js`（走解析层 + 相对化自检）、
`app/server.js`、`bin/goal.js`、`bin/send-mc-command.ps1`、若干 `.bat` 入口、`.gitignore`、`README.md`、`工具分类索引-20261005.md`。

**运行命令 / 证据**：见上文入口；判定证据就是 `selftest` 输出（11 场景 0 不符）+ `node --test` 输出（56 通过）。

**已知限制**：见上表 `not_connected` / `mocked` 行；离线全绿**不等于**实机通过。

**回滚方案**：
1. 删 `multimodel/` 与 `runs/`（无其他代码依赖它）。
2. `registry.json` 的 paths 改动回退：把 `roots`/`standards`/`docNumbers` 改回绝对路径、删 `paths` 段、删 `roots.runs` 与 `tools[harness.multimodel]` 条目即可（`bin/lib/registry.js` 兼容绝对路径）。
3. 若要连路径层一起回退：恢复 `bin/harness-gate.js` / `app/server.js` / `bin/goal.js` / `.bat` 的改动；这三处是本轮唯一被改的运行代码。
4. `runs/` 已进 `.gitignore`，删除不影响任何真源。
