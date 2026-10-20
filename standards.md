# 编程规范 · 唯一真源（机器可读）

> **这份是唯一真源。** 人读的完整版在 `D:\rdd\docs\rdd-docs\rdd架构\自编译统一版\01-工程规范.md`，
> 它是本文件的**镜像**，每条对应小节的标题里带本文的 `id`。
> ★ **改规范只改一处**：改本文 → 把同 id 小节的标题同步进镜像；或改镜像 → 同步回本文。
> ⚠️ **两侧对账目前是人工的，门禁还没机检**（2026-10-21 核实：`harness-gate.js` 里没有
> `Q-CODE-SPEC` 这个检查；而且镜像 `01-工程规范.md` 里**一个 `S-*` id 都没有** ——
> 本文 45 个、镜像 0 个，所以「标题里带同 id」这件事从来没有真的成立过。见 `杂项记录 #094`）。
> 要给机检留路：**镜像里每条规则的标题补上同 id**，届时再加 `Q-CODE-SPEC` 做双向对账；
> 在那之前，改规范仍然必须**人手把两处都改**。

**为什么要两份**：镜像那份是给人读的、篇幅大、有踩坑实录；本文是给机器读的、每条一个稳定 id、
能被门禁逐条引用。没有 id 的规范条目无法进门禁 —— 门禁只能引用有 id 的东西。

**编号规则**：`S-<域>-<序号>`。域 = 域缩写。**id 一旦分配永不重排、永不复用** ——
门禁和历史文档会引用它，改号等于让引用全失效。

| 域 | 含义 |
|---|---|
| `S-BUILD` | 编译 / 构建 / 部署 |
| `S-CODE` | 写代码本身 |
| `S-GIT` | 版本控制 |
| `S-SHELL` | shell / 脚本 / 编码 |
| `S-TEST` | 测试 |
| `S-DOC` | 文档与编号 |
| `S-JSON` | 数据格式解析 |
| `S-MC` | 进游戏 / 运行时 |
| `S-GATE` | 门禁与收口 |

---

## S-BUILD · 编译链

### S-BUILD-01 编译只有一条通道
改代码 → 编译 → 部署，只能走 `run-mutation.ps1 -Requirement "<需求>" -Module <模块>`。
**禁止手写 gradle、禁止手动拷 jar** —— opencode.json 的 permission 已 deny，绕不过去。
全仓唯一的 gradle 调用点是 `build-jar.ps1:36`；gradle task 必须写 `":$($effectiveModule):jar"`
（`:` 和 `-` 会被 PowerShell 当变量名/scope 吃掉）。

### S-BUILD-02 改执行层必须显式指定模块
改 `core/common` 的类必须 `-Module core:neoforge`，默认模块盖不到。
模块取值：`plugins:rdd` / `plugins:learner` / `plugins:acx` / `plugins:experience` / `plugins:camera` / `core:neoforge` / `api:neoforge`。

### S-BUILD-03 一个 mutation 只放一个 jar
`deploy.ps1` 取 `$dir\jar` 下**第一个** jar 部署。多模块必须开多个 mutation。

### S-BUILD-04 不信 DEPLOY_OK 一句话
`BUILD SUCCESSFUL` 和 `DEPLOY_OK` 都只是回执。判据是**实物**：
用 ZipFile 列 jar entries，确认这轮要的 class / 资源真的在里面（见 S-BUILD-05）。

### S-BUILD-05 编译成功 ≠ 运行时生效
源码改了但 jar 没重新部署，游戏里跑的还是旧版 —— 中间隔着 **编译 → 部署 → 重启** 三步。
判据有工具，别靠记性：

```powershell
node rdd-selfcompile\scripts\verify-tools\check-runtime-deployment.js   # 退出码 2 = 有源码领先于 jar
```

> 它比的是「**最后一次改 `src/main/java` 的提交**」vs jar 的 `LastWriteTime`，
> **不是**「最后一次提交」—— 只改 `*Test.java` 时 jar 本来就不用重部署。
> 这个区分不做会满屏假警报。

### S-BUILD-06 搬走 mixin 必须同时重建宿主 jar
把一个 mixin 类从 A 模块搬到 B 模块，要同时做四件事：
① B 里加 `@Mixin` + 新的 mixins.json + `[[mixins]] config=` 声明
② A 里删掉源文件 ③ A 的 mixins.json 摘掉那个类名 ④ **重建并重新部署 A 的 jar**。
漏 ④ 会导致两个 jar 各有一份 mixin 同时注入同一个 target → 冲突。
> 活案例：numencam 搬走 `MixinCamera` 后必须重建 `api:neoforge`。

---

## S-CODE · 写代码

### S-CODE-01 抄原版算法要抄全
搬 vanilla 的方法时，**partial-tick 插值**和**朝向公式的符号**是最容易丢、丢了最难查的两处。
> 活案例：`MixinCamera` 抄 `Camera.setup/move/getMaxZoom` 时，丢了 `Mth.lerp(pt, xo, x)`
> 镜头就变成 20fps 阶梯式跳动；`atan2(-dx, dz)` 少了负号整整差 180°。

### S-CODE-02 加枚举值必须同步补所有 switch 穷举
`FailureClassifier` 那种 `switch` 穷举，加枚举值不同步补 case **编译就不过**。
但编译不过是事后才发现，代价太大 —— 改之前先 grep 谁在 switch 它。

### S-CODE-03 客户端能力要用客户端原生的权威通道
客户端不能直接改权威状态（`LocalPlayer` 没有 `teleportTo`/`setPos`，改了会被服务端反传送拉回）。
传送走 `player.connection.sendCommand(...)`；发包类操作走对应的 `onUpdateAbilities()` 之类的方法。
★ 涉及原版客户端类时先查反编译源码 jar（`api/common/build/moddev/artifacts/vanilla-*.jar`），
**不要凭记忆** —— 记忆里没有 `ClientPacketListener.sendCommand` 这种细节。

### S-CODE-04 逻辑必须放在会被真正调用的地方
写在文件里 ≠ 被调用。新增的类要有活着的调用点；
`grep` 一次就能确认。生产代码里 0 处引用的东西**要么接线，要么加停用注释说明它关着** ——
不许让它看起来像在跑。

### S-CODE-05 一个类一个职责，文件别超 500 行
超过就该拆。判据是「能不能一句话说清这文件干嘛」。

---

## S-GIT · 版本控制

### S-GIT-01 ★ 精确 add，禁用 `git add -A`
本工作区**常有两个会话并行改同一个仓库**。`-A` 会把对方未完成的改动一起提交。

```powershell
git add <路径1> <路径2> …
git status --short    # 逐行确认，每一行都是你改的
```

### S-GIT-02 `rdd-docs` 尤其危险
副本同步一次就动 147 个文件。2026-10-01 实测已出过一次事故：
`git add -A` 把整个同步批次卷进一个提交信息写着「三件待办全部不做」的 commit，
**已推送、不能 amend**，只能另写补记。

### S-GIT-03 提交信息走文件
```powershell
git commit -F msg.txt
```
含空格/中文的 message 内联传给 shell 会被拆坏。写文件用 UTF-8，`-F` 不会转码。

### S-GIT-04 改了路径必须全仓 grep
散落的硬编码路径收进配置后，改完要全仓搜，不要凭印象只搜一个目录。
> 2026-10-01 知识库搬家，13 处散落硬编码全失配；第一次只搜了 `stager/` 就以为改完了，
> 漏了 `rdd-selfcompile\scripts` 的 5 处（其中 loop-gate 是硬门禁）。

### S-GIT-05 跨仓库对账看 repo-status
本工作区有 6 个 git 仓库。外层 `.gitignore` 排掉了内层 →
**外层 git 完全看不见内层改动**，stager / loop-gate 的「本轮有 commit」判据对 `minecraft-numen` 是盲的。

```powershell
node stager\bin\repo-status.js
```

### S-GIT-06 不要改 AGENTS.md 里收集到的坑
AGENTS.md 只放**指针和流程**，坑和经验落在规范文档 / 阶段索引 / 记忆图谱里。

---

## S-SHELL · shell / 脚本 / 编码

### S-SHELL-01 所有 shell 后台跑
不前台阻塞等待。长驻进程走脱离启动 + 轮询。**加长 timeout 不是解法。**
诊断要复现时：wrapper `.ps1` 写日志 → `Start-Process powershell.exe -NoProfile -ExecutionPolicy Bypass -File <wrapper> -WindowStyle Minimized` → `Start-Sleep` → 读日志。

### S-SHELL-02 ★ 工具报错 ≠ 命令没执行
`Start-Process` 在某些 shell 里会报 `ChildProcess.kill` / `NativeCommandError`，
**但命令其实已经跑了**。判据永远是**自己查进程/查产物**：
```powershell
@(Get-Process java -ErrorAction SilentlyContinue).Count
Test-Path '<预期产物>'
```

### S-SHELL-03 `.ps1` 含中文必须 UTF-8 **BOM**
PS 5.1 按 ANSI 读无 BOM 的 UTF-8，中文乱码 + 一串语法错。
控制台输出中文是 GBK 乱码 **不代表文件坏了** —— 读文件用 read 工具。

### S-SHELL-04 `node -e` 内联会被引号拆坏
一律写 `.js`/`.ps1` 文件再跑。大段参数走 `@file`。
> PS `:` 插值坑：`":$mod:jar"` 整串变成 `:`，gradle 报找不到 task。用 `":$($mod):jar"`。

### S-SHELL-05 只读 vs 会改盘，调用前必须知道
- **纯只读**：所有 `verify-tools\*`、三个 gate、`repo-status.js`、所有 `eval-*`
- **会改游戏状态**：`drop-all.js`、`mc-focus.ps1`（发按键）
- **会改 mods**：`deploy.ps1`、`selfcompile-store.js rollback --deploy`、`rollback-module.ps1`
- **默认 dry-run**：`cleanup-logs.ps1`（要 `-Apply`）、`presence-watchdog.ps1`（`-DryRun`）
- **有防误杀硬守卫**：`kill-by-cmdline.ps1`（空关键字或命中 >30 直接拒执行）

### S-SHELL-06 批量脚本用 UTF-8 写、UTF-8 读
读别人的日志（游戏日志是 GBK）用 node 脚本按对应编码读，不要在 PS 里 `Get-Content -Encoding UTF8` 硬读。

---

## S-TEST · 测试

### S-TEST-01 改了执行层必须有测试
判据不是「跑得起来」，是 `failures=0 errors=0`。

### S-TEST-02 契约/压力回归要存在且真跑过
文件名含 `stress` / `contract` / `契约` / `压力`，且 `test-results` 里有对应的 `TEST-*.xml`。

### S-TEST-03 ★ 单测绿 ≠ 部署到位
2026-10-01 实测 RL-19 落后 **56 小时**：源码对了、测试绿了、文档写「已改」，游戏里跑的还是旧版。
单测和运行时之间隔着 S-BUILD-05 那三步。

### S-TEST-04 写「怎么修」之前先实测
照着症状猜出来的修法可能是错的。
> 2026-10-01 我把「单测加载不了」诊断成「缺一行 `testImplementation`」——
> 并行会话实测发现真正缺的是整个 Minecraft 测试运行期。**症状 ≠ 病因。**

---

## S-DOC · 文档与编号

### S-DOC-01 三条铁律：东西写哪
1. **长期资产**（新规范/新清单/新运维手册）→ `docsUnified\NN-中文名.md`
2. **本轮过程文档** → `stager put --kind <kind>`，落进 `stager\.stager\tasks\<任务>\docs\`
3. **状态报告** → 本轮自己的 `docs\` 目录，不进 `docsUnified`、不进任何 `read[]`

★ **harness 目录只放工具注册表 / 门禁 / 规则 / skill，不放任何总结、复盘、报告。**

判据一句话：**下一个人接手时，第一眼该看哪份？** 长期资产进统一版，一次性产物进 stager。

### S-DOC-02 文档编号：接最大号往后排，并登记三处
新建 `NN-中文名.md` 必须同时登记：
① `README.md` §二目录表 ② `09-更新日志.md` ③ `50-按主题导航.md`。
细则见 `08-登记规约.md`。

> ★ **编号正则的盲区**：`^\d{2}-` 匹配不上**有数字但缺连字符**的文件名
> （活案例：`55自主寻找bug和修改的特殊执行.md` 完全逃过检查）。
> 新建文件**必须带连字符**。

### S-DOC-03 已知旧撞号降级 WARN，新撞号 BLOCK
否则一次旧债会把门禁永久钉死 —— **门禁一旦被长期忽略就等于没有**。

### S-DOC-04 文档里的行号会漂
想知道准不准，跑：
```powershell
node rdd-selfcompile\scripts\verify-tools\check-doc-anchor-drift.js --docs "<docs>" --src "<src>"
```

### S-DOC-05 规范条目必须有稳定 id
见本文件开头。没有 id 的条目无法进门禁。

---

## S-JSON · 数据格式

### S-JSON-01 ★ 解析上游 JSON 不能猜键序
`java.util.Map.of(...)` 的迭代顺序是 **JVM 次序随机化（SALT）** ——
同一条命令这次回 `x,y,z`、下次回 `z,y,x`。LLM 生成的 JSON 同样不稳定。
**先切出字段段，再按 key 名取。**

### S-JSON-02 别把脚本的失败模式设计成「静默」
一个判据如果只在「成功解析」时才给结论，解析失败就是「无结论」而不是「结论：失败」——
调用方会把两者混为一谈。解析失败必须显式分支。

---

## S-MC · 进游戏 / 运行时

### S-MC-01 起游戏的唯一入口
```powershell
node rdd-selfcompile\scripts\mc-start.js gpt 120
```
`--stop` 是**哑弹**（见 registry.bugs bug-1）。真要关用 `mc.stop`。

### S-MC-02 OpenClaw 8080 必须先于游戏起
否则 mod 连不上。仓库虽打了 `archived-2026-10-01` tag，但 `mc-watch.js` 还依赖它，**不能删**。

### S-MC-03 MCP：companion 是独立位置参数
```powershell
node rdd-selfcompile\scripts\mcp-call.js get_self_status DDD
```
塞进 JSON（`{"companion":"DDD"}`）会报 `needs a 'companion' argument`。
★ 只有 `numen-mcp.js status <name>` 直接返回 JSON；`call` 返回人类可读文本。

### S-MC-04 看画面优先用 PrintWindow 那条
`mc-screenshot.ps1` 走 `CopyFromScreen`，**会把遮挡窗口拍进来**。
要干净画面用 `capture-win.ps1 -TitleMatch Minecraft`。窗口标题会变，只能按前缀匹配。

### S-MC-05 视角陷阱：玩家和同伴常常离得很远
截图前先确认两者距离（`get_self_status`），50 格外就是拍了个空地。

### S-MC-06 在游戏里敲指令走「焦点 + 剪贴板 + 真实按键」
openclaw 驱不动聊天框（`InputHandler` 只认 7 个键）。
配方：`Focus-MinecraftWindow` → `Set-Clipboard` → `SendKeys('t')` `^a` `^v` `{ENTER}`。

---

## S-GATE · 门禁与收口

### S-GATE-01 两段门禁：进游戏前 / 出游戏后
```powershell
node D:\rdd\harness\rdd-harness\bin\harness-gate.js preflight  --since <YYYY-MM-DD>
node D:\rdd\harness\rdd-harness\bin\harness-gate.js postflight --since <YYYY-MM-DD>
```
- **preflight** = 编译通道 / 部署到位 / 无重复 mixin / 测试 / 规范已补 / 编号不撞 / 时间锁
- **postflight** = 有标记 / evidence / 总结 / ★ 总结位置对 / 记忆图谱 / 三个机器门 / 产物真落地 / 时间锁已更新

### S-GATE-02 ★ 回执 success 不等于东西存在
mp4 存在但只编出 1 帧；jar 部署回执 OK 但 class 不在里面；`keyDown` 回执 success 但什么也没发生。
**验收必须查产物的内容，不是查回执。**

### S-GATE-03 三个机器门
```powershell
node rdd-selfcompile\scripts\loop-gate.js --since <今天> --keyword <模块> --head <HEAD>
node rdd-selfcompile\scripts\flow-gate.js --since <今天> --active <开工时的 store active>
node stager\bin\stager.js check
```
`flow-gate` 输出 `VERDICT=NOT_DONE` → **不许收工、不许上报完成**。
★ 但**没走 stage 时这两个 gate 的 NOT_DONE 是预期内的** —— 要在 evidence 里显式说明，
不能拿它判定任务没做完。

### S-GATE-04 时间锁到期必须复核
`registry.timeLocks` 里 `status=open` 且 `reviewBy < 今天` → preflight P9 直接 BLOCK。
复核动作：验证 guard 仍有效；失效就重写 guard 并写新 reviewBy；问题彻底消失才允许 `status=done`。

### S-GATE-05 智能性错误必须留一条时间锁
**「智能性错误」= 看起来做了 / 回执成功 / 静默通过，但实际没生效。**
每条锁必须有 `guard`（现在靠什么防线挡住）—— 没有 guard 的锁不是锁，只是抱怨。