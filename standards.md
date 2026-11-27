# 编程规范

> 本文维护现行工程约束；旧自编译统一版的工程规范只作历史参考，不再要求双向手工同步。
> 写代码按需读[写码指针](<D:/rdd/docs/rdd-docs/知识库/架构意图/039-写代码规范指针.md>)。现行门禁仅为安装/包件与本次记录质量；写码和提交无需另跑流程。


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

### S-BUILD-01 复用当前构建与部署入口
本地位置、脚本参数和回执见[工作区规范](<D:/rdd/workspace/_格式规范.md#构建测试与部署>)。按当前模式做构建、隔离测试或安装，不因纯离线测试启动游戏。实际权限以宿主和工具返回为准，旧opencode配置不能决定DSH权限。

### S-BUILD-02 改执行层必须显式指定模块
改 `core/common` 的类必须 `-Module core:neoforge`，默认模块盖不到。
模块取值：`plugins:rdd` / `plugins:learner` / `plugins:acx` / `plugins:experience` / `plugins:camera` / `core:neoforge` / `api:neoforge`。

### S-BUILD-03 一个 mutation 只放一个 jar
`deploy.ps1` 取 `$dir\jar` 下**第一个** jar 部署。多模块必须开多个 mutation。

### S-BUILD-04 不信 DEPLOY_OK 一句话
`BUILD SUCCESSFUL` 和 `DEPLOY_OK` 都只是回执。判据是**实物**：
用 ZipFile 列 jar entries，确认这轮要的 class / 资源真的在里面（见 S-BUILD-05）。

### S-BUILD-05 安装、加载与效果分别核对
构建成功不证明目标实例已安装；安装哈希不证明已重启加载；效果看运行原证。核验见[两项检查](<D:/rdd/docs/rdd-docs/知识库/架构意图/006-Harness模块.md#安全边界与四线>)。

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

### S-CODE-06 每轮/每请求都读的缓存必须懒建，或显式报「没准备好」
`get(uuid)` 返回 null **不代表「没有数据」**，很多时候是「还没人初始化」——在每轮读路径上，
它会静默地永远为 null，功能看起来像「过滤器没生效」，实际是「压根没喂到」。
> 活案例（2026-10-21 G5e）：executor 知识每轮用 `MEMORIES.get(uuid)` 取惰性创建的 `ExperienceMemory`，
> 而该缓存由工具/规划先调 `memory(uuid)` 才建 ⇒ 首次部署后 **0 条**快照；改成 `memory(uuid)` 懒建后 **32 轮 = 32 条**。
判据：同一窗口的**事件数应 ≈ 轮数**；不等就先查初始化时机（谁该建、什么时候建），别先怀疑过滤器。

### S-CODE-07 修 bug 前先查修复台账，补丁不许叠
改一处之前先搜 `知识库\Bug修复\`：这处修过吗、复现几次、回归判据是什么。
复发先查原补丁与当前消费者，定位断点后决定修正或回退，不无条件撤销有效修改。
每修一个必须落一条：**修复时间 / 复现次数 / 怎么修改的 / 回归判据** —— 没回归判据的补丁不许合。
> 为什么（2026-11-04 主人定）：169 的 food 线同一处连补 3 个 commit，第四次必然叠层；
> 台账就是防止"以为修好了，其实盖住了"。入口：`知识库\Bug修复\README.md`。

---

## S-GIT · 版本控制

### S-GIT-01 ★ 精确 add，禁用 `git add -A`
本工作区**常有两个会话并行改同一个仓库**。`-A` 会把对方未完成的改动一起提交。

```powershell
git add <路径1> <路径2> …
git diff --cached     # 核对实际暂存差异归属，不混入他人的修改
```

### S-GIT-02 `rdd-docs` 尤其危险
副本同步一次就动 147 个文件。2026-10-01 实测已出过一次事故：
`git add -A` 把整个同步批次卷进一个提交信息写着「三件待办全部不做」的 commit，
**已推送、不能 amend**，只能另写补记。

### S-GIT-03 提交信息走文件
```powershell
git commit -F msg.txt
```
复杂或多行消息用UTF-8文件和-F避免转义错误；简单消息按当前Shell正确引用即可。

### S-GIT-04 改了路径必须全仓 grep
散落的硬编码路径收进配置后，改完要全仓搜，不要凭印象只搜一个目录。
> 2026-10-01 知识库搬家，13 处散落硬编码全失配；第一次只搜了 `stager/` 就以为改完了，
> 漏了 `rdd-selfcompile\scripts` 的 5 处（其中 loop-gate 是硬门禁）。

### S-GIT-05 子仓单独核对
在实际修改所在仓查状态和暂存差异；外层Git不会列出被忽略的子仓修改。不固定仓数，也不要求每次访问都扫描全部项目。

### S-GIT-06 入口与正文分工
主人维护总入口宪法；项目入口只放目的和指针。工程经验回已有主题，不复制进多份入口。

---

## S-SHELL · shell / 脚本 / 编码

### S-SHELL-01 长任务用作业
长任务用宿主后台作业，结束收取结果。短查询正常执行；手动启动后台辅助服务使用隐藏窗口。

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
复杂引号或大段参数用临时脚本/参数文件，简单命令按当前Shell正确转义即可。
> PS `:` 插值坑：`":$mod:jar"` 整串变成 `:`，gradle 报找不到 task。用 `":$($mod):jar"`。

### S-SHELL-05 只读 vs 会改盘，调用前必须知道
- **按实际副作用判断**：查询工具也可能写审计；eval脚本可执行任意动作，不按文件名前缀认定只读。
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

### S-TEST-02 验实际契约
用本次真实执行结果区分改前改后、覆盖相关失败条件，不以文件名含stress/contract或旧XML证明覆盖。

### S-TEST-03 ★ 单测绿 ≠ 部署到位
2026-10-01 实测 RL-19 落后 **56 小时**：源码对了、测试绿了、文档写「已改」，游戏里跑的还是旧版。
单测和运行时之间隔着 S-BUILD-05 那三步。

### S-TEST-04 写「怎么修」之前先实测
照着症状猜出来的修法可能是错的。
> 2026-10-01 我把「单测加载不了」诊断成「缺一行 `testImplementation`」——
> 并行会话实测发现真正缺的是整个 Minecraft 测试运行期。**症状 ≠ 病因。**

---

## S-DOC · 文档与编号

### S-DOC-01 文档落点
先查同主题现行正文；记录进入知识库相应主题，已有记录原位补充。格式、元数据与索引只见[写作规则](<D:/rdd/docs/rdd-docs/知识库/写作规则.md>)。不写stager过程文档，不回旧统一版另建平行正文。

### S-DOC-02 编号与登记
沿知识库所在目录编号，不再要求旧README/09/50三处登记。

### S-DOC-03 避免重复
已有同一事实就更新原件；缺原证标未知，不为门禁增加文件。

### S-DOC-04 文档里的行号会漂
想知道准不准，跑：
```powershell
node rdd-selfcompile\scripts\verify-tools\check-doc-anchor-drift.js --docs "<docs>" --src "<src>"
```

### S-DOC-05 规范条目必须有稳定 id
已有ID保持可追溯；普通经验无需为了进入门禁另造编号。

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

## S-MC · 游戏操作

派目标、游戏命令、相机与实例启停统一见[游戏核心工具](<D:/rdd/docs/rdd-docs/知识库/进游戏验证/001-进游戏核心工具.md>)。旧SendKeys配方、单一mc-start入口和OpenClaw必需说法不再作现行指令。

## S-GATE · 部署与记录质量

只保留进场安装/包件核验与退场本次记录质量，具体调用及边界见[Harness正文](<D:/rdd/docs/rdd-docs/知识库/架构意图/006-Harness模块.md#安全边界与四线>)。原S-GATE-01至05流程条款被该决定取代；旧ID只用于历史检索。成功回执仍不等于世界行为有效，结论需原证。

### S-OBS-01 世界事实共源

所有权、身份、覆盖与时效只见[WorldState正文](<D:/rdd/docs/rdd-docs/知识库/架构意图/008-WorldState模块.md>)。先查现有provider；未支持的路径明确登记临时旁路。未知不填0、不拿历史快照冒当前事实，不把统一设计写成全部接通。
