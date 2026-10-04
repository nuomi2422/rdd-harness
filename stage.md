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

**编译入口的完整参数在 `AGENTS.md`（工程纪律）**，那里是唯一真源，这里不重复：

```powershell
& "E:\restart developing doer\rdd-selfcompile\scripts\run-mutation.ps1" -Requirement "<需求>" -Module <模块>
```

写完：`stager implement --note "改了什么 / 为什么 / 怎么调的 / 入口出口"`

### ③ 游戏验证 · 必读（**这一阶段规范最多**）

```
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\12-进游戏验证工具集.md    ← 工具/脚本全在这
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\04-进游戏巡检规范.md    ← 四层监察
E:\新建文件夹\rdd-docs\rdd架构\自编译统一版\13-埋点与监测台链路.md
```

★ **进游戏之前先读一遍** `E:\新建文件夹\rddharness\进游戏前必读-游戏内能力清单.md`
—— 里面是游戏里到底有哪些能力（说话 / 建伙伴 / 让内脑停 / 视觉 / 拍摄 / 追踪 / 相机 / 飞行 / 看监测台）
和每一条的正确调用姿势与坑。**别临场手写已有工具。**

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
