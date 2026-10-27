# 自动 Harness 部署包（2026-10-27）

> 用途：把「AI 自主运行、自主验证，人只定总目标、最后进游戏看结果」的闭环搬到一台新机器。
> 基础运载模型：**GLM-5.3**（自主运行 + 自主验证；人只在最后进游戏核看）。
> 性质：部署包清单 + 坑摘要。**完整安装顺序与坑目录以 74 号文档为准**（本包已附全文）。

## 1 · 包里有什么

| 路径（包内） | 是什么 |
|---|---|
| `rdd-harness/` | harness 本体：bin（含 exp-runner/exp-cycle/exp-card/exp-judge/mf-observer）、registry.json（87 工具+35 门禁+9 根路径）、standards.md、experiments/cards（冻结卡+裁决）、app（8891 面板） |
| `rdd-harness/package/74-新机安装与迁移指南-20261019.md` | ★ 完整安装顺序（0–8 阶段）+ 坑目录 A–E + 验收清单 + 换机绑定项清单 |
| `docs/运维/总览.md` | 起停/端口/备份/救火 |
| `docs/存放-交接与一页纸/` | harness 交接卡、部署交付摘要、一页纸 |
| `tools/` | mineflayer 座位说明（mf-observer 用）与自研工具清单（见 74 号 §12） |

## 2 · 不在包里、新机要自己弄的（★ 用户已知：存档与部署都要重做）

| 项 | 为什么不在 | 新机怎么做 |
|---|---|---|
| **Minecraft 存档（saves/live）** | 世界不在任何 git/包里 | `node D:\rdd\tools\make-world.mjs --flat` 用原版服务端生成再拷进 saves/；难度 peaceful 要生成时写进 level.dat（74 号坑 7-2） |
| **mods 的 11 个 jar** | 构建产物不入包 | 按 74 号 §6 编译（先网络/代理，再 gradlew 两段） |
| **MC 本体 + NeoForge + assets** | 0.87GB，走官方/镜像拉 | `fetch-minecraft.mjs` + NeoForge 安装器（要代理，74 号 §4） |
| **runs/（7.8GB 历史证据）** | 太大；裁决已冻结进 cards | 不带；新机从空 runs 开始 |
| **JDK/Gradle/Node/ffmpeg** | 本机目录（74 号 §10） | 按镜像装，junction 指过去 |
| **GLM-5.3 的 API 配置** | 密钥不入包 | 新机在模型配置处填；provider 基座指向 glm-5.3 |

## 3 · GLM-5.3 自主闭环怎么跑（部署后的用法）

```powershell
# ① 起底座（顺序硬约束：8080 先于游戏）
powershell -ExecutionPolicy Bypass -File D:\rdd\start-rdd.ps1

# ② 冒烟自证（不碰游戏）
node D:\rdd\harness\rdd-harness\bin\harness-gate.js selftest     # FAIL=0 才继续
node D:\rdd\harness\rdd-harness\bin\exp-card.js selftest          # 12/12
node D:\rdd\harness\rdd-harness\bin\exp-judge.js --selftest       # 5/5

# ③ 自主轮回（GLM-5.3 写目标 → 运行器执行 → 机械裁判出裁决，全程无人盯）
#    卡先冻结，判据不改；AI 不认口头结论，只认 monitor 派生数据
node D:\rdd\harness\rdd-harness\bin\exp-cycle.js run --prefix learn --rounds 4 --minutes 25 --zero-start --goal-file experiments\journal\learn-pilot.goal.txt

# ④ 人来看（主人只做最后一步：进游戏核看 + 说一句「我看出来了/没看出来」）
node D:\rdd\harness\rdd-harness\bin\exp-card.js conclude experiments\cards\<卡>.json
```

## 4 · 坑速查（完整版见 74 号 §9；★=会浪费一小时的）

- ★ `gradle.properties` 写死 `org.gradle.java.home` → 换机第一杀手，删掉它
- ★ `maven.neoforged.net` 不可达 → 国内镜像全 404，必须代理（Java 装安装器还要单独 `-Dhttp(s).proxy*`）
- ★ 中文 `.ps1` 无 BOM + 代码页 936 → 乱码甚至吞换行；`.bat` 只写 ASCII
- ★ `registry.json` PS 5.1 读会抛（重复键）→ 一律用 Node 读
- ★ `pauseOnLostFocus:true` 默认 → 窗口一失焦全世界暂停，同伴一动不动（options.txt 关掉）
- ★ 出生点在坑里 → 路径规划器不会把自己挖出来；验证用超平坦
- ★ 难度写在 level.dat，改 server.properties 没用；无人值守用 peaceful 且生成时写入
- `mods/` 放非 mod jar → 卡在警告页，quickPlay 进不去（判据 META-INF/neoforge.mods.toml）
- `latest.log` 是 GBK，中文 grep 假阴性 → 看监测台 monitor/*.jsonl（干净 UTF-8）
- OpenClaw 8080 必须先于游戏（mod 只连一次）
- 启动器五条硬规则（classifier/rules/ignoreList/别追加原版 jar/只解 x64 natives）→ 74 号 §7.2
- 回执不等于生效：验坐标/产物/game_time，别信 success:true

## 5 · 版本基线（2026-10-27）

- harness 仓 HEAD（打包时）：见 `GIT-HEAD.txt`
- mineflayer 4.39.0（npm 标准版，无 fork）；Node 22.23.3；JDK 21.0.11+10；MC 1.21.1 + NeoForge 21.1.233
- 实验层已实机验证：two-green SUPPORTS（两轮 S1–S4 全 PASS）、learn-pilot SUPPORTS（r2 达 S5 钻石套）
