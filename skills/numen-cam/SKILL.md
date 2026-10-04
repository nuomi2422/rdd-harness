---
name: numen-cam
description: |-
  游戏内 /cam 客户端相机模块（modId=numencam）：切机位、绑定同伴、走出加载区自动传送、
  自动疾跑/飞行/加速、录视频出 mp4。当需要在游戏里操控镜头视角、跟拍 AI 同伴、
  把玩家传送到同伴旁边、或录下游戏画面时使用。
  Use when user wants 换机位 / 跟拍 / 绑定同伴 / 传送到同伴 / 相机视角 /
  录视频 / 录像 / 追踪 AI / 看同伴在干什么 / numencam / /cam.
  Voice triggers: "换机位", "跟拍", "绑定同伴", "传送到他那里", "相机视角",
  "录视频", "录像", "追踪", "numencam", "/cam", "镜头".
Metadata:
  role: "skills 级能力（客户端相机模块，plugins/camera）"
  mod_id: numencam
  command_root: "/cam"
  config: "E:\\新建文件夹\\rdd架构\\..\\live 实例 config\\numen_api\\cam.json"
  send_command_helper: "E:\\新建文件夹\\rddharness\\bin\\send-mc-command.ps1 -Text '/cam ...'"
---

# numencam（/cam）

客户端专属模块，jar `numen-plugin-camera-1.21.1-0.1.3-dev.jar`，装载后原版聊天框里直接敲 `/cam`。

## ★ 怎么把指令送进游戏（这是最容易卡住的一步）

**不要用 OpenClaw 发指令** —— 它的 `keyDown` 只认 7 个键（wasd/space/shift/ctrl），
`--chat` 那条 t→ctrl+a→delete→typeText 的路**设计上就不可能通**。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "E:\新建文件夹\rddharness\bin\send-mc-command.ps1" -Text "/cam status"
```

返回 `FOCUS_OK …` + `SENT [/cam status] to '…'` 就是送达了（实测 20+ 条全部送达）。
`-NoEnter` 只填不发送。文本里不能含 SendKeys 元字符 `^ % + ~ ( ) { } [ ]`。

## 指令全集

| 指令 | 作用 |
|---|---|
| `/cam help` | 全部指令 + 语法 |
| `/cam status` | **一屏全量**：绑定 / 机位 / 牵引 / 移动 / 录像 / 配置路径 |
| `/cam list` | 列出可见同伴（Tab 可补全名字） |
| `/cam bind <名字>` | 绑定相机目标 + 自动开牵引 |
| `/cam unbind` | 解绑 |
| `/cam tp` | 立刻传到绑定同伴身边 |
| `/cam follow [on\|off]` | 走出加载区自动传送（持续追踪） |
| `/cam followdist <格>` | 超出多远就传（默认 64） |
| `/cam mode <OFF\|SHOULDER\|ORBIT\|LOCK\|CINEMATIC>` | 切机位模式 |
| `/cam dist\|height\|shoulder\|bearing\|pitch <值>` | 微调机位参数 |
| `/cam hold [on\|off]` | 目标丢失时钉住上一机位 |
| `/cam lock [x y z]` | 设固定机位（不给参数=用当前目标位置） |
| `/cam run [on\|off]` | 自动疾跑 |
| `/cam fly [on\|off]` | 创造飞行（**每 tick 重申，一落地就自动关**） |
| `/cam speed <倍数>` | 飞行速度倍率（1=原速） |
| `/cam rec start [fps] [dedupe]` / `stop` / `status` / `maxframes <n>` | 录像 |
| `/cam save` / `reload` | 手动落盘 / 重读配置 |

## ★ 三个真坑（别重新踩）

1. **`cam.json` 的 `target` 必须是同伴真名**（`ACX` / `DDD`），不是 `"RDD"`。
   `resolveTarget()` 在 `entitiesForRendering()` 里按名字 `equalsIgnoreCase` 匹配，
   匹配不到就**静默退回原版第一人称，不报任何错**。配了半年没生效就是这个原因。
2. **录像默认去重已关**。站着不动也是一段真实画面，开了去重会退化成定格动画。
3. **验收录像要看 `ffmpeg.log` 的 `frame=` 等于 PNG 张数**，不能只看 mp4 文件存在。
   ffmpeg 的 `%05d` 当连续序列读，落盘序号有缺口就只编出 1 帧。

## 产物位置

`live 实例\screenshots\numencam_<时间戳>\`
→ `f_00000.png …`（连续）+ `numencam.txt`（fps/frames/dropped/duration）+ `numencam.mp4`

ffmpeg 探测顺序：先 PATH，再扫 `~/AppData/Local/Microsoft/WinGet/Packages/*FFmpeg*/**/ffmpeg.exe`（不写死版本号）。

## 相关

- 工具总索引 + 全部实测记录：`E:\新建文件夹\rddharness\工具总索引-20261003\70-工具总索引-编译·进游戏验证·相机·OpenClaw-20261003.md` §10
- 规范：`E:\新建文件夹\rddharness\standards.md`（`S-MC` 域）