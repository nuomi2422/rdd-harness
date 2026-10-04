## ★★★ 第 −1 条 · 所有 shell 一律后台跑（用户被卡了几十次）

**任何 shell 命令都不要前台阻塞等待。** 要么用 `Start-Process … -WindowStyle Minimized` 脱离启动，要么让命令自己立刻返回；起长驻进程统一走 `node "E:\restart developing doer\rdd-selfcompile\scripts\mc-start.js" gpt 120`（默认 2 小时；它内部已脱离 + 每 3 秒轮询）。**加长 timeout 不是解法。**

## 第 0 条 · 硬门（**只在用户说「stage」时才走 stage 路线**）

**用户明确说了要开 stage，才走下面这套流程。** 用户没说 → 按普通任务直接做，不要自己套 stage。

```powershell
node "E:\restart developing doer\stager\bin\stager.js" start "<用户原话目标>" --actor "<你的名字>"
```

开完档后 `stager ctx` 会把下面这些自动注入到你的上下文里（opencode 插件已装）。
没被注入就手动跑一次：

```powershell
node "E:\restart developing doer\stager\bin\stager.js" ctx
```

`ctx` 里有三样东西，**每次动手前都要看**：
1. **当前阶段 + 该阶段必读的 md 清单**（不读不许动手）
2. **★ 最终架构文档**（所有 AI 的锚，防跑偏）
3. **门禁还差什么**（不达标 `next` 会直接拒你）

> 顺序不许换：**先报 → 再开 stage → 再读必读 → 再动手**。

```
🔀 自报｜模式: 人工(1)/自动(2) ｜ 本轮｜<一句话要做什么>
```

- **人工(1)** = 用户在场 ｜ **自动(2)** = 用户不说话（默认）

---

## 第 1 条 · 四阶段流水线（走完一轮自动 +1，直到任务真正完成）

```
  ① 计划统筹 plan ──→ ② 编码实现 implement ──→ ③ 游戏验证 verify ──→ ④ 记录收口 close
        ↑                                                                       │
        └───────────── 有洞 / 没验完：stager next 自动回①并 +1 轮 ────────────────┘
                      全过：stager close --status done → 关档结束
```

**每阶段必须跑一次。** 每阶段跑完打标记推进，门禁不达标 `next` 会拒。
轮次上限默认 5 轮（`start --rounds N` 改），到顶了要 `--force --note "为什么超"`。

| # | 阶段 | id | 门禁（不达标不许走） | 表情 |
|---|---|---|---|---|
| ① | 🗺️ 计划统筹 | `plan` | `plan` 文档 + **`arch` 最终架构文档** | 疑惑 |
| ② | ⚙️ 编码实现 | `implement` | `implement` 标记 | 平静 |
| ③ | 🧪 游戏验证 | `verify` | `evidence` 文档 | 惊讶 |
| ④ | 🎉 记录收口 | `close` | `experience` 文档 + `check` 标记 | 大笑 |


### ① 计划统筹 · 必读

```
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\10-计划阶段.md
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\30-主要功能不回退清单.md
```
### ② 编码实现 · 必读

```
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\01-工程规范.md   （八项全表）
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\11-模块化回滚.md
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\30-主要功能不回退清单.md
固化红线时改清单
```

**入口只有一个（手写 gradle / 手动拷 jar 已被 permission deny，绕不过去）：**

```powershell
& "E:\restart developing doer\rdd-selfcompile\scripts\run-mutation.ps1" -Requirement "<需求>" -Module <模块>
```

- `-Module`：`plugins:rdd` / `plugins:learner` / `plugins:ac` / `plugins:experience` / `core:neoforge`
- **改执行层（`core/common` 的类）必须 `-Module core:neoforge`**，默认模块盖不到
- `-MaxAttempts N` 止损循环 ｜ `-SkipLaunch -SkipMcp` 只编译+部署
- 改接口**先查消费者**：`FailureClassifier` 那种 switch 穷举，加枚举值不同步补 case 就编译不过

写完：`stager implement --note "改了什么 / 为什么 / 怎么调的 / 入口出口"`

### ③ 游戏验证 · 必读（**这一阶段规范最多**）

```
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\12-进游戏验证工具集.md    ← 工具/脚本全在这
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\04-进游戏巡检规范.md    ← 四层监察
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\13-埋点与监测台链路.md
```

### ④ 记录收口 · 必读

```
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\06-检查清单.md   
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\30-主要功能不回退清单.md
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\05-记忆库与经验注入.md
```

**① 记录经验 → 灌进 memory MCP**

```powershell
# memory_create_entities / memory_add_observations
```

**别只写文档不进图谱。** 空库 → 查了没用 → 更不查，这是踩过的正反馈坑。

**② 写工程规范第 8 条要求的四件**：改了哪 / 为什么 / 怎么调的 / 入口出口
**③** `stager put --kind experience --title "工程经验-<批次>"`
**④ 机器门（三个都要过）**

```powershell
# ① 阶段门禁（stager 管：当前阶段该交的东西交了没）
node "E:\restart developing doer\stager\bin\stager.js" check
# ② 九步流硬门禁（20 项：六步 + 记忆/外脑/巡检/清单）
node "E:\restart developing doer\rdd-selfcompile\scripts\loop-gate.js" --since <今天> --keyword <模块> --head <本轮HEAD>
# ③ 自编译闭环门
node "E:\restart developing doer\rdd-selfcompile\scripts\flow-gate.js" --since <今天> --active <开工时的 store active>
```

`flow-gate` 输出 `VERDICT=NOT_DONE` → **不许收工、不许上报完成**。

**⑤ 判定：走回炉，还是走完成**

```
有洞 / 没验完  →  stager next          （自动回① +1轮，上轮标记全部作废）
全过          →  走下面的「完成动作」
```

**★ 完成动作（顺序别乱）**

```powershell
stager close --status done --note "<一句话结论>"   # ① 关 stage
```

1. `stager close --status done` —— **关 stage**（本轮必须有 `arch` + `evidence`，否则会被拦）
2. **关游戏** —— 带 `-AutoStopMinutes` 起的会自动关；手动起的**自己关，别占内存**
3. **代码推到远端** —— `git push`（commit message 用 `-F msg.txt`，含空格会被 shell 拆）
4. **报告各项验证证据 + 成果清单**
5. **汇总给用户**
6. 用户说**没问题** → 真正结束；用户说**有问题** → `stager start` 新一轮，或 `stager round --force` 接着修

---
### 唯一例外

**用户明说「这次就走九步流，不走互审」** → 跳过 W 池，`stager next --force --note "用户要求不走互审"`。
这是唯一允许 `--force` 走计划阶段的场景。

---

## 第 3 条 · 每三轮 · GLM 源码审

```
第 3 / 6 / 9 … 轮 → stager ctx 会自动在注入包里提醒你
```

**动作**：把本轮**所有源码改动**粘给 GLM 审一遍。

- **直接粘文本**，不要只给摘要或链接（GLM 看不到你的文件）
- 走完 3 轮再发，不是每轮都发
- 审稿落 `rdd-selfcompile\report\`
- 审出 P0/P1 → 记进待办，下一轮计划阶段必须处理

---


## 第 6 条 · 常见坑（别重踩）

| 坑 | 症状 | 对策 |
|---|---|---|
| **PS 5.1 按 ANSI 读无 BOM 的 UTF-8** | `.ps1` 中文乱码 + 一串语法错 | `.ps1` **必须写 UTF-8 BOM** |
| **`node -e "…"` 内联被 PS 引号拆坏** | 各种诡异报错 | **一律写 `.js` 文件再 `node file.js`** |
| **PS `:` 插值** | `":$mod:jar"` 整串变成 `:`，gradle 报找不到 task `:` | 用 `":$($mod):jar"` |
| **MCP 端口** | 文档里写过 test=8765，**是错的** | **live=8765**（真源：`<实例>\config\numen\mcp_server.json`）。test=8766 已停用 |
| **监测台端口** | 记混 | **live=8776**（真源：`config.ps1` 的 `MONITOR_URL`）。test=8777 已停用 |
| **游戏日志中文是 GBK** | 用中文 grep 假阴性 | 判中文功能查**监测台 `rdd.jsonl`**（干净 UTF-8） |
| **`get_self_status` 等 MCP 工具** | 直接派活会被门禁拒 | 关 MCP 止投，只读 |
| **test 实例 `api_key` 是 EMPTY** | 验 LLM 链路失败 | **用 live 实例**（`[openai]` 段） |
### ★ 实例叫法（2026-10-01 用户确认：只用 live）

| 叫法 | 指什么 | 状态 |
|---|---|---|
| **live** | `E:\.minecraft\versions\The Best of Twilight Forest` | ✅ **唯一在用** —— 用户口中的「live」就是它 |
| ~~gpt~~ | **同一个目录**，只是脚本参数名（`config.ps1` 的 `ValidateSet('test','gpt')`） | 别当成另一个实例 |
| ~~test~~ | `rdd-selfcompile\instances\test` | ❌ **已停用**，不计入任何债 |

**三个叫法是同一个东西**：`live` = `gpt 实例` = `The Best of Twilight Forest`。
文档里一律叫 **live**；只有在写命令行时才写 `-Instance gpt`（那是**参数名**，不是实例名）。

> ⚠️ 改叫法时**别顺手把 `ValidateSet` 也改了** —— 那是脚本契约，`launch-mc.ps1` /
> `run-mutation.ps1` / `config.ps1` 都按它传参。
| **Bash 工具 120s 超时** | 杀掉等待循环（**但 MC 照样在跑**） | 起了就查状态，**别重发** |
| **W 池调用别用默认 120s** | 大部分模型 2~3 分钟才说完，**GLM 可能要 4~5 分钟**，超时会被砍，**白等一场** | `bash(timeout=60000)` 起步（暂定 1 分钟，后面按实测调）；**超时就查落盘文件**（`report\w-replies\*.json`），别重发 |
| ⚠️ **GLM 抓回复会抓到上一轮旧答案** | 2026-09-30 实测：GLM 浏览器里答对了，但落盘文件里存的是上一轮「1+1等于2」。**是脚本抓错元素，不是 GLM 答错**（Qwen/Kimi/DeepSeek 同时同题抓取正确）。**时序偶发，非必现** | **互审前先跑探针** `node rdd-selfcompile\scripts\w-probe.js`（发随机数问题核对答案）；探针不过就别问 |
| **provider 先排再判代码** | 「它不动」被误判成执行层慢 | 第 0 步查日志有**无 401/402/5xx**（2026-09-28 实测 DeepSeek 402×49、0 成功 = 没钱） |
| ⚠️ **`git add -A` 会卷进别人的改动** | 本工作区**常有两个会话并行改同一个仓库**。`-A` 会把对方未完成的改动一起提交，甚至把故意注入的变异（测试用）写进 commit | **精确 add 指定文件**：`git add <路径1> <路径2>…`。提交前必跑 `git status --short` 逐行确认，每一行都是你改的。2026-10-01 实测已出过一次事故（`MAX_QUEUE=63` 的变异被卷进 commit，HEAD 一度是坏的） |
| ⚠️ **源码改了 ≠ 运行时生效** | 只改源码就写「已改完」= 把中间态当完成态 | 中间隔着 **编译 → 部署 jar → 重启游戏** 三步。**判据有工具，别靠记性**：<br>`node rdd-selfcompile\scripts\verify-tools\check-runtime-deployment.js`（退出码 2 = 有源码领先于 jar）<br>★ 它比的是「**最后一次改 `src/main/java`** 的提交」vs jar 的 `LastWriteTime`，**不是**「最后一次提交」—— 只改 `*Test.java` 时 jar 本来就不用重部署（这个区分不做会满屏假警报）。<br>2026-10-01 实测 RL-19 落后 **56 小时**：源码对了、测试绿了、文档写「已改」，但游戏里跑的还是旧版 |
| ⚠️ **写「怎么修」之前先实测** | 照着症状猜出来的修法可能是错的 | 2026-10-01 我把 `plugins/rdd` 单测加载不了诊断成「缺 `numen_api`、加一行 `testImplementation` 就行」—— 并行会话实测发现**真正缺的是整个 Minecraft 测试运行期**（`NoClassDefFoundError: net/minecraft/...Property`），是 moddev 配置改造不是一行的事。**症状 ≠ 病因** |

---

### ⚠️ 「精确 add」这条我当天又犯了一次（2026-10-01 · 二次事故）

写完上面那条纪律两小时后，我在 `rdd-docs` 仓库又用了 `git add -A`，
把并行会话跑 `sync-unified-copy.ps1` 的**整个同步批次（167 个文件）**卷进了
一个提交信息写着「三件待办全部不做」的 commit。

- **数据没丢**（147 个删除全在副本目录，是同步的正常结果；真源 57 份完好）
- **但提交信息与内容严重不符** —— 后来人读 git log 会以为那 167 个文件是为那三件事改的
- 已推送，不能 amend / reset，只能另写补记

**所以：写进文档的纪律不自动生效，得靠每次提交前的习惯。**
rdd-docs 尤其危险 —— 副本同步一次就动 147 个文件。

---

## 第 6 条·补 · 路径配置在哪（改文档位置只改两行）

散落的硬编码路径已经收成配置。**别再自己写死路径**：

| 侧 | 改这里 | 覆盖什么 |
|---|---|---|
| **node**（stager / loop-gate / stage-heartbeat） | `stager\core\stages.json` 的 `docsRoot` + `docsOut` | ctx 必读清单 · publish 投放到哪 |
| **PowerShell**（sync-unified-copy / backup-to-removable 等） | `rdd-selfcompile\scripts\config.ps1` 的 `DOCS_ROOT` / `DOCS_UNIFIED` / `DOCS_OUT` | 副本同步 / 备份 |

改完必跑：

```powershell
node stager\bin\stager.js self-check     # 验文档根 + 每个 read[] 真存在
```

> 为什么加这条：2026-10-01 知识库搬家（`rdd架构` → `rdd-docs\rdd架构`），
> **13 处散落硬编码全失配** —— ctx 指向不存在的目录、loop-gate 读不到测试日志、
> publish 往废弃目录投。第一次只搜了 `stager/` 就以为改完了，
> **漏了 `rdd-selfcompile\scripts` 的 5 处**（其中 loop-gate 是硬门禁）。
> 教训：**改路径必须全仓 grep，不要凭印象只搜一个目录。**

---

## 第 7 条 · 本工作区地图

| 路径 | 是什么 | 关键入口 |
|---|---|---|
| `stager\` | **★ 流程状态机**（4 阶段 / 轮次 / 人次 / 文档 / 门禁 / 桌宠）。第 0 条那条就是它 | `bin\stager.js ctx`（AI 开工第一条）、`core\stages.json`（阶段定义）、`bin\repo-status.js`（**套娃仓库状态面板**）、`pet\start-pet.ps1`（桌宠） |
| `minecraft-numen\` | **Numen 源码 · 真源**（Java / Gradle 9.2 / JDK 21 / NeoForge 1.21.1）。全部游戏代码在这 | `gradlew.bat :plugins:rdd:test`、`plugins/selfcompile/.../generated/` |
| `rdd-selfcompile\` | **自编译运行时真源**。`scripts\`（闭环/看门狗/巡检/外脑/回滚/清理）、`templates\`、`mutations\`、`ai-bridge\` | `scripts\run-mutation.ps1`（**唯一改码入口**）、`scripts\config.ps1`（真源） |
| `rdd-monitor-publish-20260913\` | **监测台 live 副本**（只读观测） | `monitoring-station\server.mjs` → `http://127.0.0.1:8776/` |
| `mc-openclaw-controller\` | OpenClaw 客户端玩家控制器（8080，键鼠/感知/截图）。**★已存档弃用**，改走 mineflayer-mcp，代码只读留档 | tag `archived-2026-10-01`；`scripts\oc-drive.js`（参考用，勿跑） |
| `gradle-9.2.0\` | 离线 Gradle 发行版 | `gradle-9.2.0\bin\gradle.bat` |

### ⚠ 套娃仓库（本工作区有 6 个 git 仓库）

外层 `E:\restart developing doer` 有一个，另有 5 个套娃：`minecraft-numen`（真源）、
`rdd-selfcompile\ai-bridge`、`rdd-monitor-publish-20260913`、`mc-openclaw-controller`、`voyager`。

**外层 `.gitignore` 排掉了它们**（理由：提交只会存成 gitlink 指针，克隆外层拿不到内容）。
代价是**外层 git 完全看不见内层改动** —— 所以 `stager` 门禁和 `loop-gate` 的
「本轮有按模块 commit」判据**对 `minecraft-numen` 的改动是盲的**。

**动子仓库前后跑一次** `node stager\bin\repo-status.js`（只读，一次看清 6 个仓库的
HEAD / 脏项 / 推没推 / 有没有远程 / 是不是浅克隆）。**跨仓库对账时看它，不要只看外层 `git log`。**

### ⚠ `plugins/selfcompile` ≠ 改码通道（2026-10-01 核实，容易搞错）

游戏里那个 `selfcompile` 插件**不是改码通道**，它现在只是
**工程流 stager 里「进游戏监督 AI」那个小流程的落地面**：

| | 干什么 | 谁在用 |
|---|---|---|
| 游戏内 `selfcompile_request` | 把游戏内 AI 的需求写进审计目录 | 游戏里的 AI |
| 游戏内 `selfcompile_status` | 查状态（idle/controlled） | 游戏里的 AI |
| 游戏内 `RddWhereamiTool` / `RddGetInventoryTool` | `generated/` 下，**它自己产的**，每轮变异要手工改入口注册 | 游戏里的 AI |
| 外层 `run-mutation.ps1` | **★ 唯一的改码通道**（编译/部署/起游戏/MCP/取证） | 本工程流 |

`selfcompile_request` 的工具描述原话：**「只创建审计目录，不生成代码、不执行命令、不编译、不部署」**

`plugins/selfcompile/MutationPipeline.java` 那条 11 态变异流水线
（编译 / 验证 / 预算止损 / Harness 写锁）**在生产代码里 0 处引用，只有单测能调到**——
**它已经关着了，不是"在跑但有风险"，是根本没接上线**。代码里已加停用注释。
⚠️ **别去接线它** —— 外层已有一套 MutationId 与门禁，两套并存必然漂移。

**真正的规则正文在** `E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\`。
**本文件就是唯一索引** —— 每个阶段该读哪几份，上面第 1 条已经写死，不用再找别的索引页。
（原来的 `自编译统一版\INDEX.md` 已并入本文件并退役，备份在 `_INDEX-已并入AGENTS-20260930.md.bak`）
本文件是**可执行的那一份**：阶段 + 门禁 + 必读 + 判据。正文细节去那 39 份里查。

---

## 第 8 条 · 东西放哪（用户随时要看/要用的东西）

**stager 的阶段是数据驱动的** —— 改 `stager\core\stages.json`，改完立刻生效，不用改代码。

```jsonc
{
  "loopTo": "plan",              // 轮回回到哪
  "goalTypes": { "module": "...", "exploit": "...", "free": "...", "tidy": "..." },
  "docKinds": { "goal": "...", "plan": "...", "arch": "...", "evidence": "...", ... },
  "stages": [{
    "id": "plan", "name": "计划统筹", "icon": "🗺️", "expr": "confused",
    "next": "implement",
    "read":  ["...必读 md..."],   // ← 改这里就改「本阶段必读」
    "gate": { "docs": ["plan", "arch"] },   // ← 改这里就改门禁
    "brief": "...", "ai": ["...必做..."]
  }]
}
```

加阶段 / 改门禁 / 改必读 / ，全在这一份 JSON 里。

---

## 第 9 条 · 改流程怎么改

**stager 的阶段是数据驱动的** —— 改 `stager\core\stages.json`，改完立刻生效，不用改代码。

```jsonc
{
  "loopTo": "plan",              // 轮回回到哪
  "goalTypes": { "module": "...", "exploit": "...", "free": "...", "tidy": "..." },
  "docKinds": { "goal": "...", "plan": "...", "arch": "...", "evidence": "...", ... },
  "stages": [{
    "id": "plan", "name": "计划统筹", "icon": "🗺️", "expr": "confused",
    "next": "implement",
    "read":  ["...必读 md..."],   // ← 改这里就改「本阶段必读」
    "gate": { "docs": ["plan", "arch"] },   // ← 改这里就改门禁
    "brief": "...", "ai": ["...必做..."]
  }]
}
```

加阶段 / 改门禁 / 改必读 / 改文档类型，全在这一份 JSON 里。

---

## 第 10 条 · 交接与资产

- **接手先看**：`E:\新建文件夹\rdd-docs\rdd架构\self-compile-handoff.md`
- **stager 自己的交接**：`stager\STAGER.md`（给 AI）+ `stager\README.md`（给人）
- **换人接手**：`stager swap "<你的名字>"` → `stager ctx --full`（把历史文档全文注入给你）
- **桌宠**：`stager\启动桌宠.bat` 或 `stager pet`；点一下报「阶段 (n/4) / 第几轮 / 轮回几次 / 人次 / 门禁」

---

**★ 用户只看这一个地方：**

```text
E:\新建文件夹\rdd-docs\rdd存放\
```

### 全目录分工（别搞混）

| 目录 | 谁用 |
|---|---|
| `E:\新建文件夹\rdd-docs\rdd存放\` | **用户** —— 要看、要用、要点的，**全部放这里** |
| `E:\新建文件夹\rdd-docs\rdd架构\` | AI —— 设计+规范+叙事的真源（**已在 git**，见下） |
| `rdd-selfcompile\report\` | AI —— 外脑审稿原文（W 池回复也归档到这） |
| `rdd-selfcompile\scripts\` | AI —— 闭环真源，**改动要用户批准** |
| `rdd-selfcompile\scripts\verify-tools\` | AI —— 我自己写的验证工具 |
| `rdd-selfcompile\mutations\` | AI —— 每次变异的临时工作区（**用户别翻**） |
| `stager\` | AI —— 阶段状态机 |

> ### ★ 知识库已入 git（2026-10-01）
>
> `E:\新建文件夹\rdd-docs\` 是**独立仓库**，远程 `nuomi2422/rdd-docs`（私有）。
> 之前 `rdd架构\` + `rdd存放\` **完全不在任何版本控制里** —— 一次磁盘故障全没。
> 现在 317 份文档有历史、有备份。**改文档后记得 commit**（跟代码仓库一样）。
>
> **两份导航（新加的，先读这个）**：
> | 想解决 | 读 |
> |---|---|
> | 「我想解决 X，该读哪份」 | `rdd架构\自编译统一版\50-按主题导航.md` |
> | 「那天他究竟做了什么」 | `rdd架构\自编译统一版\51-研发叙事时间线.md` |
>
> **文档里的行号会漂** —— 想知道准不准，跑：
> ```powershell
> node rdd-selfcompile\scripts\verify-tools\check-doc-anchor-drift.js --docs "E:\新建文件夹\rdd-docs\rdd架构" --src "E:\restart developing doer\minecraft-numen"
> ```
> 它会给出**新行号**让你直接改文档，并把「历史快照里正常的偏移」和「活文档的真债」分开。

> `rdd-selfcompile\给用户\` 已废弃（内容已归到 `rdd存放`）。
> `rdd架构\特殊模式\` 已废弃：原目录移到 `_废弃-特殊模式-20260930\`（68 个文件都在，没删），
> 审稿原文已拷到 `rdd-selfcompile\report\w-replies\`（`w-brain-drive.js` 的 `W_REPLY_DIR` 也已改指向这里）。