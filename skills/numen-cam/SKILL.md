---
name: numen-cam
description: |-
  游戏内 /cam 客户端相机模块（modId=numencam）：附身（观察者模式 + 视角绑定）、切机位、
  绑定同伴、走出加载区自动传送、自动疾跑/飞行/加速、录视频出 mp4。当需要在游戏里操控镜头
  视角、跟拍 AI 同伴、把玩家传送到同伴旁边、或录下游戏画面时使用。
  Use when user wants 换机位 / 跟拍 / 附身 / 观察者 / 绑定同伴 / 传送到同伴 / 相机视角 /
  录视频 / 录像 / 追踪 AI / 看同伴在干什么 / numencam / /cam.
  Voice triggers: "换机位", "跟拍", "附身", "观察者模式", "绑定同伴", "传送到他那里",
  "相机视角", "录视频", "录像", "追踪", "numencam", "/cam", "镜头".
Metadata:
  role: "skills 级能力（客户端相机模块，plugins/camera）"
  mod_id: numencam
  command_root: "/cam"
  config: "D:\\rdd\\docs\\rdd-docs\\rdd架构\\..\\live 实例 config\\numen_api\\cam.json"
  send_command_helper: "D:\\rdd\\harness\\rdd-harness\\bin\\send-mc-command.ps1 -Text '/cam ...'"
---

# numencam（/cam）

客户端专属模块，jar `numen-plugin-camera-1.21.1-0.1.3-dev.jar`，装载后原版聊天框里直接敲 `/cam`。

## ★★ 要「跟着同伴看」就用附身，不要一直 `/cam tp`

### 首选：改文件（**不需要键盘，20 tick 内生效**）

```jsonc
// D:\rdd\mc\The Best of Twilight Forest\config\numen_api\cam.json
{ "mode": "ORBIT", "target": "DDD", "possess": "DDD", ... }
//                                  ↑ 填同伴真名 = 附身；改回 "" = 退出
```

改完 1 秒内生效：日志出现 `[numencam] cam.json possess=DDD -> …`，聊天栏也有回执。
**为什么有这条路**：本机键盘注入完全失效（`SendKeys` / `keybd_event` / 扫描码 `SendInput` 三种都不行，
`GetForegroundWindow` 明明是 MC）—— 见时间锁 `TL-2026-10-19-02`。文件扳机就是为它存在的。

### 备选：游戏内敲指令（要人在键盘前）

```powershell
... send-mc-command.ps1 -Text "/cam possess DDD"   # 一条：切观察者 + 视角焊在它身上
... send-mc-command.ps1 -Text "/cam status"        # 「附身」那行确认已生效
... send-mc-command.ps1 -Text "/cam release"       # 退出，视角收回自己、游戏模式复原
```

**为什么不再用 `/cam tp` 刷屏**：`tp` 是「我也过去」，视角仍在自己身上，同伴一转身就跟丢，
而且每跑远一次就一条 `/tp` 回执。`possess` 走的是原版旁观者那套 —— 玩家切 `SPECTATOR` +
`ServerPlayer.setCamera(同伴)`，服务端 tick 里 `absMoveTo(camera)` **每 tick 自动跟随**，
所以视角是物理绑定的，**之后一条指令都不用再发**。

> **2026-10-19 实测（V-20261019-01）**：同伴走到 **186 格**外，`get_owner_status` 显示玩家本体
> `distance_to_me: 0`、坐标与同伴**逐位相同**，同一时段日志里 `/tp` 命中 **0** 条；
> 退出后 HUD 与 survival 都恢复。⇒ 判「身体有没有跟过去」**要用 `get_owner_status`**，
> `scan_nearby_entities` 不列玩家本体（会得到假阴性）。

- **单人存档不需要作弊/OP**：直接走 `Minecraft.getSingleplayerServer()` 调同一对 API，
  绕开命令权限但不绕开游戏规则（仍然是原版 SPECTATOR 档、仍然服务端权威）。
- **联机服**退回 `/gamemode spectator` + `/spectate <名字>`，需要 OP 等级 2；权限不足会明确报错。
- **附身期间**机位算法（`CameraRig`）与牵引（`CompanionTether`）自动让位，不会两条路抢位置。
- **崩溃保护**：原游戏模式记在 `config/numen_api/possess.json`，下次进世界发现自己在旁观者档
  会自动恢复并说明原因。

## ★ 怎么把指令送进游戏（这是最容易卡住的一步）

> ⚠️ **2026-10-19 实测：本机这条路已经不通了。** `SendKeys` / `keybd_event` / 扫描码 `SendInput`
> 三种注入全部无效（`GetForegroundWindow` 确实是 MC 窗口）。`send-mc-command.ps1` 仍会打印
> `SENT`，**但那是假回执**。要在游戏内敲指令：**要么人手动敲，要么改用文件扳机**
> （见上面附身那节 / `cam.json`）。时间锁 `TL-2026-10-19-02`。

**不要用 OpenClaw 发指令** —— 它的 `keyDown` 只认 7 个键（wasd/space/shift/ctrl），
`--chat` 那条 t→ctrl+a→delete→typeText 的路**设计上就不可能通**。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "D:\rdd\harness\rdd-harness\bin\send-mc-command.ps1" -Text "/cam status"
```

历史上（换机前）返回 `FOCUS_OK …` + `SENT [/cam status] to '…'` 是送达；**现在不要信回执** ——
发完 1 秒内截图，看不到聊天输入框就是没进去。文本里不能含 SendKeys 元字符 `^ % + ~ ( ) { } [ ]`。

## 指令全集

| 指令 | 作用 |
|---|---|
| `/cam help` | 全部指令 + 语法 |
| `/cam status` | **一屏全量**：绑定 / 机位 / 牵引 / **附身** / 移动 / 录像 / 配置路径 |
| `/cam possess <名字>` | **★ 附身**：观察者模式 + 视角绑定，之后不再发 /tp |
| `/cam release` | 退出附身，视角收回自己，游戏模式复原 |
| `/cam list` | 列出可见同伴（Tab 可补全名字） |
| `/cam bind <名字>` | 绑定相机目标 + 自动开牵引（**不切观察者**，只切机位） |
| `/cam unbind` | 解绑 |
| `/cam tp` | 立刻传到绑定同伴身边（**会刷屏，长跟请用 possess**） |
| `/cam follow [on\|off]` | 走出加载区自动传送（持续追踪；附身时自动让位） |
| `/cam followdist <格>` | 超出多远就传（默认 64） |
| `/cam mode <OFF\|SHOULDER\|ORBIT\|LOCK\|CINEMATIC>` | 切机位模式（附身时让位给原版旁观者镜头） |
| `/cam dist\|height\|shoulder\|bearing\|pitch <值>` | 微调机位参数 |
| `/cam hold [on\|off]` | 目标丢失时钉住上一机位 |
| `/cam lock [x y z]` | 设固定机位（不给参数=用当前目标位置） |
| `/cam run [on\|off]` | 自动疾跑 |
| `/cam fly [on\|off]` | 创造飞行（**每 tick 重申，一落地就自动关**） |
| `/cam speed <倍数>` | 飞行速度倍率（1=原速） |
| `/cam rec start [fps] [dedupe]` / `stop` / `status` / `maxframes <n>` | 录像 |
| `/cam save` / `reload` | 手动落盘 / 重读配置 |

## ★ 四个真坑（别重新踩）

1. **`cam.json` 的 `target` 必须是同伴真名**（`ACX` / `DDD`），不是 `"RDD"`。
   `resolveTarget()` 在 `entitiesForRendering()` 里按名字 `equalsIgnoreCase` 匹配，
   匹配不到就**静默退回原版第一人称，不报任何错**。配了半年没生效就是这个原因。
2. **附身和机位不能同时开**：附身用的是原版 `cameraEntity`，机位算法会把它覆盖掉 ——
   代码里已经让 `Possession.isActive()` 时 `MixinCamera` 早退，别再手动绕过。
3. **录像默认去重已关**。站着不动也是一段真实画面，开了去重会退化成定格动画。
4. **验收录像要看 `ffmpeg.log` 的 `frame=` 等于 PNG 张数**，不能只看 mp4 文件存在。
   ffmpeg 的 `%05d` 当连续序列读，落盘序号有缺口就只编出 1 帧。

## 产物位置

`live 实例\screenshots\numencam_<时间戳>\`
→ `f_00000.png …`（连续）+ `numencam.txt`（fps/frames/dropped/duration）+ `numencam.mp4`

ffmpeg 探测顺序：先 PATH，再扫 `~/AppData/Local/Microsoft/WinGet/Packages/*FFmpeg*/**/ffmpeg.exe`（不写死版本号）。

## 相关

- 工具总索引 + 全部实测记录：`D:\rdd\harness\rdd-harness\工具总索引-20261003\70-工具总索引-编译·进游戏验证·相机·OpenClaw-20261003.md` §10
- 规范：`D:\rdd\harness\rdd-harness\standards.md`（`S-MC` 域）
