# 交接：RDD harness 是什么，以及学习轮回现在到哪了

> 日期：2026-10-25 深夜 ｜ 给下一个 AI 会话 ｜ 机器快照另见 `rdd架构\_memory\CHECKPOINT.md`（先读它）
> 读这份的顺序：本文 §1（5 分钟认识 harness）→ §3（现在在做什么）→ §4（坑）→ §5（命令）

## 1 · RDD harness 是什么（5 分钟版）

它是「模型外面那层脚手架」，不是游戏本体。目录 `D:\rdd\harness\rdd-harness\`，独立 git 仓 `nuomi2422/rdd-harness`。

| 部件 | 是什么 | 怎么用 |
|---|---|---|
| `registry.json` | **单一真源**：工具/门禁/时间锁/编号/根路径全在里面 | 改行为先改它，`bin/lib/registry.js` 负责解析 |
| `standards.md` | 编程规范 46 条（`S-*` 编号） | 写码前查，门禁按 id 查 |
| `bin/harness-gate.js` | 两段门禁：`preflight`（进游戏前）/`postflight`（退游戏后）+ `selftest` | 进游戏前必须 `BLOCK=0`；`selftest` 随时可跑 |
| `bin/snapshot-world.js` | 存档快照/回滚（saves + config/numen，排除 monitor） | 会破坏环境的验证前打一份，用完自己删 |
| `bin/send-mc-command.ps1` | 往游戏里发 `/命令`（PostMessage 直投，唯一有效路径） | `/clear`、`/difficulty`、`/gamerule` 全靠它 |
| `bin/weekly-metrics.js` | 周行为指标（完成耗时/死亡率/7天滚动） | 周报 |
| `bin/exp-card.js` | **实验卡**：可证伪主张+冻结阈值+原始数据机械复算 | 见 §2 |
| `bin/exp-runner.js` | **运行器**：复制母版世界→起停游戏→派活→观测→受控复位→归档 | 见 §2 |
| `bin/exp-cycle.js` | **轮回驱动**：连跑 N 轮、轮末简报、对比 improved | 见 §2 |

配套：`workspace\AGENTS.md`（工程纪律九步流/编译唯一通道/提交纪律）、`docs\rdd-docs\rdd架构\`（文档真源：目录规范/项目历史/模块架构/红线回退/杂项记录/实机验证）、`docs\rdd-docs\rdd存放\`（给人看的一页纸）。

**当前口径**：RDD harness 的半退役已于 2026-10-25 夜解除（`workspace\AGENTS.md` 第 −0.8 条）；MC 相关默认走这里。Agene harness 是多项目底座，只做登记（`agene-harness.js project show rdd.mc`），不代跑。

## 2 · 实验层（今天新增，重点交接）

```
实验卡 exp-card：new → validate → freeze --commit <判据落盘 sha> --apply → conclude
运行器 exp-runner：plan（干跑）→ run（--label/--minutes/--goal-file/--zero-start/--keep-experience/--no-delta-stop）→ cleanup
轮回   exp-cycle：run --prefix learn --rounds 4 --minutes 25 --zero-start --goal-file <开场任务>
```

**铁律**：结论只从原始数据复算；样本<repeats / 缺字段 / 坏行 → `INCONCLUSIVE`；冻结后改卡 → 拒绝出结论；口头 claim 与数据矛盾 → `CLAIM_CONTRADICTS_DATA`（数据赢）。

**已实测**：
- `exp-20261025-two-green`：g1/g2 两轮 S1–S4 全 PASS（Δ5/Δ4，42s/39s，停后 0 请求）→ 卡复算 **SUPPORTS count=2**（`sameJarSig` 同构建、`sinceFreeze` 排除旧轮）。
- `exp-20261025-trim-count-v2`：从 C 轮冻结证据切片复算裁剪 4 次 → SUPPORTS；v1 读 live monitor 被判 INCONCLUSIVE（坏行）——机制正确拒了不稳定来源。
- 裁判离线自测：`exp-judge --selftest` 5/5；`exp-card selftest` 12/12（阈值矛盾/无种子/缺理由/样本不足/改卡/claim 矛盾/混构建 必拒）。

**已写码未实跑（交接的核心）**：
- `exp-runner` 新开关：`--keep-experience`（复位保留经验+备忘录，前后 hash 进 envelope）、`--minutes`、`--goal-file`、`--zero-start`（easy + keepInventory + `/clear RDDDev` + `drop-all` 同伴）、`--no-delta-stop`；
- 事件钩子：runner 从 monitor+背包自动写 `evidence/records.jsonl`（milestone/death/blocker/snapshot），**不靠 AI 自述**；
- `exp-cycle.js`：连跑 N 轮、轮末 `experiments/journal/<runId>.brief.md` 给下一轮开场带简报、`<prefix>-summary.md` 出 improved 判定（第 2..N 轮最远阶段>第 1 轮，或同阶段耗时降 ≥20%）。

## 3 · 现在在做什么 / 下一步（按顺序）

1. **5 分钟短测**：`exp-runner run --label learn-smoke --minutes 5 --zero-start --keep-experience --no-delta-stop` —— 验证 `/clear`、`drop-all`、`/difficulty easy`、`/gamerule keepInventory true` 四件事真的生效（看 `evidence/records.jsonl` 与日志）。
2. **写并冻结** `exp-card new exp-20261025-learn-pilot`（claim：4 轮内至少 1 轮最远阶段 > 第 1 轮，或同阶段耗时 ≤80%；失败：全部停在 S1/S2）→ `freeze --commit <sha> --apply`。
3. **跑轮回**：`exp-cycle run --prefix learn --rounds 4 --minutes 25 --zero-start --goal-file <开场.txt>`（开场任务：从零开始，先木器→石器→铁器→找钻石，目标钻石套；每轮 25 分钟、最多 4 轮、失败也继续）。
4. **看结果**：`experiments/journal/learn-summary.md` 的 improved 判定 + 每轮 brief（死亡/卡点/阶段耗时）；机制成功=第 2 轮确实更强；失败=4 轮都卡同处 → 卡点报告就是下一张编码工单。
5. 别忘：跑完 `exp-judge` 不适用于学习轮（那是 SMOKE-r1 的裁决），学习轮的判据用 summary/card。

## 4 · 坑（今天踩过，别重踩）

1. **别用「有行数/字节上限的读取结果」整份回写文件**——今天两次截断（杂项 3353→119、Agene CLI），恢复靠 `git checkout HEAD~1 -- <文件>`，增量一律用 edit/append。
2. **monitor 不是严格 ndjson**（事件字符串里有真换行）：读 `context.jsonl` 要按顶层花括号流式切分（`exp-card.js` 已内置），按行 `JSON.parse` 会全坏。
3. **实例只有一个**：`java=1` 时不要抢（先看 monitor mtime 是否在写）；抢之前确认对方链已停。
4. **live 世界绝不写**：exp-runner 只写 `saves/exp-*` 副本；PASS 删副本、FAIL 留复现包。
5. **判据先冻结再跑**：freeze sidecar 记 `cardSha256 + commit`；跑完改卡 = 用旧冻结盖章，工具会拒。
6. **杂项编号会被并行会话抢占**：写之前先 grep 当前最大 `#NNN`。
7. 游戏日志是 GBK，中文 grep 会假阴性；监测台 `config/numen/monitor/*.jsonl` 是干净 UTF-8。

## 5 · 命令速查

```powershell
node D:\rdd\harness\rdd-harness\bin\harness-gate.js selftest          # 门禁自检（35 项）
node D:\rdd\harness\rdd-harness\bin\exp-card.js list                    # 实验卡
node D:\rdd\harness\rdd-harness\bin\exp-runner.js status               # 历史运行
node D:\rdd\harness\rdd-harness\bin\exp-cycle.js analyze <runId>        # 只分析一轮
node D:\rdd\harness\rdd-harness\bin\checkpoint.js read                  # 醒来先读这张纸
```

## 6 · 文件坐标与今日提交

- 实验卡：`harness/rdd-harness/experiments/cards/`（`exp-20261025-two-green` 已 SUPPORTS；`exp-20261025-trim-count-v2` 示例）
- 运行证据：`harness/rdd-harness/runs/exp-*/`（verdict.md + evidence/）
- 轮回产物：`harness/rdd-harness/experiments/journal/`（brief + summary）
- 今日提交：harness `a485ddf`（学习轮回 WIP）、`7533d4b`（two-green SUPPORTS）、`dc372f9`（exp-card 适配器）、`a119a56`（实验卡首发）；docs `29544a1`、`a8072e2`；workspace `0c2ffaf`（半退役解除）。
