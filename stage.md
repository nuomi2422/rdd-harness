# ★ stage 流（**只在开 stage 时才读本文**）

> **什么时候读这个文件？** 用户明确说了「开 stage / 走 stage 流程 / 走流水线」才读。
> **没说的话不要读、不要套。** —— 按普通任务直接做。
>
> 本文是 `E:\restart developing doer\AGENTS.md` 的**分工伙伴**：
> **AGENTS.md 只留工程纪律 + 杂项，不承载 stage 流**；stage 流全部在这里。
> 想改 stage 流（加阶段 / 改门禁 / 改必读）改本文 + `stager\core\stages.json`，**不要改 AGENTS.md**。

---

## 顺序不许换：先报 → 再开 stage → 再读必读 → 再动手

```
🔀 自报｜模式: 人工(1)/自动(2) ｜ 本轮｜<一句话要做什么>
```

- **人工(1)** = 用户在场 ｜ **自动(2)** = 用户不说话（默认）

## 开档

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

---

## 四阶段流水线（走完一轮自动 +1，直到任务真正完成）

```
  ① 计划统筹 plan ──→ ② 编码实现 implement ──→ ③ 游戏验证 verify ──→ ④ 记录收口 close
        ↑                                                                       │
        └───────────── 有洞 / 没验完：stager next 自动回①并 +1 轮 ────────────────┘
                      全过：stager close --status done → 关档结束
```

**每阶段必须跑一次。** 每阶段跑完打标记推进，门禁不达标 `next` 会拒。
轮次上限默认 5 轮（`start --rounds N` 改），到顶了要 `--force --note "为什么超"`。

| # | 阶段 | id | 门禁（不达标不许走） | 进出游戏提示 | 表情 |
|---|---|---|---|---|---|
| ① | 🗺️ 计划统筹 | `plan` | `plan` 文档 + **`arch` 最终架构文档** | — | 疑惑 |
| ② | ⚙️ 编码实现 | `implement` | `implement` 标记 | **起游戏前 → preflight** | 平静 |
| ③ | 🧪 游戏验证 | `verify` | `evidence` 文档 | **进游戏前 → preflight** | 惊讶 |
| ④ | 🎉 记录收口 | `close` | `experience` 文档 + `check` 标记 | **出游戏后 → postflight** | 大笑 |

### ★★ 进出游戏 = 换阶段提示（2026-10-04 加）

以前 stager 的阶段门禁只查「有没有交文档」，**查不出有没有真的按规矩做事**。
现在把 harness 的两段门禁接进来 —— 进出游戏是最容易出事的两个瞬间，各响一次就够覆盖整轮：

```powershell
# ★ 进游戏之前（部署完 jar、要把游戏拉起来的那一刻）
node "E:\新建文件夹\rddharness\bin\harness-gate.js" preflight --since <今天> --keyword <模块> --head <HEAD>

# ★ 出游戏之后（关掉游戏之后、写记录之前）
node "E:\新建文件夹\rddharness\bin\harness-gate.js" postflight --since <今天> --keyword <模块> --head <HEAD>
```

| 退出码 | 意思 |
|---|---|
| `0` | 全过，可以动游戏 / 可以上报完成 |
| `1` | 有 BLOCK 项，必须处理完 |
| `3` | **环境错，不是债** —— 别当门禁红处理，去看它说什么 |

**输出里 `☞` 开头的那几项 = 机器判不了、必须你亲自点头的。** 它们不进 BLOCK 计数
（一条永远无法自动满足的项会把门禁永久钉死），但**永远会打印出来**。
所以「我没看到提示」只可能意味着门禁没跑，不可能是提示不存在。

| 阶段 | 会念出来的 ASK 项 |
|---|---|
| ② 编码实现 | `P12` 改接口先查消费者 · `P13` 进游戏前过一遍游戏内能力清单 |
| ③ 游戏验证 | `P13` 进游戏前过一遍游戏内能力清单 |
| ④ 记录收口 | `Q11` 提交精确没卷别人 · `Q12` 写记录 + 写文档 |

**分工**：stager 管「阶段推进的节奏」，harness 管「每个阶段该满足的硬条件」。
两者互补，不替代 —— 机器查 jar mtime / mixin 重复 / 产物真落地 / 文档编号三处，
这些 stager 的 marker 机制查不出来。

### ★★ 外脑咨询是**可选**的（2026-10-04 降级）

判据只有一个：**本轮有没有一份冻结的 `arch` 文档**（`stager put --kind arch`）。

| 情况 | 该怎么办 |
|---|---|
| **有 arch** | 架构已经写在盘上了，外脑只是复述它。★ **可以跳过外脑**，自己进游戏验证、自己写总结。 |
| 没 arch / arch 里没写这件事 | 外脑才有价值（它能补上你想不到的那一面）→ 先 `w-probe.js` 探 30 秒，过了再 `w-brain-drive.js askall --file "<你的问题.md>"` |

跳过也要**记账**：在计划/经验文档里写一行「本轮未用外脑 + 为什么」，
这样 `stager check` 的「外脑：0 家」有据可查，不是漏做。

> ★ **别为了「流程完整」反复重试外脑** —— 那是烧真额度换一个你自己就能写出来的东西。
> ★ 外脑是**找分歧**用的，不是数票：4 家一致 → 直接跳过；互相矛盾 → 逐条写
> 「谁 vs 谁 / 冲突点 / 你怎么裁的（附理由）」；一家独有 → 写下来待核。

### ① 计划统筹 · 必读

```
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\10-计划阶段.md
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\30-主要功能不回退清单.md
```

> ### ★★ 本阶段的产物 = 「防迷路的锚」
> `arch`（最终架构文档）**不是走形式**。它就是后面每一轮回头对齐的基准：
> - 计划里必须写清「**完成长什么样**」——可判定，不是「优化一下」那种。写不出判定标准就是还没想清楚。
> - 记下它的路径；②③④ 三个阶段的提示里都会让你回头读它。
> - arch 与代码不一致时：**先判断是代码错了还是 arch 错了**，别默默改代码让 arch 过期。
>
> ★★ **arch 定稿后可以上「目标锁」** —— 如果这件事要盯到**验收通过**才算完（而不是走完四阶段就算），
> 就把 arch 变成一把锁，AI 停了自动催、断流自动续、每条必须给跑出来的证据：
> ```powershell
> node "E:\新建文件夹\rddharness\bin\goal.js" init --title "<任务名>" --from-stage   # 自动认领刚冻结的 arch
> ```
> 细则（证据规则 / 三个钩子 / 怎么关掉它）读 `E:\新建文件夹\rddharness\goal-drive.md`。
> ★ **不走 stage 也能上锁** —— 目标锁和四阶段是两件事，`stage.md` 管节奏，goal 管验收。
>
> 外脑**可选**：已经有 arch 就跳过（见上面「外脑咨询是可选的」）。

### ② 编码实现 · 必读

```
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\01-工程规范.md   （八项全表）
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\11-模块化回滚.md
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\30-主要功能不回退清单.md
固化红线时改清单
```

**编译入口的完整参数在 `AGENTS.md`（工程纪律）**，那里是唯一真源，这里不重复：

```powershell
& "E:\restart developing doer\rdd-selfcompile\scripts\run-mutation.ps1" -Requirement "<需求>" -Module <模块>
```

> ### ★ 部署完、准备把游戏拉起来之前 → 跑 preflight
> ```powershell
> node "E:\新建文件夹\rddharness\bin\harness-gate.js" preflight --since <今天> --keyword <模块> --head <HEAD>
> ```
> exit=0 才动游戏。它会拦住这几类：jar 落后于源码、重复 mixin 注入、本轮没按模块 commit、
> 文档编号新撞号、规则文件三层分工打架。`☞ P12/P13` 会提醒你查消费者 + 读游戏内能力清单。

写完：`stager implement --note "改了什么 / 为什么 / 怎么调的 / 入口出口"`

### ③ 游戏验证 · 必读（**这一阶段规范最多**）

```
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\12-进游戏验证工具集.md    ← 工具/脚本全在这
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\04-进游戏巡检规范.md    ← 四层监察
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\13-埋点与监测台链路.md
```

> ### ★★ 进游戏之前 —— 本阶段的第一件事，两步
> **① 跑 preflight**
> ```powershell
> node "E:\新建文件夹\rddharness\bin\harness-gate.js" preflight --since <今天> --keyword <模块> --head <HEAD>
> ```
> **② 读游戏内能力清单**
> ```text
> E:\新建文件夹\rddharness\进游戏前必读-游戏内能力清单.md
> ```
> 它列了游戏里到底有哪些能力（说话 / 建伙伴 / 让内脑停 / 视觉 / 拍摄 / 追踪 / 相机 /
> 飞行 / 看监测台）和每一条的正确调用姿势与坑。
> **★ 别临场手写已有工具** —— 「游戏内截图能力 = 0」这类结论已经错了不止一次。
>
> 外脑**可选**：本阶段的验证脚本基本是现成的，写不出新问题时跳过外脑、自己跑、自己写证据。

### ④ 记录收口 · 必读

```
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\06-检查清单.md
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\30-主要功能不回退清单.md
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\05-记忆库与经验注入.md
```

**① 记录经验 → 灌进 memory MCP**

> ### ★★ 出游戏之后 —— 本阶段的第二条动作
> **顺序固定：关游戏 → 跑 postflight → 写记录 → 写文档 → 收尾**。
> 顺序反了就变成「边跑着游戏边补文档」，补出来的全是记忆里的版本，不是盘上那一版。
>
> ```powershell
> node "E:\新建文件夹\rddharness\bin\harness-gate.js" postflight --since <今天> --keyword <模块> --head <HEAD>
> ```
> exit=0 才许上报完成。`☞ Q12` 会把「写记录 + 写文档」三件必做的事逐条念出来：
> ① `测试日志.md` / `09-更新日志.md` 各加本轮条目（**要带签名**，否则机器判不出是你写的）
> ② 长期资产进 `docsUnified\NN-<中文名>.md`，**登记 3 处**
> ③ 灌记忆图谱 —— 别只写文档不进图谱
>
> ★ 没开游戏（本轮只改流程/文档）也要跑：postflight 查的是产物与文档，「游戏已关」那项只给 WARN。

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

### ★ 完成动作（顺序别乱）

```powershell
stager close --status done --note "<一句话结论>"   # ① 关 stage
```

1. `stager close --status done` —— **关 stage**（本轮必须有 `arch` + `evidence`，否则会被拦）
2. **关游戏** —— 带 `-AutoStopMinutes` 起的会自动关；手动起的**自己关，别占内存**
3. **代码推到远端** —— `git push`（commit message 用 `-F msg.txt`，含空格会被 shell 拆）
4. **报告各项验证证据 + 成果清单**
5. **汇总给用户**
6. 用户说**没问题** → 真正结束；用户说**有问题** → `stager start` 新一轮，或 `stager round --force` 接着修

### 唯一例外

**用户明说「这次就走九步流，不走互审」** → 跳过 W 池，`stager next --force --note "用户要求不走互审"`。
这是唯一允许 `--force` 走计划阶段的场景。

---

## 每三轮 · GLM 源码审

```
第 3 / 6 / 9 … 轮 → stager ctx 会自动在注入包里提醒你
```

**动作**：把本轮**所有源码改动**粘给 GLM 审一遍。

- **直接粘文本**，不要只给摘要或链接（GLM 看不到你的文件）
- 走完 3 轮再发，不是每轮都发
- 审稿落 `rdd-selfcompile\report\`
- 审出 P0/P1 → 记进待办，下一轮计划阶段必须处理

---

## 改流程怎么改（stager 的阶段是数据驱动的）

改 `stager\core\stages.json`，改完立刻生效，**不用改代码**。

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

改完必跑：

```powershell
rg --files "E:\新建文件夹\rdd-docs\rdd架构\自编译统一版"     # 手工确认每个 read[] 路径都在（没有 self-check 命令，见 registry bug-10）
```

---

## stager 自己的交接

- **stager 的交接文档**：`stager\STAGER.md`（给 AI）+ `stager\README.md`（给人）
- **换人接手**：`stager swap "<你的名字>"` → `stager ctx --full`（把历史文档全文注入给你）
- **桌宠**：`stager\启动桌宠.bat` 或 `stager pet`；点一下报「阶段 (n/4) / 第几轮 / 轮回几次 / 人次 / 门禁」
- **跨仓库状态面板**：`node "E:\restart developing doer\stager\bin\repo-status.js"`（只读，一次看清 6 个仓库）

## 文档根（stage 流的规则正文）

**全部在** `E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\`（70 份）。
想解决 X 该读哪份 → `50-按主题导航.md`；那天他究竟做了什么 → `51-研发叙事时间线.md`。
