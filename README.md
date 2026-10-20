# RDD Harness

> 「模型外面那层脚手架」—— 按 `minecraft-numen\api\docs\README_CN.md:46` 的定义，
> **Numen 本身**是给 Minecraft 造的那层；这个目录是**给 AI 造的那层**：工具注册表 +
> 编程规范 + 两段门禁 + 六条时间锁。

📦 **本目录已入 git**（2026-10-04）：独立仓库，远程 `nuomi2422/rdd-harness`（**私有**，与 `rdd-docs` 同 owner），
分支 `main`，root commit `0876af7`（20 文件 +3764）。改完请 commit —— 这一层原来一次磁盘故障就全没。

⚠️ **消歧**（先读完再动手）：本工作区里 `harness` 有 4 个互不相干的含义。
本目录**只**指第 1 个，其余三个是噪音：
1. ✅ **`D:\rdd\harness\rdd-harness\`** = 本目录（AI 工程脚手架 + 用户面启动台）
2. ❌ `rdd-selfcompile\scripts\opencode-harness.ps1` = headless opencode CLI 跑批器，**无人调用**
3. ❌ `minecraft-numen\...\core\pathing\execute\ExecHarness.java` = 移动执行层
4. ❌ `plugins\selfcompile\...\HarnessWriteLocks.java` = 写锁，**0 处引用、从未接线**

## 目录里有什么

| 路径 | 是什么 | 性质 |
|---|---|---|
| **`registry.json`** | ★ **唯一真源**：相对 RDD 根的 10 条根路径 + 4 条路由铁律 + 72 个工具 + 12/11 项门禁 + **10 条时间锁** + 编号台账 + **10 条 bug** | 机器可读，门禁全读它 |
| **`bin\lib\registry.js`** | ★ **唯一路径解析层**：把 registry 的相对路径解析成绝对路径（`RDD_ROOT` 环境变量可整体搬家） | 只读，别绕过它自己拼路径 |
| **`multimodel\`** | **多模型协同 + 实机验证闭环（按需索引，默认不读）** —— M1 离线骨架：测试卡/证据/裁决/路由/预算/RunStore | 只在无人值守或要做实机取证时打开；`multimodel\README.md` |
| **`standards.md`** | ★ **编程规范唯一真源**：8 域 40 条，每条带稳定 id（`S-BUILD-03` 这种） | 人读 + 机器读（有 id 才能进门禁） |
| **`bin\harness-gate.js`** | 门禁执行器，`preflight` / `postflight` / `registry` / `selftest` | 只读，唯一入口 |
| **`bin\send-mc-command.ps1`** | 把斜杠指令送进游戏聊天框 | 唯一可行路径 |
| **`skills\numen-cam\SKILL.md`** | /cam 用法 | 指针 |
| **`工具总索引-20261003\`** | 全工具实测记录（811 行） | 只读档案 |
| `*.bat` + `stage.md` | 用户面启动台（`build-harness-folder.js` 的复制品） | 原件在 `stager\` / `rdd-selfcompile\` |

## ★ 4 条路由铁律（`registry.json` → `routing`）

1. **总结 / 复盘 / 经验文档一律写 `docs`（`D:\rdd\docs\rdd-docs\rdd架构\`），
   绝不写进 harness 目录。** harness 只放：工具注册表 / 门禁 / 规则 / skill。
2. 改码只走 `scripts\run-mutation.ps1`（唯一通道）。
3. 起游戏只走 `scripts\mc-start.js gpt <分钟>`。
4. 规范条目**必须带 id**——没 id 就没法进门禁，也就等于没有。

## ★ 路径约定（2026-10-19 起：全部相对化）

**注册表里所有路径都相对「RDD 根」，RDD 根相对 `registry.json` 自己**（`paths.rootAnchor` 默认 `../..`）：

```text
<RDD 根>/                      ← registry.json 的上一级目录的上一级
  harness/rdd-harness/        ← 本目录（roots.harness = "harness/rdd-harness"）
  workspace/  docs/  mc/      ← 其余 roots 同理
```

- 换机器 / 换目录 / 拷一份临时副本：只改 `paths.rootAnchor`，或设环境变量 `RDD_ROOT`。
- 解析**只有一处**：`bin/lib/registry.js`。门禁、面板、脚本都走它；绝对路径仍兼容但 `selftest` 会报 FAIL。
- `.bat` / `.ps1` 入口用 `%~dp0..\..`（或 `$PSScriptRoot\..\..\..`）自己算根，不再写死 `D:\rdd`。
- `selftest` 的「registry roots 已相对化」是这条约定唯一的机器判据（时间锁 `TL-2026-10-19-01`）。

## 两段门禁

```powershell
# ① 进游戏之前：查工程纪律 / 补测试 / 补规范
node "D:\rdd\harness\rdd-harness\bin\harness-gate.js" preflight --since 2026-10-04 --keyword camera --head a91f2710

# ② 出游戏之后：查标记 / 文档 / 总结 / 记忆图谱 / 产物 / 时间锁 / 编号 / 游戏是否关
node "D:\rdd\harness\rdd-harness\bin\harness-gate.js" postflight --since 2026-10-04 --keyword camera --head a91f2710

# 只看注册表 / 自检执行器自身
node "D:\rdd\harness\rdd-harness\bin\harness-gate.js" registry
node "D:\rdd\harness\rdd-harness\bin\harness-gate.js" selftest
```

退出码：`0` 全过 ／ `1` 有 BLOCK ／ `3` 环境错（不是债）。

**三类检查项**（`kind`）：
- `artifact` **查实物** —— 文件在不在、jar 里有没有、sha 对不对。AI 编不出来。
- `trace` **查痕迹** —— 本轮产出（mtime + 内容签名，防「只改 mtime 骗过」）。
- `human` **人工** —— AI 自己判不了，标出来让人做。

### preflight 12 项（进游戏前）

P1 编译通道合规 ／ **P2 jar 不落后于源码** ／ P3 jar 内容自检（ZipFile 列 entries +
mods.toml + mixins.json）／ P4 无重复 mixin 注入 ／ P5 本轮有按模块 commit ／
**P6 测试 0 失败**（扫 `TEST-*.xml` 累加 failures+errors）／ **P7 规范索引已补** ／
P8 不回退清单对照过 ／ P9 时间锁未到期 ／ P10 系列文档编号 ／ P11 规则没打架 ／
P12 改接口先查消费者（人工）

### postflight 11 项（出游戏后）

Q1 有标记（`.stager/active.json`）／ Q2 evidence 已落 ／ Q3 总结已写 ／
**Q4 总结写到了正确位置**（harness 里新建的总结类 md → BLOCK）／ Q5 记忆图谱已灌 ／
Q6 三个机器门结果被记录 ／ **Q7 产物真的落地**（录音录像要验 `ffmpeg.log` 的 `frame=`
等于 PNG 张数，**回执 success ≠ 东西存在**）／ **Q8 时间锁已更新**（没有新锁也没写
「无新的智能性错误」→ BLOCK）／ Q9 编号登记三处 ／ Q10 游戏已关 ／ Q11 提交精确没卷别人（人工）

## ★ 时间锁（`registry.json` → `timeLocks`）

**「有些时候文档会有智慧性」= 智能性错误**：一个错的东西在某次运行里恰好对了，
于是没人发现，然后规则慢慢烂掉，半年后集体崩。

**policy（写在 registry 里）：**
1. 每个智能性错误必须留一条**带 `guard` 的锁**。没有 guard 的锁等于没有锁，只是抱怨。
2. `reviewBy` 到期必须复核，状态从 `open` 走成 `verified` 或 `refuted`。
3. guard 必须是**可执行的检查**，不是一句提醒。

| 锁 | 类型 | guard | reviewBy |
|---|---|---|---|
| TL-2026-10-03-01 `cam.json target:"RDD"` 静默失效 | 静默失效 | 相机 status 打印 `（渲染范围内）`／不在就明确说匹配不到 | 2026-11-03 |
| TL-2026-10-03-02 `watch-ai.js --from-rdd` 假成功 | 假成功 | 跑一次不带 `--from-rdd`，exit≠0 就报警 | 2026-11-03 |
| TL-2026-10-03-03 openclaw `keyDown` 只认 7 键 | 静默失效 | 发一个 `escape`/`t`，看收据里有没有真发生 | 2026-11-03 |
| TL-2026-10-04-01 ffmpeg `%05d` 遇缺口就停 | 隐蔽 | 验录像看 `ffmpeg.log` 的 `frame=` == PNG 张数 | 2026-11-04 |
| TL-2026-10-04-02 `Map.of` 键序随机化 | 隐蔽 | 任何解析上游 JSON 的脚本都要按 key 取，不按位置 | 2026-11-04 |
| TL-2026-10-04-03 两份 AGENTS.md 漂移丢 182 行 | 规则丢失 | `check-global.js` 必须 exit 0 | 2026-11-04 |

## 编号统一

- 真源目录 `D:\rdd\docs\rdd-docs\rdd架构\自编译统一版\`
- 现状：**最大号 69 → 下一个 70**。缺号 29/49（不必补）。
- **新文档接最大号往后排，并同时登记 3 处**：① `README.md` §二目录表
  ② `09-更新日志.md` ③ `50-按主题导航.md`
- 旧撞号 44/45/48/52/53/54 已登记 → **WARN**（旧债不钉死门禁）
- 65/66 未登记台账 → WARN + 提示补登记
- ⚠️ `55自主寻找bug和修改的特殊执行.md` **缺连字符**，逃过 `^(\d{2})-` 正则 → 建议改名 `55-…`

## 规范契约（两份，同一 id 对账）

- **真源**：`D:\rdd\harness\rdd-harness\standards.md`（带 id）
- **镜像**：`D:\rdd\docs\rdd-docs\rdd架构\自编译统一版\01-工程规范.md`（人读长文）
- **改一处必须同步另一边**；postflight 的对账项按 id 比对。
- **为什么两份**：门禁只能引用稳定 id，而写给人读的规范不该被 id 淹没。

## 已知真债（门禁会一直 BLOCK，不是 bug）

- `numen-plugin-experience` jar 落后源码 4 小时、`numen-plugin-learner` 落后 9 小时
  → P2 BLOCK。修法：`run-mutation.ps1 -Module plugins:learner|plugins:experience`。
- `06-检查清单.md` 只有 95 字节，却被 `stages.json` + 两份 AGENTS.md + loop-gate 6 处当权威用。
- `check-global.js` 现在必然 FAIL（全局 AGENTS.md 缺 7 条 H2，见 TL-2026-10-04-03）。

## 想改流程？

`stager\core\stages.json` 是数据驱动的（阶段 / 门禁 / 必读 / 文档类型全在里面），
**改那个文件就改了流程，不用动 `stager.js`**。改完跑 `node stager\bin\stager.js self-check`。